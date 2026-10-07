import unittest
import input_duplicate_audit as a


class InputAuditTests(unittest.TestCase):
    def messages(self, metadata, body='ordinary conversation'):
        return [{'role':'system','content':metadata},
                {'role':'user','content':body},
                {'role':'user','content':'reply instruction'}]

    def test_shared_boilerplate_not_a_context_duplicate(self):
        x=a.feature('x',self.messages('shared system','different first conversation'),'reply instruction')
        y=a.feature('y',self.messages('shared system','distinct second conversation'),'reply instruction')
        result=a.compare_groups({'train':[x],'final':[y]})
        self.assertEqual(result['flag_count'],0)
        self.assertEqual(result['pair_count'],1)

    def test_same_body_distinct_actor_metadata_is_diagnostic(self):
        x=a.feature('x',self.messages('actor A'),'reply instruction')
        y=a.feature('y',self.messages('actor B'),'reply instruction')
        result=a.compare_groups({'train':[x],'final':[y]})
        flag=result['comparisons'][0]['flags'][0]
        self.assertTrue(flag['normalized_context_exact'])
        self.assertFalse(flag['full_input_identity'])
        self.assertFalse(flag['system_actor_reply_metadata_identity'])
        self.assertIn('requires_independent_review',flag['reason'])
        self.assertNotIn('text',flag)

    def test_gold_target_and_wrong_instruction_boundaries_rejected(self):
        messages=self.messages('metadata')
        messages.append({'role':'assistant','content':'unrelated gold target'})
        with self.assertRaisesRegex(ValueError,'instruction_boundary'):
            a.feature('x',messages,'reply instruction')

    def test_shared_long_message_and_full_input_identity_are_explicit(self):
        messages=self.messages('same', 'long ordinary message ' * 8)
        x=a.feature('x',messages,'reply instruction')
        y=a.feature('y',messages,'reply instruction')
        result=a.compare_groups({'valid':[x],'final':[y]})
        flag=result['comparisons'][0]['flags'][0]
        self.assertEqual(result['full_input_identity_count'],1)
        self.assertTrue(flag['shared_long_message_hashes'])


if __name__=='__main__':unittest.main()
