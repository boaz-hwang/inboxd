import copy
import importlib.util
import hashlib
import json
import os
import subprocess
import signal
import threading
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

spec = importlib.util.spec_from_file_location('personalization', Path(__file__).resolve().parents[1] / 'personalization.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def example(i):
    chat={'platform':'kakao','account':'a','chat_id':f'room{i}'}
    return dict(id=str(i), chat=chat,
                source_message_keys=[json.dumps(['kakao','a',f'room{i}',f'context{i}'],separators=(',',':')),
                                     json.dumps(['kakao','a',f'room{i}',f'target{i}'],separators=(',',':'))],
                conversation_id=f'room{i}', timestamp=i+1, reviewed=True,
                linkage='explicit_reply', target_role='self', target_message_id=f'target{i}',
                context_message_ids=[f'context{i}'], context_timestamps=[i],
                provenance_refs=[f'ref{i}'], messages=[{'role':'user','content':f'question{i}'},
                                                   {'role':'assistant','content':f'answer{i}'}])


class PersonalizationTests(unittest.TestCase):
    def test_failed_training_child_creates_private_artifacts(self):
        with tempfile.TemporaryDirectory() as directory, open(os.devnull, 'w') as log:
            artifact = Path(directory) / 'checkpoint'
            code = ('import pathlib,sys; p=pathlib.Path(sys.argv[1]); '
                    'p.mkdir(); (p/"weights").write_bytes(b"checkpoint"); sys.exit(1)')
            previous_umask = os.umask(0o022)
            try:
                with self.assertRaises(p.TrainingRuntimeError):
                    p.guarded_training_run([sys.executable, '-c', code, str(artifact)],
                        env=os.environ, stdout=log, pass_fds=(),
                        max_runtime_seconds=5, max_rss_bytes=1024**3)
            finally:
                os.umask(previous_umask)
            self.assertEqual(artifact.stat().st_mode & 0o777, 0o700)
            self.assertEqual((artifact / 'weights').stat().st_mode & 0o777, 0o600)

    def test_cleanup_preserves_inherited_locks_and_removes_abandoned_staging(self):
        with tempfile.TemporaryDirectory() as root, patch.object(p.tempfile, 'tempdir', root):
            for prefix in ('inboxd-training-', 'inboxd-checkpoints-'):
                with p.private_staging(prefix) as (directory, fd):
                    # A dead orchestrator marker must not override the inherited lock.
                    os.lseek(fd, 0, os.SEEK_SET)
                    os.ftruncate(fd, 0)
                    os.write(fd, json.dumps({'version': 1, 'pid': 12345}).encode())
                    child = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read()'],
                                             stdin=subprocess.PIPE, pass_fds=tuple(p._STAGING_LOCK_FDS))
                    try:
                        with patch.object(p, '_pid_alive', return_value=False):
                            self.assertEqual(p.cleanup_stale_training_dirs(), 0)
                        self.assertTrue(directory.exists())
                    finally:
                        child.communicate(timeout=5)
                abandoned = Path(root) / (prefix + 'abandoned')
                abandoned.mkdir(mode=0o700)
                (abandoned / '.active.lock').write_text(json.dumps({'version': 1, 'pid': 12345}))
                with patch.object(p, '_pid_alive', return_value=False):
                    self.assertEqual(p.cleanup_stale_training_dirs(), 1)
                self.assertFalse(abandoned.exists())

    def test_child_lock_survives_orchestrator_descriptor_close(self):
        with tempfile.TemporaryDirectory() as root, patch.object(p.tempfile, 'tempdir', root):
            directory = Path(root) / 'inboxd-checkpoints-orphaned-parent'
            directory.mkdir(mode=0o700)
            lock = directory / '.active.lock'
            lock.write_text(json.dumps({'version': 1, 'pid': 12345}))
            fd = os.open(lock, os.O_RDWR)
            p.fcntl.flock(fd, p.fcntl.LOCK_EX)
            child = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read()'],
                                     stdin=subprocess.PIPE, pass_fds=(fd,))
            os.close(fd)
            try:
                with patch.object(p, '_pid_alive', return_value=False):
                    self.assertEqual(p.cleanup_stale_training_dirs(), 0)
                self.assertTrue(directory.exists())
            finally:
                child.communicate(timeout=5)
            with patch.object(p, '_pid_alive', return_value=False):
                self.assertEqual(p.cleanup_stale_training_dirs(), 1)

    def test_cleanup_fails_closed_for_symlinks_and_invalid_markers(self):
        with tempfile.TemporaryDirectory() as root, patch.object(p.tempfile, 'tempdir', root):
            target = Path(root) / 'target'
            target.mkdir(mode=0o700)
            (Path(root) / 'inboxd-training-link').symlink_to(target, target_is_directory=True)
            for index, marker in enumerate(('[]', '{bad', '{"version":1,"pid":0}')):
                directory = Path(root) / f'inboxd-checkpoints-invalid-{index}'
                directory.mkdir(mode=0o700)
                (directory / '.active.lock').write_text(marker)
            dangling = Path(root) / 'inboxd-training-dangling'
            dangling.mkdir(mode=0o700)
            (dangling / '.active.lock').symlink_to(Path(root) / 'missing')
            with patch.object(p, '_legacy_process_uses', return_value=False):
                self.assertEqual(p.cleanup_stale_training_dirs(legacy_grace_seconds=0), 0)
            self.assertTrue(target.exists())
            self.assertTrue(dangling.exists())

    def test_guarded_child_success_and_rss_abort_preserve_staging_until_exit(self):
        with tempfile.TemporaryDirectory() as root, patch.object(p.tempfile, 'tempdir', root):
            with p.private_staging('inboxd-training-') as (directory, fd), open(os.devnull, 'w') as log:
                result = p.guarded_training_run([sys.executable, '-c', 'pass'], env=os.environ,
                    stdout=log, pass_fds=(fd,), max_runtime_seconds=5, max_rss_bytes=1024**3)
                self.assertEqual(result.returncode, 0)
                def high_rss(group):
                    self.assertNotEqual(group, os.getpgrp())
                    with patch.object(p, '_pid_alive', return_value=False):
                        self.assertEqual(p.cleanup_stale_training_dirs(), 0)
                    self.assertTrue(directory.exists())
                    return 100
                with patch.object(p, '_process_group_rss', side_effect=high_rss):
                    with self.assertRaises(p.TrainingRuntimeError) as error:
                        p.guarded_training_run([sys.executable, '-c', 'import time; time.sleep(30)'],
                            env=os.environ, stdout=log, pass_fds=(fd,), max_runtime_seconds=5, max_rss_bytes=99)
                self.assertEqual(error.exception.reason, 'training_rss_limit')
                self.assertTrue(directory.exists())
            self.assertFalse(directory.exists())

    def test_guarded_timeout_kills_term_ignoring_process_group(self):
        with tempfile.TemporaryDirectory() as root, open(os.devnull, 'w') as log:
            pidfile = Path(root) / 'child.pid'
            code = ('import os, signal, subprocess, sys, time; '
                    'signal.signal(signal.SIGTERM, signal.SIG_IGN); '
                    'child=subprocess.Popen([sys.executable,"-c","import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)"]); '
                    'open(sys.argv[1],"w").write(str(os.getpgrp())); time.sleep(30)')
            with self.assertRaises(p.TrainingRuntimeError) as error:
                p.guarded_training_run([sys.executable, '-c', code, str(pidfile)], env=os.environ,
                    stdout=log, pass_fds=(), max_runtime_seconds=.3, max_rss_bytes=1024**3)
            self.assertEqual(error.exception.reason, 'training_timeout')
            group = int(pidfile.read_text())
            # Dead descendants may remain zombies briefly; none may hold a live FD.
            result = subprocess.run(['ps', '-axo', 'pgid=,stat='], capture_output=True, text=True)
            states = [line.split()[1] for line in result.stdout.splitlines()
                      if line.split() and int(line.split()[0]) == group]
            self.assertTrue(all(state.startswith('Z') for state in states))

    def test_guarded_cancellation_is_typed_and_restores_signal_handler(self):
        before = signal.getsignal(signal.SIGTERM)
        timer = threading.Timer(.1, lambda: os.kill(os.getpid(), signal.SIGTERM))
        with open(os.devnull, 'w') as log:
            timer.start()
            try:
                with self.assertRaises(p.TrainingRuntimeError) as error:
                    p.guarded_training_run([sys.executable, '-c', 'import time; time.sleep(30)'],
                        env=os.environ, stdout=log, pass_fds=(), max_runtime_seconds=5, max_rss_bytes=1024**3)
                self.assertEqual(error.exception.reason, 'training_cancelled')
            finally:
                timer.cancel()
                timer.join()
        self.assertEqual(signal.getsignal(signal.SIGTERM), before)

    def test_outer_timeout_kills_nested_term_ignoring_session(self):
        with tempfile.TemporaryDirectory() as tmp, open(os.devnull, 'w') as log:
            pidfile = Path(tmp) / 'nested.pid'
            nested = 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)'
            code = ('import subprocess,sys,time; '
                f'child=subprocess.Popen([sys.executable,"-c",{nested!r}],start_new_session=True); '
                'open(sys.argv[1],"w").write(str(child.pid)); time.sleep(30)')
            with self.assertRaises(p.TrainingRuntimeError):
                p.guarded_training_run([sys.executable, '-c', code, str(pidfile)],
                    env=os.environ, stdout=log, pass_fds=(), max_runtime_seconds=.4,
                    max_rss_bytes=1024**3)
            child = int(pidfile.read_text())
            result = subprocess.run(['ps', '-p', str(child), '-o', 'stat='], capture_output=True, text=True)
            self.assertTrue(not result.stdout.strip() or result.stdout.strip().startswith('Z'))

    def test_failed_training_manifest_records_safe_typed_reason(self):
        class Tokenizer:
            def apply_chat_template(self, messages, **kwargs):
                return list(range(10 if messages[-1]['role'] == 'assistant' else 5))
        with tempfile.TemporaryDirectory() as root:
            model = Path(root) / 'model'
            model.mkdir()
            (model / 'config.json').write_text('{}')
            (model / 'model.safetensors').write_bytes(b'fake')
            output = Path(root) / 'output'
            with patch.dict(sys.modules, {'mlx_lm.utils': type('Utils', (), {'load_tokenizer': lambda path: Tokenizer()})}), \
                 patch.object(p, 'stage_training_model', return_value=model), \
                 patch.object(p, 'guarded_training_run', side_effect=p.TrainingRuntimeError('training_timeout')):
                with self.assertRaises(p.TrainingRuntimeError):
                    p.run_local([example(i) for i in range(20)], model, output, iters=1)
            manifest = json.loads((output / 'manifest.json').read_text())
            self.assertEqual(manifest['status'], 'failed')
            self.assertEqual(manifest['failure_reason'], 'training_timeout')
            self.assertEqual(manifest['resource_budget']['max_rss_bytes'], 20 * 1024**3)

    def test_known_metal_memory_failure_is_classified_without_log_exposure(self):
        class Tokenizer:
            def apply_chat_template(self, messages, **kwargs):
                return list(range(10 if messages[-1]['role'] == 'assistant' else 5))
        with tempfile.TemporaryDirectory() as root:
            model = Path(root) / 'model'
            model.mkdir()
            (model / 'config.json').write_text('{}')
            (model / 'model.safetensors').write_bytes(b'fake')
            for index, marker in enumerate(('[METAL] Insufficient Memory', 'generic error')):
                output = Path(root) / str(index)
                def failing_child(*args, **kwargs):
                    kwargs['stdout'].write(marker + ' synthetic-private-detail')
                    raise p.TrainingRuntimeError('local_training_or_evaluation_failed')
                with patch.dict(sys.modules, {'mlx_lm.utils': type('Utils', (), {'load_tokenizer': lambda path: Tokenizer()})}), \
                     patch.object(p, 'stage_training_model', return_value=model), \
                     patch.object(p, 'guarded_training_run', side_effect=failing_child):
                    with self.assertRaises(p.TrainingRuntimeError) as error:
                        p.run_local([example(i) for i in range(20)], model, output, iters=1)
                expected = 'training_memory_error' if index == 0 else 'local_training_or_evaluation_failed'
                self.assertEqual(error.exception.reason, expected)
                self.assertNotIn('private-detail', str(error.exception))
                manifest = json.loads((output / 'manifest.json').read_text())
                self.assertEqual(manifest['failure_reason'], expected)
                self.assertNotIn('private-detail', json.dumps(manifest))

    def test_swap_parser_and_growth_guard(self):
        self.assertEqual(p.parse_swap_usage('total = 4.00G used = 1024.50M free = 1.0G'), int(1024.5 * 1024**2))
        self.assertEqual(p.parse_swap_usage('used = 2.25G'), int(2.25 * 1024**3))
        with self.assertRaises(p.TrainingRuntimeError):
            p.parse_swap_usage('unsupported output')
        with open(os.devnull, 'w') as log, patch.object(p, '_system_swap_used', side_effect=[100, 150]):
            with self.assertRaises(p.TrainingRuntimeError) as error:
                p.guarded_training_run([sys.executable, '-c', 'import time; time.sleep(30)'],
                    env=os.environ, stdout=log, pass_fds=(), max_runtime_seconds=5,
                    max_rss_bytes=1024**3, max_swap_bytes=50)
            self.assertEqual(error.exception.reason, 'training_swap_limit')
        with patch.object(p.sys, 'platform', 'linux'):
            self.assertIsNone(p._system_swap_used())

    def test_resource_report_records_success_and_failure_without_command(self):
        with tempfile.TemporaryDirectory() as tmp, open(os.devnull, 'w') as log:
            report = Path(tmp) / 'resources.json'
            with patch.object(p, '_process_group_rss', return_value=100), \
                 patch.object(p, '_system_swap_used', return_value=200):
                p.guarded_training_run([sys.executable, '-c', 'import time; time.sleep(.1)'],
                    env=os.environ, stdout=log, pass_fds=(), max_runtime_seconds=5,
                    max_rss_bytes=1000, resource_report_path=report)
            data = json.loads(report.read_text())
            self.assertEqual(data['status'], 'complete')
            self.assertEqual(data['peak_rss_bytes'], 100)
            self.assertEqual(data['baseline_swap_bytes'], 200)
            self.assertTrue(data['samples'])
            self.assertEqual(report.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('command', data)
            with patch.object(p, '_process_group_rss', return_value=1100), \
                 patch.object(p, '_system_swap_used', return_value=200):
                with self.assertRaises(p.TrainingRuntimeError):
                    p.guarded_training_run([sys.executable, '-c', 'import time; time.sleep(30)'],
                        env=os.environ, stdout=log, pass_fds=(), max_runtime_seconds=5,
                        max_rss_bytes=1000, resource_report_path=report)
            data = json.loads(report.read_text())
            self.assertEqual(data['failure_reason'], 'training_rss_limit')
            self.assertEqual(data['peak_rss_bytes'], 1100)

    def test_resource_accounting_includes_nested_dedicated_sessions(self):
        result = subprocess.CompletedProcess([], 0, stdout='10 1 10 100\n11 10 11 200\n12 11 12 300\n20 1 20 999\n')
        with patch.object(p.subprocess, 'run', return_value=result):
            self.assertEqual(p._process_group_rss(10), 600 * 1024)

    def test_optional_checkpoint_dedup_evaluates_identical_final_only_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            adapter = Path(tmp) / 'adapter'; adapter.mkdir()
            (adapter / '0000060_adapters.safetensors').write_bytes(b'first')
            (adapter / '0000120_adapters.safetensors').write_bytes(b'final')
            (adapter / 'adapters.safetensors').write_bytes(b'final')
            p.private_json(adapter / 'adapter_config.json', {})
            p.private_json(adapter / 'manifest.json', {'iters': 120})
            calls = []
            runtime_fields = {
                'runtime_configuration': {'backend': 'legacy', 'compile_mode': 'default'},
                'runtime_source_sha256': {'personalization.py': 'a' * 64, 'training_runtime.py': 'b' * 64},
                'runtime_dependency_versions': {'mlx': 'synthetic-mlx', 'mlx-lm': 'synthetic-mlx-lm'},
                'runtime_fingerprint': 'c' * 64,
            }
            def evaluate(records, model, output, **kwargs):
                calls.append(kwargs['adapter'])
                output.mkdir()
                (output / 'runtime.log').write_text(f'Test loss {3 - len(calls)}')
                p.private_json(output/'manifest.json', {
                    'status':'complete','base_model_id':'fixture','dataset_id':'valid-dataset',
                    **runtime_fields,
                })
                p.private_json(output/'resources.json', {'status':'complete','elapsed_seconds':1})
            with patch.object(p, 'run_local', side_effect=evaluate):
                selection = p.select_validation_checkpoint([], Path(tmp), adapter,
                    assignments={}, deduplicate=True)
            self.assertEqual(len(calls), 2)
            self.assertEqual(selection['checkpoint_iteration'], 120)
            self.assertEqual(selection['evaluated_checkpoints'], 2)
            receipts = json.loads((adapter/'checkpoint-validation.json').read_text())
            self.assertEqual(receipts['status'], 'complete')
            self.assertEqual([r['checkpoint_iteration'] for r in receipts['evaluations']], [60,120])
            for receipt in receipts['evaluations']:
                for field, value in runtime_fields.items():
                    self.assertEqual(receipt[field], value)
                self.assertEqual(receipt['loss_evaluation_hash'], p.digest(
                    {k:v for k,v in receipt.items() if k!='loss_evaluation_hash'}))
                resources=Path(receipt['resource_report_path'])
                self.assertTrue(resources.exists())
                self.assertEqual(resources.stat().st_mode & 0o777, 0o600)

    def test_time_split_and_input_immutable(self):
        records = [example(i) for i in range(20)]
        before = copy.deepcopy(records)
        splits, manifest = p.prepare_examples(records)
        self.assertTrue(all(splits[k] for k in ('train','valid','test')))
        self.assertLess(max(r['timestamp'] for r in splits['train']), min(r['timestamp'] for r in splits['valid']))
        self.assertEqual(records,before)
        self.assertEqual(p.prepare_examples(records)[1]['dataset_id'],manifest['dataset_id'])

    def test_completed_checkpoint_receipt_survives_later_validation_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            adapter = Path(tmp)/'adapter'; adapter.mkdir()
            (adapter/'0000076_adapters.safetensors').write_bytes(b'first-weight')
            (adapter/'0000152_adapters.safetensors').write_bytes(b'second-weight')
            (adapter/'adapters.safetensors').write_bytes(b'second-weight')
            p.private_json(adapter/'adapter_config.json', {})
            p.private_json(adapter/'manifest.json', {'iters':152})
            calls=[]
            runtime_fields = {
                'runtime_configuration': {'backend': 'legacy', 'compile_mode': 'default'},
                'runtime_source_sha256': {'personalization.py': 'a' * 64, 'training_runtime.py': 'b' * 64},
                'runtime_dependency_versions': {'mlx': 'synthetic-mlx', 'mlx-lm': 'synthetic-mlx-lm'},
                'runtime_fingerprint': 'c' * 64,
            }
            def evaluate(records, model, output, **kwargs):
                calls.append(True)
                if len(calls)==2: raise p.TrainingRuntimeError('training_timeout')
                output.mkdir()
                (output/'runtime.log').write_text('Test loss 1.234, Test ppl 3.435.')
                p.private_json(output/'manifest.json', {
                    'status':'complete','base_model_id':'fixture','dataset_id':'valid-only',
                    **runtime_fields,
                })
                p.private_json(output/'resources.json', {'status':'complete','elapsed_seconds':2})
            with patch.object(p,'run_local',side_effect=evaluate):
                with self.assertRaisesRegex(p.TrainingRuntimeError,'training_timeout'):
                    p.select_validation_checkpoint([],Path(tmp),adapter,assignments={},deduplicate=True)
            ledger=json.loads((adapter/'checkpoint-validation.json').read_text())
            self.assertEqual(len(ledger['evaluations']),1)
            receipt=ledger['evaluations'][0]
            self.assertEqual(receipt['checkpoint_iteration'],76)
            self.assertEqual(receipt['validation_loss'],1.234)
            self.assertTrue(Path(receipt['resource_report_path']).exists())
            self.assertEqual(receipt['artifact_sha256'],hashlib.sha256(b'first-weight').hexdigest())

    def test_future_context_and_unreviewed_not_labels(self):
        a,b,c = example(1),example(2),example(3)
        a['context_timestamps']=[a['timestamp']]
        b['reviewed']=False
        c['target_role']='other'
        splits, manifest=p.prepare_examples([a,b,c])
        self.assertFalse(any(splits.values()))
        self.assertEqual(len(manifest['rejected']),3)

    def test_conversation_and_near_duplicate_groups_do_not_leak(self):
        records=[example(i) for i in range(20)]
        records[0]['conversation_id']=records[-1]['conversation_id']='shared'
        records[1]['duplicate_group']=records[-2]['duplicate_group']='paraphrase'
        splits,manifest=p.prepare_examples(records)
        ids={r['id'] for values in splits.values() for r in values}
        self.assertNotIn('1',ids)
        self.assertEqual(len(manifest['rejected']),1)

    def test_registry_requires_review_and_matching_model_and_rollback(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); adapter=root/'adapter'; adapter.mkdir()
            (adapter/'adapters.safetensors').write_bytes(b'test')
            (adapter/'adapter_config.json').write_text('{}')
            (adapter/'manifest.json').write_text(json.dumps(dict(status='complete',mode='train',base_model_id='base',dataset_id='dataset')))
            registry=root/'active.json'
            with self.assertRaisesRegex(ValueError,'review'):
                p.activate(registry,adapter,'base')
            with self.assertRaisesRegex(ValueError,'mismatch'):
                p.activate(registry,adapter,'wrong',reviewed=True)
            p.activate(registry,adapter,'base',reviewed=True)
            self.assertEqual(json.loads(registry.read_text())['active']['path'],str(adapter.resolve()))
            self.assertEqual(registry.stat().st_mode & 0o777,0o600)
            p.rollback(registry)
            self.assertIsNone(json.loads(registry.read_text())['active'])

    def test_local_only_and_insufficient_data(self):
        with self.assertRaisesRegex(ValueError,'absolute_local'):
            p.local_model('remote/model')
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); (root/'config.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'insufficient'):
                p.run_local([],str(root),str(root/'out'))

    def test_standalone_train_selects_validation_checkpoint(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); data=root/'examples.jsonl'
            data.write_text(json.dumps(example(1))+'\n')
            output=root/'adapter'
            argv=['personalization.py','train','--examples',str(data),'--model',str(root),
                  '--output',str(output),'--iters','3','--seq-length','512','--batch-size','2']
            with patch.object(sys,'argv',argv), patch.object(p,'run_local') as train, \
                 patch.object(p,'select_validation_checkpoint') as select:
                p.main()
            self.assertEqual(train.call_args.kwargs['iters'],3)
            self.assertEqual(train.call_args.kwargs['seq_length'],512)
            self.assertEqual(select.call_args.kwargs['seq_length'],512)


if __name__=='__main__':
    unittest.main()
