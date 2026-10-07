import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
from behavior_audit import digest
from primary_duplicate_audit import compare, normalized_context


class TargetFreeDuplicateAuditTests(unittest.TestCase):
    def record(self, bodies):
        return {'context': [{'author_role': 'other', 'body': b} for b in bodies],
                'messages': [{'role': 'user', 'content': b} for b in bodies]}

    def test_input_binding_includes_last_incoming_message(self):
        record = self.record(['fixture first', 'fixture final request'])
        row = compare({'candidate': record}, {'prior': self.record(['different'])})[0]
        self.assertEqual(row['input_hash'], digest(record['messages']))
        self.assertNotEqual(row['input_hash'], digest(record['messages'][:-1]))

    def test_normalized_exact_is_a_text_diagnostic_not_semantic_clearance(self):
        row = compare({'candidate': self.record(['ＦＩＸＴＵＲＥ!'])},
                      {'prior': self.record(['fixture'])})[0]
        self.assertEqual(row['normalized_exact_prior_matches'], ['prior'])
        self.assertIn('pending', row['semantic_duplicate_status'])

    def test_roles_remain_part_of_normalized_context(self):
        first = self.record(['fixture'])
        second = self.record(['fixture'])
        second['context'][0]['author_role'] = 'self'
        self.assertNotEqual(normalized_context(first), normalized_context(second))


if __name__ == '__main__':
    unittest.main()
