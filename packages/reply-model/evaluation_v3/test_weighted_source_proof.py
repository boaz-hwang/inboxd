"""Fake CPU metadata only; no corpus, tokenizer, GPU or real adapters."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest

import weighted_source_proof as w
from independent import seal


def producer_seal(value,key):
    value = {k:v for k,v in value.items() if k != key}
    return {**value,key:w.producer_digest(value)}


def fixture():
    plan = producer_seal({'iters':304,'save_every':76,'epochs':2,'batch_size':1,
        'max_runtime_seconds':6600,'max_rss_bytes':28*1024**3,'max_swap_bytes':4*1024**3,
        'train_max_tokens':2048,'seq_length':4096,'compile_mode':'disabled',
        'lengths':{'train':{'count':152},'valid':{'count':46}},
        'manifest_id':'m','records_hash':'r','assignments_hash':'a'},'plan_hash')
    entries=[]
    for i in range(152):
        category = (*w.PRIORITY,'all_other_examples')[i%5]
        entries.append({'id':f'fake{i}','criteria':{k:k==category for k in w.PRIORITY},
            'category':category,'raw_weight':w.RAW[category], 'example_hash':f'{i:064x}',
            'review_hash':'b'*64,'tokenized_example_hash':f'{i:064x}',
            'offset':100+i%3,'total_tokens':107+i%3})
    mean=sum(e['raw_weight'] for e in entries)/152
    for e in entries:e['normalized_weight']=e['raw_weight']/mean
    weights=producer_seal({'schema':'frozen-functional-loss-weights-v1',
        'proposal_hash':w.PROPOSAL_HASH,'normalization':'arithmetic_mean_over_training_examples',
        'normalizer':mean,'training_example_count':152,'validation_example_count':46,
        'validation_target_token_count':322,'validation_weighting':'unchanged_unweighted_all46',
        'manifest_id':'m','records_hash':'r','assignments_hash':'a','entries':entries,
        'expected_training_order_hash':w.order_hash(entries)},'weight_map_hash')
    helpers={'weighted_training.py':'1'*64,'weighted_training_runtime.py':'2'*64}
    experiment=producer_seal({'schema':'functional-weighted-trial-plan-v1',
        'proposal_hash':w.PROPOSAL_HASH,'ordinary_training_plan':plan,
        'weight_map_hash':weights['weight_map_hash'],'helper_fingerprint':helpers,
        'validation_unweighted':True,'weighted_train_loss_comparable_to_prior':False,
        'activation_performed':False},'experiment_hash')
    completion={'status':'awaiting_independent_evaluation','plan_hash':plan['plan_hash'],
        'final_test_records_supplied':0,'activation_performed':False}
    dispatch={'experiment_hash':experiment['experiment_hash'],'weight_map_hash':weights['weight_map_hash'],
        'dispatches':[{'weighted':i==0,'target_bound':65} for i in range(5)],
        'original_guard_restored':True,'validation_weighted':False}
    observation={'status':'complete','complete':True,'child_main_returned':True,
        'weight_map_hash':weights['weight_map_hash'],'actual_train_loss_calls':304,
        'original_training_ids':152,'unique_tokenized_examples':152,
        'seen_counts':{e['tokenized_example_hash']:2 for e in entries},
        'expected_seen_counts':{e['tokenized_example_hash']:2 for e in entries},
        'ordered_key_hash':weights['expected_training_order_hash'],
        'expected_ordered_key_hash':weights['expected_training_order_hash'],
        'training_ntoks':2128,'expected_training_ntoks':2128,
        'unweighted_eval_calls':230,'unweighted_eval_ntoks':1610}
    receipt=producer_seal({'schema':'functional-weighted-trial-completion-v1',
        'status':'awaiting_independent_evaluation','base_training_plan_hash':plan['plan_hash'],
        'experiment_hash':experiment['experiment_hash'],'weight_map_hash':weights['weight_map_hash'],
        'weight_map_sha256':'mapsha','helper_fingerprint':helpers,
        'ordinary_completion_hash':w.producer_digest(completion),
        'loss_observation_sha256':'obssha','dispatch_proof_hash':w.producer_digest(dispatch)},'receipt_hash')
    kwargs={'expected_plan_hash':plan['plan_hash'],'expected_experiment_hash':experiment['experiment_hash'],
        'expected_map_hash':weights['weight_map_hash'],'map_sha256':'mapsha',
        'observation_sha256':'obssha','helpers':helpers}
    return [plan,experiment,weights,completion,receipt,dispatch,observation],kwargs


def fake_completed_files(folder):
    values,kw=fixture()
    plan,experiment,weights,completion,receipt,dispatch,observation=values
    output=folder/'run';adapter=output/'adapter';adapter.mkdir(parents=True)
    paths={k:folder/(k+'.json') for k in ('ordinary_plan','weighted_experiment','weight_map')}
    paths.update(completion=output/'completion.json',ledger=adapter/'checkpoint-validation.json',
        weighted_dispatch=output/'weighted-dispatch-proof.json',weighted_completion=output/'weighted-completion.json',
        loss_observation=adapter/'weighted-loss-observation.json')
    def write(path,value):
        path.write_text(json.dumps(value,ensure_ascii=False));path.chmod(0o600)
    write(adapter/'resources.json',{'status':'complete','failure_reason':None,'elapsed_seconds':100.,
        'peak_rss_bytes':10000,'peak_swap_growth_bytes':0,'baseline_swap_bytes':0})
    plan=producer_seal({**plan,'output':str(output)},'plan_hash')
    helpers={n:w.sha(Path(w.__file__).resolve().parent.parent/n)
             for n in ('weighted_training.py','weighted_training_runtime.py')}
    experiment=producer_seal({**experiment,'ordinary_training_plan':plan,'helper_fingerprint':helpers,
        'weight_map_path':str(paths['weight_map'])},'experiment_hash')
    write(paths['weight_map'],weights);write(paths['loss_observation'],observation)
    receipts=[]
    for step in w.STEPS:
        artifact=adapter/f'{step:07d}_adapters.safetensors'
        artifact.write_bytes(f'fake weights{step}'.encode())
        resource=output/f'resource-{step}.json';write(resource,{'status':'complete'})
        receipts.append(producer_seal({'checkpoint_iteration':step,'artifact_path':str(artifact),
            'artifact_sha256':w.sha(artifact),'resource_report_path':str(resource),
            'resource_report_sha256':w.sha(resource),'validation_loss':2.,
            'validation_example_count':46,'seq_length':4096,'batch_size':1,
            'final_test_records_supplied':0,'validation_records_hash':'vr',
            'validation_assignments_hash':'va','runtime_source_sha256':{
                name:w.sha(Path(w.__file__).resolve().parent.parent/name)
                for name in ('personalization.py','training_runtime.py')}},'loss_evaluation_hash'))
    ledger=producer_seal({'status':'complete','final_test_records_supplied':0,'evaluations':receipts,
        'validation_records_hash':'vr','validation_assignments_hash':'va'},'ledger_hash')
    write(paths['ledger'],ledger)
    completion={**completion,'plan_hash':plan['plan_hash'],'checkpoint_selection':{
        'checkpoint_validation_ledger':str(paths['ledger']),
        'checkpoint_validation_ledger_sha256':w.sha(paths['ledger'])}}
    dispatch={**dispatch,'experiment_hash':experiment['experiment_hash']}
    receipt=producer_seal({**receipt,'base_training_plan_hash':plan['plan_hash'],
        'experiment_hash':experiment['experiment_hash'],'helper_fingerprint':helpers,
        'weight_map_sha256':w.sha(paths['weight_map']),
        'loss_observation_sha256':w.sha(paths['loss_observation']),
        'ordinary_completion_hash':w.producer_digest(completion),
        'dispatch_proof_hash':w.producer_digest(dispatch)},'receipt_hash')
    for k,value in (('ordinary_plan',plan),('weighted_experiment',experiment),('completion',completion),
                    ('weighted_dispatch',dispatch),('weighted_completion',receipt)):
        write(paths[k],value)
    return paths,{'expected_plan_hash':plan['plan_hash'],'expected_experiment_hash':experiment['experiment_hash'],
                  'expected_map_hash':weights['weight_map_hash']}


class MetadataTests(unittest.TestCase):
    def test_complete_actual_schema(self):
        values,kw=fixture()
        self.assertEqual(w.validate_metadata(*values,**kw)['actual_train_loss_calls'],304)

    def test_actual_personalization_digest_protocol(self):
        sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
        import personalization as producer
        self.assertEqual(producer.digest({'nested':[1,2],'한국어':'가'}),
                         w.producer_digest({'nested':[1,2],'한국어':'가'}))
        values,kw=fixture();values[4]=seal(values[4],'receipt_hash')
        with self.assertRaisesRegex(ValueError,'producer_digest_protocol'):w.validate_metadata(*values,**kw)

    def test_ordinary_success_cannot_mask_weighted_failure(self):
        values,kw=fixture();values[4]['status']='failed'
        values[4]=producer_seal(values[4],'receipt_hash')
        with self.assertRaisesRegex(ValueError,'actual_weighted_completion'):w.validate_metadata(*values,**kw)

    def test_audit_success_flags_not_sufficient(self):
        for key,value in (('training_ntoks',2127),('actual_train_loss_calls',303),
                          ('unweighted_eval_calls',229),('unweighted_eval_ntoks',1609),
                          ('child_main_returned',False),('ordered_key_hash','wrong')):
            values,kw=fixture();values[6][key]=value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError,'loss_observation'):
                w.validate_metadata(*values,**kw)

    def test_recompute_seen_counts(self):
        values,kw=fixture();key=next(iter(values[6]['seen_counts']))
        values[6]['seen_counts'][key]=values[6]['expected_seen_counts'][key]=1
        with self.assertRaisesRegex(ValueError,'loss_observation'):w.validate_metadata(*values,**kw)

    def test_guard_restoration_and_all_four_validation_dispatches(self):
        for key,value in (('original_guard_restored',False),('validation_weighted',True),
                          ('dispatches',[{'weighted':True,'target_bound':65}]*5)):
            values,kw=fixture();values[5][key]=value
            values[4]['dispatch_proof_hash']=w.producer_digest(values[5])
            values[4]=producer_seal(values[4],'receipt_hash')
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'dispatch'):
                w.validate_metadata(*values,**kw)

    def test_actual_files_and_completion_binding(self):
        values,kw=fixture();values[4]['loss_observation_sha256']='wrong'
        values[4]=producer_seal(values[4],'receipt_hash')
        with self.assertRaisesRegex(ValueError,'actual_weighted_completion'):w.validate_metadata(*values,**kw)
        values,kw=fixture();values[3]['plan_hash']='another'
        with self.assertRaisesRegex(ValueError,'actual_weighted_completion'):w.validate_metadata(*values,**kw)

    def test_map_priority_and_full_target_metadata(self):
        for mutation in ('priority','boundary','duplicate'):
            values,kw=fixture();e=values[2]['entries'][0]
            if mutation=='priority':e['criteria']['required_state_preservation']=False
            elif mutation=='boundary':e['total_tokens']=e['offset']+66
            else:values[2]['entries'][1]['id']=e['id']
            values[2]=producer_seal(values[2],'weight_map_hash')
            kw['expected_map_hash']=values[2]['weight_map_hash']
            values[1]['weight_map_hash']=kw['expected_map_hash']
            values[1]=producer_seal(values[1],'experiment_hash')
            kw['expected_experiment_hash']=values[1]['experiment_hash']
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):w.validate_metadata(*values,**kw)

    def test_source_helpers_are_bound(self):
        values,kw=fixture();kw['helpers']['weighted_training_runtime.py']='changed'
        # Shared dictionary in fake fixture is deliberate: re-sealing cannot
        # conceal changed source under an originally approved experiment hash.
        with self.assertRaisesRegex(ValueError,'producer_digest_protocol'):w.validate_metadata(*values,**kw)

    def test_complete_file_proof_shape_matches_frozen_weighted_dev(self):
        with tempfile.TemporaryDirectory() as folder:
            paths,kw=fake_completed_files(Path(folder))
            proof=w.build(paths,**kw)
            self.assertEqual(set(proof['artifact_paths']),w.CORE_PATHS)
            self.assertEqual(proof['saved_steps'],[76,152,228,304])
            self.assertTrue(proof['training_complete'])
            self.assertTrue(all(w.sha(p)==h for p,h in proof['file_sha256'].items()))
            self.assertEqual(proof['weighted_training_dispatches'],1)
            self.assertEqual(proof['unweighted_saved_validation_dispatches'],4)

    def test_resealed_other_ledger_rejected_by_completion(self):
        with tempfile.TemporaryDirectory() as folder:
            paths,kw=fake_completed_files(Path(folder))
            ledger=json.loads(paths['ledger'].read_text());ledger['extra_audit']='other'
            paths['ledger'].write_text(json.dumps(producer_seal(ledger,'ledger_hash')))
            with self.assertRaisesRegex(ValueError,'completion_exact_ledger'):w.build(paths,**kw)

    def test_numbered_checkpoint_and_resource_identity(self):
        for change in ('artifact','resource'):
            with tempfile.TemporaryDirectory() as folder:
                paths,kw=fake_completed_files(Path(folder))
                if change=='artifact':(paths['ledger'].parent/'0000152_adapters.safetensors').write_bytes(b'wrong')
                else:(paths['completion'].parent/'resource-152.json').write_text('{"status":"failed"}')
                with self.subTest(change=change),self.assertRaisesRegex(ValueError,'saved_loss_artifact'):
                    w.build(paths,**kw)

    def test_actual_train_guard_limits_and_failure(self):
        plan=fixture()[0][0]
        resources={'status':'complete','failure_reason':None,'elapsed_seconds':100.,
            'peak_rss_bytes':10000,'peak_swap_growth_bytes':0,'baseline_swap_bytes':0}
        self.assertEqual(w.validate_training_guard(plan,resources)['elapsed_seconds'],100.)
        for key,value in (('status','failed'),('elapsed_seconds',6601.),
                          ('peak_rss_bytes',28*1024**3+1),('peak_swap_growth_bytes',4*1024**3),
                          ('baseline_swap_bytes',None)):
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'actual_training_resource'):
                w.validate_training_guard(plan,{**resources,key:value})

    def test_validation_target_bound_is_actual_not_assumed_train_bound(self):
        values,kw=fixture()
        for d in values[5]['dispatches'][1:]:d['target_bound']=56
        values[4]['dispatch_proof_hash']=w.producer_digest(values[5])
        values[4]=producer_seal(values[4],'receipt_hash')
        self.assertEqual(w.validate_metadata(*values,**kw)['actual_train_loss_calls'],304)


if __name__=='__main__':unittest.main()
