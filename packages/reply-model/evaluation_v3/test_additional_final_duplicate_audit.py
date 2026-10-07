"""Fake context data only; no live owner endpoint or real sealed suite."""
from copy import deepcopy
import unittest

import additional_final_duplicate_audit as a
from independent import digest


def record(i,group):
    # Distinct short role/body contexts do not spuriously count boilerplate.
    body=f'fake {group} {i}'
    return {'id':f'{group}{i}','context':[{'author_role':'other','body':body}],
        'targets':[{'author_role':'self','body':'fake target'}],
        'source_message_keys':[f'source:{group}:{i}'],'review_hash':'review',
        'messages':[{'role':'system','content':f'actor {group}'},
                    {'role':'user','content':body},
                    {'role':'user','content':'constant fake instruction'},
                    {'role':'assistant','content':'fake target'}]}


def groups():
    new=[record(i,'new') for i in range(39)]
    real=[record(i,'real') for i in range(48)]
    synthetic=[{'id':f'synth{i}','inputs':{'production_base_v4':record(i,'synth')['messages'][:-1]}}
               for i in range(48)]
    return new,real,synthetic


class AuditTests(unittest.TestCase):
    def test_complete_accounting_and_no_cross_final_extra_pairs(self):
        result=a.compare(*groups())
        self.assertEqual(result['input_only_boundary_pair_count'],3744)
        self.assertEqual(result['full_episode_supplemental_pair_count'],1872)
        self.assertEqual(result['input_only_real_boundary']['flag_count'],0)
        self.assertEqual(result['input_only_synthetic_boundary']['flag_count'],0)
        self.assertNotIn('full_episode_synthetic_boundary',result)

    def test_omissions_and_duplicate_id_fail(self):
        new,real,synthetic=groups()
        with self.assertRaisesRegex(ValueError,'exact39'):a.compare(new[:-1],real,synthetic)
        new[1]['id']=new[0]['id']
        with self.assertRaisesRegex(ValueError,'unique_case'):a.compare(new,real,synthetic)

    def test_full_input_identity_separate_from_context_flag(self):
        new,real,synthetic=groups()
        real[0]['messages']=deepcopy(new[0]['messages'])
        synthetic[0]['inputs']['production_base_v4']=deepcopy(new[0]['messages'][:-1])
        synthetic[0]['inputs']['production_base_v4'][0]['content']='different fake actor'
        result=a.compare(new,real,synthetic)
        self.assertEqual(result['input_only_real_boundary']['full_input_identity_count'],1)
        self.assertEqual(result['input_only_synthetic_boundary']['flag_count'],1)
        self.assertEqual(result['input_only_synthetic_boundary']['full_input_identity_count'],0)

    def test_final_packet_hashes_target_and_source_exact(self):
        r=record(0,'real')
        e={'id':r['id'],'hash':r['review_hash'],
            'raw_content_hash':digest({'context':r['context'],'targets':r['targets']}),
            'input_hash':digest(r['messages'][:-1]),'target_hash':digest(r['messages'][-1:]),
            'source_keys_hash':digest(r['source_message_keys'])}
        packet={'split':'test','snapshot_hash':'snap','case_count':1,'cases':[r]}
        self.assertEqual(a.validate_final_packet(packet,[e],{'snapshot_hash':'snap'}),[r])
        for field in ('raw_content_hash','input_hash','target_hash','source_keys_hash'):
            changed={**e,field:'wrong'}
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'original_final_hash'):
                a.validate_final_packet(packet,[changed],{'snapshot_hash':'snap'})

    def test_explicit_exclusion_and_scope_fail(self):
        r=record(0,'real');r['approvable']=False
        e={'id':r['id'],'hash':r['review_hash']}
        packet={'split':'test','snapshot_hash':'snap','case_count':1,'cases':[r]}
        with self.assertRaisesRegex(ValueError,'original_final_hash'):
            a.validate_final_packet(packet,[e],{'snapshot_hash':'snap'})
        packet['case_count']=2
        with self.assertRaisesRegex(ValueError,'exact_final_packet_scope'):
            a.validate_final_packet(packet,[e],{'snapshot_hash':'snap'})

    def test_persistable_result_contains_no_body(self):
        result=a.compare(*groups())
        import json
        text=json.dumps(result)
        self.assertNotIn('fake target',text)
        self.assertNotIn('constant fake instruction',text)
        self.assertNotIn('actor new',text)


if __name__=='__main__':unittest.main()
