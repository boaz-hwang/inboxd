import copy
import json
import importlib.util
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import expanded_training as e
import history
from test_personalization import example


class Tokenizer:
    def apply_chat_template(self, messages, **kwargs):
        size = int(messages[0]['content'].split(':')[-1])
        return list(range(size if messages[-1]['role'] == 'assistant' else size - 5))


class ExpandedTraining(unittest.TestCase):
    def test_total_deadline_terminates_owned_child_then_disarms_before_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); pid_file = root / 'child-pid'
            original = signal.getsignal(signal.SIGALRM)
            cleanup = []
            def restore(args):
                self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
                cleanup.append(True)
            with patch.object(e.lifecycle, 'stop_owner_daemon'), \
                 patch.object(e.lifecycle, 'restore_daemon', side_effect=restore), \
                 patch.object(e.p, '_system_swap_used', return_value=0), \
                 patch.object(e.p, '_process_group_rss', return_value=1024), \
                 tempfile.TemporaryFile(mode='w+') as log:
                with self.assertRaisesRegex(e.p.TrainingRuntimeError, 'training_total_timeout'):
                    with e.lifecycle.daemon_pause(SimpleNamespace(pause_daemon=True)):
                        with e.total_runtime_guard(.25):
                            e.p.guarded_training_run([sys.executable, '-c',
                                'import os,time,pathlib; pathlib.Path(' + repr(str(pid_file)) + ').write_text(str(os.getpid())); time.sleep(30)'],
                                env=dict(os.environ), stdout=log, pass_fds=(), max_runtime_seconds=5,
                                max_rss_bytes=512*1024**2, resource_report_path=root/'resources.json')
            self.assertEqual(cleanup, [True])
            self.assertEqual(signal.getsignal(signal.SIGALRM), original)
            with self.assertRaises(ProcessLookupError): os.kill(int(pid_file.read_text()), 0)
            self.assertEqual(json.loads((root/'resources.json').read_text())['failure_reason'], 'training_total_timeout')

    def test_total_deadline_covers_cpu_staging_and_preserves_existing_timer(self):
        with self.assertRaisesRegex(e.p.TrainingRuntimeError, 'training_total_timeout'):
            with e.total_runtime_guard(.01): time.sleep(.1)
        signal.setitimer(signal.ITIMER_REAL, 30)
        try:
            with self.assertRaisesRegex(ValueError, 'existing_process_deadline'):
                with e.total_runtime_guard(1): pass
            self.assertGreater(signal.getitimer(signal.ITIMER_REAL)[0], 29)
        finally: signal.setitimer(signal.ITIMER_REAL, 0)

    def fixture(self, root, *, train_lengths=(100, 3000), valid_length=3500):
        root = root.resolve()
        model = root / 'model'; model.mkdir()
        (model / 'config.json').write_text('{}')
        (model / 'model.safetensors').write_bytes(b'weights')
        records = [example(i) for i in range(len(train_lengths) + 1)]
        sizes = list(train_lengths) + [valid_length]
        entries, assignments = [], {}
        for i, r in enumerate(records):
            r['messages'][0]['content'] = 'private-question:' + str(sizes[i])
            r['messages'][-1]['content'] = 'private-answer'
            r['review_hash'] = 'review-' + r['id']
            name = 'valid' if i == len(records) - 1 else 'train'
            assignments[r['id']] = name
            entries.append({'id': r['id'], 'example_hash': e.p.digest(r),
                            'review_hash': r['review_hash'], 'split': name})
        entries.append({'id': 'sealed', 'example_hash': 'sealed-hash',
                        'review_hash': 'sealed-review', 'split': 'test'})
        assignments['sealed'] = 'test'
        manifest = {'version': 1, 'records': entries, 'assignments': assignments,
                    'reservations': {'assignments': {'sealed': 'test'}, 'source_keys': {},
                                     'intervals': {}, 'heldout_chats': []},
                    'source': {'snapshot_hash': 'frozen', 'watermark_ts': 42,
                               'sensitive_source_quarantine': self.quarantine()}}
        self.seal(manifest)
        options = dict(model=model, output=root / 'output', epochs=2,
                       max_runtime_seconds=123)
        return records, manifest, options

    def quarantine(self, keys=()):
        value = {'version': 'test', 'source_keys': list(keys), 'values_retained': False}
        return {**value, 'quarantine_hash': history.digest(value)}

    def test_reviewed_sources_and_authored_targets_cannot_bypass_sensitive_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            records, manifest, options = self.fixture(Path(tmp))
            manifest['source']['sensitive_source_quarantine'] = self.quarantine(
                [records[0]['source_message_keys'][0]])
            self.seal(manifest)
            with self.assertRaisesRegex(ValueError, 'sensitive_source_in_admitted_record'):
                e.prepare(records, manifest, Tokenizer(), **options)
            manifest['source']['sensitive_source_quarantine'] = self.quarantine()
            records[0]['messages'][-1]['content'] = 'password: synthetic-credential-42'
            manifest['records'][0]['example_hash'] = e.p.digest(records[0])
            self.seal(manifest)
            with self.assertRaisesRegex(ValueError, 'sensitive_source_in_admitted_record'):
                e.prepare(records, manifest, Tokenizer(), **options)
            manifest['source'].pop('sensitive_source_quarantine')
            self.seal(manifest)
            with self.assertRaisesRegex(ValueError, 'sensitive_source_quarantine_required'):
                e.prepare(records, manifest, Tokenizer(), **options)

    def seal(self, manifest):
        manifest['manifest_id'] = e.p.digest({k: v for k, v in manifest.items() if k != 'manifest_id'})

    def test_train_cap_keeps_full_validation_and_sealed_metadata_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            records, manifest, options = self.fixture(Path(tmp))
            prepared = e.prepare(records, manifest, Tokenizer(), **options)
            self.assertEqual(prepared.plan['lengths'], {'train': {'count': 1, 'max_total_tokens': 100},
                                                       'valid': {'count': 1, 'max_total_tokens': 3500}})
            self.assertEqual(prepared.plan['seq_length'], 4096)
            self.assertEqual(prepared.plan['iters'], 2)
            self.assertEqual(prepared.plan['final_test_records_supplied'], 0)
            self.assertNotIn('private-answer', json.dumps(prepared.plan))
            self.assertNotIn('sealed', prepared.assignments)
            self.assertEqual(len(records), 3)

    def test_explicit_total_and_selection_budgets_are_frozen_and_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); records, manifest, options = self.fixture(root)
            prepared = e.prepare(records, manifest, Tokenizer(), **options,
                                 selection_max_runtime_seconds=17, max_total_runtime_seconds=200,
                                 compile_mode='disabled')
            self.assertEqual(prepared.plan['selection_max_runtime_seconds'], 17)
            self.assertEqual(prepared.plan['max_total_runtime_seconds'], 200)
            self.assertEqual(prepared.plan['compile_mode'], 'disabled')
            paths = [root / n for n in ('daemon', 'lock', 'inboxd')]
            for path in paths: path.write_text('placeholder')
            args = SimpleNamespace(pause_daemon=True, model=options['model'], output=options['output'],
                daemon_binary=paths[0], daemon_lock=paths[1], inboxd=paths[2])
            with patch.object(e.lifecycle, 'stop_owner_daemon'), patch.object(e.lifecycle, 'restore_daemon'), \
                 patch.object(e.p, 'run_local') as train, \
                 patch.object(e.p, 'select_validation_checkpoint', return_value={}) as select:
                e.execute(prepared, expected_plan_hash=prepared.plan['plan_hash'], daemon_args=args)
            self.assertEqual(train.call_args.kwargs['max_runtime_seconds'], 123)
            self.assertEqual(select.call_args.kwargs['max_runtime_seconds'], 17)
            self.assertEqual(train.call_args.kwargs['compile_mode'], 'disabled')
            self.assertEqual(select.call_args.kwargs['compile_mode'], 'disabled')

    def test_no_unlisted_test_or_changed_review_can_be_admitted(self):
        with tempfile.TemporaryDirectory() as tmp:
            records, manifest, options = self.fixture(Path(tmp))
            for altered in (records + [example(99)], [{**records[0], 'review_hash': 'changed'}] + records[1:]):
                with self.assertRaises(ValueError): e.prepare(altered, manifest, Tokenizer(), **options)
            changed = copy.deepcopy(manifest); changed['assignments']['0'] = 'test'; self.seal(changed)
            with self.assertRaises(ValueError): e.prepare(records, changed, Tokenizer(), **options)

    def test_old_heldout_source_reservation_blocks_new_training_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            records, manifest, options = self.fixture(Path(tmp))
            manifest['reservations']['source_keys'][records[0]['source_message_keys'][0]] = 'test'
            self.seal(manifest)
            with self.assertRaisesRegex(ValueError, 'frozen_boundary'):
                e.prepare(records, manifest, Tokenizer(), **options)

    def test_validation_is_never_silently_shortened(self):
        with tempfile.TemporaryDirectory() as tmp:
            records, manifest, options = self.fixture(Path(tmp), valid_length=5000)
            with self.assertRaisesRegex(ValueError, 'validation_over_token_budget'):
                e.prepare(records, manifest, Tokenizer(), **options)

    def test_executor_passes_only_validation_to_selection_and_restores_on_failure(self):
        for fail in (False, True):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve(); records, manifest, options = self.fixture(root)
                prepared = e.prepare(records, manifest, Tokenizer(), **options)
                paths = [root / n for n in ('daemon', 'lock', 'inboxd')]
                for path in paths: path.write_text('placeholder')
                args = SimpleNamespace(pause_daemon=True, model=options['model'], output=options['output'],
                                       daemon_binary=paths[0], daemon_lock=paths[1], inboxd=paths[2])
                with patch.object(e.lifecycle, 'stop_owner_daemon'), \
                     patch.object(e.lifecycle, 'restore_daemon') as restore, \
                     patch.object(e.p, 'run_local', side_effect=ValueError('guard_failure') if fail else None) as train, \
                     patch.object(e.p, 'select_validation_checkpoint', return_value={'loss': 1}) as select:
                    if fail:
                        with self.assertRaisesRegex(ValueError, 'guard_failure'):
                            e.execute(prepared, expected_plan_hash=prepared.plan['plan_hash'], daemon_args=args)
                        select.assert_not_called()
                    else:
                        report = e.execute(prepared, expected_plan_hash=prepared.plan['plan_hash'], daemon_args=args)
                        self.assertFalse(report['activation_performed'])
                        self.assertEqual([r['id'] for r in select.call_args.args[0]], ['2'])
                        self.assertEqual(select.call_args.kwargs['assignments'], {'2': 'valid'})
                    self.assertFalse(train.call_args.kwargs['require_test_split'])
                    self.assertEqual(train.call_args.kwargs['seq_length'], 4096)
                    restore.assert_called_once_with(args)

    def test_changed_memory_or_plan_rejected_before_daemon_pause(self):
        with tempfile.TemporaryDirectory() as tmp:
            records, manifest, options = self.fixture(Path(tmp))
            prepared = e.prepare(records, manifest, Tokenizer(), **options)
            prepared.records[0]['messages'][-1]['content'] = 'changed'
            with patch.object(e.lifecycle, 'daemon_pause') as pause:
                with self.assertRaisesRegex(ValueError, 'training_plan_changed'):
                    e.execute(prepared, expected_plan_hash=prepared.plan['plan_hash'], daemon_args=None)
                pause.assert_not_called()

    def test_executor_interrupt_during_checkpoint_work_restores_daemon(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); records, manifest, options = self.fixture(root)
            prepared = e.prepare(records, manifest, Tokenizer(), **options)
            paths = [root / n for n in ('daemon', 'lock', 'inboxd')]
            for path in paths: path.write_text('placeholder')
            args = SimpleNamespace(pause_daemon=True, model=options['model'], output=options['output'],
                daemon_binary=paths[0], daemon_lock=paths[1], inboxd=paths[2])
            def checkpoint_work(*args, **kwargs):
                os.kill(os.getpid(), signal.SIGTERM)
            with patch.object(e.lifecycle, 'stop_owner_daemon'), \
                 patch.object(e.lifecycle, 'restore_daemon') as restore, \
                 patch.object(e.p, 'run_local'), \
                 patch.object(e.p, 'select_validation_checkpoint', side_effect=checkpoint_work):
                with self.assertRaisesRegex(e.p.TrainingRuntimeError, 'training_cancelled'):
                    e.execute(prepared, expected_plan_hash=prepared.plan['plan_hash'], daemon_args=args)
            restore.assert_called_once_with(args)
            self.assertEqual(json.loads((options['output'] / 'completion.json').read_text())['status'], 'failed')

    def test_tokenizer_change_rejected_before_daemon_pause(self):
        with tempfile.TemporaryDirectory() as tmp:
            records, manifest, options = self.fixture(Path(tmp))
            template = options['model'] / 'chat_template.jinja'
            template.write_text('original-template')
            prepared = e.prepare(records, manifest, Tokenizer(), **options)
            template.write_text('changed-template')
            with patch.object(e.lifecycle, 'daemon_pause') as pause:
                with self.assertRaisesRegex(ValueError, 'training_model_changed'):
                    e.execute(prepared, expected_plan_hash=prepared.plan['plan_hash'], daemon_args=None)
                pause.assert_not_called()

    def test_actual_staging_has_empty_test_and_valid_only_evaluation_works(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); records, manifest, options = self.fixture(root, train_lengths=(100,))
            assignments = {r['id']: manifest['assignments'][r['id']] for r in records}
            staged = []
            def child(command, **kwargs):
                config = json.loads(Path(command[-1]).read_text())
                data = Path(config['data'])
                staged.append({n: (data / (n + '.jsonl')).read_text() if (data / (n + '.jsonl')).exists() else ''
                               for n in ('train', 'valid', 'test')})
                if config['train']: self.assertFalse((data/'test.jsonl').exists())
                else: self.assertFalse((data/'train.jsonl').exists())
                self.assertEqual(config['iters'], 1)
                return subprocess.CompletedProcess(command, 0)
            with patch.dict(sys.modules, {'mlx_lm.utils': SimpleNamespace(load_tokenizer=lambda path: Tokenizer())}), \
                 patch.object(e.p, 'stage_training_model', return_value=options['model']) as stage, \
                 patch.object(e.p, 'guarded_training_run', side_effect=child):
                e.p.run_local(records, options['model'], root / 'training', assignments=assignments,
                              iters=1, seq_length=4096, require_test_split=False)
                self.assertEqual(staged[0]['test'], '')
                self.assertEqual(len(stage.call_args.args[2]), 2)
                valid = [r for r in records if assignments[r['id']] == 'valid']
                e.p.run_local(valid, options['model'], root / 'validation', assignments={valid[0]['id']: 'valid'},
                              evaluate=True, split_name='valid', seq_length=4096)
                self.assertEqual(staged[1]['train'], '')
                self.assertEqual(staged[1]['test'], staged[1]['valid'])
            with self.assertRaisesRegex(ValueError, 'sealed_test_records'):
                e.p.run_local(records, options['model'], root / 'rejected',
                              assignments={r['id']: 'test' for r in records}, require_test_split=False)

    @unittest.skipUnless(importlib.util.find_spec('mlx_lm'), 'actual installed MLX loader required')
    def test_installed_mlx_loader_accepts_actual_training_and_validation_staging(self):
        from mlx_lm.tuner.datasets import load_local_dataset
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); records, manifest, options = self.fixture(root, train_lengths=(100,))
            assignments = {r['id']: manifest['assignments'][r['id']] for r in records}
            # Confirm the exact provider failure before exercising fixed staging.
            empty = root/'empty'; empty.mkdir(); (empty/'test.jsonl').write_text('')
            with self.assertRaises(IndexError): load_local_dataset(empty, Tokenizer(), SimpleNamespace(mask_prompt=True))
            actual_counts = []
            def loader_child(command, **kwargs):
                config = json.loads(Path(command[-1]).read_text())
                loaded = load_local_dataset(Path(config['data']), Tokenizer(), SimpleNamespace(mask_prompt=True))
                actual_counts.append(tuple(len(value) for value in loaded))
                return subprocess.CompletedProcess(command, 0)
            with patch.dict(sys.modules, {'mlx_lm.utils': SimpleNamespace(load_tokenizer=lambda path: Tokenizer())}), \
                 patch.object(e.p, 'stage_training_model', return_value=options['model']), \
                 patch.object(e.p, 'guarded_training_run', side_effect=loader_child):
                e.p.run_local(records, options['model'], root/'training', assignments=assignments,
                              iters=1, seq_length=4096, require_test_split=False)
                valid = [r for r in records if assignments[r['id']]=='valid']
                e.p.run_local(valid, options['model'], root/'evaluation', assignments={valid[0]['id']:'valid'},
                              evaluate=True, split_name='valid', seq_length=4096)
            self.assertEqual(actual_counts, [(1,1,0), (0,1,1)])


if __name__ == '__main__':
    unittest.main()
