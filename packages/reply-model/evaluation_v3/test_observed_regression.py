import unittest
from unittest.mock import Mock
import observed_regression as o


class Tokenizer:
    def apply_chat_template(self,messages,**kwargs):return list(range(messages[0].get('length',3)))


class Engine:
    def __init__(self):self.models={'stale':True};self.calls=[]
    def generate_text(self,messages,*,adapter_path,max_tokens,temperature):
        if not self.calls or self.calls[-1][0] != adapter_path:assert not self.models
        self.models[adapter_path]=True;self.calls.append((adapter_path,max_tokens))
        return 'fake ordinary response'


class ObservedTests(unittest.TestCase):
    def fixture(self):
        ids={k:[k+str(i) for i in range(n)] for k,n in o.COUNTS.items()}
        groups={k:{i:[{'content':i}] for i in v} for k,v in ids.items()}
        entries=[{'id':i,'status':'ready','original_prompt_hash':o.legacy_prompt_hash(groups['real22'][i]),
                  'current_prompt_hash':o.legacy_prompt_hash(groups['real22'][i])} for i in ids['real22']]
        return groups,ids,entries

    def test_unavailable_accounted_but_no_substitute(self):
        groups,ids,entries=self.fixture();entry=entries[-1]
        entry.update(status='unavailable',reason='old_prompt_hash_mismatch')
        del groups['real22'][entry['id']]
        result=o.preflight(groups,ids,entries,Tokenizer())
        self.assertEqual(result['real22']['unavailable_case_count'],1)
        self.assertFalse(result['real22']['fresh_gate_evidence'])
        groups['real22']['replacement']=[{'content':'fake replacement'}]
        with self.assertRaisesRegex(ValueError,'no_silent_missing_or_substituted'):
            o.preflight(groups,ids,entries,Tokenizer())

    def test_missing_availability_entry_and_unexplained_exclusion_rejected(self):
        groups,ids,entries=self.fixture()
        with self.assertRaisesRegex(ValueError,'all22'):o.preflight(groups,ids,entries[:-1],Tokenizer())
        entries[0]['status']='unavailable'
        with self.assertRaisesRegex(ValueError,'explicit_unavailable'):o.preflight(groups,ids,entries,Tokenizer())

    def test_whole_preflight_no_omission_or_truncation(self):
        groups,ids,entries=self.fixture();groups['operational4'][ids['operational4'][-1]][0]['length']=3905
        with self.assertRaisesRegex(ValueError,'no_truncation_or_omission'):
            o.preflight(groups,ids,entries,Tokenizer())

    def test_old_prompt_hash_mismatch_cannot_be_ready(self):
        groups,ids,entries=self.fixture();entries[0]['current_prompt_hash']='changed'
        with self.assertRaisesRegex(ValueError,'exact_old_prompt_hash'):
            o.preflight(groups,ids,entries,Tokenizer())

    def test_output128_preserved_and_one_quality_winner_after_cleanreset(self):
        inputs={'a':[{'content':'same'}],'b':[{'content':'same'}]};engine=Engine();clears=[]
        cache=o.generate_cached(engine,inputs,'/qualitywinner','synthetic24',lambda:clears.append(1))
        self.assertEqual(engine.calls,[(None,128)]*2+[('/qualitywinner',128)]*2)
        self.assertEqual(len(clears),3);self.assertFalse(engine.models)
        for messages in inputs.values():
            for adapter in ('/qualitywinner',None):
                cache.generate_text(messages,adapter_path=adapter,max_tokens=128,temperature=0.)
        self.assertEqual(cache.remaining,0)

    def test_cached_unchanged_helper_cannot_underpublish(self):
        helper=Mock();helper.generate.return_value={'case_count':24,'comparison_complete':True}
        cache=o.Cache(128);cache.put([{'content':'x'}],None,'x')
        with self.assertRaisesRegex(ValueError,'incomplete_observed_synthetic_publication'):
            o.publish_existing_synthetic(helper,cache,Tokenizer(),'/winner','new','old-suite')


if __name__=='__main__':unittest.main()
