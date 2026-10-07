"""Sole-owner observed50 runner, with later explicit execution authorization.

No final input/suite access. A single invocation resolves permitted old rooms on
CPU, closes owner RPC, freezes all input/provenance hashes, then pauses the daemon
and launches one bounded child. Only private transient staging holds real inputs.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys

from independent import read,seal,check_seal,digest,write_private,now,worker_module
import checkpoint_dev as dev
from final_controller import require_completed_selection
import observed_regression as utility
import regression_inputs as resolver

PLAN_HASH='f9ca7dbc7510ef8f518586e951cb7e86ef97d7897e408f0deb6b5de314c8aae7'
GRANT_HASH='90f30ba52d6f14c73fe9710cf4079e04b9608b8e47ec519190bc60c48e506b91'
QUARANTINE_HASH='fbd4cad7c22edaedd8e04e5e8931c352fc0c4e1c75163b9f3379d6d07879d2bc'


def helpers():
    here=Path(__file__).resolve().parent;repo=here.parent
    files=[here/n for n in ('observed_controller.py','observed_regression.py','regression_inputs.py',
        'independent.py','checkpoint_dev.py','final_controller.py','development_selection.py')]
    files += [repo/n for n in ('worker.py','operational_fixtures.py','quality_review.py','learning_evaluation.py')]
    files += [repo/'evaluation_v2'/n for n in ('fresh_evaluate.py','fresh_cases.py')]
    return {str(p):dev.sha(p) for p in files}


def resolution_approval(proof):
    """Bind evaluation identity, retaining unrelated room inventory as audit only."""
    check_seal(proof,'proof_hash')
    keys=('version','evidence_class','grant_hash','quarantine_hash','prompt_version',
        'old_input_hash_scheme','metadata_hash_scheme','resolver_source_sha256','worker_source_sha256',
        'ready_count','unavailable_count','roomwide_read','original_timestamp_bounds_available',
        'historical_targets_model_input','exact_all22_reproduced','credential_detection_not_exhaustive')
    entries=proof['entries']
    if len(entries) != 22 or len({e['id'] for e in entries}) != 22:
        raise ValueError('all22_resolution_approval_entries_required')
    return seal({'schema':'observed-real22-resolution-approval-v1',
        'evaluation_identity':{k:proof[k] for k in keys},
        'entries':sorted(entries,key=lambda e:e['id']),
        'excluded_audit_fields':['reads.pages','reads.raw_inventory_hash','reads.raw_candidate_count',
                                 'reads.omitted_count','reads.omissions_hash'],
        'all_unprojected_room_reads_retained_in_execution_proof':True},'approval_hash')


def require_resolution_approval(proof,expected_hash):
    approval=resolution_approval(proof)
    if approval['approval_hash'] != expected_hash:
        raise ValueError('approved_original22_resolution_identity_changed_hold_before_generation')
    return approval


def proof_check(proof,grant,groups):
    check_seal(grant,'grant_hash');check_seal(proof,'proof_hash')
    if (grant['grant_hash'] != GRANT_HASH or grant['quarantine_hash'] != QUARANTINE_HASH
            or proof['grant_hash'] != grant['grant_hash'] or proof['quarantine_hash'] != QUARANTINE_HASH
            or proof['historical_targets_model_input'] is not False
            or proof['old_input_hash_scheme'] != resolver.OLD_HASH_SCHEME
            or proof['metadata_hash_scheme'] != resolver.METADATA_HASH_SCHEME
            or proof['resolver_source_sha256'] != dev.sha(resolver.__file__)
            or proof['worker_source_sha256'] != dev.sha(Path(__file__).resolve().parent.parent/'worker.py')
            or len(grant['room_keys']) != 6 or proof['roomwide_read'] is not True
            or proof['original_timestamp_bounds_available'] is not False
            or set(groups['real22']) != {e['id'] for e in proof['entries'] if e['status']=='ready'}):
        raise ValueError('exact_original22_resolver_grant_proof_policy_required')
    original={e['id']:e for e in grant['entries']}
    if len(proof['entries']) != 22 or {e['id'] for e in proof['entries']} != set(original):
        raise ValueError('all22_resolution_entries_required')
    for e in proof['entries']:
        old=original[e['id']]
        if any(e[k] != old[k] for k in ('original_prompt_hash','original_source_hash','rubric_hash')):
            raise ValueError('original_observed_identity_changed')
    count=len(groups['real22'])
    if proof['ready_count'] != count or proof['unavailable_count'] != 22-count:
        raise ValueError('resolution_counts_changed')
    if any(r['room_key'] not in grant['room_keys'] for r in proof['reads']):
        raise ValueError('resolution_read_outside_original_six_rooms')


def prepare(paths,output,expected_candidate_sha,expected_training_plan_hash,authorization,expected_approval_hash):
    if not authorization or not expected_approval_hash:
        raise ValueError('explicit_observed_authorization_and_approved_resolution_hash_required')
    identity,devbinding=require_completed_selection(paths,expected_candidate_sha,expected_training_plan_hash)
    plan=read(paths['plan']);check_seal(plan,'plan_hash')
    grant,quarantine=read(paths['grant']),read(paths['quarantine'])
    check_seal(quarantine,'quarantine_hash');check_seal(grant,'grant_hash')
    if (plan['plan_hash'] != PLAN_HASH or grant['grant_hash'] != GRANT_HASH
            or quarantine['quarantine_hash'] != QUARANTINE_HASH
            or len(quarantine['source_keys']) != 49):
        raise ValueError('fixed_observed_plan_grant_known49_policy_required')
    if any(dev.sha(p) != h for p,h in plan['source_files_raw_sha256'].items()):
        raise ValueError('pinned_observed_source_changed')
    base=devbinding['artifacts']['model_path']
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'evaluation_v2'))
    import fresh_evaluate as fresh
    import operational_fixtures as operational
    from mlx_lm.utils import load_tokenizer
    from kakao_local_import import OwnerRpc
    from history_snapshot import OwnerHistoryQuery
    tokenizer=load_tokenizer(base)  # CPU tokenizer only, no model weights.
    synthetic=fresh.load_suite(plan['observed_synthetic24']['suite_path'])
    if synthetic['suite_hash'] != plan['observed_synthetic24']['suite_hash']:
        raise ValueError('original_synthetic24_suite_changed')
    operational_cases=operational.inputs()
    opinfo=plan['observed_operational4']
    if (utility.legacy_prompt_hash(operational_cases) != opinfo['input_bundle_hash']
            or {c['id']:utility.legacy_prompt_hash(c['input']) for c in operational_cases} != opinfo['case_prompt_hashes']):
        raise ValueError('original_operational4_inputs_changed')
    rpc=OwnerRpc()
    try:resolved=resolver.resolve_inputs(OwnerHistoryQuery(rpc),grant,quarantine)
    finally:rpc.close()
    groups={'real22':resolved['inputs'],
        'synthetic24':{c['id']:c['messages'] for c in synthetic['cases']},
        'operational4':{c['id']:c['input'] for c in operational_cases}}
    proof=resolved['metadata'];proof_check(proof,grant,groups)
    approval=require_resolution_approval(proof,expected_approval_hash)
    ids={'real22':[e['id'] for e in grant['entries']],
         'synthetic24':[c['id'] for c in synthetic['cases']],
         'operational4':list(opinfo['case_prompt_hashes'])}
    preflight=utility.preflight(groups,ids,proof['entries'],tokenizer)
    # Only original rubric fields are consumed; old model outputs are never used.
    oldrubric=json.loads(Path(plan['real22']['rubric_path']).read_text())['heldout']
    if any(utility.legacy_prompt_hash(oldrubric) != e['rubric_hash'] for e in grant['entries']):
        raise ValueError('original_real22_rubric_changed')
    bundle=seal({'groups':groups,'expected_ids':ids,'real_entries':proof['entries'],
        'real_rubric':oldrubric,'grant_entries':grant['entries'],'gap_policy':grant['gap_policy']},'bundle_hash')
    output=Path(output).resolve();output.mkdir(mode=0o700,parents=True,exist_ok=False)
    files={str(Path(v).resolve()):dev.sha(v) for k,v in paths.items()}
    files.update(devbinding['artifacts']['tokenizer_file_hashes'])
    for n,h in identity['file_hashes'].items():files[str(Path(identity['path'])/n)]=h
    binding=seal({'schema':'observed-regression-bounded-binding-v1','frozen_at_utc':now(),
        'authorization':authorization,'plan_hash':PLAN_HASH,'grant_hash':grant['grant_hash'],
        'quarantine_hash':QUARANTINE_HASH,'quarantine_source_count':49,'resolution_proof_hash':proof['proof_hash'],
        'resolution_approval_hash':approval['approval_hash'],
        'output':str(output),'bundle_hash':bundle['bundle_hash'],'expected_ids':ids,'preflight':preflight,
        'ready_input_hashes':{k:{i:utility.legacy_prompt_hash(m) for i,m in v.items()} for k,v in groups.items()},
        'real_availability':proof['entries'],'paths':{k:str(Path(v).resolve()) for k,v in paths.items()},
        'selected_adapter':identity['path'],'selected_identity_hash':identity['identity_hash'],
        'candidate_weight_sha256':expected_candidate_sha,'training_plan_hash':expected_training_plan_hash,
        'development_selection_hash':identity['checkpoint_selection_hash'],'model_path':base,
        'base_model_identity':devbinding['artifacts']['base_model_identity'],
        'file_hashes':files,'helper_sha256':helpers(),'libraries':dev.libraries(),
        'shared_runtime_sha256':dev.shared_runtime_fingerprints(),
        'resource_budget':{'seconds':1200,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3},
        'budget_estimate':{'expected_original_cases':50,'maximum_generated_outputs':100,
            'estimated_seconds':300,'estimate_not_measurement':True},
        'evidence_class':'observed_regression_only','fresh_gate_evidence':False,
        'generation_output_tokens':utility.OUTPUT_TOKENS,'max_input_tokens':3904,
        'one_global_quality_winner':True,'prior_reference_included':False,
        'automatic_retry_allowed':False,'activation_authorized':False},'binding_hash')
    write_private(output/'bindings.json',binding);write_private(output/'real-resolution-proof.json',proof)
    write_private(output/'real-resolution-approval.json',approval)
    return binding,bundle


def verify(binding,expected_hash):
    check_seal(binding,'binding_hash')
    if (binding['binding_hash'] != expected_hash or binding['plan_hash'] != PLAN_HASH
            or binding['grant_hash'] != GRANT_HASH or binding['quarantine_hash'] != QUARANTINE_HASH
            or binding['quarantine_source_count'] != 49 or binding['evidence_class'] != 'observed_regression_only'
            or binding['fresh_gate_evidence'] is not False or binding['one_global_quality_winner'] is not True
            or binding['prior_reference_included'] is not False
            or binding['generation_output_tokens'] != utility.OUTPUT_TOKENS
            or binding['max_input_tokens'] != 3904 or binding['helper_sha256'] != helpers()
            or binding['resource_budget'] != {'seconds':1200,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3}
            or binding['libraries'] != dev.libraries()
            or binding['shared_runtime_sha256'] != dev.shared_runtime_fingerprints()
            or any(dev.sha(p) != h for p,h in binding['file_hashes'].items())
            or dev.model_identity(binding['model_path']) != binding['base_model_identity']):
        raise ValueError('frozen_observed_binding_artifact_or_runtime_changed')
    identity,_=require_completed_selection(binding['paths'],binding['candidate_weight_sha256'],binding['training_plan_hash'])
    if (identity['path'] != binding['selected_adapter'] or identity['identity_hash'] != binding['selected_identity_hash']
            or identity['checkpoint_selection_hash'] != binding['development_selection_hash']):
        raise ValueError('same_single_global_quality_winner_required')


def preflight_output(folder):
    folder=Path(folder)
    names=('attempt.json','real-report.json','real-report-unblind.json','synthetic-report.json',
        'synthetic-report-unblind.json','operational4','outputs-complete.json','completion.json',
        'failure.json','observed-runtime.log','observed-resources.json')
    if any((folder/n).exists() for n in names):
        raise ValueError('existing_observed_attempt_or_outputs_no_retry_no_overwrite')


def publish_real(cache,bundle,binding):
    originals={e['id']:e for e in bundle['grant_entries']};rows=[];mapping={}
    rubric=bundle['real_rubric'];adapter=binding['selected_adapter']
    for entry in bundle['real_entries']:
        old=originals[entry['id']]
        row={'id':entry['id'],'status':entry['status'],'source':'observed_real_history',
            'evaluation_group':old.get('evaluation_group'),
            'original_source_hash':entry['original_source_hash'],'original_prompt_hash':entry['original_prompt_hash'],
            'rubric_hash':entry['rubric_hash'],'rubric':rubric,'same_input':entry['status']=='ready','outputs':[]}
        if entry['status']=='unavailable':row['reason']=entry['reason']
        else:
            messages=bundle['groups']['real22'][entry['id']]
            source={k:entry[k] for k in ('current_raw_content_hash','current_source_keys_hash','current_prompt_hash')}
            row.update(source_hash=digest(source),current_source_evidence=source,
                       prompt_hash=entry['current_prompt_hash'],comparison_complete=True)
            methods=[('base',None),('trained',adapter)];secrets.SystemRandom().shuffle(methods)
            mapping[entry['id']]={}
            for n,(method,path) in enumerate(methods,1):
                text=cache.generate_text(messages,adapter_path=path,max_tokens=192,temperature=0.)
                label='option_'+str(n)
                row['outputs'].append({'label':label,'text':text,'output_hash':utility.legacy_prompt_hash(text)})
                mapping[entry['id']][label]={'method':method}
        rows.append(row)
    if cache.remaining:raise ValueError('incomplete_observed_real_publication')
    folder=Path(binding['output']);mapping_path=folder/'real-report-unblind.json'
    write_private(mapping_path,seal({'binding_hash':binding['binding_hash'],'mapping':mapping},'mapping_hash'))
    ready=len(bundle['groups']['real22'])
    report=seal({'report_version':'observed-real22-two-method-v1','binding_hash':binding['binding_hash'],
        'evidence_class':'observed_regression','complete':True,'expected_case_count':22,
        'ready_case_count':ready,'unavailable_case_count':22-ready,'output_count':2*ready,
        'complete_same_input_22':ready==22,'comparison_complete':ready==22,
        'observed_status':'complete' if ready==22 else 'hold_incomplete_same_input_real22',
        'cases':rows,'generation_settings':{'temperature':0.,'enable_thinking':False,'max_tokens':192,'max_input_tokens':3904},
        'gap_policy':bundle['gap_policy'],'gap_policy_hash':utility.legacy_prompt_hash(bundle['gap_policy']),
        'mapping_file_sha256':dev.sha(mapping_path),'fresh_gate_evidence':False,
        'activation_authorized':False},'report_hash')
    write_private(folder/'real-report.json',report)
    return report


def validate_publication(binding):
    folder=Path(binding['output']);real=read(folder/'real-report.json');check_seal(real,'report_hash')
    if (real['binding_hash'] != binding['binding_hash'] or len(real['cases']) != 22
            or {r['id'] for r in real['cases']} != set(binding['expected_ids']['real22'])
            or real['ready_case_count'] != binding['preflight']['real22']['ready_case_count']
            or real['unavailable_case_count'] != 22-real['ready_case_count']
            or real['output_count'] != 2*real['ready_case_count']
            or dev.sha(folder/'real-report-unblind.json') != real['mapping_file_sha256']):
        raise ValueError('incomplete_observed_real22_accounting')
    expected={e['id']:e for e in binding['real_availability']}
    for row in real['cases']:
        entry=expected[row['id']]
        if (row['status'] != entry['status']
                or any(row[k] != entry[k] for k in ('original_source_hash','original_prompt_hash','rubric_hash'))
                or (row['status']=='unavailable' and row.get('reason') != entry['reason'])
                or len(row['outputs']) != (2 if row['status']=='ready' else 0)):
            raise ValueError('changed_observed_real_availability')
    if (real['complete_same_input_22'] is not (real['ready_case_count']==22)
            or real['comparison_complete'] is not (real['ready_case_count']==22)
            or real['fresh_gate_evidence'] is not False):
        raise ValueError('observed_real_complete_or_evidence_claim_changed')
    synthetic=read(folder/'synthetic-report.json');operational=read(folder/'operational4/blind-report.json')
    for group,report,count in [('synthetic24',synthetic,24),('operational4',operational,4)]:
        if (len(report['cases']) != count or {r['id'] for r in report['cases']} != set(binding['expected_ids'][group])
                or any(len(r['outputs']) != 2 for r in report['cases'])):
            raise ValueError('incomplete_observed_group_publication')
    # Legacy helpers use producer digests, real report deliberately matches them.
    for report in (real,synthetic,operational):
        for row in report['cases']:
            if (len({o['label'] for o in row['outputs']}) != len(row['outputs'])
                    or any(not o['text'].strip() or utility.legacy_prompt_hash(o['text']) != o['output_hash'] for o in row['outputs'])):
                raise ValueError('observed_output_hash_or_option_changed')
    if not synthetic['comparison_complete'] or not synthetic['complete'] or not operational['complete']:
        raise ValueError('incomplete_observed_helper_report')
    files=('real-report.json','real-report-unblind.json','synthetic-report.json',
           'synthetic-report-unblind.json','operational4/blind-report.json','operational4/mapping.json','operational4/metadata.json')
    return {n:dev.sha(folder/n) for n in files}


def child(binding_path,input_path,expected_hash):
    binding=read(binding_path);verify(binding,expected_hash)
    folder=Path(binding['output']);attempt=read(folder/'attempt.json');check_seal(attempt,'attempt_hash')
    if attempt['binding_hash'] != expected_hash:raise ValueError('observed_owner_attempt_required')
    if any((folder/n).exists() for n in ('real-report.json','synthetic-report.json','operational4','outputs-complete.json','failure.json','completion.json')):
        raise ValueError('existing_partial_observed_child_no_retry')
    bundle=read(input_path);check_seal(bundle,'bundle_hash')
    if bundle['bundle_hash'] != binding['bundle_hash']:raise ValueError('exact_transient_observed_input_bundle_required')
    from mlx_lm.utils import load_tokenizer
    tokenizer=load_tokenizer(binding['model_path'])
    if utility.preflight(bundle['groups'],bundle['expected_ids'],bundle['real_entries'],tokenizer) != binding['preflight']:
        raise ValueError('observed_complete_preflight_changed')
    if {k:{i:utility.legacy_prompt_hash(m) for i,m in v.items()} for k,v in bundle['groups'].items()} != binding['ready_input_hashes']:
        raise ValueError('observed_ready_input_identity_changed')
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent));sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'evaluation_v2'))
    import fresh_evaluate as fresh
    import operational_fixtures as operational
    import mlx.core as mx
    engine=worker_module(Path(__file__).resolve().parent.parent/'worker.py').ReplyWorker();engine.path=Path(binding['model_path'])
    plan=read(binding['paths']['plan'])
    for group in utility.COUNTS:
        cache=utility.generate_cached(engine,bundle['groups'][group],binding['selected_adapter'],group,mx.clear_cache)
        if group=='real22':publish_real(cache,bundle,binding)
        elif group=='synthetic24':utility.publish_existing_synthetic(fresh,cache,tokenizer,binding['selected_adapter'],
            folder/'synthetic-report.json',plan['observed_synthetic24']['suite_path'])
        else:utility.publish_existing_operational(operational,cache,binding['model_path'],binding['selected_adapter'],folder/'operational4')
    artifacts=validate_publication(binding)
    write_private(folder/'outputs-complete.json',seal({'binding_hash':expected_hash,'file_sha256':artifacts,
        'group_counts':binding['preflight'],'observed_real_status':'complete' if len(bundle['groups']['real22'])==22 else 'hold_incomplete_same_input_real22',
        'fresh_gate_evidence':False,'activation_authorized':False},'outputs_hash'))
    return {'status':'observed_outputs_complete','binding_hash':expected_hash}


def execute(binding,bundle,args):
    verify(binding,binding['binding_hash']);preflight_output(binding['output'])
    if not args.pause_daemon or not args.authorize_execution:
        raise ValueError('explicit_sole_owner_authorization_and_daemon_pause_required')
    args.output=Path(binding['output'])
    write_private(args.output/'attempt.json',seal({'binding_hash':binding['binding_hash'],
        'owner_pid':os.getpid(),'started_at_utc':now(),'automatic_retry_allowed':False},'attempt_hash'))
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
    import personalization as guard
    import bounded_pilot as daemon
    try:
        with guard.private_staging('inboxd-observed-inputs-') as (stage,_):
            inputs=Path(stage)/'inputs.json';write_private(inputs,bundle)
            budget=binding['resource_budget']
            with daemon.daemon_pause(args):
                with (args.output/'observed-runtime.log').open('x') as log:
                    os.chmod(log.name,0o600)
                    guard.guarded_training_run([sys.executable,str(Path(__file__).resolve()),'_child',
                        '--bindings',str(args.output/'bindings.json'),'--inputs',str(inputs),
                        '--expected-binding-hash',binding['binding_hash']],env=os.environ,stdout=log,pass_fds=(),
                        max_runtime_seconds=budget['seconds'],max_rss_bytes=budget['rss_bytes'],
                        max_swap_bytes=budget['swap_growth_bytes'],resource_report_path=args.output/'observed-resources.json')
        outputs=read(args.output/'outputs-complete.json');check_seal(outputs,'outputs_hash')
        if (outputs['binding_hash'] != binding['binding_hash']
                or read(args.output/'observed-resources.json')['status'] != 'complete'
                or any(dev.sha(args.output/p) != h for p,h in outputs['file_sha256'].items())):
            raise ValueError('incomplete_or_changed_observed_outputs')
        write_private(args.output/'completion.json',seal({'status':'awaiting_observed_blind_review',
            'binding_hash':binding['binding_hash'],'outputs_hash':outputs['outputs_hash'],
            'daemon_restored_and_readiness_verified':True,'transient_input_staging_removed':True,
            'observed_real_status':outputs['observed_real_status'],'fresh_gate_evidence':False,
            'activation_performed':False},'completion_hash'))
    except BaseException as error:
        write_private(args.output/'failure.json',{'status':'hold_no_retry_no_activation',
            'binding_hash':binding['binding_hash'],'exception_class':type(error).__name__,
            'partial_results_are_not_complete_evidence':True});raise
    return {'status':'observed_complete_daemon_restored','binding_hash':binding['binding_hash'],
            'fresh_gate_evidence':False,'activation_authorized':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('command',choices=['run','_child'])
    for name in ('plan','grant','quarantine','selected-identity','selection','dev-summary','dev-metadata',
        'dev-verdicts','dev-rule','dev-bindings','output','bindings','inputs','inboxd','daemon-lock','daemon-binary'):
        parser.add_argument('--'+name,type=Path)
    for name in ('expected-candidate-sha','expected-training-plan-hash','authorization','expected-binding-hash','expected-resolution-approval-hash'):
        parser.add_argument('--'+name)
    parser.add_argument('--pause-daemon',action='store_true');parser.add_argument('--authorize-execution',action='store_true')
    args=parser.parse_args()
    if args.command=='_child':result=child(args.bindings,args.inputs,args.expected_binding_hash)
    else:
        if not args.authorize_execution or not args.pause_daemon:raise ValueError('explicit_authorized_sole_owner_launch_required_before_resolution')
        keys=('plan','grant','quarantine','selected_identity','selection','dev_summary','dev_metadata',
              'dev_verdicts','dev_rule','dev_bindings')
        binding,bundle=prepare({k:getattr(args,k) for k in keys},args.output,args.expected_candidate_sha,
                               args.expected_training_plan_hash,args.authorization,args.expected_resolution_approval_hash)
        print(json.dumps({'phase':'observed_cpu_binding_frozen_before_generation','binding_hash':binding['binding_hash'],
            'group_counts':binding['preflight'],'budget_estimate':binding['budget_estimate']}),flush=True)
        result=execute(binding,bundle,args)
    print(json.dumps(result))


if __name__=='__main__':main()
