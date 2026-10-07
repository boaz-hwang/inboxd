"""CPU preparation and explicitly authorized bounded Dev24 2x2 diagnostic.

No training records, final inputs, checkpoint reselection or activation. Every
method is freshly generated; the fixed step152 adapter is not prompt-retrained.
"""
import argparse
from copy import deepcopy
import gc
import os
from pathlib import Path
import sys

import checkpoint_dev as dev
from final_controller import require_completed_selection
from independent import (read, seal, check_seal, digest, now, write_private,
    load_suite, GENERATION_POLICY, worker_module, review_view, freeze_verdicts,
    summarize)
from multi_adapter import generate_multi
from prompt_instruction_experiment import compile_final_instruction, VARIANT, FINAL_INSTRUCTION

METHODS = ('base_v4', 'adapter152_v4', 'base_instruction_v1', 'adapter152_instruction_v1')
CANDIDATE = METHODS[-1]
SUITE_NAME = 'dev24-instruction-only-2x2-frozen.json'
SELECTED_SHA = '0bde3cdf51f4afa9baf773e26f5dff5bdbd8c86ff12e9647831ed46a3d70d6e6'
PLAN_HASH = '32d14c8f870d2d201e3a50958960def5a4d2e9c7f3378b694f678fc415d9bd79'
SELECTION_KEYS = {'selected_identity', 'selection', 'dev_summary', 'dev_metadata',
                  'dev_verdicts', 'dev_bindings', 'dev_rule'}
THRESHOLDS = {'max_clear_failure_cases': 2, 'max_uncertain_cases': 0,
              'min_mean_usefulness': 3.025}


def helpers():
    names = ('prompt_diagnostic.py', 'prompt_instruction_experiment.py',
        'checkpoint_dev.py', 'final_controller.py', 'final_inputs.py',
        'independent.py', 'multi_adapter.py', 'development_selection.py', 'selected_adapter.py')
    return {n: dev.sha(Path(__file__).with_name(n)) for n in names}


def build_suite(original):
    if (original['suite_hash'] != dev.DEV_HASH or original['case_count'] != 24
            or original['split'] != 'development_diagnostic'):
        raise ValueError('exact_existing_development_only')
    cases = []
    for source in original['cases']:
        v4 = source['inputs']['production_base_v4']
        if any(messages != v4 for messages in source['inputs'].values()):
            raise ValueError('same_original_v4_representation_required')
        changed = compile_final_instruction(v4)
        if changed == v4:
            raise ValueError('predeclared_instruction_must_differ')
        case = {k: deepcopy(source[k]) for k in ('id','category','request','rubric','request_hash','rubric_hash')}
        case['inputs'] = {METHODS[0]:deepcopy(v4),METHODS[1]:deepcopy(v4),
                          METHODS[2]:deepcopy(changed),METHODS[3]:deepcopy(changed)}
        case['input_hashes'] = {m:digest(v) for m,v in case['inputs'].items()}
        cases.append(case)
    compiler = original['compilers']['production_base_v4']
    variant = {**compiler, 'experimental_final_instruction_sha256':dev.sha(Path(__file__).with_name('prompt_instruction_experiment.py')),
               'variant':VARIANT,'final_instruction_hash':digest(FINAL_INSTRUCTION)}
    return seal({'schema':'independent-compiled-v1','split':'development_diagnostic',
        'raw_hash':original['raw_hash'],'source_dev_suite_hash':original['suite_hash'],
        'case_count':24,'candidate':CANDIDATE,'comparators':list(METHODS[:-1]),
        'compilers':{METHODS[0]:compiler,METHODS[1]:compiler,METHODS[2]:variant,METHODS[3]:variant},
        'cases':cases,'policy':original['policy'],'general_rubric':original['general_rubric'],
        'supplemental_policy':original.get('supplemental_policy'),
        'provenance':{'development_previously_observed':True,'only_final_user_instruction_changed':True,
                      'same_raw_cases_and_rubrics':True,'fresh_generation_all_four_methods':True},
        'generation_policy':GENERATION_POLICY,
        'evaluation_helper_sha256':dev.sha(Path(__file__).with_name('independent.py'))},'suite_hash')


def experiment_suite(path):
    if Path(path).name != SUITE_NAME:
        raise ValueError('development_experiment_filename_required_before_read')
    suite = load_suite(path)
    if (suite['case_count'] != 24 or suite['source_dev_suite_hash'] != dev.DEV_HASH
            or suite['split'] != 'development_diagnostic' or suite['candidate'] != CANDIDATE
            or tuple(suite['compilers']) != METHODS):
        raise ValueError('exact_four_method_development_required')
    for case in suite['cases']:
        old = case['inputs'][METHODS[0]]
        changed = compile_final_instruction(old)
        if (case['inputs'][METHODS[1]] != old
                or case['inputs'][METHODS[2]] != changed
                or case['inputs'][METHODS[3]] != changed):
            raise ValueError('instruction_only_pair_identity_required')
    return suite


def preflight(suite, tokenizer):
    lengths = {}
    for case in suite['cases']:
        lengths[case['id']] = {}
        for method in METHODS:
            tokens = tokenizer.apply_chat_template(case['inputs'][method],
                add_generation_prompt=True,enable_thinking=False,return_dict=False)
            if len(tokens) > 3904:
                raise ValueError('whole_development_budget_exceeded_no_truncation')
            lengths[case['id']][method] = len(tokens)
    return {'case_count':24,'method_count':4,'output_count':96,
        'max_input_tokens':max(v for row in lengths.values() for v in row.values()),
        'output_tokens':192,'input_token_counts':lengths}


def prepare(paths, output, tokenizer=None):
    if set(paths) != SELECTION_KEYS | {'original_suite','worker'}:
        raise ValueError('development_only_exact_path_contract_required')
    original = dev.dev_suite(paths['original_suite'])
    identity, old_binding = require_completed_selection(paths, SELECTED_SHA, PLAN_HASH)
    if identity['step'] != 152 or identity['method'] != 'checkpoint_2_v4':
        raise ValueError('fixed_step152_no_reselection')
    if dev.sha(paths['worker']) != original['compilers']['production_base_v4']['source_sha256']:
        raise ValueError('unchanged_v4_worker_required')
    suite = build_suite(original)
    if tokenizer is None:
        from mlx_lm.utils import load_tokenizer
        tokenizer = load_tokenizer(old_binding['artifacts']['model_path'])
    counts = preflight(suite, tokenizer)
    output = Path(output).resolve();output.mkdir(mode=0o700,parents=True,exist_ok=False)
    suite_path = output / SUITE_NAME
    write_private(suite_path,suite)
    file_hashes = {str(Path(p).resolve()):dev.sha(p) for p in paths.values()}
    for name, expected in identity['file_hashes'].items():
        file_hashes[str(Path(identity['path'])/name)] = expected
    binding = seal({'schema':'development-instruction-2x2-bindings-v1','frozen_at_utc':now(),
        'suite_hash':suite['suite_hash'],'suite_path':str(suite_path),'output':str(output),
        'paths':{k:str(Path(p).resolve()) for k,p in paths.items()},
        'generator_sha256':dev.sha(Path(__file__).with_name('multi_adapter.py')),
        'generation_policy':GENERATION_POLICY,
        'method_adapters':{METHODS[0]:None,METHODS[1]:identity['path'],METHODS[2]:None,METHODS[3]:identity['path']},
        'complete_input_preflight':counts,'diagnostic_thresholds':THRESHOLDS,
        'activation_authorized':False,'checkpoint_reselection_allowed':False,
        'old_outputs_reused':False,'diagnostic_only':True,
        'interaction_note':'The same v3-trained152 adapter is evaluated under a changed instruction; no new-prompt training.',
        'resource_budget':{'seconds':900,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3},
        'artifacts':{'training_plan_hash':PLAN_HASH,'fixed_weight_sha256':SELECTED_SHA,
            'selected_identity_hash':identity['identity_hash'],'selection_hash':identity['checkpoint_selection_hash'],
            'model_path':old_binding['artifacts']['model_path'],
            'base_model_identity':old_binding['artifacts']['base_model_identity'],
            'file_hashes':file_hashes,'helper_fingerprints':helpers(),
            'library_versions':dev.libraries(),'shared_runtime_fingerprints':dev.shared_runtime_fingerprints()}},'binding_hash')
    write_private(output/'bindings.json',binding)
    return {'binding_hash':binding['binding_hash'],'suite_hash':suite['suite_hash'],
            'case_count':24,'method_count':4,'output_count':96,'max_input_tokens':counts['max_input_tokens']}


def verify(binding, expected_hash):
    check_seal(binding,'binding_hash');a=binding['artifacts']
    if (binding['binding_hash'] != expected_hash or binding['generation_policy'] != GENERATION_POLICY
            or binding['diagnostic_thresholds'] != THRESHOLDS
            or binding['activation_authorized'] is not False
            or binding['checkpoint_reselection_allowed'] is not False
            or binding['resource_budget'] != {'seconds':900,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3}
            or binding['old_outputs_reused'] is not False):
        raise ValueError('explicit_frozen_diagnostic_binding_required')
    if (a['helper_fingerprints'] != helpers() or a['library_versions'] != dev.libraries()
            or a['shared_runtime_fingerprints'] != dev.shared_runtime_fingerprints()
            or any(dev.sha(p) != h for p,h in a['file_hashes'].items())
            or dev.model_identity(a['model_path']) != a['base_model_identity']):
        raise ValueError('frozen_diagnostic_provenance_changed')
    identity,_ = require_completed_selection(binding['paths'],SELECTED_SHA,PLAN_HASH)
    if (identity['step'] != 152 or identity['identity_hash'] != a['selected_identity_hash']
            or binding['method_adapters'] != dict(zip(METHODS,[None,identity['path'],None,identity['path']]))):
        raise ValueError('fixed_global_step152_pair_required')
    suite = experiment_suite(binding['suite_path'])
    if suite['suite_hash'] != binding['suite_hash']:
        raise ValueError('frozen_diagnostic_suite_changed')
    rebuilt = build_suite(dev.dev_suite(binding['paths']['original_suite']))
    if rebuilt != suite:
        raise ValueError('exact_existing_raw_cases_rubrics_and_instruction_required')
    return suite


def output_preflight(binding):
    names = ('attempt.json','report.json','report-unblind.json','outputs-complete.json',
             'completion.json','failure.json','runtime.log','resources.json')
    if any((Path(binding['output'])/n).exists() for n in names):
        raise ValueError('existing_or_partial_attempt_no_retry_no_overwrite')


def child(binding_path, expected_hash):
    binding=read(binding_path);suite=verify(binding,expected_hash);folder=Path(binding['output'])
    attempt=read(folder/'attempt.json');check_seal(attempt,'attempt_hash')
    if attempt['binding_hash'] != expected_hash:
        raise ValueError('owner_attempt_required')
    if any((folder/n).exists() for n in ('report.json','report-unblind.json','outputs-complete.json','completion.json','failure.json')):
        raise ValueError('existing_partial_child_no_retry')
    from mlx_lm.utils import load_tokenizer
    tokenizer=load_tokenizer(binding['artifacts']['model_path'])
    if preflight(suite,tokenizer) != binding['complete_input_preflight']:
        raise ValueError('exact_preflight_changed')
    import mlx.core as mx
    engine=worker_module(binding['paths']['worker']).ReplyWorker()
    engine.path=Path(binding['artifacts']['model_path'])
    try:
        outputs=dev.generate_method_major(engine,tokenizer,suite,binding['method_adapters'],mx.clear_cache)
    finally:
        engine.models.clear();gc.collect();mx.clear_cache()
    cache=dev.FrozenOutputCache(outputs)
    result=generate_multi(cache,tokenizer,binding_path,folder/'report.json',suite_path=binding['suite_path'],
        artifacts={'method_major_clean_reset':True,'fresh_four_methods':True,'fixed_step152':True})
    if len(cache.used) != 96 or len(outputs) != 96:
        raise ValueError('all96_outputs_required')
    write_private(folder/'outputs-complete.json',seal({'binding_hash':expected_hash,
        'report_hash':result['report_hash'],'output_count':96,'activation_authorized':False},'outputs_hash'))
    return result


def completed_run(binding):
    folder=Path(binding['output']);done=read(folder/'completion.json');check_seal(done,'completion_hash')
    outputs=read(folder/'outputs-complete.json');check_seal(outputs,'outputs_hash')
    suite,report,views=review_view(binding['suite_path'],folder/'report.json')
    if (done.get('status') != 'diagnostic_complete_daemon_restored'
            or done['binding_hash'] != binding['binding_hash']
            or suite['suite_hash'] != binding['suite_hash']
            or report['generation_artifacts']['binding_hash'] != binding['binding_hash']
            or outputs['binding_hash'] != binding['binding_hash']
            or outputs['output_count'] != 96 or outputs['report_hash'] != report['report_hash']
            or done['report_hash'] != report['report_hash']
            or dev.sha(folder/'resources.json') != done['resource_report_sha256']
            or read(folder/'resources.json').get('status') != 'complete'
            or dev.sha(folder/'report-unblind.json') != report['mapping_file_sha256']):
        raise ValueError('complete_guarded_restored_run_required')
    return suite,report,views


def run(args):
    binding=read(args.bindings);verify(binding,args.expected_binding_hash);output_preflight(binding)
    if not args.pause_daemon:raise ValueError('verified_daemon_pause_required')
    args.output=Path(binding['output'])
    if Path(args.bindings).resolve().parent != args.output:
        raise ValueError('private_binding_directory_required')
    write_private(args.output/'attempt.json',seal({'binding_hash':binding['binding_hash'],
        'started_at_utc':now(),'automatic_retry_allowed':False},'attempt_hash'))
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
    import bounded_pilot as lifecycle
    import personalization as guard
    budget=binding['resource_budget']
    try:
        with lifecycle.daemon_pause(args):
            with (args.output/'runtime.log').open('x') as log:
                os.chmod(log.name,0o600)
                guard.guarded_training_run([sys.executable,str(Path(__file__).resolve()),'_child',
                    '--bindings',str(args.bindings),'--expected-binding-hash',args.expected_binding_hash],
                    env=os.environ,stdout=log,pass_fds=(),max_runtime_seconds=budget['seconds'],
                    max_rss_bytes=budget['rss_bytes'],max_swap_bytes=budget['swap_growth_bytes'],
                    resource_report_path=args.output/'resources.json')
        suite,report,_=review_view(binding['suite_path'],args.output/'report.json')
        outputs=read(args.output/'outputs-complete.json');check_seal(outputs,'outputs_hash')
        if outputs['output_count'] != 96 or outputs['report_hash'] != report['report_hash']:
            raise ValueError('partial_outputs_hold')
        resources=read(args.output/'resources.json')
        if resources.get('status') != 'complete':raise ValueError('resource_guard_incomplete')
        write_private(args.output/'completion.json',seal({'status':'diagnostic_complete_daemon_restored',
            'binding_hash':binding['binding_hash'],'report_hash':report['report_hash'],
            'resource_report_sha256':dev.sha(args.output/'resources.json'),
            'activation_authorized':False},'completion_hash'))
        completed_run(binding)
    except BaseException as exc:
        write_private(args.output/'failure.json',seal({'binding_hash':binding['binding_hash'],
            'status':'hold_no_retry_no_activation','error_class':type(exc).__name__},'failure_hash'))
        raise
    return {'status':'diagnostic_complete_daemon_restored','binding_hash':binding['binding_hash']}


def prepare_packets(binding_path, output):
    binding=read(binding_path);experiment_suite(binding['suite_path'])
    suite,report,views=completed_run(binding)
    output=Path(output);output.mkdir(mode=0o700,parents=True,exist_ok=False)
    result=[]
    for name,owner,rows in [('root','/root',views[:12]),('dataset','/root/dataset_expansion',views[12:])]:
        packet=seal({'schema':'blind-development-instruction-review-v1','suite_hash':suite['suite_hash'],
            'report_hash':report['report_hash'],'assigned_reviewer':owner,'reviewer':'agent_delegated',
            'mapping_included':False,'development_previously_observed':True,'case_count':12,'cases':rows,
            'instructions':'Judge all four options with unchanged rubrics, semantic dimensions and1–5 usefulness/style; rank all options allowing ties. Freeze all96 judgments before mapping access.'},'packet_hash')
        write_private(output/(name+'-packet.json'),packet)
        write_private(output/(name+'-judgments-template.json'),{'reviewer':'agent_delegated',
            'assigned_reviewer':owner,'packet_hash':packet['packet_hash'],'mapping_seen_before_freeze':False,
            'cases':{c['id']:{'options':{o['label']:{'output_hash':o['output_hash'],
                'role':None,'fact':None,'consent':None,'response':None,'usefulness':None,'style':None,'reason':''}
                for o in c['outputs']},'preference':[]} for c in rows}})
        result.append({'reviewer':owner,'case_count':12,'packet_hash':packet['packet_hash']})
    return {'packets':result,'mapping_read':False}


def merge_reviews(binding_path, packet_dir, root_judgments, dataset_judgments, output):
    binding=read(binding_path);completed_run(binding);merged={}
    for name,owner,path in [('root','/root',root_judgments),('dataset','/root/dataset_expansion',dataset_judgments)]:
        packet=read(Path(packet_dir)/(name+'-packet.json'));check_seal(packet,'packet_hash');j=read(path)
        ids={c['id'] for c in packet['cases']}
        if (packet['suite_hash'] != binding['suite_hash'] or packet['assigned_reviewer'] != owner
                or j.get('assigned_reviewer') != owner or j.get('packet_hash') != packet['packet_hash']
                or j.get('mapping_seen_before_freeze') is not False or j.get('reviewer') != 'agent_delegated'
                or set(j['cases']) != ids or merged.keys() & ids):
            raise ValueError('complete_disjoint_blind_review_required')
        merged.update(j['cases'])
    combined=Path(output).with_name(Path(output).stem+'-combined.json')
    write_private(combined,{'reviewer':'agent_delegated','mapping_seen_before_freeze':False,'cases':merged})
    return freeze_verdicts(binding['suite_path'],Path(binding['output'])/'report.json',combined,output)


def freeze_summary(binding_path, verdicts, output):
    binding=read(binding_path);completed_run(binding)
    # Independent summarize first validates a frozen complete verdict set, then reads mapping.
    result=summarize(binding['suite_path'],Path(binding['output'])/'report.json',verdicts)
    metrics=result['methods'];diagnostics={}
    for method,q in metrics.items():
        diagnostics[method]={'thresholds_met':q['clear_semantic_failure_cases']<=2
            and q['unresolved_semantic_cases']==0 and q['usefulness_mean']>=3.025,
            'clear_failures':q['clear_semantic_failure_cases'],'uncertainty':q['unresolved_semantic_cases'],
            'usefulness_mean':q['usefulness_mean'],'style_mean':q['style_mean']}
    deltas={}
    for a,b in [(METHODS[2],METHODS[0]),(METHODS[3],METHODS[1]),(METHODS[3],METHODS[2]),(METHODS[1],METHODS[0])]:
        deltas[a+'_minus_'+b]={k:diagnostics[a][k]-diagnostics[b][k] for k in
            ('clear_failures','uncertainty','usefulness_mean','style_mean')}
    result.update(development_only=True,activation_authorized=False,checkpoint_reselection_allowed=False,
        diagnostic_thresholds=THRESHOLDS,diagnostics=diagnostics,factorial_deltas=deltas,
        generic_gate_unused=True,gate='diagnostic_only',gate_reasons=[],binding_hash=binding['binding_hash'])
    result=seal(result,'summary_hash');write_private(output,result)
    return {'summary_hash':result['summary_hash'],'activation_authorized':False,'diagnostics':diagnostics}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['prepare','run','_child','packets','merge','summary'])
    for name in ('paths','output','bindings','inboxd','daemon-lock','daemon-binary','packet-dir',
                 'root-judgments','dataset-judgments','verdicts'):
        p.add_argument('--'+name,type=Path)
    p.add_argument('--expected-binding-hash');p.add_argument('--pause-daemon',action='store_true');args=p.parse_args()
    if args.command=='prepare':result=prepare(read(args.paths),args.output)
    elif args.command=='run':result=run(args)
    elif args.command=='_child':result=child(args.bindings,args.expected_binding_hash)
    elif args.command=='packets':result=prepare_packets(args.bindings,args.output)
    elif args.command=='merge':result=merge_reviews(args.bindings,args.packet_dir,args.root_judgments,args.dataset_judgments,args.output)
    else:result=freeze_summary(args.bindings,args.verdicts,args.output)
    import json
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':main()
