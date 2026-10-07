"""Real-only blind freeze then unblind summary under the frozen real protocol.

Never uses synthetic numeric/style gates; prior comparisons are diagnostics.
Call only during authorized independent final review, with transient real suite.
"""
import math
from pathlib import Path

from independent import (read, check_seal, digest, seal, write_private, now,
                         review_view, freeze_verdicts, DIMENSIONS)
import final_controller as controller
from checkpoint_dev import sha


def contract(suite_path,report_path,binding_path,protocol_path):
    suite,report,views=review_view(suite_path,report_path)  # No mapping access.
    binding,protocol=read(binding_path),read(protocol_path)
    check_seal(binding,'run_hash');check_seal(protocol,'protocol_hash')
    folder=Path(binding['output']).resolve()
    if Path(report_path).resolve().parent != folder or (folder/'failure.json').exists():
        raise ValueError('successful_complete_final_run_required_before_review')
    completion,outputs=read(folder/'completion.json'),read(folder/'outputs-complete.json')
    check_seal(completion,'completion_hash');check_seal(outputs,'outputs_hash')
    if (completion['status'] != 'awaiting_independent_blind_final_review'
            or completion['run_hash'] != binding['run_hash']
            or completion['outputs_hash'] != outputs['outputs_hash']
            or completion['daemon_restored_and_readiness_verified'] is not True
            or completion['activation_performed'] is not False
            or outputs['run_hash'] != binding['run_hash']
            or set(outputs['report_hashes']) != {'real','synthetic'}
            or outputs['report_hashes']['real'] != report['report_hash']
            or outputs['suite_hashes'] != binding['suite_hashes']
            or read(folder/'final-resources.json')['status'] != 'complete'):
        raise ValueError('successful_complete_final_run_required_before_review')
    frozen=report['generation_artifacts']['frozen_artifacts']
    if (suite['split'] != 'sealed_final_real' or suite['case_count'] != 48
            or set(suite['compilers']) != set(controller.METHODS)
            or suite['candidate'] != 'adapter_v4'
            or set(suite['comparators']) != {'production_base_v4','prior_adapter_v4'}
            or suite['suite_hash'] != binding['suite_hashes']['real']
            or suite['raw_hash'] != controller.ADMISSION_HASH
            or protocol['protocol_hash'] != controller.REAL_PROTOCOL_HASH
            or suite['policy']['protocol_hash'] != protocol['protocol_hash']
            or binding['gating_comparators'] != ['production_base_v4']
            or binding['diagnostic_comparators'] != ['prior_adapter_v4']
            or binding['artifacts']['helper_fingerprints']['real_gate.py'] != sha(__file__)
            or frozen['final_run_hash'] != binding['run_hash']
            or frozen['selected_identity_hash'] != binding['selected_identity_hash']
            or frozen['candidate_weight_sha256'] != binding['candidate_weight_sha256']
            or frozen['prior_weight_sha256'] != binding['prior_weight_sha256']
            or report['generation_settings'] != {'temperature':0.,'enable_thinking':False,
                                                  'max_tokens':192,'max_input_tokens':3904}):
        raise ValueError('exact_real48_protocol_run_and_artifact_binding_required')
    return suite,report,views,binding,protocol


def validate_verdicts(verdicts,suite,report,views):
    check_seal(verdicts,'verdict_hash')
    if (verdicts['reviewer'] != 'agent_delegated' or verdicts['mapping_seen_before_freeze'] is not False
            or verdicts['suite_hash'] != suite['suite_hash'] or verdicts['report_hash'] != report['report_hash']
            or verdicts['case_count'] != 48 or set(verdicts['cases']) != {v['id'] for v in views}):
        raise ValueError('complete_frozen_real48_blind_verdicts_required_before_unblind')
    for view in views:
        verdict=verdicts['cases'][view['id']]
        options={o['label']:o for o in view['outputs']}
        if set(verdict['options']) != set(options):
            raise ValueError('all_real_options_required_before_unblind')
        for label,judgment in verdict['options'].items():
            if (judgment.get('output_hash') != options[label]['output_hash']
                    or any(judgment.get(d) not in ('pass','fail','uncertain') for d in DIMENSIONS)
                    or any(type(judgment.get(d)) is not int or not 1 <= judgment[d] <= 5 for d in ('usefulness','style'))
                    or not judgment.get('reason')):
                raise ValueError('complete_real_semantic_scores_required_before_unblind')
        tiers=verdict.get('preference',[])
        labels=[l for tier in tiers for l in tier] if isinstance(tiers,list) and all(isinstance(t,list) and t for t in tiers) else []
        if len(labels) != 3 or set(labels) != set(options):
            raise ValueError('complete_real_preferences_required_before_unblind')


def freeze_real(suite_path,report_path,judgments_path,output,*,binding_path,protocol_path):
    contract(suite_path,report_path,binding_path,protocol_path)
    # Frozen core validates every hash, dimension, integer score and preference;
    # this function and that core never read the mapping.
    return freeze_verdicts(suite_path,report_path,judgments_path,output)


def calculate(verdicts,mapping):
    """Pure metrics from synthetic fixtures or already authorized unblinded data."""
    if len(verdicts) != 48 or set(mapping) != set(verdicts):
        raise ValueError('exact48_real_metric_cases_required')
    methods={m:{'count':0,'clear_semantic_failure_cases':0,'unresolved_semantic_cases':0,
        'usefulness':[],'style':[],**{d+'_'+v:0 for d in DIMENSIONS for v in ('pass','fail','uncertain')}}
        for m in controller.METHODS}
    paired={m:{'wins':0,'losses':0,'ties':0} for m in ('production_base_v4','prior_adapter_v4')}
    for cid,verdict in verdicts.items():
        labels=mapping[cid]
        if (set(labels) != set(verdict['options']) or len(labels) != 3
                or {v['method'] for v in labels.values()} != set(methods)):
            raise ValueError('exact_three_method_real_mapping_required')
        ranks={label:rank for rank,tier in enumerate(verdict['preference']) for label in tier}
        method_labels={v['method']:label for label,v in labels.items()}
        for label,meta in labels.items():
            judgment,stats=verdict['options'][label],methods[meta['method']]
            stats['count']+=1
            stats['clear_semantic_failure_cases']+=int(any(judgment[d]=='fail' for d in DIMENSIONS))
            stats['unresolved_semantic_cases']+=int(any(judgment[d]=='uncertain' for d in DIMENSIONS))
            for d in DIMENSIONS:stats[d+'_'+judgment[d]]+=1
            for d in ('usefulness','style'):stats[d].append(judgment[d])
        candidate_rank=ranks[method_labels['adapter_v4']]
        for comparator,pair in paired.items():
            rank=ranks[method_labels[comparator]]
            pair['wins' if candidate_rank<rank else 'losses' if candidate_rank>rank else 'ties']+=1
    for stats in methods.values():
        for dimension in ('usefulness','style'):
            values=stats.pop(dimension)
            stats[dimension+'_mean']=sum(values)/48;stats[dimension+'_min']=min(values)
    candidate=methods['adapter_v4'];reasons=[]
    if candidate['clear_semantic_failure_cases']:reasons.append('candidate_clear_semantic_failure')
    if candidate['unresolved_semantic_cases']:reasons.append('candidate_unresolved_semantic_judgment')
    if candidate['usefulness_min']<3:reasons.append('candidate_case_usefulness_below3')
    if candidate['usefulness_mean']<4:reasons.append('candidate_mean_usefulness_below4')
    if candidate['style_mean']<3.5:reasons.append('candidate_mean_style_below3_5')
    for comparator,pair in paired.items():
        other=methods[comparator]
        pair.update(usefulness_gain=candidate['usefulness_mean']-other['usefulness_mean'],
            style_gain=candidate['style_mean']-other['style_mean'],net_wins=pair['wins']-pair['losses'],
            clear_semantic_failure_case_reduction=other['clear_semantic_failure_cases']-candidate['clear_semantic_failure_cases'],
            semantic_failure_reduction_by_dimension={d:other[d+'_fail']-candidate[d+'_fail'] for d in DIMENSIONS})
    base=paired['production_base_v4']
    if base['usefulness_gain'] < -1e-9:reasons.append('usefulness_regresses_vs_production_base_v4')
    if base['net_wins'] < math.ceil(48*.10):reasons.append('base_paired_net_wins_below5')
    if not (base['usefulness_gain'] >= .15-1e-9 or base['clear_semantic_failure_case_reduction'] >= 2):
        reasons.append('no_meaningful_real_behavior_gain_vs_base')
    return {'methods':methods,'paired':paired,'gate_reasons':reasons,
        'gate':'reject' if candidate['clear_semantic_failure_cases'] else 'hold' if reasons else 'pass',
        'gating_comparators':['production_base_v4'],'diagnostic_comparators':['prior_adapter_v4'],
        'activation_authorized':False}


def summarize_real(suite_path,report_path,verdicts_path,output,*,binding_path,protocol_path):
    if Path(output).exists():raise ValueError('real_summary_exists_no_overwrite')
    suite,report,views,binding,protocol=contract(suite_path,report_path,binding_path,protocol_path)
    verdicts=read(verdicts_path)
    validate_verdicts(verdicts,suite,report,views)  # MUST precede mapping access.
    mapping_path=Path(report_path).with_name(Path(report_path).stem+'-unblind.json')
    if sha(mapping_path) != report['mapping_file_sha256']:raise ValueError('real_mapping_file_changed')
    mapping=read(mapping_path);check_seal(mapping,'mapping_hash')
    if mapping['suite_hash'] != suite['suite_hash']:raise ValueError('real_mapping_suite_changed')
    result=calculate(verdicts['cases'],mapping['mapping'])
    payload=seal({**result,'schema':'frozen-real48-independent-summary-v1','frozen_at_utc':now(),
        'suite_hash':suite['suite_hash'],'report_hash':report['report_hash'],'verdict_hash':verdicts['verdict_hash'],
        'run_hash':binding['run_hash'],'protocol_hash':protocol['protocol_hash'],
        'mapping_hash':mapping['mapping_hash'],'reviewer':'agent_delegated',
        'evidence_kind':'fresh_independent_real_holdout','generic_synthetic_gate_used':False,
        'minimum_paired_net_wins':5,'meaningful_behavior_rule':'usefulness_gain>=0.15 OR failure_case_reduction>=2'},'summary_hash')
    write_private(output,payload)
    return {'summary_hash':payload['summary_hash'],'case_count':48,'gate':payload['gate'],
            'activation_authorized':False}
