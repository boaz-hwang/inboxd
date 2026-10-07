import contextlib
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import prompt_diagnostic as p
from prompt_instruction_experiment import compile_final_instruction, FINAL_INSTRUCTION
from independent import digest, seal, write_private, read, GENERATION_POLICY


class Tokenizer:
    def apply_chat_template(self,messages,**kwargs):
        assert kwargs == {'add_generation_prompt':True,'enable_thinking':False,'return_dict':False}
        return list(range(messages[0].get('length',10)))


class Engine:
    def __init__(self,fail=False):self.models={'stale':True};self.calls=[];self.fail=fail
    def generate_text(self,messages,*,adapter_path,max_tokens,temperature):
        if len(self.calls)%24==0:assert not self.models
        self.models['loaded']=True;self.calls.append((adapter_path,digest(messages)))
        assert max_tokens==192 and temperature==0
        if self.fail:raise RuntimeError('fake inference failed')
        return 'fake grounded reply'


def original():
    cases=[]
    for i in range(24):
        request={'id':str(i),'context':'fake context '+str(i)}
        rubric={'allowed':['fake'],'forbidden':['unsupported'],'role':'actor','fact':'grounded',
                'consent':'no inferred consent','response':'useful'}
        messages=[{'role':'system','content':'fake system '+str(i)},
                  {'role':'assistant','content':'fake prior self'},
                  {'role':'user','content':'fake incoming'},
                  {'role':'user','content':'fake old final instruction'}]
        cases.append({'id':str(i),'category':'fake','request':request,'rubric':rubric,
            'request_hash':digest(request),'rubric_hash':digest(rubric),
            'inputs':{m:deepcopy(messages) for m in ['production_base_v4']+[f'checkpoint_{n}_v4' for n in range(1,5)]}})
    return {'suite_hash':p.dev.DEV_HASH,'case_count':24,'split':'development_diagnostic',
        'raw_hash':'fake_raw','cases':cases,'compilers':{'production_base_v4':{'source_sha256':'fake_worker'}},
        'policy':{'min_case_usefulness':3,'min_mean_usefulness':4,'min_mean_style':3.5,
            'meaningful_usefulness_gain':.15,'meaningful_style_gain':.25,'min_paired_net_win_fraction':.1},
        'general_rubric':{'fake':'original'},'supplemental_policy':None}


def modules(engine):
    mx=types.ModuleType('mlx.core');mx.clear_cache=lambda:None
    mlx=types.ModuleType('mlx');mlx.core=mx
    utils=types.ModuleType('mlx_lm.utils');utils.load_tokenizer=lambda _:Tokenizer()
    mlxlm=types.ModuleType('mlx_lm');mlxlm.utils=utils
    return {'mlx':mlx,'mlx.core':mx,'mlx_lm':mlxlm,'mlx_lm.utils':utils}


def bundle(folder):
    suite=p.build_suite(original());suite_path=folder/p.SUITE_NAME;write_private(suite_path,suite)
    binding=seal({'suite_hash':suite['suite_hash'],'suite_path':str(suite_path),'output':str(folder),
        'paths':{'worker':'fake'},'artifacts':{'model_path':'fake'},
        'generator_sha256':p.dev.sha(Path(p.__file__).with_name('multi_adapter.py')),
        'generation_policy':GENERATION_POLICY,'method_adapters':dict(zip(p.METHODS,[None,'/152',None,'/152'])),
        'complete_input_preflight':p.preflight(suite,Tokenizer()),
        'resource_budget':{'seconds':900,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3}},'binding_hash')
    write_private(folder/'bindings.json',binding)
    write_private(folder/'attempt.json',seal({'binding_hash':binding['binding_hash']},'attempt_hash'))
    return suite,binding


class PromptDiagnosticTests(unittest.TestCase):
    def test_instruction_preserves_every_other_message_and_final_fields(self):
        x=original()['cases'][0]['inputs']['production_base_v4'];x[-1]['other_field']='preserved'
        saved=deepcopy(x);changed=compile_final_instruction(x)
        self.assertEqual(x,saved);self.assertEqual(changed[:-1],x[:-1])
        self.assertEqual(changed[-1],{**x[-1],'content':FINAL_INSTRUCTION})
        self.assertNotIn('dev-',FINAL_INSTRUCTION)

    def test_suite_preserves_request_rubric_identity_and_pairs(self):
        old=original();suite=p.build_suite(old)
        for a,b in zip(old['cases'],suite['cases']):
            for k in ('request','rubric','request_hash','rubric_hash'):self.assertEqual(a[k],b[k])
            self.assertEqual(b['inputs'][p.METHODS[0]],b['inputs'][p.METHODS[1]])
            self.assertEqual(b['inputs'][p.METHODS[2]],b['inputs'][p.METHODS[3]])
            self.assertEqual(b['inputs'][p.METHODS[0]][:-1],b['inputs'][p.METHODS[3]][:-1])

    def test_final_filename_rejected_before_any_read(self):
        with patch.object(p,'load_suite') as loader:
            with self.assertRaisesRegex(ValueError,'before_read'):p.experiment_suite('final.json')
            loader.assert_not_called()

    def test_last_input_overflow_rejected_without_any_generation(self):
        suite=p.build_suite(original());suite['cases'][-1]['inputs'][p.METHODS[-1]][0]['length']=3905
        with self.assertRaisesRegex(ValueError,'no_truncation'):p.preflight(suite,Tokenizer())

    def test_actual_publication_96_fake_outputs_and_blind_review_summary(self):
        engine=Engine()
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);suite,binding=bundle(folder)
            with patch.object(p,'verify',return_value=suite),patch.object(p,'worker_module',
                    return_value=types.SimpleNamespace(ReplyWorker=lambda:engine)),patch.dict(sys.modules,modules(engine)):
                p.child(folder/'bindings.json',binding['binding_hash'])
            self.assertEqual(len(engine.calls),96);self.assertFalse(engine.models)
            self.assertEqual([x[0] for x in engine.calls],[None]*24+['/152']*24+[None]*24+['/152']*24)
            write_private(folder/'resources.json',{'status':'complete'})
            report=read(folder/'report.json')
            write_private(folder/'completion.json',seal({'status':'diagnostic_complete_daemon_restored',
                'binding_hash':binding['binding_hash'],'report_hash':report['report_hash'],
                'resource_report_sha256':p.dev.sha(folder/'resources.json')},'completion_hash'))
            packets=folder/'review';r=p.prepare_packets(folder/'bindings.json',packets)
            self.assertFalse(r['mapping_read'])
            for name in ('root','dataset'):
                j=read(packets/(name+'-judgments-template.json'))
                for c in j['cases'].values():
                    for q in c['options'].values():q.update(role='pass',fact='pass',consent='pass',response='pass',usefulness=4,style=4,reason='fake grounded response')
                    c['preference']=[list(c['options'])]
                write_private(packets/(name+'-judgments.json'),j)
            verdicts=folder/'verdicts.json'
            p.merge_reviews(folder/'bindings.json',packets,packets/'root-judgments.json',packets/'dataset-judgments.json',verdicts)
            z=p.freeze_summary(folder/'bindings.json',verdicts,folder/'summary.json')
            self.assertTrue(all(q['thresholds_met'] for q in z['diagnostics'].values()))
            self.assertFalse(z['activation_authorized'])
            with self.assertRaisesRegex(ValueError,'no_retry'):p.output_preflight(binding)

    def test_inference_failure_cleans_engine(self):
        engine=Engine(fail=True)
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);suite,binding=bundle(folder)
            with patch.object(p,'verify',return_value=suite),patch.object(p,'worker_module',
                    return_value=types.SimpleNamespace(ReplyWorker=lambda:engine)),patch.dict(sys.modules,modules(engine)):
                with self.assertRaisesRegex(RuntimeError,'fake inference'):p.child(folder/'bindings.json',binding['binding_hash'])
            self.assertFalse(engine.models);self.assertFalse((folder/'outputs-complete.json').exists())

    def test_partial_report_cannot_become_review_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);suite,binding=bundle(folder)
            write_private(folder/'completion.json',seal({'status':'diagnostic_complete_daemon_restored',
                'binding_hash':binding['binding_hash']},'completion_hash'))
            write_private(folder/'outputs-complete.json',seal({'output_count':95},'outputs_hash'))
            write_private(folder/'report.json',seal({'suite_hash':suite['suite_hash'],'case_count':24,
                'cases':[]},'report_hash'))
            with self.assertRaisesRegex(ValueError,'case_set'):p.completed_run(binding)

    def test_guard_failure_restores_daemon_and_keeps_failed_attempt(self):
        events=[]
        @contextlib.contextmanager
        def pause(args):
            events.append('pause')
            try:yield
            finally:events.append('restore')
        def fail(*a,**kw):
            self.assertEqual(kw['max_runtime_seconds'],900);self.assertEqual(kw['max_rss_bytes'],12*1024**3)
            self.assertEqual(kw['max_swap_bytes'],1024**3);raise RuntimeError('fake bounded failure')
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp).resolve();binding={'output':str(folder),'binding_hash':'fake',
                'resource_budget':{'seconds':900,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3}}
            write_private(folder/'bindings.json',binding)
            args=types.SimpleNamespace(bindings=folder/'bindings.json',expected_binding_hash='fake',pause_daemon=True)
            with patch.object(p,'verify'),patch.dict(sys.modules,{
                    'bounded_pilot':types.SimpleNamespace(daemon_pause=pause),
                    'personalization':types.SimpleNamespace(guarded_training_run=fail)}):
                with self.assertRaisesRegex(RuntimeError,'fake bounded'):p.run(args)
            self.assertEqual(events,['pause','restore'])
            self.assertEqual(read(folder/'failure.json')['status'],'hold_no_retry_no_activation')
            with self.assertRaisesRegex(ValueError,'no_retry'):p.output_preflight(binding)

    def test_tampered_prefix_or_nonfixed_adapter_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);suite,binding=bundle(folder)
            suite['cases'][0]['inputs'][p.METHODS[3]][1]['content']='changed prior self'
            suite['cases'][0]['input_hashes'][p.METHODS[3]]=digest(suite['cases'][0]['inputs'][p.METHODS[3]])
            suite=seal({k:v for k,v in suite.items() if k!='suite_hash'},'suite_hash')
            changed=folder/'other'/p.SUITE_NAME;write_private(changed,suite)
            with self.assertRaisesRegex(ValueError,'instruction_only_pair'):p.experiment_suite(changed)

    def test_bad_freeze_before_mapping_read(self):
        import independent
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);suite,binding=bundle(folder);verdicts=folder/'incomplete.json'
            write_private(verdicts,{'verdict_hash':'invalid'})
            with patch.object(p,'completed_run'),patch.object(independent,'review_view',return_value=(suite,{'report_hash':'fake'},[])),patch.object(independent.Path,'read_bytes',side_effect=AssertionError('mapping accessed')):
                with self.assertRaisesRegex(ValueError,'frozen_payload'):p.freeze_summary(folder/'bindings.json',verdicts,folder/'summary.json')


if __name__=='__main__':unittest.main()
