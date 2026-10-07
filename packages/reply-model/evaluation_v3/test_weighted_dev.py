import contextlib
from copy import deepcopy
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import weighted_dev as w
from independent import read,write_private,seal,digest,GENERATION_POLICY
from development_selection import select_checkpoint

class Tokenizer:
    def apply_chat_template(self,messages,**kw):return list(range(messages[0].get('length',12)))

class Engine:
    def __init__(self,fail=False):self.models={'stale':1};self.calls=[];self.fail=fail
    def generate_text(self,messages,*,adapter_path,max_tokens,temperature):
        if len(self.calls)%24==0:assert not self.models
        self.models['loaded']=1;self.calls.append(adapter_path)
        assert max_tokens==192 and temperature==0
        if self.fail:raise RuntimeError('fake inference failure')
        return 'fake grounded reply'

def original():
    cases=[]
    for i in range(24):
        req={'id':str(i),'context':'fake '+str(i)};rubric={'allowed':['fake'],'forbidden':['unsupported']}
        messages=[{'role':'system','content':'fake system '+str(i)},{'role':'user','content':'fake incoming'},
                  {'role':'user','content':'fake old v4 instruction'}]
        cases.append({'id':str(i),'category':'fake','request':req,'rubric':rubric,
            'request_hash':digest(req),'rubric_hash':digest(rubric),
            'inputs':{m:deepcopy(messages) for m in ['production_base_v4']+list(w.CANDIDATES)}})
    return {'schema':'independent-compiled-v1','suite_hash':w.dev.DEV_HASH,'case_count':24,
        'raw_hash':'fake_raw','split':'development_diagnostic','cases':cases,
        'compilers':{'production_base_v4':{}},'generation_policy':GENERATION_POLICY,
        'evaluation_helper_sha256':w.dev.sha(Path(w.__file__).with_name('independent.py')),
        'policy':{'min_case_usefulness':3,'min_mean_usefulness':4,'min_mean_style':3.5,
            'meaningful_usefulness_gain':.15,'meaningful_style_gain':.25,'min_paired_net_win_fraction':.1},
        'general_rubric':{},'supplemental_policy':None}

def modules():
    mx=types.ModuleType('mlx.core');mx.clear_cache=lambda:None
    mlx=types.ModuleType('mlx');mlx.core=mx
    u=types.ModuleType('mlx_lm.utils');u.load_tokenizer=lambda _:Tokenizer()
    lm=types.ModuleType('mlx_lm');lm.utils=u
    return {'mlx':mlx,'mlx.core':mx,'mlx_lm':lm,'mlx_lm.utils':u}

def bundle(folder):
    suite=w.suite_from_original(original());write_private(folder/w.SUITE_NAME,suite)
    adapters=dict(zip(w.METHODS,[None,'/old152','/new76','/new152','/new228','/new304']))
    binding=seal({'suite_hash':suite['suite_hash'],'suite_path':str(folder/w.SUITE_NAME),'output':str(folder),
        'artifacts':{'model_path':'fake','worker_path':'fake'},'method_adapters':adapters,
        'generator_sha256':w.dev.sha(Path(w.__file__).with_name('multi_adapter.py')),
        'generation_policy':GENERATION_POLICY,'complete_input_preflight':w.preflight(suite,Tokenizer())},'binding_hash')
    write_private(folder/'bindings.json',binding)
    write_private(folder/'attempt.json',seal({'binding_hash':binding['binding_hash']},'attempt_hash'))
    return suite,binding

class WeightedDevTests(unittest.TestCase):
    def test_same_original_requests_rubrics_v4_all_six(self):
        old=original();new=w.suite_from_original(old)
        for a,b in zip(old['cases'],new['cases']):
            for k in ('id','request','rubric','request_hash','rubric_hash'):self.assertEqual(a[k],b[k])
            self.assertTrue(all(x==a['inputs']['production_base_v4'] for x in b['inputs'].values()))

    def test_final_filename_rejected_before_read(self):
        with patch.object(w,'load_suite') as reader:
            with self.assertRaisesRegex(ValueError,'before_read'):w.weighted_suite('final.json')
            reader.assert_not_called()

    def test_input_overflow_whole_suite_rejected(self):
        suite=w.suite_from_original(original())
        for m in w.METHODS:suite['cases'][-1]['inputs'][m][0]['length']=3905
        with self.assertRaisesRegex(ValueError,'no_truncation'):w.preflight(suite,Tokenizer())

    def test_fake144_complete_publication_and_failure_cleanup(self):
        for fail in (False,True):
            engine=Engine(fail)
            with tempfile.TemporaryDirectory() as tmp:
                folder=Path(tmp);suite,binding=bundle(folder)
                with patch.object(w,'verify',return_value=suite),patch.object(w,'worker_module',
                        return_value=types.SimpleNamespace(ReplyWorker=lambda:engine)),patch.dict(sys.modules,modules()):
                    if fail:
                        with self.assertRaisesRegex(RuntimeError,'fake inference'):w.child(folder/'bindings.json',binding['binding_hash'])
                    else:w.child(folder/'bindings.json',binding['binding_hash'])
                self.assertFalse(engine.models)
                if fail:self.assertFalse((folder/'outputs-complete.json').exists())
                else:
                    self.assertEqual(len(engine.calls),144)
                    self.assertEqual(engine.calls,sum(([a]*24 for a in binding['method_adapters'].values()),[]))
                    report=read(folder/'report.json');self.assertEqual(len(report['cases']),24)
                    self.assertTrue(all(len(c['outputs'])==6 for c in report['cases']))

    def test_controls_never_selected_even_if_globally_best(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);metrics={m:{'count':24,'clear_semantic_failure_cases':0 if m in w.CONTROLS else 3,
                'unresolved_semantic_cases':0,'usefulness_mean':5 if m in w.CONTROLS else 3,
                'style_mean':5 if m in w.CONTROLS else 4} for m in w.METHODS}
            checkpoints={m:{'step':step,'adapter_artifact_hash':'fake-'+m,'loss_evaluation_hash':'loss-'+m,
                'validation_loss':loss} for m,step,loss in zip(w.CANDIDATES,[76,152,228,304],[2.6,2.4,2.5,2.7])}
            write_private(p/'summary.json',seal({'suite_hash':'fake','methods':metrics},'summary_hash'))
            write_private(p/'metadata.json',seal({'development_case_count':24,
                'loss_measurement_kind':'reevaluated_saved_artifact','validation_set_hash':'fixed46',
                'checkpoints':checkpoints},'checkpoint_metadata_hash'))
            write_private(p/'rule.json',seal({'suite_hash':'fake','candidate_methods':list(w.CANDIDATES),
                'diagnostic_methods':list(w.CONTROLS)},'selection_rule_hash'))
            x=select_checkpoint(p/'summary.json',p/'metadata.json',p/'rule.json')
            self.assertEqual(x['selected_method'],w.CANDIDATES[1]);self.assertNotIn(x['selected_method'],w.CONTROLS)
            self.assertEqual(set(x['rank_keys']),set(w.CANDIDATES))

    def test_guard_failure_restores_and_blocks_retry(self):
        events=[]
        @contextlib.contextmanager
        def pause(args):
            events.append('pause')
            try:yield
            finally:events.append('restore')
        def fail(*a,**k):
            self.assertEqual(k['max_runtime_seconds'],1200);self.assertEqual(k['max_rss_bytes'],12*1024**3)
            self.assertEqual(k['max_swap_bytes'],1024**3);raise RuntimeError('fake bounded failure')
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp).resolve();binding={'output':str(folder),'binding_hash':'fake'}
            write_private(folder/'bindings.json',binding)
            args=types.SimpleNamespace(bindings=folder/'bindings.json',expected_binding_hash='fake',pause_daemon=True)
            with patch.object(w,'verify'),patch.dict(sys.modules,{'bounded_pilot':types.SimpleNamespace(daemon_pause=pause),
                    'personalization':types.SimpleNamespace(guarded_training_run=fail)}):
                with self.assertRaisesRegex(RuntimeError,'fake bounded'):w.run(args)
            self.assertEqual(events,['pause','restore'])
            self.assertEqual(read(folder/'failure.json')['status'],'hold_no_retry_no_activation')
            with self.assertRaisesRegex(ValueError,'no_retry'):w.output_preflight(binding)

    def test_incomplete_verdict_rejected_before_mapping_read(self):
        import independent
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);suite,binding=bundle(folder);write_private(folder/'bad.json',{'verdict_hash':'invalid'})
            with patch.object(w,'completed_run',return_value=(suite,{'report_hash':'fake'},[])),patch.object(independent,'review_view',return_value=(suite,{'report_hash':'fake'},[])),patch.object(independent.Path,'read_bytes',side_effect=AssertionError('mapping read')):
                with self.assertRaisesRegex(ValueError,'frozen_payload'):
                    w.summary_and_selection(folder/'bindings.json',folder/'bad.json',folder/'summary.json',folder/'selection.json')

    def test_source_proof_incomplete_before_model_or_weights(self):
        with tempfile.TemporaryDirectory() as tmp:
            proof=Path(tmp)/'source.json';write_private(proof,seal({'training_complete':False},'source_proof_hash'))
            with patch.object(w.dev,'metadata_from_ledger') as reader:
                with self.assertRaisesRegex(ValueError,'development_only_exact_paths'):
                    w.prepare({'weighted_source_proof':proof},Path(tmp)/'run','no_actual_plan','no_actual_proof')
                reader.assert_not_called()

    def test_complete144_blind_packets_freeze_and_four_candidate_selection(self):
        engine=Engine()
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);suite,binding=bundle(folder)
            with patch.object(w,'verify',return_value=suite),patch.object(w,'worker_module',
                    return_value=types.SimpleNamespace(ReplyWorker=lambda:engine)),patch.dict(sys.modules,modules()):
                w.child(folder/'bindings.json',binding['binding_hash'])
            write_private(folder/'resources.json',{'status':'complete'});report=read(folder/'report.json')
            write_private(folder/'completion.json',seal({'status':'weighted_dev_complete_daemon_restored',
                'binding_hash':binding['binding_hash'],'report_hash':report['report_hash'],
                'resource_report_sha256':w.dev.sha(folder/'resources.json')},'completion_hash'))
            packets=folder/'review';w.packets(folder/'bindings.json',packets)
            for owner in ('root','dataset'):
                j=read(packets/(owner+'-judgments-template.json'))
                for c in j['cases'].values():
                    self.assertEqual(len(c['options']),6)
                    for q in c['options'].values():q.update(role='pass',fact='pass',consent='pass',response='pass',usefulness=4,style=4,reason='fake')
                    c['preference']=[list(c['options'])]
                write_private(packets/(owner+'-judgments.json'),j)
            verdicts=folder/'verdicts.json';w.merge(folder/'bindings.json',packets,
                packets/'root-judgments.json',packets/'dataset-judgments.json',verdicts)
            checkpoints={m:{'step':step,'adapter_artifact_hash':'fake-'+m,'loss_evaluation_hash':'loss-'+m,'validation_loss':loss}
                for m,step,loss in zip(w.CANDIDATES,[76,152,228,304],[2.6,2.4,2.5,2.7])}
            write_private(folder/'checkpoint-selection-metadata.json',seal({'development_case_count':24,
                'loss_measurement_kind':'reevaluated_saved_artifact','validation_set_hash':'fixed46',
                'checkpoints':checkpoints},'checkpoint_metadata_hash'))
            write_private(folder/'selection-rule-frozen.json',seal({'suite_hash':suite['suite_hash'],
                'candidate_methods':list(w.CANDIDATES),'diagnostic_methods':list(w.CONTROLS)},'selection_rule_hash'))
            z=w.summary_and_selection(folder/'bindings.json',verdicts,folder/'summary.json',folder/'selection.json')
            self.assertEqual(z['selected_method'],w.CANDIDATES[1]);self.assertFalse(z['activation_authorized'])
            summary=read(folder/'summary.json');self.assertEqual(len(summary['all_candidate_control_pairings']),8)
            self.assertTrue(all(x['ties']==24 for x in summary['all_candidate_control_pairings'].values()))

    def test_sealed_partial_verdict_before_mapping_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);suite,binding=bundle(folder)
            bad=seal({'reviewer':'agent_delegated','mapping_seen_before_freeze':False,'suite_hash':suite['suite_hash'],
                'report_hash':'fake','case_count':24,'cases':{}},'verdict_hash');write_private(folder/'bad.json',bad)
            with patch.object(w,'completed_run',return_value=(suite,{'report_hash':'fake'},[{'id':'required'}])),\
                    patch.object(w,'summarize',side_effect=AssertionError('mapping accessed')):
                with self.assertRaisesRegex(ValueError,'before_mapping'):
                    w.summary_and_selection(folder/'bindings.json',folder/'bad.json',folder/'summary.json',folder/'selection.json')

if __name__=='__main__':unittest.main()
