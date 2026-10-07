"""One weighted-trial Dev24 comparison: four candidates plus two controls.

Preparation waits for actual complete receipts and weighted-source proof. No
training examples or final inputs are read. Existing frozen helpers are reused.
"""
import argparse
from copy import deepcopy
import gc
import os
from pathlib import Path
import sys

import checkpoint_dev as dev
from development_selection import select_checkpoint
from independent import (read,seal,check_seal,write_private,now,digest,load_suite,
    review_view,freeze_verdicts,summarize,worker_module,GENERATION_POLICY)
from multi_adapter import generate_multi

CANDIDATES=tuple(f'checkpoint_{i}_v4' for i in range(1,5))
CONTROLS=('production_base_v4','old152_control_v4')
METHODS=CONTROLS+CANDIDATES
SUITE_NAME='dev24-weighted-six-method-frozen.json'
OLD152_SHA='0bde3cdf51f4afa9baf773e26f5dff5bdbd8c86ff12e9647831ed46a3d70d6e6'
BUDGET={'seconds':1200,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3}


def suite_from_original(original):
    if original['suite_hash']!=dev.DEV_HASH or original['case_count']!=24:
        raise ValueError('same_original_development24_required')
    cases=[]
    for source in original['cases']:
        messages=source['inputs']['production_base_v4']
        if any(x!=messages for x in source['inputs'].values()):
            raise ValueError('unchanged_v4_inputs_required')
        case={k:deepcopy(source[k]) for k in ('id','category','request','rubric','request_hash','rubric_hash')}
        case.update(inputs={m:deepcopy(messages) for m in METHODS},
                    input_hashes={m:digest(messages) for m in METHODS})
        cases.append(case)
    payload={k:deepcopy(original[k]) for k in ('schema','raw_hash','split','policy','general_rubric',
        'supplemental_policy','generation_policy','evaluation_helper_sha256')}
    payload.update(source_dev_suite_hash=dev.DEV_HASH,case_count=24,candidate=CANDIDATES[0],
        comparators=[m for m in METHODS if m!=CANDIDATES[0]],
        compilers={m:deepcopy(original['compilers']['production_base_v4']) for m in METHODS},cases=cases,
        provenance={'development_previously_observed':True,'same_raw_v4_rubrics':True,
            'fresh_all144_outputs':True,'final_evidence':False})
    return seal(payload,'suite_hash')


def weighted_suite(path):
    if Path(path).name!=SUITE_NAME:raise ValueError('development_filename_required_before_read')
    suite=load_suite(path)
    if (suite['source_dev_suite_hash']!=dev.DEV_HASH or suite['case_count']!=24
            or suite['split']!='development_diagnostic' or set(suite['compilers'])!=set(METHODS)):
        raise ValueError('exact_six_method_development_required')
    if any(len({digest(v) for v in c['inputs'].values()})!=1 for c in suite['cases']):
        raise ValueError('all_methods_same_v4_required')
    return suite


def rule_from_original(original,suite):
    check_seal(original,'selection_rule_hash')
    if original['selection_rule_hash']!=dev.RULE_HASH:raise ValueError('same_global_rank_rule_required')
    rule={k:deepcopy(v) for k,v in original.items() if k!='selection_rule_hash'}
    rule.update(suite_hash=suite['suite_hash'],candidate_methods=list(CANDIDATES),
        diagnostic_methods=list(CONTROLS),previous_rule_hash=dev.RULE_HASH,
        experiment='one_weighted_trial_four_new_candidates_only')
    return seal(rule,'selection_rule_hash')


def preflight(suite,tokenizer):
    lengths={}
    for c in suite['cases']:
        n=len(tokenizer.apply_chat_template(c['inputs'][CONTROLS[0]],add_generation_prompt=True,
            enable_thinking=False,return_dict=False))
        if n>3904:raise ValueError('complete_input_budget_exceeded_no_truncation')
        lengths[c['id']]=n
    return {'cases':24,'methods':6,'outputs':144,'max_input_tokens':max(lengths.values()),
        'output_tokens':192,'input_token_counts':lengths}


def helper_hashes():
    names=('weighted_dev.py','checkpoint_dev.py','independent.py','multi_adapter.py',
           'development_selection.py','selected_adapter.py')
    return {n:dev.sha(Path(__file__).with_name(n)) for n in names}


def prepare(paths,output,expected_plan_hash,expected_source_proof_hash):
    """Later CPU operation: source proof must be authored from actual producer artifacts.

    source_proof is compact sealed metadata binding completed weighted experiment,
    map/helper/dispatch files. No placeholder hashes or prospective completion.
    The engineer/root provides this proof only after its actual producer contract
    and all validation dispatch receipts have been verified.
    """
    if set(paths)!={'weighted_source_proof','original_suite','original_rule','old152_identity',
                   'ledger','completion','model','worker'}:
        raise ValueError('development_only_exact_paths_required')
    source=read(paths['weighted_source_proof']);check_seal(source,'source_proof_hash')
    artifact_paths=source.get('artifact_paths',{})
    required_artifacts={'ordinary_plan','weighted_experiment','weight_map','weighted_dispatch','ledger','completion'}
    if (set(artifact_paths)!=required_artifacts
            or Path(artifact_paths['ledger']).resolve()!=Path(paths['ledger']).resolve()
            or Path(artifact_paths['completion']).resolve()!=Path(paths['completion']).resolve()
            or not source.get('helper_fingerprints')
            or any(str(Path(p).resolve()) not in source['file_sha256'] for p in artifact_paths.values())
            or any(source['file_sha256'].get(str(Path(p).resolve()))!=h
                   for p,h in source['helper_fingerprints'].items())):
        raise ValueError('exact_plan_map_helper_dispatch_completion_files_required')
    if (source['source_proof_hash']!=expected_source_proof_hash
            or source['ordinary_training_plan_hash']!=expected_plan_hash
            or source['training_complete'] is not True or source['validation_unweighted'] is not True
            or source['saved_steps']!=[76,152,228,304]
            or source.get('weighted_training_dispatches')!=1
            or source.get('unweighted_saved_validation_dispatches')!=4
            or not source.get('experiment_hash') or not source.get('weight_map_hash')
            or any(dev.sha(p)!=h for p,h in source['file_sha256'].items())):
        raise ValueError('actual_complete_weighted_source_binding_required')
    original=dev.dev_suite(paths['original_suite']);suite=suite_from_original(original)
    identity=read(paths['old152_identity']);check_seal(identity,'identity_hash')
    if (identity['step']!=152 or identity['method']!='checkpoint_2_v4'
            or identity['file_hashes']['adapters.safetensors']!=OLD152_SHA
            or any(dev.sha(Path(identity['path'])/n)!=h for n,h in identity['file_hashes'].items())):
        raise ValueError('immutable_old152_control_required')
    metadata=dev.metadata_from_ledger(paths['ledger'],paths['completion'],expected_plan_hash,paths['model'])
    if sorted(c['step'] for c in metadata['checkpoint_methods'].values())!=[76,152,228,304]:
        raise ValueError('exact_four_new_saved_steps_required')
    if identity['base_model_identity']!=metadata['base_model_identity']:
        raise ValueError('same_base_identity_both_training_runs_required')
    output=Path(output).resolve();output.mkdir(mode=0o700,parents=True,exist_ok=False)
    artifact_path=output/'actual-artifact-metadata.json';write_private(artifact_path,metadata)
    stage=output/'checkpoint-stage'
    dev.prepare(paths['original_suite'],artifact_path,stage,paths['worker'])
    oldbinding=read(stage/'bindings.json');binding=deepcopy(oldbinding)
    rule=rule_from_original(read(paths['original_rule']),suite)
    write_private(output/SUITE_NAME,suite);write_private(output/'selection-rule-frozen.json',rule)
    binding.pop('binding_hash');binding.update(schema='weighted-six-method-development-bindings-v1',
        suite_hash=suite['suite_hash'],selection_rule_hash=rule['selection_rule_hash'],
        suite_path=str(output/SUITE_NAME),output=str(output),resource_budget=BUDGET,
        candidate_methods=list(CANDIDATES),diagnostic_methods=list(CONTROLS),
        weighted_source_proof_hash=expected_source_proof_hash,
        experiment_hash=source['experiment_hash'],weight_map_hash=source['weight_map_hash'],
        new_helper_fingerprints=helper_hashes(),activation_authorized=False,
        paths={k:str(Path(v).resolve()) for k,v in paths.items()},
        additional_file_hashes={**source['file_sha256'],**{str(Path(p).resolve()):dev.sha(p) for k,p in paths.items() if k!='model'},
            **{str(Path(identity['path'])/n):h for n,h in identity['file_hashes'].items()}})
    binding['method_adapters']={m:(None if m==CONTROLS[0] else identity['path'] if m==CONTROLS[1]
        else oldbinding['method_adapters'][m]) for m in METHODS}
    from mlx_lm.utils import load_tokenizer
    binding['complete_input_preflight']=preflight(suite,load_tokenizer(metadata['model_path']))
    binding=seal(binding,'binding_hash');write_private(output/'bindings.json',binding)
    checkpoint_meta=seal({'development_case_count':24,'loss_measurement_kind':'reevaluated_saved_artifact',
        'validation_set_hash':metadata['validation_set_hash'],
        'checkpoints':binding['artifacts']['checkpoint_receipts'],'binding_hash':binding['binding_hash']},'checkpoint_metadata_hash')
    write_private(output/'checkpoint-selection-metadata.json',checkpoint_meta)
    return {'binding_hash':binding['binding_hash'],'suite_hash':suite['suite_hash'],'cases':24,'methods':6,'outputs':144}


def verify(binding,expected_hash):
    dev.verify_binding(binding)
    if (binding['binding_hash']!=expected_hash or binding['resource_budget']!=BUDGET
            or binding['candidate_methods']!=list(CANDIDATES) or binding['diagnostic_methods']!=list(CONTROLS)
            or binding['new_helper_fingerprints']!=helper_hashes()
            or any(dev.sha(p)!=h for p,h in binding['additional_file_hashes'].items())):
        raise ValueError('frozen_weighted_comparison_changed')
    suite=weighted_suite(binding['suite_path'])
    if suite['suite_hash']!=binding['suite_hash']:raise ValueError('suite_binding_mismatch')
    if suite!=suite_from_original(dev.dev_suite(binding['paths']['original_suite'])):
        raise ValueError('original_raw_v4_rubrics_changed')
    if set(binding['method_adapters'])!=set(METHODS) or binding['method_adapters'][CONTROLS[0]] is not None:
        raise ValueError('exact_method_bindings_required')
    for m in CANDIDATES:
        c=binding['artifacts']['checkpoint_receipts'][m]
        if binding['method_adapters'][m]!=c['adapter_path'] or dev.sha(Path(c['adapter_path'])/'adapters.safetensors')!=c['adapter_artifact_hash']:
            raise ValueError('exact_new_checkpoint_required')
    if dev.sha(Path(binding['method_adapters'][CONTROLS[1]])/'adapters.safetensors')!=OLD152_SHA:
        raise ValueError('exact_old152_control_required')
    return suite


def output_preflight(binding):
    if any((Path(binding['output'])/n).exists() for n in ('attempt.json','report.json','report-unblind.json',
            'outputs-complete.json','completion.json','failure.json','runtime.log','resources.json')):
        raise ValueError('existing_or_partial_attempt_no_retry_no_overwrite')


def child(path,expected_hash):
    binding=read(path);suite=verify(binding,expected_hash);folder=Path(binding['output'])
    attempt=read(folder/'attempt.json');check_seal(attempt,'attempt_hash')
    if attempt['binding_hash']!=expected_hash:raise ValueError('owner_attempt_required')
    if any((folder/n).exists() for n in ('report.json','report-unblind.json','outputs-complete.json','completion.json','failure.json')):
        raise ValueError('existing_partial_child_no_retry')
    from mlx_lm.utils import load_tokenizer
    import mlx.core as mx
    tokenizer=load_tokenizer(binding['artifacts']['model_path'])
    if preflight(suite,tokenizer)!=binding['complete_input_preflight']:raise ValueError('preflight_changed')
    engine=worker_module(binding['artifacts']['worker_path']).ReplyWorker();engine.path=Path(binding['artifacts']['model_path'])
    try:outputs=dev.generate_method_major(engine,tokenizer,suite,binding['method_adapters'],mx.clear_cache)
    finally:engine.models.clear();gc.collect();mx.clear_cache()
    cache=dev.FrozenOutputCache(outputs)
    result=generate_multi(cache,tokenizer,path,folder/'report.json',suite_path=binding['suite_path'],
        artifacts={'fresh144':True,'method_major_clean_reset':True,'only_four_new_candidates':True})
    if len(outputs)!=144 or len(cache.used)!=144:raise ValueError('whole144_outputs_required')
    write_private(folder/'outputs-complete.json',seal({'binding_hash':expected_hash,
        'report_hash':result['report_hash'],'output_count':144},'outputs_hash'))
    return result


def completed_run(binding):
    folder=Path(binding['output']);done=read(folder/'completion.json');check_seal(done,'completion_hash')
    out=read(folder/'outputs-complete.json');check_seal(out,'outputs_hash')
    suite,report,views=review_view(binding['suite_path'],folder/'report.json')
    if (done['status']!='weighted_dev_complete_daemon_restored'
            or done['binding_hash']!=binding['binding_hash'] or out['binding_hash']!=binding['binding_hash']
            or out['output_count']!=144 or out['report_hash']!=report['report_hash']
            or report['generation_artifacts']['binding_hash']!=binding['binding_hash']
            or done['report_hash']!=report['report_hash'] or suite['suite_hash']!=binding['suite_hash']
            or dev.sha(folder/'resources.json')!=done['resource_report_sha256']
            or read(folder/'resources.json').get('status')!='complete'
            or dev.sha(folder/'report-unblind.json')!=report['mapping_file_sha256']):
        raise ValueError('complete144_guarded_restored_run_required')
    return suite,report,views


def run(args):
    binding=read(args.bindings);verify(binding,args.expected_binding_hash);output_preflight(binding)
    if not args.pause_daemon:raise ValueError('verified_daemon_pause_required')
    args.output=Path(binding['output'])
    if Path(args.bindings).resolve().parent!=args.output:raise ValueError('private_binding_directory_required')
    write_private(args.output/'attempt.json',seal({'binding_hash':binding['binding_hash'],'started_at_utc':now()},'attempt_hash'))
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
    import bounded_pilot as lifecycle
    import personalization as guard
    try:
        with lifecycle.daemon_pause(args):
            with (args.output/'runtime.log').open('x') as log:
                os.chmod(log.name,0o600)
                guard.guarded_training_run([sys.executable,str(Path(__file__).resolve()),'_child',
                    '--bindings',str(args.bindings),'--expected-binding-hash',args.expected_binding_hash],
                    env=os.environ,stdout=log,pass_fds=(),max_runtime_seconds=BUDGET['seconds'],
                    max_rss_bytes=BUDGET['rss_bytes'],max_swap_bytes=BUDGET['swap_growth_bytes'],
                    resource_report_path=args.output/'resources.json')
        _,report,_=review_view(binding['suite_path'],args.output/'report.json')
        write_private(args.output/'completion.json',seal({'status':'weighted_dev_complete_daemon_restored',
            'binding_hash':binding['binding_hash'],'report_hash':report['report_hash'],
            'resource_report_sha256':dev.sha(args.output/'resources.json')},'completion_hash'))
        completed_run(binding)
    except BaseException as exc:
        write_private(args.output/'failure.json',seal({'binding_hash':binding['binding_hash'],
            'status':'hold_no_retry_no_activation','error_class':type(exc).__name__},'failure_hash'))
        raise
    return {'status':'weighted_dev_complete_daemon_restored','binding_hash':binding['binding_hash']}


def packets(binding_path,output):
    binding=read(binding_path);weighted_suite(binding['suite_path']);suite,report,views=completed_run(binding)
    folder=Path(output);folder.mkdir(mode=0o700,parents=True,exist_ok=False);result=[]
    for name,owner,rows in [('root','/root',views[:12]),('dataset','/root/dataset_expansion',views[12:])]:
        packet=seal({'schema':'weighted-dev-blind-review-v1','suite_hash':suite['suite_hash'],
            'report_hash':report['report_hash'],'assigned_reviewer':owner,'reviewer':'agent_delegated',
            'development_previously_observed':True,'mapping_included':False,'case_count':12,'cases':rows,
            'instructions':'Judge all six outputs with unchanged rubrics; all144 judgments freeze before mapping access. No control is eligible for checkpoint selection.'},'packet_hash')
        write_private(folder/(name+'-packet.json'),packet)
        write_private(folder/(name+'-judgments-template.json'),{'reviewer':'agent_delegated',
            'assigned_reviewer':owner,'packet_hash':packet['packet_hash'],'mapping_seen_before_freeze':False,
            'cases':{c['id']:{'options':{o['label']:{'output_hash':o['output_hash'],'role':None,'fact':None,
                'consent':None,'response':None,'usefulness':None,'style':None,'reason':''} for o in c['outputs']},
                'preference':[]} for c in rows}})
        result.append({'assigned_reviewer':owner,'case_count':12,'packet_hash':packet['packet_hash']})
    return {'packets':result,'mapping_read':False}


def merge(binding_path,packet_dir,root_judgments,dataset_judgments,output):
    binding=read(binding_path);completed_run(binding);cases={}
    for name,owner,path in [('root','/root',root_judgments),('dataset','/root/dataset_expansion',dataset_judgments)]:
        packet=read(Path(packet_dir)/(name+'-packet.json'));check_seal(packet,'packet_hash');j=read(path)
        ids={c['id'] for c in packet['cases']}
        if (packet['suite_hash']!=binding['suite_hash'] or packet['assigned_reviewer']!=owner
                or j.get('assigned_reviewer')!=owner or j.get('packet_hash')!=packet['packet_hash']
                or j.get('reviewer')!='agent_delegated' or j.get('mapping_seen_before_freeze') is not False
                or set(j['cases'])!=ids or cases.keys()&ids):raise ValueError('complete_disjoint_blind_review_required')
        cases.update(j['cases'])
    combined=Path(output).with_name(Path(output).stem+'-combined.json')
    write_private(combined,{'reviewer':'agent_delegated','mapping_seen_before_freeze':False,'cases':cases})
    return freeze_verdicts(binding['suite_path'],Path(binding['output'])/'report.json',combined,output)


def summary_and_selection(binding_path,verdicts,summary_path,selection_path):
    binding=read(binding_path);suite,report,views=completed_run(binding)
    frozen=read(verdicts);check_seal(frozen,'verdict_hash')
    if (frozen.get('reviewer')!='agent_delegated' or frozen.get('mapping_seen_before_freeze') is not False
            or frozen.get('suite_hash')!=suite['suite_hash'] or frozen.get('report_hash')!=report['report_hash']
            or frozen.get('case_count')!=24 or set(frozen['cases'])!={c['id'] for c in views}):
        raise ValueError('all144_frozen_judgments_required_before_mapping')
    for c in views:
        verdict=frozen['cases'][c['id']];options=verdict.get('options',{});labels={o['label'] for o in c['outputs']}
        if len(labels)!=6 or set(options)!=labels:raise ValueError('all_six_options_required_before_mapping')
        for out in c['outputs']:
            q=options[out['label']]
            if (q.get('output_hash')!=out['output_hash'] or not q.get('reason')
                    or any(q.get(k) not in ('pass','fail','uncertain') for k in ('role','fact','consent','response'))
                    or any(type(q.get(k)) is not int or not 1<=q[k]<=5 for k in ('usefulness','style'))):
                raise ValueError('complete_semantic_scores_required_before_mapping')
        tiers=verdict.get('preference',[])
        ranked=[x for tier in tiers for x in tier] if isinstance(tiers,list) and all(isinstance(t,list) and t for t in tiers) else []
        if len(ranked)!=6 or set(ranked)!=labels:raise ValueError('all_six_preferences_required_before_mapping')
    result=summarize(binding['suite_path'],Path(binding['output'])/'report.json',verdicts)
    mapping=read(Path(binding['output'])/'report-unblind.json')['mapping']
    pairs={}
    for candidate in CANDIDATES:
        for control in CONTROLS:
            counts={'wins':0,'losses':0,'ties':0}
            for cid,q in frozen['cases'].items():
                ranks={label:i for i,tier in enumerate(q['preference']) for label in tier}
                labels={info['method']:label for label,info in mapping[cid].items()}
                a,b=ranks[labels[candidate]],ranks[labels[control]]
                counts['wins' if a<b else 'losses' if a>b else 'ties']+=1
            counts['net_wins']=counts['wins']-counts['losses'];pairs[candidate+'_vs_'+control]=counts
    result.update(development_only=True,final_evidence=False,placeholder_gate_unused=True,
        candidate_methods=list(CANDIDATES),diagnostic_methods=list(CONTROLS),
        all_candidate_control_pairings=pairs,paired_candidate_field_is_structural_placeholder=True,
        gate='development_only',gate_reasons=[],activation_authorized=False)
    write_private(summary_path,seal(result,'summary_hash'))
    folder=Path(binding['output'])
    selected=select_checkpoint(summary_path,folder/'checkpoint-selection-metadata.json',folder/'selection-rule-frozen.json')
    if selected['selected_method'] not in CANDIDATES:raise ValueError('control_cannot_be_selected')
    write_private(selection_path,selected)
    return {'summary_hash':read(summary_path)['summary_hash'],'selection_hash':selected['checkpoint_selection_hash'],
        'selected_method':selected['selected_method'],'activation_authorized':False}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['prepare','run','_child','packets','merge','summary'])
    for n in ('paths','output','bindings','inboxd','daemon-lock','daemon-binary','packet-dir','root-judgments',
              'dataset-judgments','verdicts','summary','selection'):
        p.add_argument('--'+n,type=Path)
    for n in ('expected-binding-hash','expected-plan-hash','expected-source-proof-hash'):p.add_argument('--'+n)
    p.add_argument('--pause-daemon',action='store_true');a=p.parse_args()
    if a.command=='prepare':z=prepare(read(a.paths),a.output,a.expected_plan_hash,a.expected_source_proof_hash)
    elif a.command=='run':z=run(a)
    elif a.command=='_child':z=child(a.bindings,a.expected_binding_hash)
    elif a.command=='packets':z=packets(a.bindings,a.output)
    elif a.command=='merge':z=merge(a.bindings,a.packet_dir,a.root_judgments,a.dataset_judgments,a.output)
    else:z=summary_and_selection(a.bindings,a.verdicts,a.summary,a.selection)
    import json
    print(json.dumps(z,ensure_ascii=False))


if __name__=='__main__':main()
