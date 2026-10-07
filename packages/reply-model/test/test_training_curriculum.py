import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import training_curriculum as curriculum
import expanded_training
import history
from personalization import prepare_examples, digest


class TemplateTokenizer:
    def apply_chat_template(self, messages, *, add_generation_prompt=False, **kwargs):
        text = ''.join('<' + m['role'] + '>' + m['content'] for m in messages)
        if add_generation_prompt:
            text += '<assistant>'
        return list(text)


class CurriculumTests(unittest.TestCase):
    def test_authored_binding_is_exact_stable_and_not_real_review(self):
        tokenizer = TemplateTokenizer()
        original = curriculum.build_records(tokenizer, seq_length=10000)
        repeated = curriculum.build_records(tokenizer, seq_length=10000)
        self.assertEqual(original, repeated)
        for record in original:
            self.assertEqual(record['review_hash'], 'authored-synthetic:' + digest(
                {k: v for k, v in record.items() if k != 'review_hash'}))
            self.assertEqual(record['review_binding_kind'], 'authored_synthetic_supervision')
            self.assertEqual(record['source'], 'synthetic')
            self.assertEqual(record['review_provenance'], 'authored_synthetic_supervision')
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / 'authored.json'
            bundle = json.loads(curriculum.DEFAULT_FIXTURE.read_text())
            bundle['cases'][0]['target'] += ' 감사합니다.'
            fixture.write_text(json.dumps(bundle, ensure_ascii=False))
            changed = curriculum.build_records(tokenizer, seq_length=10000, fixture=fixture)
        self.assertNotEqual(original[0]['messages'], changed[0]['messages'])
        self.assertTrue(all(a['review_hash'] != b['review_hash']
                            for a, b in zip(original, changed)))

    def test_existing_authored_train_and_valid_enter_exact_training_manifest(self):
        tokenizer = TemplateTokenizer()
        records = curriculum.build_records(tokenizer, seq_length=10000)
        records += curriculum.build_validation_records(tokenizer, seq_length=10000)
        assignments = {r['id']: ('train' if r['training_only'] else 'valid') for r in records}
        manifest = {'version': 1,
            'records': [{'id': r['id'], 'split': assignments[r['id']],
                         'example_hash': digest(r), 'review_hash': r['review_hash']} for r in records],
            'assignments': assignments,
            'reservations': {'assignments': {}, 'source_keys': {}, 'intervals': {}, 'heldout_chats': []},
            'source': {'kind': 'authored_synthetic', 'real_reviews_claimed': 0,
                       'sensitive_source_quarantine': {
                           'source_keys': [], 'values_retained': False,
                           'quarantine_hash': history.digest({'source_keys': [], 'values_retained': False})}}}
        manifest['manifest_id'] = digest(manifest)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            model = root / 'model'; model.mkdir()
            (model / 'config.json').write_text('{}')
            (model / 'model.safetensors').write_bytes(b'test_weights')
            options = dict(model=model, output=root / 'output', epochs=2,
                           max_runtime_seconds=123, train_max_tokens=10000,
                           evaluation_max_tokens=10000)
            prepared = expanded_training.prepare(records, manifest, tokenizer, **options)
            self.assertEqual({k: v['count'] for k, v in prepared.plan['lengths'].items()},
                             {'train': 32, 'valid': 8})
            self.assertEqual(prepared.plan['final_test_records_supplied'], 0)
            self.assertEqual(prepared.plan['exclusions'], [])
            changed = [{**r} for r in records]
            changed[0]['review_hash'] = 'authored-synthetic:changed'
            with self.assertRaisesRegex(ValueError, 'reviewed_example_changed'):
                expanded_training.prepare(changed, manifest, tokenizer, **options)

    def test_fixture_paths_prefer_installed_module_sibling_and_fallback_to_source(self):
        with tempfile.TemporaryDirectory() as directory:
            module = Path(directory)/'training_curriculum.py'
            with patch.object(curriculum, '__file__', str(module)):
                for name in ('reply_safety_curriculum.json','reply_safety_validation.json'):
                    self.assertEqual(curriculum._fixture_path(name), Path(directory)/'fixtures'/name)
                    sibling = Path(directory)/name
                    sibling.write_text('{}')
                    self.assertEqual(curriculum._fixture_path(name), sibling)

    def test_independent_validation_only_records_preserve_splits_and_reject_train_merge(self):
        tokenizer = TemplateTokenizer()
        train = curriculum.build_records(tokenizer, seq_length=10000)
        valid = curriculum.build_validation_records(tokenizer, seq_length=10000)
        self.assertEqual(len(valid), 8)
        self.assertEqual({p:sum(r['purpose']==p for r in valid) for p in
            ('refusal','approval','actor_owner','unexpressed_decision')},
            {'refusal':2,'approval':2,'actor_owner':2,'unexpressed_decision':2})
        self.assertFalse({r['id'] for r in train} & {r['id'] for r in valid})
        self.assertFalse({k for r in train for k in r['source_message_keys']} &
                         {k for r in valid for k in r['source_message_keys']})
        real = [{'id':'real-test'}]
        records, assignments = curriculum.merge_training_records(real, {'real-test':'test'}, train)
        records, assignments = curriculum.merge_validation_records(records, assignments, valid)
        self.assertEqual(assignments['real-test'],'test')
        self.assertTrue(all(assignments[r['id']]=='valid' and r['validation_only'] and
                            not r['training_only'] for r in valid))
        splits, manifest = prepare_examples(train + valid,
            assignments={r['id']:('train' if r['training_only'] else 'valid') for r in train + valid})
        self.assertEqual([len(splits[k]) for k in ('train','valid','test')],[32,8,0])
        self.assertEqual(manifest['rejected'],[])
        with self.assertRaisesRegex(ValueError,'invalid_synthetic_training_record'):
            curriculum.merge_training_records(real, {'real-test':'test'}, valid)
        with self.assertRaisesRegex(ValueError,'invalid_synthetic_validation_record'):
            curriculum.merge_validation_records(real, {'real-test':'test'}, train)

    def test_balanced_train_only_records_use_exact_operating_input(self):
        records = curriculum.build_records(TemplateTokenizer(), seq_length=10000)
        self.assertEqual(len(records), 32)
        counts = {purpose: sum(r['purpose'] == purpose for r in records)
                  for purpose in ('refusal', 'approval', 'unknown_information', 'actor_owner', 'group_roles')}
        self.assertEqual(counts, {'refusal':8, 'approval':8, 'unknown_information':4, 'actor_owner':8, 'group_roles':4})
        for record in records:
            compiled, _ = curriculum.compile_prompt({'context':record['context'], 'chat':record['chat'],
                                                     'incoming_message_ids':None})
            self.assertEqual(record['messages'][:-1], curriculum.build_generation_input(compiled))
            self.assertTrue(all(t < record['timestamp'] for t in record['context_timestamps']))
            self.assertNotIn(record['target_message_id'], record['context_message_ids'])
            self.assertEqual(record['source'], 'synthetic')
            self.assertEqual(record['review_provenance'], 'authored_synthetic_supervision')
            self.assertTrue(record['training_only'])
        assignments = {r['id']:'train' for r in records}
        splits, manifest = prepare_examples(records, assignments=assignments)
        self.assertEqual(len(splits['train']), 32)
        self.assertEqual(splits['valid'], [])
        self.assertEqual(splits['test'], [])
        self.assertEqual(manifest['rejected'], [])

    def test_merge_preserves_every_real_partition_and_does_not_mutate_inputs(self):
        synthetic = curriculum.build_records(TemplateTokenizer(), seq_length=10000)
        real = [{'id':'real-train'}, {'id':'real-valid'}, {'id':'real-test'}]
        assignments = {'real-train':'train', 'real-valid':'valid', 'real-test':'test'}
        records, merged = curriculum.merge_training_records(real, assignments, synthetic)
        self.assertEqual({k:merged[k] for k in assignments}, assignments)
        self.assertEqual(len(real), 3)
        self.assertEqual(len(assignments), 3)
        self.assertTrue(all(merged[r['id']] == 'train' for r in synthetic))
        records[-1]['messages'][-1]['content'] = 'changed'
        self.assertNotEqual(records[-1]['messages'], synthetic[-1]['messages'])
        with self.assertRaisesRegex(ValueError, 'explicit_real_assignments_required'):
            curriculum.merge_training_records(real, {}, synthetic)

    def test_budget_and_template_mismatch_fail_without_silent_truncation(self):
        with self.assertRaisesRegex(ValueError, 'curriculum_over_token_budget'):
            curriculum.build_records(TemplateTokenizer(), seq_length=10)
        class MismatchTokenizer(TemplateTokenizer):
            def apply_chat_template(self, messages, **kwargs):
                values = super().apply_chat_template(messages, **kwargs)
                return [999] + values if kwargs.get('add_generation_prompt') else values
        with self.assertRaisesRegex(ValueError, 'training_prefix_or_target_mismatch'):
            curriculum.build_records(MismatchTokenizer(), seq_length=10000)

    def test_bad_role_or_provenance_is_rejected(self):
        original = json.loads(curriculum.DEFAULT_FIXTURE.read_text())
        for mutation, error in [('role','invalid_curriculum_role'), ('provenance','invalid_curriculum_provenance')]:
            bundle = json.loads(json.dumps(original))
            if mutation == 'role':
                bundle['cases'][0]['turns'][0]['role'] = 'other'
            else:
                bundle['cases'][0]['source'] = 'history'
            with tempfile.TemporaryDirectory() as directory:
                fixture = Path(directory)/'fixture.json'
                fixture.write_text(json.dumps(bundle))
                with self.assertRaisesRegex(ValueError, error):
                    curriculum.build_records(TemplateTokenizer(), seq_length=10000, fixture=fixture)
