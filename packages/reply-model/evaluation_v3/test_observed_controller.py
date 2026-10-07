import contextlib
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import observed_controller as c
from independent import seal,write_private,read,digest


class Tokenizer:
    def apply_chat_template(self,messages,**kwargs):return [0]*3


class Engine:
    def __init__(self):self.models={};self.calls=[]
    def generate_text(self,messages,*,adapter_path,max_tokens,temperature):
        self.models[adapter_path]=True;self.calls.append((adapter_path,max_tokens))
        return 'ordinary fake response'


def fixture(unavailable=True):
    ids={k:[k+str(i) for i in range(n)] for k,n in c.utility.COUNTS.items()}
    groups={k:{i:[{'role':'user','content':'fake '+i}] for i in v} for k,v in ids.items()}
    rubric={'role':'fake role criterion','fact':'fake fact criterion','abstain':'fake abstention criterion'}
    entries=[];old=[]
    for i in ids['real22']:
        prompt=c.utility.legacy_prompt_hash(groups['real22'][i])
        entry={'id':i,'status':'ready','original_prompt_hash':prompt,'current_prompt_hash':prompt,
            'original_source_hash':'oldsource','rubric_hash':c.utility.legacy_prompt_hash(rubric),
            'current_raw_content_hash':'current-raw','current_source_keys_hash':'current-keys'}
        entries.append(entry);old.append({**entry,'evaluation_group':'heldout_chat'})
    if unavailable:
        entries[-1].update(status='unavailable',reason='original_prompt_hash_mismatch')
        del groups['real22'][entries[-1]['id']]
    return seal({'groups':groups,'expected_ids':ids,'real_entries':entries,'grant_entries':old,
                 'real_rubric':rubric,'gap_policy':{'kakao':64,'telegram':115}},'bundle_hash')


class ObservedControllerTests(unittest.TestCase):
    def projection_proof(self):
        return seal({'version':'observed-real22-input-proof-v1','evidence_class':'observed_regression',
            'grant_hash':'grant','quarantine_hash':c.QUARANTINE_HASH,'prompt_version':'reply-v4',
            'old_input_hash_scheme':c.resolver.OLD_HASH_SCHEME,'metadata_hash_scheme':c.resolver.METADATA_HASH_SCHEME,
            'resolver_source_sha256':'resolver','worker_source_sha256':'worker',
            'ready_count':21,'unavailable_count':1,'roomwide_read':True,
            'original_timestamp_bounds_available':False,'historical_targets_model_input':False,
            'exact_all22_reproduced':False,'credential_detection_not_exhaustive':True,
            'entries':fixture()['real_entries'],
            'reads':[{'room_key':'old-room','pages':2,'raw_inventory_hash':'old-inventory'}]},'proof_hash')

    def test_unrelated_room_inventory_changes_do_not_change_approval(self):
        proof=self.projection_proof();expected=c.resolution_approval(proof)['approval_hash']
        changed={k:v for k,v in proof.items() if k!='proof_hash'}
        changed['reads']=[{'room_key':'old-room','pages':3,'raw_inventory_hash':'new-unrelated-inventory'}]
        changed=seal(changed,'proof_hash')
        self.assertNotEqual(changed['proof_hash'],proof['proof_hash'])
        self.assertEqual(c.require_resolution_approval(changed,expected)['approval_hash'],expected)

    def test_original22_source_or_status_change_rejected_before_execution(self):
        import copy
        proof=self.projection_proof();expected=c.resolution_approval(proof)['approval_hash']
        for field,value in [('current_raw_content_hash','changed-original-case-source'),('status','unavailable'),('current_prompt_hash','changed-input')]:
            changed=copy.deepcopy({k:v for k,v in proof.items() if k!='proof_hash'})
            changed['entries'][0][field]=value;changed=seal(changed,'proof_hash')
            with self.assertRaisesRegex(ValueError,'identity_changed_hold_before_generation'):
                c.require_resolution_approval(changed,expected)

    def test_scoped_compact_proof_and_known49_policy_binding(self):
        bundle=fixture()
        grant=seal({'entries':bundle['grant_entries'],'room_keys':['fake-room'+str(i) for i in range(6)],
                    'quarantine_hash':c.QUARANTINE_HASH},'grant_hash')
        proof=seal({'entries':bundle['real_entries'],'grant_hash':grant['grant_hash'],
            'quarantine_hash':c.QUARANTINE_HASH,'historical_targets_model_input':False,
            'old_input_hash_scheme':c.resolver.OLD_HASH_SCHEME,'metadata_hash_scheme':c.resolver.METADATA_HASH_SCHEME,
            'resolver_source_sha256':c.dev.sha(c.resolver.__file__),
            'worker_source_sha256':c.dev.sha(Path(c.__file__).resolve().parent.parent/'worker.py'),
            'roomwide_read':True,'original_timestamp_bounds_available':False,
            'ready_count':21,'unavailable_count':1,'reads':[{'room_key':'fake-room0'}]},'proof_hash')
        with patch.object(c,'GRANT_HASH',grant['grant_hash']):
            c.proof_check(proof,grant,bundle['groups'])
            invalid={k:v for k,v in proof.items() if k!='proof_hash'};invalid['quarantine_hash']='other'
            with self.assertRaisesRegex(ValueError,'policy_required'):
                c.proof_check(seal(invalid,'proof_hash'),grant,bundle['groups'])
            invalid={k:v for k,v in proof.items() if k!='proof_hash'};invalid['reads']=[{'room_key':'outside'}]
            with self.assertRaisesRegex(ValueError,'outside_original_six'):
                c.proof_check(seal(invalid,'proof_hash'),grant,bundle['groups'])

    def test_plain_real_report_retains_all22_unavailable_and_only_two_methods(self):
        bundle=fixture();engine=Engine()
        cache=c.utility.generate_cached(engine,bundle['groups']['real22'],'/qualitywinner','real22',lambda:None)
        with tempfile.TemporaryDirectory() as tmp:
            binding={'output':tmp,'binding_hash':'binding','selected_adapter':'/qualitywinner'}
            report=c.publish_real(cache,bundle,binding)
            self.assertEqual(len(report['cases']),22);self.assertEqual(report['output_count'],42)
            self.assertEqual(report['unavailable_case_count'],1)
            self.assertEqual(report['observed_status'],'hold_incomplete_same_input_real22')
            self.assertFalse(report['complete_same_input_22']);self.assertFalse(report['fresh_gate_evidence'])
            unavailable=report['cases'][-1];self.assertEqual(unavailable['outputs'],[])
            self.assertEqual(unavailable['reason'],'original_prompt_hash_mismatch')
            mapping=read(Path(tmp)/'real-report-unblind.json')['mapping']
            self.assertEqual(len(mapping),21)
            self.assertTrue(all({v['method'] for v in labels.values()}=={'base','trained'} for labels in mapping.values()))
            self.assertTrue(all(o['label'] in ('option_1','option_2') for row in report['cases'] for o in row['outputs']))

    def test_fake_child_all_three_groups_same_winner_and_no_rpc(self):
        import sys
        bundle=fixture();engine=Engine()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);plan={'observed_synthetic24':{'suite_path':'unused-fake'}}
            write_private(root/'plan.json',plan)
            binding={'output':str(root),'binding_hash':'b','bundle_hash':bundle['bundle_hash'],
                'model_path':'fake-model','selected_adapter':'/qualitywinner',
                'preflight':c.utility.preflight(bundle['groups'],bundle['expected_ids'],bundle['real_entries'],Tokenizer()),
                'ready_input_hashes':{k:{i:c.utility.legacy_prompt_hash(m) for i,m in v.items()} for k,v in bundle['groups'].items()},
                'expected_ids':bundle['expected_ids'],'real_availability':bundle['real_entries'],'paths':{'plan':str(root/'plan.json')}}
            write_private(root/'bindings.json',binding);write_private(root/'inputs.json',bundle)
            write_private(root/'attempt.json',seal({'binding_hash':'b'},'attempt_hash'))
            def fake_fresh(cache,tokenizer,adapter,output,**kwargs):
                rows=[]
                for cid,messages in bundle['groups']['synthetic24'].items():
                    outputs=[]
                    for n,path in enumerate((None,str(adapter)),1):
                        text=cache.generate_text(messages,adapter_path=path,max_tokens=128,temperature=0.)
                        outputs.append({'label':'option_'+str(n),'text':text,'output_hash':c.utility.legacy_prompt_hash(text)})
                    rows.append({'id':cid,'outputs':outputs})
                write_private(output,{'cases':rows,'complete':True,'comparison_complete':True})
                write_private(Path(output).with_name(Path(output).stem+'-unblind.json'),{})
                return {'case_count':24,'comparison_complete':True}
            def fake_operational(model,adapter,output,engine_factory):
                cache=engine_factory();rows=[];output=Path(output);output.mkdir()
                for cid,messages in bundle['groups']['operational4'].items():
                    outputs=[]
                    for n,path in enumerate((None,str(adapter)),1):
                        text=cache.generate_text(messages,adapter_path=path,max_tokens=192,temperature=0.)
                        outputs.append({'label':'option_'+str(n),'text':text,'output_hash':c.utility.legacy_prompt_hash(text)})
                    rows.append({'id':cid,'outputs':outputs})
                write_private(output/'blind-report.json',{'cases':rows,'complete':True})
                write_private(output/'mapping.json',{});write_private(output/'metadata.json',{})
                return str(output/'blind-report.json')
            mx=types.ModuleType('mlx.core');mx.clear_cache=lambda:None
            mlx=types.ModuleType('mlx');mlx.core=mx
            utils=types.ModuleType('mlx_lm.utils');utils.load_tokenizer=lambda path:Tokenizer()
            lm=types.ModuleType('mlx_lm');lm.utils=utils
            with patch.object(c,'verify'),patch.object(c,'worker_module',return_value=types.SimpleNamespace(ReplyWorker=lambda:engine)),\
                patch.dict(sys.modules,{'mlx':mlx,'mlx.core':mx,'mlx_lm':lm,'mlx_lm.utils':utils,
                    'fresh_evaluate':types.SimpleNamespace(generate=fake_fresh),
                    'operational_fixtures':types.SimpleNamespace(compare_operational=fake_operational)}):
                result=c.child(root/'bindings.json',root/'inputs.json','b')
            self.assertEqual(result['status'],'observed_outputs_complete')
            self.assertEqual(len(engine.calls),98)
            self.assertEqual({path for path,tokens in engine.calls},{None,'/qualitywinner'})
            self.assertEqual(sum(tokens==128 for path,tokens in engine.calls),48)
            self.assertFalse(engine.models)
            outputs=read(root/'outputs-complete.json')
            self.assertEqual(outputs['observed_real_status'],'hold_incomplete_same_input_real22')
            with self.assertRaisesRegex(ValueError,'no_retry'):c.preflight_output(root)
            # Metadata/declared denominators cannot silently relabel a subset complete.
            report=read(root/'real-report.json');report['complete_same_input_22']=True
            report=seal({k:v for k,v in report.items() if k!='report_hash'},'report_hash')
            (root/'real-report.json').unlink();write_private(root/'real-report.json',report)
            with self.assertRaisesRegex(ValueError,'claim_changed'):c.validate_publication(binding)

    def test_guard_failure_restores_and_deletes_transient_inputs(self):
        import sys
        events=[];stages=[]
        @contextlib.contextmanager
        def stage(prefix):
            with tempfile.TemporaryDirectory(prefix=prefix) as tmp:
                stages.append(Path(tmp));yield Path(tmp),None
        @contextlib.contextmanager
        def pause(args):
            events.append('pause')
            try:yield
            finally:events.append('restore')
        def fail(*a,**k):raise RuntimeError('fake child guard failure')
        with tempfile.TemporaryDirectory() as tmp:
            binding={'output':str(Path(tmp).resolve()),'binding_hash':'b',
                'resource_budget':{'seconds':1200,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3}}
            args=types.SimpleNamespace(pause_daemon=True,authorize_execution=True)
            with patch.object(c,'verify'),patch.dict(sys.modules,
                {'personalization':types.SimpleNamespace(private_staging=stage,guarded_training_run=fail),
                 'bounded_pilot':types.SimpleNamespace(daemon_pause=pause)}):
                with self.assertRaisesRegex(RuntimeError,'fake child'):c.execute(binding,fixture(),args)
            self.assertEqual(events,['pause','restore'])
            self.assertTrue(all(not p.exists() for p in stages))
            self.assertEqual(read(Path(tmp)/'failure.json')['status'],'hold_no_retry_no_activation')

    def test_no_authorization_or_existing_attempt_stops_before_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            binding={'output':tmp,'binding_hash':'b'};args=types.SimpleNamespace(pause_daemon=True,authorize_execution=False)
            with patch.object(c,'verify'):
                with self.assertRaisesRegex(ValueError,'authorization'):c.execute(binding,fixture(),args)
            write_private(Path(tmp)/'attempt.json',{'partial':True})
            with self.assertRaisesRegex(ValueError,'no_retry'):c.preflight_output(tmp)


if __name__=='__main__':unittest.main()
