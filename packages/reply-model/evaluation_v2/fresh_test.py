"""CPU-only metadata and blind-review integrity tests; never loads a model."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fresh_evaluate as fresh


class FakeTokenizer:
    def apply_chat_template(self, messages, **kwargs):
        return list(range(200))

    def encode(self, text):
        return list(text)


class FakeEngine:
    def generate_text(self, messages, **kwargs):
        return 'CPU harness placeholder; never a semantic model result.'


class FreshSuiteTests(unittest.TestCase):
    def test_production_metadata_and_roles_preserved(self):
        suite = fresh.load_suite()
        for row in suite['cases']:
            turns = row['request']['context']
            messages = row['messages']
            metadata = json.loads(messages[0]['content'].split('사전 검증 결과 및 아래 발언 순서별 메타데이터: ', 1)[1])
            self.assertEqual(len(messages), len(turns)+2)
            self.assertTrue(messages[0]['content'].startswith(fresh.worker.SYSTEM))
            self.assertEqual(len(metadata['turn_metadata']), len(turns))
            aliases = {turn['message_id']: index for index, turn in enumerate(turns)}
            for index, turn in enumerate(turns):
                values = dict(zip(metadata['turn_fields'], metadata['turn_metadata'][index]))
                self.assertEqual(values['author_id'], turn['author_id'])
                self.assertEqual(values['author_role'], turn['author_role'])
                self.assertEqual(values['reply_to'], aliases.get(turn['reply_to']))
                self.assertEqual(messages[index+1]['content'], turn['body'])
                self.assertEqual(messages[index+1]['role'], 'assistant' if turn['author_role']=='self' else 'user')
            self.assertEqual(metadata['preflight']['reply_target_id'], len(turns)-1)
            self.assertEqual(metadata['preflight']['status'], 'ready')

    def test_suite_covers_structural_variation_without_real_data(self):
        suite = fresh.load_suite()
        self.assertEqual(len(suite['cases']), 24)
        self.assertFalse(suite['provenance']['real_conversation_bodies'])
        self.assertFalse(suite['provenance']['supplemental_training_examples_inspected'])
        requests = [c['request'] for c in suite['cases']]
        self.assertEqual({r['chat']['kind'] for r in requests}, {'group','dm'})
        self.assertEqual({r['chat']['platform'] for r in requests}, {'kakao','telegram','slack'})
        self.assertTrue(any('incoming_message_ids' not in r for r in requests))
        self.assertTrue(any(r.get('incoming_message_ids')==[] for r in requests))
        self.assertTrue(any(t['reply_to'] for r in requests for t in r['context']))

    def test_frozen_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'suite.json'
            suite = fresh.load_suite()
            suite['cases'][0]['messages'][1]['content'] = 'changed'
            target.write_text(json.dumps(suite))
            with self.assertRaisesRegex(ValueError, 'frozen_suite_tampered'):
                fresh.load_suite(target)

    def test_fake_blind_review_cannot_unblind_before_freeze(self):
        with tempfile.TemporaryDirectory() as directory:
            report_path = Path(directory)/'fake.json'
            fresh.generate(FakeEngine(), FakeTokenizer(), '/fake-adapter', report_path)
            report, views = fresh.report_view(report_path)
            self.assertEqual(len(views), 24)
            self.assertNotIn('method', views['fresh-01']['outputs'][0])
            with self.assertRaises(FileNotFoundError):
                fresh.summarize(report_path)
            for view in views.values():
                judgment = {'options': {o['label']: {'role':'pass','fact':'pass',
                    'abstain':'pass','usefulness':4,'style':4} for o in view['outputs']},
                    'preference': 'tie'}
                fresh.quality_review.save_verdict(report_path, view, judgment,
                    reviewer='agent_delegated', authorization='CPU harness only; not actual review')
            seal = fresh.freeze_verdicts(report_path)
            self.assertEqual(seal['reviewer'], 'agent_delegated')
            result = fresh.summarize(report_path)
            self.assertEqual(result['fresh_gate'], 'pass')
            self.assertFalse(result['human_review_complete'])
            self.assertFalse(result['activation_authorized'])
            with self.assertRaisesRegex(ValueError, 'verdicts_already_frozen'):
                fresh.freeze_verdicts(report_path)


if __name__ == '__main__':
    unittest.main()
