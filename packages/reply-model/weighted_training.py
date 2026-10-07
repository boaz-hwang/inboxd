"""CPU preparation and scoped injection for one fixed functional-weight trial.

No messenger collection, semantic classification, final evaluation, defaults,
activation or original runtime files are changed by this module.
"""
import contextlib
import hashlib
import json
import re
from pathlib import Path

import expanded_training as e
import personalization as p
from weighted_training_runtime import RAW_WEIGHTS, token_key, validate_map


PROPOSAL_HASH = '581c32f67a8f85ea4ccc7fd0a5fd534c5e495e12a5de4cf611d555251e44a4fd'
CRITERIA = ('required_state_preservation', 'mandatory_abstain_only',
            'useful_clarification_or_future_intent', 'real_acknowledgement_or_greeting')


def classification_category(entry):
    flags = entry['criteria']
    if set(flags) != set(CRITERIA) or any(type(v) is not bool for v in flags.values()):
        raise ValueError('explicit_semantic_priority_criteria_required')
    return next((name for name in CRITERIA if flags[name]), 'all_other_examples')


def helper_fingerprint():
    return {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in ('weighted_training.py', 'weighted_training_runtime.py')}


def expected_order(entries, validation_count):
    """Installed trainer seed0 permutations including five full validation passes."""
    import numpy as np
    rng = np.random.RandomState(0)
    indices = sorted(range(len(entries)), key=lambda i: entries[i]['total_tokens'])
    keys = []
    for epoch in range(2):
        order = rng.permutation(len(indices))
        for within_epoch, index in enumerate(order):
            step = epoch * len(entries) + within_epoch + 1
            if step == 1 or step % 76 == 0 or step == 304:
                rng.permutation(validation_count)
            keys.append(entries[indices[index]]['tokenized_example_hash'])
    return p.digest(keys)


def freeze_weights(prepared, classification, tokenizer):
    """Owner supplies exact, reviewed semantic criteria; no keyword inference."""
    if (classification.get('proposal_hash') != PROPOSAL_HASH
            or classification.get('classification_hash') != p.digest(
                {k: v for k, v in classification.items() if k != 'classification_hash'})
            or classification.get('review_provenance') != 'agent_delegated_full_semantic'
            or classification.get('manifest_id') != prepared.plan['manifest_id']):
        raise ValueError('owner_frozen_classification_required')
    train = [r for r in prepared.records if prepared.assignments[r['id']] == 'train']
    by_id = {entry['id']: entry for entry in classification['entries']}
    if (len(train) != 152 or len(by_id) != 152 or len(classification['entries']) != 152
            or set(by_id) != {r['id'] for r in train}):
        raise ValueError('same_exact_152_training_examples_required')
    entries = []
    for record in train:
        decision = by_id[record['id']]
        category = classification_category(decision)
        if (decision['example_hash'] != p.digest(record)
                or decision['review_hash'] != record['review_hash']
                or decision['category'] != category
                or decision['raw_weight'] != RAW_WEIGHTS[category]
                or not isinstance(decision.get('rationale_codes'), list)
                or not decision['rationale_codes']
                or any(not isinstance(code, str) or not re.fullmatch(r'[a-z0-9_]+', code)
                       for code in decision['rationale_codes'])):
            raise ValueError('reviewed_weight_classification_changed')
        if (record['messages'][-1]['content'].strip() == '<ABSTAIN>'
                and not decision['criteria']['mandatory_abstain_only']):
            raise ValueError('mandatory_abstain_priority_not_acknowledged')
        tokens = tokenizer.apply_chat_template(record['messages'], return_dict=False,
                                               enable_thinking=False)
        prefix = tokenizer.apply_chat_template(record['messages'][:-1],
            add_generation_prompt=True, return_dict=False, enable_thinking=False)
        if (tokens[:len(prefix)] != prefix or len(tokens) > 2048
                or not 0 < len(tokens) - len(prefix) <= 65):
            raise ValueError('weighted_example_token_boundary_changed')
        metadata = {key: decision[key] for key in ('id', 'example_hash', 'review_hash',
                    'criteria', 'category', 'raw_weight', 'rationale_codes')}
        entries.append({**metadata, 'tokenized_example_hash': token_key(tokens, len(prefix)),
                        'total_tokens': len(tokens), 'offset': len(prefix)})
    mean = sum(entry['raw_weight'] for entry in entries) / 152
    for entry in entries:
        entry['normalized_weight'] = entry['raw_weight'] / mean
    validation = [r for r in prepared.records if prepared.assignments[r['id']] == 'valid']
    validation_ntoks = sum(len(tokenizer.apply_chat_template(r['messages'], return_dict=False,
        enable_thinking=False)) - len(tokenizer.apply_chat_template(r['messages'][:-1],
        add_generation_prompt=True, return_dict=False, enable_thinking=False)) for r in validation)
    result = {'schema': 'frozen-functional-loss-weights-v1', 'proposal_hash': PROPOSAL_HASH,
        'manifest_id': prepared.plan['manifest_id'], 'records_hash': prepared.plan['records_hash'],
        'assignments_hash': prepared.plan['assignments_hash'],
        'classification_hash': classification['classification_hash'],
        'normalization': 'arithmetic_mean_over_training_examples', 'normalizer': mean,
        'training_example_count': 152, 'entries': entries,
        'validation_example_count': len(validation), 'validation_target_token_count': validation_ntoks,
        'expected_training_order_hash': expected_order(entries, len(validation)),
        'validation_weighting': 'unchanged_unweighted_all46'}
    result['weight_map_hash'] = p.digest(result)
    validate_map(result)
    return result


def experiment_plan(prepared, weights, *, weight_path):
    validate_map(weights)
    plan = prepared.plan
    train = {r['id']: r for r in prepared.records if prepared.assignments[r['id']] == 'train'}
    if (set(train) != {entry['id'] for entry in weights['entries']}
            or any(entry['example_hash'] != p.digest(train[entry['id']])
                   or entry['review_hash'] != train[entry['id']]['review_hash']
                   or entry['category'] != classification_category(entry)
                   for entry in weights['entries'])):
        raise ValueError('weighted_training_record_identity_changed')
    if (weights['records_hash'] != plan['records_hash']
            or weights['assignments_hash'] != plan['assignments_hash']
            or weights['manifest_id'] != plan['manifest_id']
            or plan['lengths']['train']['count'] != 152
            or plan['lengths']['valid']['count'] != 46 or plan['iters'] != 304
            or plan['save_every'] != 76 or plan['compile_mode'] != 'disabled'
            or plan['train_max_tokens'] != 2048 or plan['seq_length'] != 4096
            or plan['batch_size'] != 1 or plan['epochs'] != 2
            or weights['validation_example_count'] != 46
            or weights['expected_training_order_hash'] != expected_order(weights['entries'], 46)):
        raise ValueError('fixed_weighted_trial_factors_changed')
    result = {'schema': 'functional-weighted-trial-plan-v1', 'proposal_hash': PROPOSAL_HASH,
              'ordinary_training_plan': plan, 'weight_map_hash': weights['weight_map_hash'],
              'weight_map_path': str(e.owner_path(weight_path, exists=True)),
              'helper_fingerprint': helper_fingerprint(), 'validation_unweighted': True,
              'weighted_train_loss_comparable_to_prior': False, 'activation_performed': False}
    result['experiment_hash'] = p.digest(result)
    return result


@contextlib.contextmanager
def inject_training_child(weight_path, weights, observations):
    """Only a training config is redirected; all evaluation commands untouched."""
    original = p.guarded_training_run
    runtime_path = str(Path(e.__file__).with_name('training_runtime.py').resolve())
    weighted_path = str(Path(__file__).with_name('weighted_training_runtime.py').resolve())
    def guarded(command, **kwargs):
        if len(command) != 4 or str(command[1]) != runtime_path or command[2] != '--config':
            raise ValueError('unexpected_experimental_child_command')
        config = json.loads(Path(command[3]).read_text())
        if config.get('train') is True:
            if any(o['weighted'] for o in observations):
                raise ValueError('weighted_training_child_already_dispatched')
            command = [command[0], weighted_path, *command[2:], '--weight-map', str(weight_path),
                       '--expected-weight-map-hash', weights['weight_map_hash']]
            observations.append({'weighted': True, 'target_bound': config['inboxd_target_token_bound']})
        else:
            observations.append({'weighted': False, 'target_bound': config['inboxd_target_token_bound']})
        return original(command, **kwargs)
    p.guarded_training_run = guarded
    try:
        yield
    finally:
        p.guarded_training_run = original


def execute(prepared, weights, experiment, *, expected_experiment_hash, weight_path, daemon_args):
    """Explicit root launch only; preserves base staging/guards/lifecycle/selection."""
    if (experiment != experiment_plan(prepared, weights, weight_path=weight_path)
            or experiment['experiment_hash'] != expected_experiment_hash):
        raise ValueError('frozen_weighted_experiment_changed')
    weight_path = e.owner_path(weight_path, exists=True)
    if json.loads(weight_path.read_text()) != weights:
        raise ValueError('weight_file_changed')
    observations = []
    output = Path(prepared.plan['output'])
    receipt = {'schema': 'functional-weighted-trial-completion-v1', 'status': 'failed',
               'experiment_hash': expected_experiment_hash,
               'base_training_plan_hash': prepared.plan['plan_hash'],
               'weight_map_hash': weights['weight_map_hash'],
               'weight_map_sha256': hashlib.sha256(weight_path.read_bytes()).hexdigest(),
               'helper_fingerprint': helper_fingerprint()}
    try:
        with inject_training_child(weight_path, weights, observations):
            result = e.execute(prepared, expected_plan_hash=prepared.plan['plan_hash'],
                               daemon_args=daemon_args)
        if sum(o['weighted'] for o in observations) != 1 or sum(not o['weighted'] for o in observations) != 4:
            raise ValueError('weighted_trial_dispatch_count_changed')
        proof_path = output / 'adapter' / 'weighted-loss-observation.json'
        loss_proof = json.loads(proof_path.read_text())
        if (loss_proof['status'] != 'complete' or not loss_proof['complete']
                or loss_proof['weight_map_hash'] != weights['weight_map_hash']):
            raise ValueError('weighted_child_loss_observation_incomplete')
        receipt.update(status='awaiting_independent_evaluation',
                       loss_observation_sha256=hashlib.sha256(proof_path.read_bytes()).hexdigest(),
                       ordinary_completion_hash=p.digest(result))
    except BaseException as error:
        receipt['error_type'] = type(error).__name__
        raise
    finally:
        if output.exists():
            dispatch = {
                'experiment_hash': expected_experiment_hash,
                'weight_map_hash': weights['weight_map_hash'], 'dispatches': observations,
                'original_guard_restored': True, 'validation_weighted': False}
            p.private_json(output / 'weighted-dispatch-proof.json', dispatch)
            receipt['dispatch_proof_hash'] = p.digest(dispatch)
            receipt['receipt_hash'] = p.digest(receipt)
            p.private_json(output / 'weighted-completion.json', receipt)
    return result
