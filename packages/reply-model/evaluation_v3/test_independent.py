"""CPU-only workflow/integrity checks using invented stubs, never real cases."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import independent as ev


WORKER = '''import json
PROMPT_VERSION = "test-v1"
SYSTEM = "stub"
def compile_prompt(request):
 return [{"role":"system","content":SYSTEM},{"role":"user","content":json.dumps({"preflight":{"status":"ready"}})}], []
def build_generation_input(compiled):
 return compiled
'''


class Tokenizer:
    def __init__(self, count=20):
        self.count = count

    def apply_chat_template(self, *args, **kwargs):
        return [0] * self.count


class Engine:
    def __init__(self):
        self.calls = []

    def generate_text(self, messages, **kwargs):
        self.calls.append(kwargs)
        return 'stub candidate' if kwargs['adapter_path'] else 'stub baseline'


class Workflow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.worker = self.root / 'worker.py'
        self.worker.write_text(WORKER)
        self.raw = self.root / 'raw.json'
        self.suite = self.root / 'suite.json'
        self.report = self.root / 'report.json'
        self.review = self.root / 'review.json'
        self.verdict = self.root / 'verdict.json'
        self.policy = {'min_case_usefulness': 3, 'min_mean_usefulness': 4,
            'min_mean_style': 3.5, 'meaningful_usefulness_gain': 0.15,
            'meaningful_style_gain': 0.25, 'min_paired_net_win_fraction': 0.1}
        cases = [{'id': 'stub-' + str(i), 'category': 'stub', 'request': {'id': str(i)},
                  'rubric': {key: ['stub rule'] for key in ('allowed', 'forbidden', *ev.DIMENSIONS)}}
                 for i in range(3)]
        ev.freeze_raw(self.raw, cases, {}, self.policy, 'unit_test')
        raw = ev.read(self.raw)
        supplemental = ev.seal({'applicable_raw_hashes': [raw['raw_hash']],
            'min_behavior_usefulness_gain': 0.15, 'min_clear_failure_case_reduction': 2}, 'supplemental_hash')
        ev.write_private(self.root / 'supplemental-gate-frozen.json', supplemental)
        ev.compile_suite(self.raw, self.suite,
            {'old': self.worker, 'new': self.worker, 'candidate': self.worker}, 'candidate', ['old', 'new'])

    def generate(self):
        engine = Engine()
        ev.generate(engine, Tokenizer(), self.root / 'adapter', self.report, suite_path=self.suite)
        self.assertEqual(len(engine.calls), 9)
        return engine

    def judgments(self, style_only=False, fail=False):
        _, _, views = ev.review_view(self.suite, self.report)
        rows = {}
        for view in views:
            candidate = next(o['label'] for o in view['outputs'] if o['text'] == 'stub candidate')
            baseline = [o['label'] for o in view['outputs'] if o['label'] != candidate]
            options = {}
            for option in view['outputs']:
                is_candidate = option['label'] == candidate
                options[option['label']] = {'output_hash': option['output_hash'],
                    **{d: 'fail' if fail and is_candidate and d == 'fact' else 'pass' for d in ev.DIMENSIONS},
                    'usefulness': 4 if is_candidate or style_only else 3,
                    'style': 5 if is_candidate else 4, 'reason': 'Stub integrity review.'}
            rows[view['id']] = {'options': options, 'preference': [[candidate], baseline]}
        ev.write_private(self.review, {'reviewer': 'agent_delegated',
            'mapping_seen_before_freeze': False, 'cases': rows})

    def test_complete_three_method_arbitrary_count_and_blind_freeze(self):
        self.generate()
        self.judgments()
        original_read = ev.read
        def no_mapping_read(path):
            if str(path).endswith('-unblind.json'):
                raise AssertionError('review leaked mapping')
            return original_read(path)
        with patch.object(ev, 'read', no_mapping_read):
            ev.freeze_verdicts(self.suite, self.report, self.review, self.verdict)
        summary = ev.summarize(self.suite, self.report, self.verdict)
        self.assertEqual(summary['gate'], 'pass')
        self.assertEqual(summary['methods']['candidate']['count'], 3)
        self.assertEqual(set(summary['paired']), {'old', 'new'})
        self.assertFalse(summary['activation_authorized'])

    def test_style_only_cannot_qualify_as_behavior_improvement(self):
        self.generate()
        self.judgments(style_only=True)
        ev.freeze_verdicts(self.suite, self.report, self.review, self.verdict)
        summary = ev.summarize(self.suite, self.report, self.verdict)
        self.assertEqual(summary['gate'], 'hold')
        self.assertIn('no_meaningful_behavior_gain_vs_new', summary['gate_reasons'])

    def test_clear_failure_rejects_even_with_score_gain(self):
        self.generate()
        self.judgments(fail=True)
        ev.freeze_verdicts(self.suite, self.report, self.review, self.verdict)
        self.assertEqual(ev.summarize(self.suite, self.report, self.verdict)['gate'], 'reject')

    def test_oversized_input_checks_entire_suite_before_generation(self):
        engine = Engine()
        with self.assertRaisesRegex(ValueError, 'common_input_budget_exceeded'):
            ev.generate(engine, Tokenizer(4097), self.root / 'adapter', self.report, suite_path=self.suite)
        self.assertEqual(engine.calls, [])
        self.assertFalse(self.report.exists())

    def test_omitted_review_and_changed_output_cannot_freeze(self):
        self.generate()
        self.judgments()
        partial = ev.read(self.review)
        partial['cases'].pop('stub-0')
        partial_path = self.root / 'partial.json'
        ev.write_private(partial_path, partial)
        with self.assertRaisesRegex(ValueError, 'complete_review_required'):
            ev.freeze_verdicts(self.suite, self.report, partial_path, self.verdict)
        report = ev.read(self.report)
        report['cases'][0]['outputs'][0]['text'] = 'replacement'
        changed_path = self.root / 'changed.json'
        ev.write_private(changed_path, ev.seal({k: v for k, v in report.items() if k != 'report_hash'}, 'report_hash'))
        with self.assertRaisesRegex(ValueError, 'report_output_changed'):
            ev.review_view(self.suite, changed_path)

    def test_frozen_private_files_cannot_be_replaced_or_read_publicly(self):
        with self.assertRaises(FileExistsError):
            ev.write_private(self.raw, {})
        self.raw.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'private_file_permissions_required'):
            ev.read(self.raw)


if __name__ == '__main__':
    unittest.main()
