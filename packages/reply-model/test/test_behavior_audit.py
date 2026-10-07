import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
from behavior_audit import classify, prior_label, repeat_inventory
from incoming_behavior_owner import operational_prefix_tokens
from worker import compile_prompt, build_generation_input


class BehaviorAuditTests(unittest.TestCase):
    def test_operational_token_array_matches_preserved_qwen_template(self):
        assets = pathlib.Path.home()/'.inboxd/reply-model/models/Qwen3.5-9B-4bit'
        if not assets.exists():
            self.skipTest('Owner-local tokenizer assets unavailable')
        try:
            from transformers import AutoTokenizer
        except ImportError:
            self.skipTest('Tokenizer runtime unavailable')
        tokenizer = AutoTokenizer.from_pretrained(str(assets),local_files_only=True)
        compiled, _ = compile_prompt({'chat':{'platform':'kakao'},'context':[
            {'message_id':'fixture1','author_role':'other','author_id':'fixture_peer','ts':1,'body':'일정 알려주세요.'}]})
        messages = build_generation_input(compiled)
        actual = operational_prefix_tokens(tokenizer,messages)
        templated = tokenizer.apply_chat_template(messages,tokenize=True,add_generation_prompt=True,enable_thinking=False)
        expected = templated['input_ids'] if isinstance(templated,dict) or hasattr(templated,'keys') else templated
        if expected and isinstance(expected[0],list):
            expected = expected[0]
        self.assertEqual(actual,expected)
        self.assertGreater(len(actual),2)
        self.assertTrue(all(type(t) is int for t in actual))
    def test_combined_prior_refusal_is_explicitly_ambiguous(self):
        row = {'targets': [{'body': '그대로 유지합니다'}], 'context': []}
        result = classify(row, {'semantic_decision': {'behavior_category': 'existing_decision_or_refusal'}})
        self.assertIn('prior_combines_existing_decision_and_refusal', result['ambiguity_codes'])
        self.assertFalse(result['new_semantic_judgment'])

    def test_exact_target_repetition_does_not_imply_duplicate_episode(self):
        records = {'a': {'targets': [{'body': '고맙습니다'}], 'messages': [{'content': 'one'}]},
                   'b': {'targets': [{'body': '고맙습니다'}], 'messages': [{'content': 'two'}]}}
        result = repeat_inventory(records)
        self.assertEqual(result['exact_target_text']['pair_count'], 1)
        self.assertEqual(result['exact_compiled_episode']['pair_count'], 0)
        self.assertFalse(result['semantic_paraphrase_repetition']['measured'])

    def test_unmapped_category_stays_unresolved(self):
        self.assertEqual(prior_label('other')[0], 'other_uncertain')

    def test_question_detection_is_labeled_rule_not_semantic(self):
        row = {'targets': [{'body': '그렇군요?'}], 'context': []}
        result = classify(row, {'semantic_decision': {'behavior_category': 'acknowledgement/greeting'}})
        self.assertFalse(result['new_semantic_judgment'])
        self.assertIn('rule_refines_prior_social_category', result['ambiguity_codes'])


if __name__ == '__main__':
    unittest.main()
