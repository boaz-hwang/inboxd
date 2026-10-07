import contextlib
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import final_controller as f
from independent import digest, seal, write_private, read, GENERATION_POLICY


class Tokenizer:
    def apply_chat_template(self,messages,**kwargs):
        return list(range(messages[0].get('length',3)))


class Engine:
    def __init__(self,fail=False):self.models={'stale':True};self.calls=[];self.fail=fail
    def generate_text(self,messages,*,adapter_path,max_tokens,temperature):
        if not self.calls or self.calls[-1][0] != adapter_path:
            assert not self.models
        self.models[adapter_path]=True
        self.calls.append((adapter_path,messages[0]['content']))
        if self.fail:raise RuntimeError('fake inference failure')
        assert max_tokens==192 and temperature==0
        return 'ordinary grounded response'


def fake_suite():
    return {'case_count':48,'cases':[{'id':str(i),'inputs':{m:[{'content':str(i)}] for m in f.METHODS}}
           for i in range(48)]}


class FinalControllerTests(unittest.TestCase):
    def test_fake_child_publishes_both_complete_reports_and_removes_staging(self):
        import sys
        engine=Engine();stage_locations=[]
        @contextlib.contextmanager
        def staging(prefix):
            with tempfile.TemporaryDirectory(prefix=prefix) as stage:
                stage_locations.append(Path(stage));yield Path(stage),None
        suite=fake_suite()
        for c in suite['cases']:
            c.update(request={'id':c['id']},rubric={'allowed':['fake reply']})
            c.update(request_hash=digest(c['request']),rubric_hash=digest(c['rubric']),
                     input_hashes={m:digest(v) for m,v in c['inputs'].items()})
        suite.update(compilers={m:{} for m in f.METHODS},candidate='adapter_v4',
            generation_policy=GENERATION_POLICY,split='fake_final_only',
            evaluation_helper_sha256=f.dev.sha(Path(f.__file__).with_name('independent.py')))
        suite=seal(suite,'suite_hash');suites={'synthetic':suite,'real':suite}
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            binding={'output':str(folder),'suite_hashes':{k:v['suite_hash'] for k,v in suites.items()},
                'complete_input_preflight':f.preflight_inputs(suites,Tokenizer()),
                'paths':{'worker':'fake-worker'},'artifacts':{'model_path':'fake-model'},
                'method_adapters':dict(zip(f.METHODS,[None,'/qualitywinner','/prior'])),
                'selected_identity_hash':'identity','candidate_weight_sha256':'qualitysha','prior_weight_sha256':'prior'}
            write_private(folder/'bindings.json',binding)
            write_private(folder/'attempt.json',seal({'run_hash':'run'},'attempt_hash'))
            mx=types.ModuleType('mlx.core');mx.clear_cache=lambda:None
            mlx=types.ModuleType('mlx');mlx.core=mx
            utils=types.ModuleType('mlx_lm.utils');utils.load_tokenizer=lambda path:Tokenizer()
            mlxlm=types.ModuleType('mlx_lm');mlxlm.utils=utils
            with patch.object(f,'verify'),patch.object(f,'assemble_suites',return_value=suites),\
                patch.object(f,'worker_module',return_value=types.SimpleNamespace(ReplyWorker=lambda:engine)),\
                patch.dict(sys.modules,{'mlx':mlx,'mlx.core':mx,'mlx_lm':mlxlm,'mlx_lm.utils':utils,
                    'personalization':types.SimpleNamespace(private_staging=staging)}):
                result=f.child(folder/'bindings.json','run')
            self.assertEqual(result['status'],'outputs_complete_pending_daemon_restore')
            self.assertEqual(len(engine.calls),288)
            self.assertFalse(engine.models)
            self.assertTrue(all(not stage.exists() for stage in stage_locations))
            for kind in suites:
                report=read(folder/(kind+'-report.json'))
                self.assertEqual(report['case_count'],48)
                self.assertEqual(len(report['cases']),48)
                self.assertTrue(all(len(c['outputs'])==3 for c in report['cases']))
            with self.assertRaisesRegex(ValueError,'no_retry'):
                f.output_preflight(binding)

    def test_partial_report_is_not_complete_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'real-report.json'
            report=seal({'suite_hash':'suite','case_count':48,'cases':[{'id':str(i)} for i in range(47)],
                'generation_artifacts':{'binding_hash':'binding'},'mapping_file_sha256':'missing'},'report_hash')
            write_private(path,report)
            with self.assertRaisesRegex(ValueError,'partial_or_changed_final_report'):
                f.verify_report(path,{'suite_hash':'suite','cases':[{'id':str(i)} for i in range(48)]},'binding')

    def test_complete96_preflight_before_generation(self):
        suites={'synthetic':fake_suite(),'real':fake_suite()}
        suites['real']['cases'][-1]['inputs']={m:[{'content':'last','length':3905}] for m in f.METHODS}
        with self.assertRaisesRegex(ValueError,'budget_exceeded_no_truncation'):
            f.preflight_inputs(suites,Tokenizer())

    def test_each_method48_then_release_and_one_candidate(self):
        suite=fake_suite();adapters=dict(zip(f.METHODS,[None,'/qualitywinner','/prior']))
        engine=Engine();clears=[]
        f.preflight_inputs({'s':suite},Tokenizer())
        cache=f.generate_suite(engine,suite,adapters,lambda:clears.append(True))
        self.assertEqual([c[0] for c in engine.calls],[None]*48+['/qualitywinner']*48+['/prior']*48)
        self.assertEqual(len(clears),4);self.assertFalse(engine.models)
        for case in suite['cases']:
            for m in reversed(f.METHODS):
                cache.generate_text(case['inputs'][m],adapter_path=adapters[m],max_tokens=192,temperature=0.)
        self.assertEqual(cache.remaining,0)
        with self.assertRaisesRegex(ValueError,'cache_boundary'):
            cache.generate_text(suite['cases'][0]['inputs'][f.METHODS[0]],adapter_path=None,max_tokens=192,temperature=0.)

    def test_duplicate_inputs_still_generate_and_publish_every_case(self):
        suite=fake_suite()
        for c in suite['cases']:c['inputs']={m:[{'content':'same'}] for m in f.METHODS}
        engine=Engine();adapters=dict(zip(f.METHODS,[None,'/winner','/prior']))
        cache=f.generate_suite(engine,suite,adapters,lambda:None)
        self.assertEqual(len(engine.calls),144)
        for c in suite['cases']:
            for m in f.METHODS:cache.generate_text(c['inputs'][m],adapter_path=adapters[m],max_tokens=192,temperature=0.)
        self.assertEqual(cache.remaining,0)

    def test_failure_clears_model_and_cache(self):
        engine=Engine(fail=True);clears=[]
        with self.assertRaisesRegex(RuntimeError,'fake inference'):
            f.generate_suite(engine,fake_suite(),dict(zip(f.METHODS,[None,'/winner','/prior'])),lambda:clears.append(1))
        self.assertFalse(engine.models);self.assertEqual(len(clears),2)

    def test_same_representation_required(self):
        suite=fake_suite();suite['cases'][0]['inputs']['adapter_v4']=[{'content':'changed'}]
        with self.assertRaisesRegex(ValueError,'same_v4_representation'):
            f.preflight_inputs({'s':suite},Tokenizer())

    def test_final_filename_guard_precedes_read(self):
        with patch.object(f,'load_suite') as loader:
            with self.assertRaisesRegex(ValueError,'before_read'):f.final_suite('dev.json')
            loader.assert_not_called()

    def test_partial_attempt_and_existing_mapping_rejected(self):
        for name in ('attempt.json','real-report-unblind.json','synthetic-report.json','failure.json'):
            with tempfile.TemporaryDirectory() as tmp:
                (Path(tmp)/name).write_text('{}')
                with self.assertRaisesRegex(ValueError,'no_retry_no_overwrite'):
                    f.output_preflight({'output':tmp})

    def real_metadata(self):
        inputs={str(i):[{'role':'user','content':'fake context '+str(i)}] for i in range(48)}
        entries=[{'id':i,'hash':'review-'+i,'quality_hash':'quality-'+i,'source_keys_hash':'sources',
                  'raw_content_hash':'raw','input_hash':digest(m),'target_hash':'target'} for i,m in inputs.items()]
        qualities=[{'id':e['id'],'quality_hash':e['quality_hash'],'review_hash':e['hash'],
                    'source_hashes':{k:e[k] for k in ('source_keys_hash','raw_content_hash','input_hash','target_hash')},
                    'rubric':{'allowed':['future check'],'forbidden':['completed action']}} for e in entries]
        admission=seal({'entries':entries,'case_quality_records':qualities},'admission_hash')
        protocol=seal({'real_gate':'frozen'},'protocol_hash')
        return admission,inputs,protocol

    def test_real_rubrics_join_exactly_and_gold_never_added(self):
        a,inputs,p=self.real_metadata()
        with patch.object(f,'ADMISSION_HASH',a['admission_hash']),patch.object(f,'REAL_PROTOCOL_HASH',p['protocol_hash']):
            suite=f.real_suite(a,inputs,p,{'source_sha256':'fake'})
        self.assertEqual(suite['cases'][0]['rubric'],a['case_quality_records'][0]['rubric'])
        self.assertEqual(suite['cases'][0]['inputs']['adapter_v4'],inputs['0'])
        self.assertTrue(suite['policy']['generic_synthetic_gate_for_this_suite_forbidden'])
        a['case_quality_records'][0]['quality_hash']='wrong';a=seal({k:v for k,v in a.items() if k!='admission_hash'},'admission_hash')
        with patch.object(f,'ADMISSION_HASH',a['admission_hash']),patch.object(f,'REAL_PROTOCOL_HASH',p['protocol_hash']):
            with self.assertRaisesRegex(ValueError,'quality_join'):f.real_suite(a,inputs,p,{})

    def test_guard_failure_restores_daemon_and_marks_hold(self):
        import sys
        events=[]
        @contextlib.contextmanager
        def pause(args):
            events.append('pause')
            try:yield
            finally:events.append('restore')
        def fail(*a,**k):raise RuntimeError('fake bounded child failure')
        with tempfile.TemporaryDirectory() as tmp:
            args=types.SimpleNamespace(bindings=Path(tmp)/'bindings.json',expected_run_hash='run',pause_daemon=True)
            binding={'output':str(Path(tmp).resolve()),'resource_budget':{'seconds':1800,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3}}
            with patch.object(f,'read',return_value=binding),patch.object(f,'verify'),patch.dict(sys.modules,
                {'bounded_pilot':types.SimpleNamespace(daemon_pause=pause),
                 'personalization':types.SimpleNamespace(guarded_training_run=fail)}):
                with self.assertRaisesRegex(RuntimeError,'fake bounded'):f.run(args)
            self.assertEqual(events,['pause','restore'])
            self.assertEqual(read(Path(tmp)/'failure.json')['status'],'hold_no_retry_no_activation')
            with self.assertRaisesRegex(ValueError,'no_retry'):f.output_preflight(binding)

    def test_selected_candidate_sha_must_be_qualitywinner(self):
        identity=seal({'path':'/qualitywinner','file_hashes':{'adapters.safetensors':'qualitysha'},
            'checkpoint_selection_hash':'selected','binding_hash':'binding','method':'checkpoint_2_v4',
            'step':152,'base_model_identity':'base','activation_authorized':False,'final_evaluation_required':True},'identity_hash')
        selected_payload={'selected_method':'checkpoint_2_v4','selected_checkpoint':{'step':152,'adapter_artifact_hash':'qualitysha'},
            'minimum_validation_loss_method':'checkpoint_4_v4','rank_keys':{},'summary_hash':'summary',
            'checkpoint_metadata_hash':'metadata','selection_rule_hash':f.dev.RULE_HASH,
            'activation_authorized':False,'final_outputs_seen':False}
        selection=seal(selected_payload,'checkpoint_selection_hash');identity['checkpoint_selection_hash']=selection['checkpoint_selection_hash']
        identity=seal({k:v for k,v in identity.items() if k!='identity_hash'},'identity_hash')
        options={str(i):{'role':'pass','fact':'pass','consent':'pass','response':'pass',
                        'usefulness':4,'style':4,'reason':'fake rubric reason','output_hash':'fake'} for i in range(5)}
        verdicts=seal({'reviewer':'agent_delegated','mapping_seen_before_freeze':False,'case_count':24,
            'suite_hash':f.dev.DEV_HASH,'cases':{str(i):{'options':options,'preference':[list(options)]} for i in range(24)},'report_hash':'report'},'verdict_hash')
        summary=seal({'development_only':True,'suite_hash':f.dev.DEV_HASH,'verdict_hash':verdicts['verdict_hash'],
            'report_hash':'report'},'summary_hash')
        metadata=seal({'binding_hash':'binding','checkpoints':{}},'checkpoint_metadata_hash')
        # Valid sealed comparison metadata with a different loss-only winner.
        selected_payload.update(summary_hash=summary['summary_hash'],checkpoint_metadata_hash=metadata['checkpoint_metadata_hash'])
        selection=seal(selected_payload,'checkpoint_selection_hash')
        identity=seal({**{k:v for k,v in identity.items() if k!='identity_hash'},
                       'checkpoint_selection_hash':selection['checkpoint_selection_hash']},'identity_hash')
        bindings={'binding_hash':'binding','artifacts':{'training_plan_hash':'plan','base_model_identity':'base','checkpoint_receipts':{}}}
        paths={k:k for k in ('selected_identity','selection','dev_summary','dev_metadata','dev_verdicts','dev_bindings','dev_rule')}
        with patch.object(f,'read',side_effect=[identity,selection,summary,metadata,verdicts,bindings]),\
             patch.object(f.dev,'verify_binding'),patch.object(f,'select_checkpoint',return_value=selection):
            with self.assertRaisesRegex(ValueError,'quality_winner_weight_sha'):
                f.require_completed_selection(paths,'losswinnersha','plan')
        with patch.object(f,'read',side_effect=[identity,selection,summary,metadata,verdicts,bindings]),\
             patch.object(f.dev,'verify_binding'),patch.object(f,'select_checkpoint',return_value=selection),\
             patch.object(f.dev,'sha',return_value='qualitysha'),patch.object(f.dev,'finite_adapter'):
            actual,_=f.require_completed_selection(paths,'qualitysha','plan')
            self.assertEqual(actual['method'],'checkpoint_2_v4')


if __name__=='__main__':unittest.main()
