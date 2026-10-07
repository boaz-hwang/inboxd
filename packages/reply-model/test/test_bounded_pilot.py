import json
import os
import signal
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bounded_pilot as b


class PilotDaemonRestoration(unittest.TestCase):
    def test_interrupt_between_children_restores_and_shields_second_interrupt(self):
        for number in (signal.SIGINT, signal.SIGTERM):
            before = {n: signal.getsignal(n) for n in (signal.SIGINT, signal.SIGTERM)}
            restored = []
            def restore(args):
                # These real signals must be ignored only during cleanup.
                os.kill(os.getpid(), signal.SIGTERM)
                os.kill(os.getpid(), signal.SIGINT)
                restored.append(True)
            with patch.object(b, 'stop_owner_daemon'), patch.object(b, 'restore_daemon', side_effect=restore):
                with self.assertRaisesRegex(b.p.TrainingRuntimeError, 'training_cancelled'):
                    with b.daemon_pause(SimpleNamespace(pause_daemon=True)):
                        os.kill(os.getpid(), number)
            self.assertEqual(restored, [True])
            self.assertEqual({n: signal.getsignal(n) for n in before}, before)

    def test_handlers_restored_even_if_daemon_readiness_fails(self):
        before = {n: signal.getsignal(n) for n in (signal.SIGINT, signal.SIGTERM)}
        with patch.object(b, 'stop_owner_daemon'), patch.object(b, 'restore_daemon', side_effect=ValueError('restore_failed')):
            with self.assertRaisesRegex(ValueError, 'restore_failed'):
                with b.daemon_pause(SimpleNamespace(pause_daemon=True)):
                    pass
        self.assertEqual({n: signal.getsignal(n) for n in before}, before)

    def test_readiness_requires_actual_nested_encryption_and_schema(self):
        good = {'ready': True, 'encryption': {'ready': True, 'schema_valid': True}}
        self.assertTrue(b.daemon_status_ready(good))
        for status in ({'daemon_ready': True, 'encryption_ready': True},
                       {'ready': True}, {'ready': True, 'encryption': {'ready': True, 'schema_valid': False}}):
            self.assertFalse(b.daemon_status_ready(status))
        with patch.object(b, 'owner_daemon_status', return_value=good):
            b.wait_daemon_ready(timeout=.1)
        with patch.object(b, 'owner_daemon_status', return_value={'ready': False}):
            with self.assertRaisesRegex(ValueError, 'not_ready_after_restore'):
                b.wait_daemon_ready(timeout=.001)

    def fake_args(self, tmp):
        root = Path(tmp)
        cli = root / 'inboxd'
        actions = root / 'actions.jsonl'
        cli.write_text('#!' + sys.executable + '\nimport sys,json\n'
            + f'with open({str(actions)!r}, "a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n')
        cli.chmod(0o700)
        return SimpleNamespace(pause_daemon=True, inboxd=cli, output=root,
            root=root, model=root, daemon_lock=root/'lock', daemon_binary=root/'daemon', train_max_tokens=4096), actions

    def test_training_cap_excludes_whole_real_examples_only(self):
        class Tokenizer:
            def apply_chat_template(self, messages, **kwargs):
                return list(range(messages[0]['token_length']))
        def record(identity, length):
            return {'id': identity, 'review_hash': 'hash-' + identity,
                    'messages': [{'token_length': length}]}
        splits = {'train': [record('short', 1985), record('long', 2791)],
                  'valid': [record('validation', 3550)], 'test': [record('test', 3428)]}
        used, excluded = b.filter_real_training(splits, Tokenizer(), 2048)
        self.assertEqual([r['id'] for r in used['train']], ['short'])
        self.assertEqual(used['valid'], splits['valid'])
        self.assertEqual(used['test'], splits['test'])
        self.assertEqual(len(splits['train']), 2)
        self.assertEqual(excluded, [{'id':'long','hash':'hash-long','total_tokens':2791,
                                    'reason':'pilot_train_over_token_budget'}])

    def test_inner_failure_restores_through_actual_fake_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            args, actions = self.fake_args(tmp)
            with patch.object(b, 'stop_owner_daemon') as stop, \
                 patch.object(b, 'wait_daemon_ready') as ready:
                with self.assertRaisesRegex(ValueError, 'synthetic_training_failure'):
                    with b.daemon_pause(args):
                        raise ValueError('synthetic_training_failure')
            stop.assert_called_once_with(args)
            self.assertEqual(json.loads(actions.read_text()), ['daemon', 'start'])
            ready.assert_called_once()

    def test_outer_resource_failure_always_restores(self):
        with tempfile.TemporaryDirectory() as tmp:
            args, actions = self.fake_args(tmp)
            with patch.object(b.p, 'guarded_training_run', side_effect=b.p.TrainingRuntimeError('training_swap_limit')), \
                 patch.object(b, 'wait_daemon_ready') as ready:
                with self.assertRaises(b.p.TrainingRuntimeError):
                    b.run_guarded(args)
            self.assertEqual(json.loads(actions.read_text()), ['daemon', 'start'])
            ready.assert_called_once()


if __name__ == '__main__':
    unittest.main()
