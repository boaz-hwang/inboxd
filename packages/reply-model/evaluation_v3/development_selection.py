"""Select one complete development checkpoint under the pre-final frozen rule."""
import math
from independent import read, check_seal, seal, now


def select_checkpoint(summary_path, checkpoint_metadata_path, rule_path):
    summary, metadata, rule = map(read, (summary_path, checkpoint_metadata_path, rule_path))
    check_seal(summary, 'summary_hash')
    check_seal(metadata, 'checkpoint_metadata_hash')
    check_seal(rule, 'selection_rule_hash')
    if summary['suite_hash'] != rule['suite_hash']:
        raise ValueError('development_suite_mismatch')
    candidates = rule['candidate_methods']
    if set(metadata['checkpoints']) != set(candidates):
        raise ValueError('complete_candidate_metadata_required')
    if metadata.get('loss_measurement_kind') != 'reevaluated_saved_artifact' or not metadata.get('validation_set_hash'):
        raise ValueError('exact_saved_artifact_loss_provenance_required')
    metrics = summary['methods']
    expected_count = metadata['development_case_count']
    if expected_count != 24:
        raise ValueError('frozen_dev_twenty_four_required')
    if set(metrics) != set(candidates + rule['diagnostic_methods']):
        raise ValueError('complete_five_method_judgments_required')
    if any(metrics[m]['count'] != expected_count for m in metrics):
        raise ValueError('incomplete_development_judgments')
    steps = [metadata['checkpoints'][m]['step'] for m in candidates]
    if any(type(s) is not int or s <= 0 for s in steps) or len(set(steps)) != len(steps):
        raise ValueError('distinct_chronological_steps_required')
    ranks = {}
    for method in candidates:
        q, c = metrics[method], metadata['checkpoints'][method]
        if not c.get('adapter_artifact_hash') or not c.get('loss_evaluation_hash'):
            raise ValueError('exact_checkpoint_artifact_identity_required')
        values = [q['usefulness_mean'], q['style_mean'], c['validation_loss']]
        if any(not isinstance(x, (int, float)) or not math.isfinite(x) for x in values):
            raise ValueError('finite_quality_and_loss_required')
        if any(not 1 <= x <= 5 for x in values[:2]) or values[2] < 0:
            raise ValueError('quality_or_loss_out_of_range')
        for key in ('clear_semantic_failure_cases', 'unresolved_semantic_cases'):
            if type(q[key]) is not int or not 0 <= q[key] <= expected_count:
                raise ValueError('case_count_metric_invalid')
        ranks[method] = (q['clear_semantic_failure_cases'], q['unresolved_semantic_cases'],
                         -q['usefulness_mean'], -q['style_mean'], c['validation_loss'], c['step'])
    selected = min(candidates, key=lambda m: ranks[m])
    loss_only = min(candidates, key=lambda m: (metadata['checkpoints'][m]['validation_loss'],
                                               metadata['checkpoints'][m]['step']))
    return seal({'schema': 'global-development-checkpoint-selection-v1', 'frozen_at_utc': now(),
        'selection_rule_hash': rule['selection_rule_hash'], 'summary_hash': summary['summary_hash'],
        'checkpoint_metadata_hash': metadata['checkpoint_metadata_hash'],
        'selected_method': selected, 'selected_checkpoint': metadata['checkpoints'][selected],
        'minimum_validation_loss_method': loss_only,
        'minimum_validation_loss_checkpoint': metadata['checkpoints'][loss_only],
        'rank_keys': {m: list(ranks[m]) for m in candidates},
        'exact_quality_and_loss_ties': [m for m in candidates if ranks[m][:-1] == ranks[selected][:-1]],
        'selection_scope': 'one global checkpoint; no per-case selection',
        'final_outputs_seen': False, 'activation_authorized': False}, 'checkpoint_selection_hash')
