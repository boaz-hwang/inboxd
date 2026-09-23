import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('personalization', Path(__file__).resolve().parents[1] / 'personalization.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def example(i):
    return dict(id=str(i), conversation_id=f'room{i}', timestamp=i+1, reviewed=True,
                linkage='explicit_reply', target_role='self', target_message_id=f'target{i}',
                context_message_ids=[f'context{i}'], context_timestamps=[i],
                provenance_refs=[f'ref{i}'], messages=[{'role':'user','content':f'question{i}'},
                                                   {'role':'assistant','content':f'answer{i}'}])


class PersonalizationTests(unittest.TestCase):
    def test_time_split_and_input_immutable(self):
        records = [example(i) for i in range(20)]
        before = copy.deepcopy(records)
        splits, manifest = p.prepare_examples(records)
        self.assertEqual([len(splits[k]) for k in ('train','valid','test')], [14,3,3])
        self.assertLess(max(r['timestamp'] for r in splits['train']), min(r['timestamp'] for r in splits['valid']))
        self.assertEqual(records,before)
        self.assertEqual(p.prepare_examples(records)[1]['dataset_id'],manifest['dataset_id'])

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
        self.assertFalse(ids & {'0','19','1','18'})
        self.assertEqual(len(manifest['rejected']),4)

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


if __name__=='__main__':
    unittest.main()
