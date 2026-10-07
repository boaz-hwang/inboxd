import unittest
from unittest.mock import patch
import checkpoint_dev as d
from independent import digest

class Tokenizer:
    def apply_chat_template(self,messages,**kwargs):return list(range(messages[0].get('length',3)))

class Engine:
    def __init__(self):self.models={'stale':'bad'};self.calls=[]
    def generate_text(self,messages,*,adapter_path,max_tokens,temperature):
        if not self.calls or self.calls[-1][0]!=adapter_path:
            assert not self.models,'stale model retained across method'
        self.models[adapter_path]='loaded';self.calls.append((adapter_path,messages[0]['content']))
        return str(adapter_path)+':'+messages[0]['content']

class ControllerTests(unittest.TestCase):
    def suite(self):
        return {'generation_policy':{'max_input_tokens':3904,'max_tokens':192},'cases':[
            {'inputs':{m:[{'content':c}] for m in ['base','a','b']}} for c in ['one','two']]}
    def test_clean_reset_and_method_major_generation(self):
        engine=Engine();clears=[];suite=self.suite();adapters={'base':None,'a':'/a','b':'/b'}
        outputs=d.generate_method_major(engine,Tokenizer(),suite,adapters,lambda:clears.append(True))
        self.assertEqual([c[0] for c in engine.calls],[None,None,'/a','/a','/b','/b'])
        self.assertEqual(len(clears),4);self.assertFalse(engine.models)
        cache=d.FrozenOutputCache(outputs)
        for case in suite['cases']:
            for method in reversed(list(adapters)):
                text=cache.generate_text(case['inputs'][method],adapter_path=adapters[method],max_tokens=192,temperature=0.)
                self.assertIn(case['inputs'][method][0]['content'],text)
        self.assertEqual(len(cache.used),6)
    def test_all_inputs_prechecked_before_first_model_call(self):
        engine=Engine();suite=self.suite();suite['cases'][-1]['inputs']['b'][0]['length']=4000
        with self.assertRaisesRegex(ValueError,'input_budget'):
            d.generate_method_major(engine,Tokenizer(),suite,{'base':None,'a':'/a','b':'/b'},lambda:None)
        self.assertFalse(engine.calls)
    def test_final_filename_rejected_before_suite_read(self):
        with patch.object(d,'load_suite') as read:
            with self.assertRaisesRegex(ValueError,'before_read'):d.dev_suite('final-compiled-v4-frozen.json')
            read.assert_not_called()
    def test_training_must_have_finished(self):
        with patch.object(d,'check_seal'):
            with self.assertRaisesRegex(ValueError,'completed_training'):d.validate_artifact_metadata({'training_complete':False},[])
    def test_cache_refuses_duplicate_publish(self):
        messages=[{'content':'x'}];cache=d.FrozenOutputCache({(digest(messages),None):'text'})
        cache.generate_text(messages,adapter_path=None,max_tokens=192,temperature=0.)
        with self.assertRaisesRegex(ValueError,'duplicate_call'):cache.generate_text(messages,adapter_path=None,max_tokens=192,temperature=0.)

if __name__=='__main__':unittest.main()

class LifecycleContractTests(unittest.TestCase):
    def test_guard_failure_still_exits_daemon_pause_context(self):
        import contextlib,sys,tempfile,types
        from pathlib import Path
        events=[]
        @contextlib.contextmanager
        def pause(args):
            events.append('pause')
            try:yield
            finally:events.append('restore')
        fake_lifecycle=types.SimpleNamespace(daemon_pause=pause)
        def guarded(*args,**kwargs):
            events.append('guard');raise RuntimeError('synthetic child failure')
        fake_resources=types.SimpleNamespace(guarded_training_run=guarded)
        with tempfile.TemporaryDirectory() as tmp:
            args=types.SimpleNamespace(suite=Path('dev'),bindings=Path(tmp)/'bindings.json',report=Path(tmp)/'report.json',expected_binding_hash='b',pause_daemon=True)
            binding={'suite_hash':'s','binding_hash':'b','resource_budget':{'seconds':900,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3}}
            with patch.object(d,'dev_suite',return_value={'suite_hash':'s'}),patch.object(d,'read',return_value=binding),patch.object(d,'verify_binding'),patch.object(d,'verify_suite_binding'),patch.dict(sys.modules,{'bounded_pilot':fake_lifecycle,'personalization':fake_resources}):
                with self.assertRaisesRegex(RuntimeError,'synthetic'):d.run(args)
            self.assertEqual(events,['pause','guard','restore'])
    def test_existing_report_rejected_before_generation(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            report=Path(tmp)/'report.json';report.write_text('{}')
            with self.assertRaisesRegex(ValueError,'no_overwrite'):d.preflight_report(report,Path(tmp)/'bindings.json')
