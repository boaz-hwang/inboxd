"""Dedicated experimental child: globally normalized answer-loss weights.

The original runtime remains unchanged. Evaluation returns its exact ordinary
loss and token count. This entry point is never used for production inference.
"""
import argparse
from collections import Counter
import json
import math
import re
import sys
from pathlib import Path

import personalization as p
import training_runtime as runtime


RAW_WEIGHTS = {
    'required_state_preservation': 2.0,
    'mandatory_abstain_only': 1.0,
    'useful_clarification_or_future_intent': 2.0,
    'real_acknowledgement_or_greeting': .5,
    'all_other_examples': 1.0,
}


def token_key(tokens, offset):
    return p.digest({'tokens': tokens, 'offset': offset})


def validate_map(value):
    if (value.get('schema') != 'frozen-functional-loss-weights-v1'
            or value.get('weight_map_hash') != p.digest(
                {k: v for k, v in value.items() if k != 'weight_map_hash'})
            or value.get('normalization') != 'arithmetic_mean_over_training_examples'):
        raise ValueError('frozen_weight_map_invalid')
    entries = value['entries']
    if not entries or len(entries) != value['training_example_count']:
        raise ValueError('weight_map_count_changed')
    if len({e['id'] for e in entries}) != len(entries):
        raise ValueError('weight_map_duplicate_identity')
    mean = sum(RAW_WEIGHTS[e['category']] for e in entries) / len(entries)
    if not math.isclose(mean, value['normalizer'], rel_tol=0, abs_tol=1e-12):
        raise ValueError('weight_map_global_normalizer_changed')
    index = {}
    for entry in entries:
        raw = RAW_WEIGHTS[entry['category']]
        alpha = raw / mean
        if (type(entry['raw_weight']) not in (int, float)
                or type(entry['normalized_weight']) not in (int, float)
                or entry['raw_weight'] != raw or not math.isfinite(entry['normalized_weight'])
                or not math.isclose(alpha, entry['normalized_weight'], rel_tol=0, abs_tol=1e-12)
                or not entry.get('example_hash') or not entry.get('review_hash')):
            raise ValueError('weight_map_entry_changed')
        key = entry['tokenized_example_hash']
        if not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{64}', key):
            raise ValueError('weight_map_token_hash_invalid')
        if key in index and index[key] != alpha:
            raise ValueError('ambiguous_tokenized_example_weight')
        index[key] = alpha
    return index


def weighted_loss(base_loss, value, observations=None):
    index = validate_map(value)
    def loss(model, batch, lengths, **kwargs):
        # Installed trainer evaluates with model.eval(), then restores train().
        # Returning directly preserves validation arithmetic and ntoks exactly.
        if model.training is False:
            result = base_loss(model, batch, lengths, **kwargs)
            if observations is not None:
                observations['unweighted_eval_calls'] += 1
                observations['unweighted_eval_ntoks'] += int(result[1].item())
            return result
        if model.training is not True or batch.shape[0] != 1:
            raise ValueError('weighted_training_requires_batch_one')
        bounds = lengths.tolist()
        if len(bounds) != 1 or len(bounds[0]) != 2:
            raise ValueError('weighted_training_lengths_invalid')
        offset, total = bounds[0]
        if not 0 < offset < total <= batch.shape[1]:
            raise ValueError('weighted_training_target_invalid')
        key = token_key(batch[0, :total].tolist(), offset)
        if key not in index:
            raise ValueError('unfrozen_training_example')
        ordinary, ntoks = base_loss(model, batch, lengths, **kwargs)
        if int(ntoks.item()) != total - offset:
            raise ValueError('weighted_loss_target_count_changed')
        if observations is not None:
            observations['ordered_training_keys'].append(key)
            observations['training_ntoks'] += int(ntoks.item())
        # No per-batch sum-of-weights denominator: batch1 would cancel it.
        return ordinary * index[key], ntoks
    return loss


def audit_observations(value, observations):
    expected = Counter(entry['tokenized_example_hash'] for entry in value['entries'])
    expected = {key: count * 2 for key, count in expected.items()}
    seen = dict(Counter(observations['ordered_training_keys']))
    order_hash = p.digest(observations['ordered_training_keys'])
    total_ntoks = sum(entry['total_tokens'] - entry['offset'] for entry in value['entries']) * 2
    valid_count = value['validation_example_count'] * 5
    valid_ntoks = value['validation_target_token_count'] * 5
    complete = (seen == expected and len(observations['ordered_training_keys']) == len(value['entries']) * 2
                and observations['training_ntoks'] == total_ntoks
                and observations['unweighted_eval_calls'] == valid_count
                and observations['unweighted_eval_ntoks'] == valid_ntoks
                and order_hash == value['expected_training_order_hash'])
    return {'weight_map_hash': value['weight_map_hash'], 'actual_train_loss_calls': len(observations['ordered_training_keys']),
            'unique_tokenized_examples': len(expected), 'original_training_ids': len(value['entries']),
            'seen_counts': seen, 'expected_seen_counts': expected, 'ordered_key_hash': order_hash,
            'expected_ordered_key_hash': value['expected_training_order_hash'],
            'training_ntoks': observations['training_ntoks'], 'expected_training_ntoks': total_ntoks,
            'unweighted_eval_calls': observations['unweighted_eval_calls'],
            'unweighted_eval_ntoks': observations['unweighted_eval_ntoks'],
            'complete': complete}


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--weight-map', required=True, type=Path)
    parser.add_argument('--expected-weight-map-hash', required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    value = json.loads(args.weight_map.read_text())
    if (value['weight_map_hash'] != args.expected_weight_map_hash
            or value['training_example_count'] != 152 or config.get('train') is not True
            or config.get('test') is not False or config.get('batch_size') != 1
            or config.get('inboxd_compile_mode') != 'disabled'
            or config.get('inboxd_target_token_bound') != 65
            or config.get('iters') != 304 or config.get('save_every') != 76
            or config.get('steps_per_eval') != 76 or config.get('val_batches') != -1
            or config.get('seed') != 0 or config.get('num_layers') != 4
            or config.get('max_seq_length') != 4096
            or config.get('mask_prompt') is not True or config.get('grad_checkpoint') is not True):
        raise ValueError('exact_weighted_experiment_required')
    # Patch only this newly spawned process, before install_runtime binds loss.
    observations = {'ordered_training_keys': [], 'training_ntoks': 0,
                    'unweighted_eval_calls': 0, 'unweighted_eval_ntoks': 0}
    runtime.checkpointed_loss = weighted_loss(runtime.checkpointed_loss, value, observations)
    sys.argv = [sys.argv[0], '--config', str(args.config)]
    succeeded = False
    try:
        runtime.main()
        succeeded = True
    finally:
        proof = audit_observations(value, observations)
        proof['child_main_returned'] = succeeded
        proof['status'] = 'complete' if succeeded and proof['complete'] else 'failed'
        p.private_json(Path(config['adapter_path']) / 'weighted-loss-observation.json', proof)
    if not proof['complete']:
        raise ValueError('weighted_loss_actual_call_audit_failed')


if __name__ == '__main__':
    main()
