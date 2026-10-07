"""Read-only, body-free audit of metadata exposure versus actual model use.

This does not infer model use from a room appearing in a snapshot. It does not
produce a complete prior-use ledger or prepare cases for model inference.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def audit(base):
    refs = {}

    def read(relative, lines=False):
        path = base / relative
        raw = path.read_bytes()
        refs[relative] = hashlib.sha256(raw).hexdigest()
        return [json.loads(row) for row in raw.decode().splitlines() if row.strip()] \
            if lines else json.loads(raw)

    snapshot = read('learning/expansion-20261003/dataset-snapshot.json')
    ledger = read('evaluations/failure-eval-audit-20261006/exposure-ledger.json')
    samples = read('learning/granite-fullpool-20261006-v1/all-admitted-train-sample-manifest.json')['ordered_receipts']
    coverage = read('learning/granite-training-20261006/full-epoch/train/coverage.jsonl', True)
    receipt = read('learning/granite-training-20261006/full-epoch/train/receipt.json')
    pair = read('evaluations/granite-finetune-20261006/manifest.json')
    temporal = read('evaluations/failure-eval-audit-20261006/temporal/temporal-source-window-audit.json')
    previous = read('learning/expansion-20261003/expanded-training-session-v3/manifest-frozen.json')
    previous_run = read('learning/expansion-20261003/expanded-training-session-v3/run/completion.json')
    expected = {row['id']: row['token_sha256'] for row in samples}
    actual = {row['id']: row['token_sha256'] for row in coverage}
    result = {
        'schema': 'independent-methodology-exposure-audit-v1',
        'created_unix': time.time(),
        'reviewer': 'agent_delegated_independent_methodology_auditor',
        'historical_results_and_contracts_modified': False,
        'models_loaded_or_outputs_generated': 0,
        'original_bodies_or_token_arrays_persisted': 0,
        'metadata_only_evidence': {
            'snapshot_rooms': len(snapshot['room_metrics']),
            'source_metadata_rows': len(snapshot['source']['rows']),
            'source_row_fields': sorted(snapshot['source']['rows'][0]),
            'queue_metadata_rows': len(snapshot['queue']['entries']),
            'old_ledger_rooms': len(ledger['exposed_rooms']),
            'old_ledger_input_hash_count': len(ledger['input_hashes']),
            'conclusion': 'Room metadata or ID/hash listing alone does not demonstrate semantic review, gradient updates, loss evaluation, generation or prompt tuning.',
            'unknowns': 'This does not prove that all snapshot rooms were otherwise unused. Actual-use and semantic-review evidence must be independently audited.',
        },
        'actual_model_use_evidence': {
            'full_epoch_status': receipt['status'],
            'full_epoch_trained_examples': receipt['trained_examples'],
            'full_epoch_coverage_rows': len(coverage),
            'full_epoch_unique_ids': len(actual),
            'coverage_exactly_matches_1374_manifest_ids_and_token_hashes': actual == expected and len(coverage) == len(samples) == 1374,
            'old_quality_input_count': len(pair['input_receipts']),
            'old_quality_real_count': pair['real_case_count'],
            'old_quality_synthetic_count': pair['observed_synthetic_count'],
            'old54_fresh_reuse_prohibited': True,
            'previous_expanded_v3_supplied_records': len(previous['records']),
            'previous_expanded_v3_train_records': sum(row['split'] == 'train' for row in previous['records']),
            'previous_expanded_v3_valid_records': sum(row['split'] == 'valid' for row in previous['records']),
            'previous_expanded_v3_assignment_metadata_count': len(previous['assignments']),
            'previous_expanded_v3_run_status': previous_run['status'],
            'previous_expanded_v3_checkpoint_selection_recorded': bool(previous_run.get('checkpoint_selection')),
            'complete_all_prior_model_use_ledger': False,
        },
        'temporal_old31': {
            'count': temporal['count'],
            'target_after_cutoff': temporal['target_after_cutoff_count'],
            'whole_window_after_cutoff': temporal['full_source_window_after_cutoff_count'],
            'actual_train_source_intersection': temporal['actual_train_source_intersection_case_count'],
            'not_known_train_source_intersection': temporal['count'] - temporal['actual_train_source_intersection_case_count'],
            'conclusion': 'Pre-watermark context alone is not evidence of train/evaluation leakage. It disqualifies strict whole-window temporal novelty, but may allow a separately labelled source-disjoint unseen episode after other gates.',
            'not_ready': 'Nonintersection with 1374 alone is insufficient: prior experiments, old evaluation/development/review episodes, duplicate checks, privacy and source reconstruction/preflight remain required.',
            'hard_exclusion_counts': temporal['hard_exclusion_code_counts'],
        },
        'recommended_new_protocol_axes': [
            'primary_room_heldout_from_actual_training_development_generation_and_prior_semantic_tuning; metadata_listing_alone_is_not_exposure',
            'secondary_seen_room_source_disjoint_unseen_episode; no_new_room_claim',
            'strict_temporal_subset_whole_production_source_window_after_cutoff; separately_counted',
        ],
        'required_new_protocol_controls': [
            'Freeze appendix and full enumerated candidate inventory before new model outputs; never select by output quality.',
            'Hide historical target from all case rubric reviewers; rubric-only preoutput review is authorised evaluation preparation, not evidence the evaluated model consumed it.',
            'Separate metadata-listed, semantically-reviewed, actual-train, loss-valid, generated, prompt-tuned and unknown-lineage evidence.',
            'Compare candidate input and withheld target sources/episodes against actual prior train/valid/dev/eval inputs and targets; old54 evaluation contexts never fresh again.',
            'Keep complete actual production input; do not crop shared history to manufacture independence.',
            'Reserve whole rooms before semantic selection; report full pool and exclusions; maintain independent final versus development sources and episodes.',
            'Audit normalized exact and lexical near duplicates plus independent semantic review of suspicious pairs; lexical zero is not semantic equivalence proof.',
            'Freeze actor, visible/unavailable facts, permissible acts and forbidden claims before inference; no-reply safety is separate from warranted-answer sendability.',
            'New protocol axes do not retroactively relabel prior sealed results and do not authorise inference, training or activation.',
        ],
        'source_file_sha256': refs,
        'signature_kind': 'SHA256_integrity_attestation_not_cryptographic_identity_signature',
    }
    result['review_attestation_sha256'] = digest(result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', type=Path, default=Path.home() / '.inboxd/reply-model')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.base)
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    import os
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps({'audit_path': str(args.output),
                      'actual1374_token_binding_matches': result['actual_model_use_evidence']['coverage_exactly_matches_1374_manifest_ids_and_token_hashes'],
                      'attestation_sha256': result['review_attestation_sha256']}))


if __name__ == '__main__':
    main()
