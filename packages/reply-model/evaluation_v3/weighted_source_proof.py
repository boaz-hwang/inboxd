"""CPU-only verification of actual weighted-producer completion metadata.

No training records, conversation bodies, tokenizer or model are opened. Producer
seals use spaced JSON; the newly authored source proof uses independent compact
JSON. Run only after all four saved-artifact evaluations and owner restoration.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path

from independent import read, seal, write_private, now
from checkpoint_dev import check_producer_digest, sha

PROPOSAL_HASH = '581c32f67a8f85ea4ccc7fd0a5fd534c5e495e12a5de4cf611d555251e44a4fd'
PRIORITY = ('required_state_preservation', 'mandatory_abstain_only',
            'useful_clarification_or_future_intent', 'real_acknowledgement_or_greeting')
RAW = dict(zip((*PRIORITY, 'all_other_examples'), (2., 1., 2., .5, 1.)))
STEPS = [76, 152, 228, 304]
CORE_PATHS = {'ordinary_plan', 'weighted_experiment', 'weight_map',
              'weighted_dispatch', 'ledger', 'completion'}


def producer_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def order_hash(entries):
    # Independent recomputation of the installed seed0 permutation schedule.
    import numpy as np
    rng = np.random.RandomState(0)
    indices = sorted(range(152), key=lambda i: entries[i]['total_tokens'])
    keys = []
    for epoch in range(2):
        for within, index in enumerate(rng.permutation(152)):
            step = epoch * 152 + within + 1
            if step == 1 or step % 76 == 0:
                rng.permutation(46)
            keys.append(entries[indices[index]]['tokenized_example_hash'])
    return producer_digest(keys)


def validate_metadata(plan, experiment, weights, completion, receipt, dispatch, observation,
                      *, expected_plan_hash, expected_experiment_hash, expected_map_hash,
                      map_sha256, observation_sha256, helpers):
    """Pure metadata verifier, also exercised with fake CPU fixtures."""
    for value, key in ((plan, 'plan_hash'), (experiment, 'experiment_hash'),
                       (weights, 'weight_map_hash'), (receipt, 'receipt_hash')):
        check_producer_digest(value, key)
    require(plan['plan_hash'] == expected_plan_hash
            and experiment['experiment_hash'] == expected_experiment_hash
            and weights['weight_map_hash'] == expected_map_hash, 'approved_identity_mismatch')
    require(plan['iters'] == 304 and plan['save_every'] == 76 and plan['epochs'] == 2
            and plan['batch_size'] == 1 and plan['train_max_tokens'] == 2048
            and plan['seq_length'] == 4096 and plan['compile_mode'] == 'disabled'
            and plan['lengths']['train']['count'] == 152
            and plan['lengths']['valid']['count'] == 46, 'fixed_trial_factors_changed')
    require(experiment['schema'] == 'functional-weighted-trial-plan-v1'
            and experiment['ordinary_training_plan'] == plan
            and experiment['proposal_hash'] == weights['proposal_hash'] == PROPOSAL_HASH
            and experiment['weight_map_hash'] == expected_map_hash
            and experiment['validation_unweighted'] is True
            and experiment['weighted_train_loss_comparable_to_prior'] is False
            and experiment['activation_performed'] is False
            and experiment['helper_fingerprint'] == helpers, 'weighted_experiment_changed')
    require(weights['schema'] == 'frozen-functional-loss-weights-v1'
            and weights['normalization'] == 'arithmetic_mean_over_training_examples'
            and weights['validation_weighting'] == 'unchanged_unweighted_all46'
            and weights['training_example_count'] == 152
            and weights['validation_example_count'] == 46
            and type(weights['validation_target_token_count']) is int
            and weights['validation_target_token_count'] > 0
            and all(weights[k] == plan[k] for k in ('manifest_id','records_hash','assignments_hash')),
            'weight_map_provenance_changed')
    entries = weights['entries']
    require(len(entries) == 152 and len({e['id'] for e in entries}) == 152,
            'exact152_unique_examples_required')
    mean = sum(RAW[e['category']] for e in entries) / 152
    require(type(weights['normalizer']) in (int,float)
            and math.isclose(weights['normalizer'], mean, rel_tol=0, abs_tol=1e-12),
            'global_mean_changed')
    keys = {}
    for e in entries:
        flags = e['criteria']
        category = next((k for k in PRIORITY if flags.get(k)), 'all_other_examples')
        require(set(flags) == set(PRIORITY) and all(type(v) is bool for v in flags.values())
                and e['category'] == category, 'functional_priority_changed')
        require(type(e['raw_weight']) in (int,float) and e['raw_weight'] == RAW[category]
                and type(e['normalized_weight']) in (int,float)
                and math.isfinite(e['normalized_weight'])
                and math.isclose(e['normalized_weight'], RAW[category]/mean, rel_tol=0, abs_tol=1e-12),
                'normalized_weight_changed')
        require(type(e['offset']) is int and type(e['total_tokens']) is int
                and 0 < e['offset'] < e['total_tokens'] <= 2048
                and 0 < e['total_tokens']-e['offset'] <= 65,
                'complete_target_boundary_changed')
        for k in ('example_hash','review_hash','tokenized_example_hash'):
            require(isinstance(e[k],str) and len(e[k]) == 64
                    and all(c in '0123456789abcdef' for c in e[k]), 'invalid_example_identity')
        key = e['tokenized_example_hash']
        require(key not in keys or keys[key] == e['normalized_weight'], 'ambiguous_duplicate_weight')
        keys[key] = e['normalized_weight']
    require(weights['expected_training_order_hash'] == order_hash(entries), 'frozen_order_mismatch')
    require(completion['status'] == receipt['status'] == 'awaiting_independent_evaluation'
            and completion['plan_hash'] == receipt['base_training_plan_hash'] == expected_plan_hash
            and completion['final_test_records_supplied'] == 0
            and completion['activation_performed'] is False
            and receipt['schema'] == 'functional-weighted-trial-completion-v1'
            and receipt['experiment_hash'] == expected_experiment_hash
            and receipt['weight_map_hash'] == expected_map_hash
            and receipt['weight_map_sha256'] == map_sha256
            and receipt['helper_fingerprint'] == helpers
            and receipt['ordinary_completion_hash'] == producer_digest(completion)
            and receipt['loss_observation_sha256'] == observation_sha256,
            'actual_weighted_completion_required')
    require(receipt['dispatch_proof_hash'] == producer_digest(dispatch)
            and dispatch['experiment_hash'] == expected_experiment_hash
            and dispatch['weight_map_hash'] == expected_map_hash
            and dispatch['original_guard_restored'] is True
            and dispatch['validation_weighted'] is False
            and len(dispatch['dispatches']) == 5
            and [d['weighted'] for d in dispatch['dispatches']] == [True,False,False,False,False]
            and all(type(d['weighted']) is bool and type(d['target_bound']) is int
                    and 0 < d['target_bound'] <= 4096 for d in dispatch['dispatches'])
            and dispatch['dispatches'][0]['target_bound'] == 65
            and len({d['target_bound'] for d in dispatch['dispatches'][1:]}) == 1,
            'exact_train_and_unweighted_validation_dispatch_required')
    expected_seen = {k:v*2 for k,v in Counter(e['tokenized_example_hash'] for e in entries).items()}
    ntoks = sum(e['total_tokens']-e['offset'] for e in entries)*2
    require(observation['status'] == 'complete' and observation['complete'] is True
            and observation['child_main_returned'] is True
            and observation['weight_map_hash'] == expected_map_hash
            and observation['actual_train_loss_calls'] == 304
            and observation['original_training_ids'] == 152
            and observation['unique_tokenized_examples'] == len(expected_seen)
            and observation['seen_counts'] == observation['expected_seen_counts'] == expected_seen
            and observation['ordered_key_hash'] == observation['expected_ordered_key_hash']
                == weights['expected_training_order_hash']
            and observation['training_ntoks'] == observation['expected_training_ntoks'] == ntoks
            and observation['unweighted_eval_calls'] == 230
            and observation['unweighted_eval_ntoks'] == weights['validation_target_token_count']*5,
            'actual_loss_observation_incomplete')
    return {'training_example_count':152, 'validation_example_count':46,
            'actual_train_loss_calls':304, 'training_target_ntoks':ntoks,
            'internal_unweighted_validation_loss_calls':230,
            'internal_unweighted_validation_ntoks':weights['validation_target_token_count']*5,
            'expected_training_order_hash':weights['expected_training_order_hash']}


def validate_training_guard(plan, resources):
    """The actual train-child guard, not daemon pause bookkeeping."""
    require(plan['max_runtime_seconds']==6600 and plan['max_rss_bytes']==28*1024**3
            and plan['max_swap_bytes']==4*1024**3, 'approved_training_guard_limits_required')
    require(resources['status']=='complete' and resources.get('failure_reason') is None
            and type(resources['elapsed_seconds']) in (int,float)
            and math.isfinite(resources['elapsed_seconds']) and 0 <= resources['elapsed_seconds'] <= 6600
            and type(resources['peak_rss_bytes']) is int and 0 < resources['peak_rss_bytes'] <= 28*1024**3
            and type(resources['peak_swap_growth_bytes']) is int
            and 0 <= resources['peak_swap_growth_bytes'] < 4*1024**3
            and type(resources['baseline_swap_bytes']) is int and resources['baseline_swap_bytes'] >= 0,
            'actual_training_resource_guard_incomplete_or_limit_exceeded')
    return {k:resources[k] for k in ('elapsed_seconds','peak_rss_bytes','peak_swap_growth_bytes','baseline_swap_bytes')}


def build(paths, *, expected_plan_hash, expected_experiment_hash, expected_map_hash):
    """Actual-completion operation; never a prospective proof generator."""
    require(set(paths) == CORE_PATHS | {'weighted_completion','loss_observation'}, 'exact_paths_required')
    paths = {k:Path(p).resolve() for k,p in paths.items()}
    values = {k:read(p) for k,p in paths.items()}
    producer_root = Path(__file__).resolve().parent.parent
    helper_paths = {n:producer_root/n for n in ('weighted_training.py','weighted_training_runtime.py')}
    helpers = {n:sha(p) for n,p in helper_paths.items()}
    experiment, plan = values['weighted_experiment'], values['ordinary_plan']
    require(Path(experiment['weight_map_path']).resolve() == paths['weight_map'], 'actual_map_path_required')
    output = Path(plan['output']).resolve()
    expected_paths = {'completion':output/'completion.json', 'ledger':output/'adapter/checkpoint-validation.json',
        'weighted_dispatch':output/'weighted-dispatch-proof.json',
        'weighted_completion':output/'weighted-completion.json',
        'loss_observation':output/'adapter/weighted-loss-observation.json'}
    require(all(paths[k] == p for k,p in expected_paths.items()), 'exact_completed_run_paths_required')
    evidence = validate_metadata(plan,experiment,values['weight_map'],values['completion'],
        values['weighted_completion'],values['weighted_dispatch'],values['loss_observation'],
        expected_plan_hash=expected_plan_hash, expected_experiment_hash=expected_experiment_hash,
        expected_map_hash=expected_map_hash, map_sha256=sha(paths['weight_map']),
        observation_sha256=sha(paths['loss_observation']), helpers=helpers)
    ledger = values['ledger']; check_producer_digest(ledger,'ledger_hash')
    selection = values['completion']['checkpoint_selection']
    require(ledger['status'] == 'complete' and ledger['final_test_records_supplied'] == 0
            and selection['checkpoint_validation_ledger_sha256'] == sha(paths['ledger'])
            and Path(selection['checkpoint_validation_ledger']).resolve() == paths['ledger'],
            'completion_exact_ledger_required')
    receipts = sorted(ledger['evaluations'], key=lambda e:e['checkpoint_iteration'])
    require([e['checkpoint_iteration'] for e in receipts] == STEPS, 'four_actual_saved_losses_required')
    file_hashes = {str(p):sha(p) for p in paths.values()}
    train_resource = output/'adapter/resources.json'
    training_guard = validate_training_guard(plan,read(train_resource))
    file_hashes[str(train_resource)] = sha(train_resource)
    original_runtime = {name:sha(producer_root/name) for name in ('personalization.py','training_runtime.py')}
    for c in receipts:
        check_producer_digest(c,'loss_evaluation_hash')
        require(type(c['validation_loss']) in (int,float) and math.isfinite(c['validation_loss'])
                and c['validation_loss'] >= 0 and c['validation_example_count'] == 46
                and c['seq_length'] == 4096 and c['batch_size'] == 1
                and c['final_test_records_supplied'] == 0
                and c['runtime_source_sha256'] == original_runtime
                and c['validation_records_hash'] == ledger['validation_records_hash']
                and c['validation_assignments_hash'] == ledger['validation_assignments_hash'],
                'saved_loss_receipt_invalid')
        # Never rely on the overwritten canonical loss-winner alias.
        artifact = paths['ledger'].parent / f"{c['checkpoint_iteration']:07d}_adapters.safetensors"
        resource = Path(c['resource_report_path']).resolve()
        require(sha(artifact) == c['artifact_sha256'] and sha(resource) == c['resource_report_sha256']
                and read(resource)['status'] == 'complete', 'saved_loss_artifact_or_resource_changed')
        file_hashes[str(artifact)] = sha(artifact); file_hashes[str(resource)] = sha(resource)
    helper_fingerprints = {str(p):helpers[n] for n,p in helper_paths.items()}
    file_hashes.update(helper_fingerprints)
    file_hashes.update({str(producer_root/name):h for name,h in original_runtime.items()})
    file_hashes[str(Path(__file__).resolve())] = sha(Path(__file__))
    return seal({'schema':'actual-functional-weighted-source-proof-v1','frozen_at_utc':now(),
        'artifact_paths':{k:str(paths[k]) for k in sorted(CORE_PATHS)},
        'weighted_completion_path':str(paths['weighted_completion']),
        'loss_observation_path':str(paths['loss_observation']),
        'file_sha256':file_hashes,'helper_fingerprints':helper_fingerprints,
        'verifier_sha256':sha(Path(__file__)),
        'ordinary_training_plan_hash':expected_plan_hash,'experiment_hash':expected_experiment_hash,
        'weight_map_hash':expected_map_hash,'training_complete':True,'validation_unweighted':True,
        'saved_steps':STEPS,'weighted_training_dispatches':1,'unweighted_saved_validation_dispatches':4,
        'actual_loss_observation':evidence,'training_bodies_opened':False,
        'actual_training_guard':training_guard,
        'daemon_restore_evidence':'root_and_engineer_actual_post_run_status_query_required_separately',
        'daemon_pause_resources_are_restore_evidence':False,
        'weight_finiteness_and_base_identity_checked_by':'checkpoint_dev.metadata_from_ledger_before_dev_binding',
        'producer_digest_protocol':'sorted_json_default_spaces_ensure_ascii_false',
        'new_proof_digest_protocol':'independent_sorted_compact_json'}, 'source_proof_hash')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for k in sorted(CORE_PATHS | {'weighted_completion','loss_observation'}):
        parser.add_argument('--'+k.replace('_','-'),required=True,type=Path)
    for k in ('plan','experiment','map'):
        parser.add_argument('--expected-'+k+'-hash',required=True)
    parser.add_argument('--output',required=True,type=Path)
    args = parser.parse_args()
    require(not args.output.exists(), 'source_proof_no_overwrite')
    proof = build({k:getattr(args,k) for k in CORE_PATHS | {'weighted_completion','loss_observation'}},
        expected_plan_hash=args.expected_plan_hash,expected_experiment_hash=args.expected_experiment_hash,
        expected_map_hash=args.expected_map_hash)
    write_private(args.output,proof)
    print(json.dumps({'source_proof_hash':proof['source_proof_hash'],'saved_steps':STEPS,
                      'actual_train_loss_calls':304,'unweighted_saved_validation_dispatches':4}))
