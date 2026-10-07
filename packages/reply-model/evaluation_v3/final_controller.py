"""Explicitly authorized final generation; CPU preparation never activates.

Real input suites exist only in private transient staging. This module makes no
quality/gate decision and never reads a final mapping for independent reviewers.
The prior adapter is diagnostic only. Use one globally selected candidate.
"""
import argparse
from collections import defaultdict, deque
import gc
import os
from pathlib import Path
import sys

from independent import (read, seal, check_seal, digest, write_private, now,
                         load_suite, GENERATION_POLICY, worker_module)
import checkpoint_dev as dev
from development_selection import select_checkpoint
from final_inputs import fetch_inputs
from multi_adapter import generate_multi

METHODS = ('production_base_v4', 'adapter_v4', 'prior_adapter_v4')
SYNTHETIC_NAME = 'final-compiled-v4-three-method-frozen.json'
SYNTHETIC_HASH = '3ff9c55ce246e6a1c4255f953b835f3c6ccc5745d4aa2f6ba7d1ad7df26ab1db'
ADMISSION_HASH = 'f8d6b617a8056db642728f4eae3c91a794dd2985bca3b8c1efb5994010b1c2e9'
REAL_PROTOCOL_HASH = '9f297d2a7acd6f7b335203b715ca12acbe0ebe464ba2e54c66503c25180e684e'
COMPARISON_HASH = '23237463173cca7e815d453fef936602df1e4f56825a8a648a87ea8b9bc1e2e9'


def final_suite(path):
    if Path(path).name != SYNTHETIC_NAME:
        raise ValueError('exact_sealed_final_filename_required_before_read')
    suite = load_suite(path)
    if (suite['suite_hash'] != SYNTHETIC_HASH or suite['case_count'] != 48
            or set(suite['compilers']) != set(METHODS) or suite['candidate'] != 'adapter_v4'):
        raise ValueError('frozen_final48_three_methods_required')
    return suite


def final_helpers():
    names = ('final_controller.py', 'final_inputs.py', 'multi_adapter.py',
             'independent.py', 'checkpoint_dev.py', 'development_selection.py', 'selected_adapter.py', 'real_gate.py')
    return {n:dev.sha(Path(__file__).with_name(n)) for n in names}


def require_completed_selection(paths, expected_candidate_sha, expected_plan_hash):
    identity, selection, summary, metadata, verdicts = [read(paths[k]) for k in
        ('selected_identity','selection','dev_summary','dev_metadata','dev_verdicts')]
    for obj, key in [(identity,'identity_hash'),(selection,'checkpoint_selection_hash'),
                     (summary,'summary_hash'),(metadata,'checkpoint_metadata_hash'),(verdicts,'verdict_hash')]:
        check_seal(obj,key)
    bindings = read(paths['dev_bindings'])
    dev.verify_binding(bindings)
    if bindings['artifacts']['training_plan_hash'] != expected_plan_hash:
        raise ValueError('exact_completed_training_plan_required')
    if metadata['checkpoints'] != bindings['artifacts']['checkpoint_receipts']:
        raise ValueError('exact_development_checkpoint_receipts_required')
    recomputed = select_checkpoint(paths['dev_summary'], paths['dev_metadata'], paths['dev_rule'])
    for key in ('selected_method','selected_checkpoint','minimum_validation_loss_method',
                'rank_keys','summary_hash','checkpoint_metadata_hash','selection_rule_hash'):
        if selection[key] != recomputed[key]:
            raise ValueError('complete_global_development_selection_required')
    if (selection['activation_authorized'] is not False or selection['final_outputs_seen'] is not False
            or summary.get('development_only') is not True
            or summary['verdict_hash'] != verdicts['verdict_hash']
            or summary['report_hash'] != verdicts['report_hash']
            or verdicts.get('mapping_seen_before_freeze') is not False
            or verdicts.get('reviewer') != 'agent_delegated' or verdicts['case_count'] != 24
            or verdicts['suite_hash'] != dev.DEV_HASH
            or len(verdicts['cases']) != 24
            or metadata['binding_hash'] != bindings['binding_hash']
            or selection['selection_rule_hash'] != dev.RULE_HASH
            or summary['suite_hash'] != dev.DEV_HASH
            or identity['checkpoint_selection_hash'] != selection['checkpoint_selection_hash']
            or identity['binding_hash'] != bindings['binding_hash']
            or identity['method'] != selection['selected_method']
            or identity['step'] != selection['selected_checkpoint']['step']
            or identity['base_model_identity'] != bindings['artifacts']['base_model_identity']
            or identity['activation_authorized'] is not False
            or identity['final_evaluation_required'] is not True):
        raise ValueError('completed_blind_development_identity_required')
    for case in verdicts['cases'].values():
        options=case.get('options',{})
        if len(options) != 5:
            raise ValueError('complete_five_option_development_verdicts_required')
        for judgment in options.values():
            if (any(judgment.get(k) not in ('pass','fail','uncertain') for k in ('role','fact','consent','response'))
                    or any(type(judgment.get(k)) is not int or not 1 <= judgment[k] <= 5 for k in ('usefulness','style'))
                    or not judgment.get('reason') or not judgment.get('output_hash')):
                raise ValueError('complete_development_semantic_verdicts_required')
        tiers=case.get('preference',[])
        labels=[label for tier in tiers for label in tier] if isinstance(tiers,list) and all(isinstance(t,list) and t for t in tiers) else []
        if len(labels) != 5 or set(labels) != set(options):
            raise ValueError('complete_development_preferences_required')
    weights = Path(identity['path']) / 'adapters.safetensors'
    if (expected_candidate_sha != identity['file_hashes']['adapters.safetensors']
            or expected_candidate_sha != selection['selected_checkpoint']['adapter_artifact_hash']
            or dev.sha(weights) != expected_candidate_sha):
        raise ValueError('exact_quality_winner_weight_sha_required')
    for name, expected in identity['file_hashes'].items():
        if dev.sha(Path(identity['path']) / name) != expected:
            raise ValueError('selected_artifact_changed')
    dev.finite_adapter(weights)
    return identity, bindings


def real_suite(admission, inputs, protocol, compiler):
    """Deterministic transient adapter-comparison suite, never a new gate."""
    check_seal(admission,'admission_hash')
    check_seal(protocol,'protocol_hash')
    if admission['admission_hash'] != ADMISSION_HASH or protocol['protocol_hash'] != REAL_PROTOCOL_HASH:
        raise ValueError('frozen_real_admission_and_protocol_required')
    entries = admission['entries']
    qualities = {q['id']:q for q in admission['case_quality_records']}
    if len(entries) != 48 or set(inputs) != {e['id'] for e in entries}:
        raise ValueError('all_frozen_real48_required')
    if len(qualities) != 48 or set(qualities) != set(inputs):
        raise ValueError('all_frozen_real48_quality_records_required')
    cases = []
    for entry in entries:
        messages = inputs[entry['id']]
        if digest(messages) != entry['input_hash']:
            raise ValueError('frozen_real_generation_input_changed')
        request = {'id':entry['id'],'source_review_hash':entry['hash'],
                   'original_context_required_from_final_only_owner':True}
        quality = qualities[entry['id']]
        if (quality['quality_hash'] != entry['quality_hash'] or quality['review_hash'] != entry['hash']
                or any(quality['source_hashes'][k] != entry[k] for k in
                       ('source_keys_hash','raw_content_hash','input_hash','target_hash'))):
            raise ValueError('exact_frozen_real_quality_join_required')
        rubric = quality['rubric']  # Preserve the exact independently frozen rubric.
        cases.append({'id':entry['id'],'category':'independent_real_holdout',
            'request':request,'rubric':rubric,'request_hash':digest(request),'rubric_hash':digest(rubric),
            'inputs':{m:messages for m in METHODS},'input_hashes':{m:entry['input_hash'] for m in METHODS}})
    return seal({'schema':'independent-compiled-v1','split':'sealed_final_real',
        'case_count':48,'candidate':'adapter_v4','comparators':['production_base_v4','prior_adapter_v4'],
        'compilers':{m:compiler for m in METHODS},'cases':cases,
        'evaluation_helper_sha256':dev.sha(Path(__file__).with_name('independent.py')),
        'generation_policy':GENERATION_POLICY,'general_rubric':protocol,
        'policy':{'authority':'frozen_real_protocol_only','protocol_hash':protocol['protocol_hash'],
                  'generic_synthetic_gate_for_this_suite_forbidden':True},
        'supplemental_policy':None,'raw_hash':admission['admission_hash'],
        'provenance':{'kind':'fresh_independent_real_holdout','historical_targets_model_input':False}},'suite_hash')


def assemble_suites(paths):
    synthetic = final_suite(paths['synthetic_suite'])
    admission, protocol = read(paths['real_admission']), read(paths['real_protocol'])
    inputs = fetch_inputs(paths['final_grant'], paths['real_admission'])
    real = real_suite(admission,inputs,protocol,synthetic['compilers']['production_base_v4'])
    return {'synthetic':synthetic,'real':real}


def prepare(paths, output, expected_candidate_sha, expected_prior_sha, expected_plan_hash):
    """Later authorized CPU operation; current preparation uses fake tests only."""
    identity, devbindings = require_completed_selection(paths,expected_candidate_sha,expected_plan_hash)
    prior = Path(paths['prior_adapter']).resolve()
    if str(prior) == identity['path'] or dev.sha(prior/'adapters.safetensors') != expected_prior_sha:
        raise ValueError('distinct_exact_prior_reference_required')
    dev.finite_adapter(prior/'adapters.safetensors')
    if read(prior/'manifest.json').get('base_model_id') != devbindings['artifacts']['base_model_identity']:
        raise ValueError('prior_reference_exact_base_identity_required')
    policy = read(paths['comparison_policy']);check_seal(policy,'comparison_hash')
    if (policy['comparison_hash'] != COMPARISON_HASH
            or policy['gating_comparators'] != ['production_base_v4']
            or policy['diagnostic_comparators'] != ['prior_adapter_v4']):
        raise ValueError('base_only_gate_prior_diagnostic_required')
    suites = assemble_suites(paths)
    worker = Path(paths['worker']).resolve()
    if dev.sha(worker) != suites['synthetic']['compilers']['production_base_v4']['source_sha256']:
        raise ValueError('frozen_v4_worker_required')
    from mlx_lm.utils import load_tokenizer
    input_preflight = preflight_inputs(suites,load_tokenizer(devbindings['artifacts']['model_path']))
    output = Path(output).resolve();output.mkdir(mode=0o700,parents=True,exist_ok=False)
    adapters = {'production_base_v4':None,'adapter_v4':identity['path'],'prior_adapter_v4':str(prior)}
    files = {str(Path(v).resolve()):dev.sha(v) for k,v in paths.items() if k != 'prior_adapter'}
    for folder in (Path(identity['path']),prior):
        for name in ('adapters.safetensors','adapter_config.json','manifest.json'):
            files[str(folder/name)] = dev.sha(folder/name)
    payload = seal({'schema':'bounded-final-run-bindings-v1','frozen_at_utc':now(),
        'paths':{k:str(Path(v).resolve()) for k,v in paths.items()},'output':str(output),
        'suite_hashes':{k:s['suite_hash'] for k,s in suites.items()},
        'method_adapters':adapters,'candidate_weight_sha256':expected_candidate_sha,
        'prior_weight_sha256':expected_prior_sha,'selected_identity_hash':identity['identity_hash'],
        'development_selection_hash':identity['checkpoint_selection_hash'],
        'training_plan_hash':expected_plan_hash,'generation_policy':GENERATION_POLICY,
        'complete_input_preflight':input_preflight,
        'gating_comparators':['production_base_v4'],'diagnostic_comparators':['prior_adapter_v4'],
        'activation_authorized':False,'artifacts':{'file_hashes':files,
            'base_model_identity':devbindings['artifacts']['base_model_identity'],
            'model_path':devbindings['artifacts']['model_path'],
            'helper_fingerprints':final_helpers(),'library_versions':dev.libraries(),
            'shared_runtime_fingerprints':dev.shared_runtime_fingerprints()},
        'resource_budget':{'seconds':1800,'rss_bytes':12*1024**3,'swap_growth_bytes':1024**3},
        'execution_order':'each_suite_then_each_method48_then_clear_models_gc_mlx_cache',
        'failure_policy':'one_attempt_no_automatic_retry_or_final_driven_reselection'},'run_hash')
    write_private(output/'bindings.json',payload)
    # Suites with message bodies are deliberately NOT written during preparation.
    return {'run_hash':payload['run_hash'],'suite_count':2,'cases_per_suite':48,'method_count':3}


def verify(binding, expected_hash):
    check_seal(binding,'run_hash')
    if binding['run_hash'] != expected_hash or binding['generation_policy'] != GENERATION_POLICY:
        raise ValueError('explicit_frozen_final_binding_required')
    if (binding['artifacts']['helper_fingerprints'] != final_helpers()
            or binding['artifacts']['library_versions'] != dev.libraries()
            or binding['artifacts']['shared_runtime_fingerprints'] != dev.shared_runtime_fingerprints()
            or any(dev.sha(p) != h for p,h in binding['artifacts']['file_hashes'].items())
            or dev.model_identity(binding['artifacts']['model_path']) != binding['artifacts']['base_model_identity']):
        raise ValueError('frozen_final_sources_libraries_or_artifacts_changed')
    identity,_ = require_completed_selection(binding['paths'],binding['candidate_weight_sha256'],binding['training_plan_hash'])
    if (binding['method_adapters'] != {'production_base_v4':None,'adapter_v4':identity['path'],
            'prior_adapter_v4':str(Path(binding['paths']['prior_adapter']).resolve())}
            or binding['gating_comparators'] != ['production_base_v4']
            or binding['diagnostic_comparators'] != ['prior_adapter_v4']):
        raise ValueError('one_candidate_base_only_gate_binding_required')


def output_preflight(binding):
    folder = Path(binding['output'])
    names = ['attempt.json','outputs-complete.json','completion.json','failure.json',
             'final-runtime.log','final-resources.json']
    names += [k+s for k in ('real','synthetic') for s in ('-report.json','-report-unblind.json')]
    if any((folder/n).exists() for n in names):
        raise ValueError('existing_or_partial_final_attempt_no_retry_no_overwrite')


def preflight_inputs(suites,tokenizer):
    result={}
    for kind,suite in suites.items():
        maximum=0
        if suite['case_count'] != 48 or len(suite['cases']) != 48:
            raise ValueError('whole48_suite_required')
        for case in suite['cases']:
            if set(case['inputs']) != set(METHODS):
                raise ValueError('all_three_methods_required')
            if len({digest(v) for v in case['inputs'].values()}) != 1:
                raise ValueError('same_v4_representation_all_methods_required')
            for messages in case['inputs'].values():
                tokens = tokenizer.apply_chat_template(messages,add_generation_prompt=True,
                    enable_thinking=False,return_dict=False)
                if len(tokens) > 3904:
                    raise ValueError('complete_final_input_budget_exceeded_no_truncation')
                maximum=max(maximum,len(tokens))
        result[kind]={'case_count':48,'method_count':3,'max_input_tokens':maximum,
                      'output_tokens':192,'max_total_tokens':maximum+192}
    return result


class ReplayCache:
    def __init__(self):self.outputs=defaultdict(deque);self.remaining=0
    def add(self,messages,adapter,text):
        self.outputs[(digest(messages),adapter)].append(text);self.remaining+=1
    def generate_text(self,messages,*,adapter_path,max_tokens,temperature):
        q=self.outputs[(digest(messages),adapter_path)]
        if not q or max_tokens != 192 or temperature != 0:
            raise ValueError('frozen_generated_output_cache_boundary')
        self.remaining-=1;return q.popleft()


def generate_suite(engine,suite,adapters,clear_cache):
    cache=ReplayCache()
    try:
        for method in METHODS:
            engine.models.clear();gc.collect();clear_cache()
            for case in suite['cases']:
                messages=case['inputs'][method]
                text=engine.generate_text(messages,adapter_path=adapters[method],
                    max_tokens=192,temperature=0.).strip()
                if not text:raise ValueError('empty_final_generation_hold')
                cache.add(messages,adapters[method],text)
    finally:
        engine.models.clear();gc.collect();clear_cache()
    return cache


def verify_report(path,suite,binding_hash):
    report=read(path);check_seal(report,'report_hash')
    if (report['suite_hash'] != suite['suite_hash'] or report['case_count'] != 48
            or len(report['cases']) != 48
            or {r['id'] for r in report['cases']} != {c['id'] for c in suite['cases']}
            or report['generation_artifacts']['binding_hash'] != binding_hash
            or dev.sha(Path(path).with_name(Path(path).stem+'-unblind.json')) != report['mapping_file_sha256']):
        raise ValueError('partial_or_changed_final_report')
    for row in report['cases']:
        if (len(row['outputs']) != 3 or len({o['label'] for o in row['outputs']}) != 3
                or any(not o['text'].strip() or digest(o['text']) != o['output_hash'] for o in row['outputs'])):
            raise ValueError('partial_or_changed_final_options')
    return report['report_hash']


def child(binding_path,expected_hash):
    binding=read(binding_path);verify(binding,expected_hash)
    folder=Path(binding['output']);attempt=read(folder/'attempt.json');check_seal(attempt,'attempt_hash')
    if attempt['run_hash'] != expected_hash:raise ValueError('owner_attempt_binding_required')
    if any((folder/n).exists() for n in ('real-report.json','real-report-unblind.json',
            'synthetic-report.json','synthetic-report-unblind.json','outputs-complete.json','completion.json','failure.json')):
        raise ValueError('existing_or_partial_final_output_no_child_retry')
    suites=assemble_suites(binding['paths'])
    if {k:s['suite_hash'] for k,s in suites.items()} != binding['suite_hashes']:
        raise ValueError('frozen_final_source_inputs_changed')
    from mlx_lm.utils import load_tokenizer
    tokenizer=load_tokenizer(binding['artifacts']['model_path'])
    if preflight_inputs(suites,tokenizer) != binding['complete_input_preflight']:
        raise ValueError('frozen_complete_input_preflight_changed')
    import mlx.core as mx
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
    import personalization as lifecycle
    engine=worker_module(binding['paths']['worker']).ReplyWorker()
    engine.path=Path(binding['artifacts']['model_path'])
    results={}
    with lifecycle.private_staging('inboxd-sealed-final-') as (stage,_):
        for kind,suite in suites.items():
            suite_path=Path(stage)/(kind+'-suite.json');write_private(suite_path,suite)
            sb=seal({'suite_hash':suite['suite_hash'],
                'generator_sha256':dev.sha(Path(__file__).with_name('multi_adapter.py')),
                'generation_policy':GENERATION_POLICY,'method_adapters':binding['method_adapters'],
                'artifacts':{'final_run_hash':expected_hash,'selected_identity_hash':binding['selected_identity_hash'],
                    'candidate_weight_sha256':binding['candidate_weight_sha256'],
                    'prior_weight_sha256':binding['prior_weight_sha256'],
                    'gating_comparators':['production_base_v4'],'diagnostic_comparators':['prior_adapter_v4'],
                    'activation_authorized':False}},'binding_hash')
            sb_path=Path(stage)/(kind+'-bindings.json');write_private(sb_path,sb)
            cache=generate_suite(engine,suite,binding['method_adapters'],mx.clear_cache)
            report=folder/(kind+'-report.json')
            generate_multi(cache,tokenizer,sb_path,report,suite_path=suite_path,
                           artifacts={'method_major_clean_reset':True,'one_global_candidate':True})
            if cache.remaining:raise ValueError('incomplete_final_output_publication')
            results[kind]=verify_report(report,suite,sb['binding_hash'])
    write_private(folder/'outputs-complete.json',seal({'run_hash':expected_hash,'report_hashes':results,
        'suite_hashes':binding['suite_hashes'],'activation_authorized':False,
        'independent_blind_review_required':True},'outputs_hash'))
    return {'status':'outputs_complete_pending_daemon_restore','run_hash':expected_hash}


def run(args):
    binding=read(args.bindings);verify(binding,args.expected_run_hash);output_preflight(binding)
    if not args.pause_daemon:raise ValueError('verified_daemon_pause_required')
    args.output=Path(binding['output'])
    if Path(args.bindings).resolve().parent != args.output:
        raise ValueError('private_binding_directory_required')
    write_private(args.output/'attempt.json',seal({'run_hash':args.expected_run_hash,
        'started_at_utc':now(),'owner_pid':os.getpid(),'automatic_retry_allowed':False},'attempt_hash'))
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
    import bounded_pilot as daemon
    import personalization as guard
    budget=binding['resource_budget']
    try:
        with daemon.daemon_pause(args):
            with (args.output/'final-runtime.log').open('x') as log:
                os.chmod(log.name,0o600)
                guard.guarded_training_run([sys.executable,str(Path(__file__).resolve()),'_child',
                    '--bindings',str(args.bindings),'--expected-run-hash',args.expected_run_hash],
                    env=os.environ,stdout=log,pass_fds=(),max_runtime_seconds=budget['seconds'],
                    max_rss_bytes=budget['rss_bytes'],max_swap_bytes=budget['swap_growth_bytes'],
                    resource_report_path=args.output/'final-resources.json')
        outputs=read(args.output/'outputs-complete.json');check_seal(outputs,'outputs_hash')
        if outputs['run_hash'] != args.expected_run_hash or read(args.output/'final-resources.json')['status'] != 'complete':
            raise ValueError('incomplete_guarded_final_run')
        write_private(args.output/'completion.json',seal({'status':'awaiting_independent_blind_final_review',
            'run_hash':args.expected_run_hash,'outputs_hash':outputs['outputs_hash'],
            'daemon_restored_and_readiness_verified':True,'activation_performed':False},'completion_hash'))
    except BaseException as error:
        write_private(args.output/'failure.json',{'run_hash':args.expected_run_hash,
            'exception_class':type(error).__name__,'status':'hold_no_retry_no_activation',
            'partial_reports_must_not_be_used_as_complete_evidence':True})
        raise
    return {'status':'final_complete_daemon_restored','run_hash':args.expected_run_hash,
            'activation_authorized':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['prepare','run','_child'])
    for name in ('synthetic-suite','real-admission','real-protocol','final-grant','comparison-policy',
        'selected-identity','selection','dev-summary','dev-metadata','dev-verdicts','dev-rule','dev-bindings',
        'prior-adapter','worker','output','bindings','inboxd','daemon-lock','daemon-binary'):
        parser.add_argument('--'+name,type=Path)
    for name in ('expected-candidate-sha','expected-prior-sha','expected-training-plan-hash','expected-run-hash'):
        parser.add_argument('--'+name)
    parser.add_argument('--pause-daemon',action='store_true')
    args=parser.parse_args()
    if args.command == 'prepare':
        keys=('synthetic_suite','real_admission','real_protocol','final_grant','comparison_policy',
              'selected_identity','selection','dev_summary','dev_metadata','dev_verdicts','dev_rule',
              'dev_bindings','prior_adapter','worker')
        result=prepare({k:getattr(args,k) for k in keys},args.output,args.expected_candidate_sha,
                       args.expected_prior_sha,args.expected_training_plan_hash)
    elif args.command == '_child':result=child(args.bindings,args.expected_run_hash)
    else:result=run(args)
    import json
    print(json.dumps(result))


if __name__=='__main__':main()
