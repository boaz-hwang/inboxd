"""Freeze new holdout rules and consume body-free, source-audited candidates.

No model loading, generation, training, historical target reading or edits to
previous experiment contracts. Missing evidence always remains a hold.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import time


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':')).encode()).hexdigest()


def protocol():
    return {
        'schema': 'reply-holdout-expansion-protocol-v2',
        'created_unix': time.time(),
        'status': 'frozen_before_new_candidate_semantic_selection_and_any_new_outputs',
        'scope': 'Collect, audit and freeze data only; no inference, training, download or activation.',
        'historical_contracts_and_results': 'Preserved. New rules do not retroactively change old ready0 conclusions.',
        'rationale': 'Metadata inventory/hash preparation is not evidence of model consumption. Pre-watermark context is not leakage by timestamp alone. Actual model use, assessed-source/episode duplication and development tuning are audited separately.',
        'exposure_classes': {
            'actual_used': 'Gradient training, loss validation, generated evaluation/development inputs, or actual prompt/model selection use.',
            'semantic_tuning': 'Semantically inspected content used to change prompts, select models or tune behaviour rules.',
            'reviewed_only': 'Content assessed but no recorded model/tuning consumption; reviewer familiarity reported separately.',
            'metadata_only': 'IDs, room metrics, hashes, counts or reservation preparation only.',
            'unexposed': 'No recorded actual use or semantic review in audited local evidence.',
            'unknown': 'Use cannot be established; cannot assume unused.',
        },
        'axes': {
            'primary_actual_unseen_room': 'No actual model-use or semantic-tuning episode from this room. Reviewed-only and metadata-only rooms may qualify after case-level gates; report reviewer familiarity.',
            'secondary_seen_room_unseen_episode': 'Room has actual-use/tuning history, but entire actual production input and hidden-target sources are disjoint from prior actual used/assessed examples, and episode duplicates cleared. Never claim new-room generalization.',
            'strict_temporal_subset': 'Separate subset of either axis whose complete actual production source window is after original watermark. Target later alone is insufficient for this label.',
            'pure_blind_room_subset': 'Primary rooms without any prior semantic review; metadata listing alone does not remove them.',
        },
        'prior_evaluation': 'All old54 quality evaluation contexts are permanently excluded from fresh reuse, irrespective of source date or model run.',
        'pool_and_splits': 'Enumerate all accessible candidate metadata before semantic selection. Deterministic room assignment by SHA256(seed20261006, room), first modulo3 development and rest final. A room cannot cross development/final in either axis. Include all eligible cases and publish exclusions; no output-driven choice.',
        'source_and_duplicates': 'Zero shared actual-used or previously assessed case sources, including candidate hidden target source if any; no metadata-only source exclusion. Compare actual input/episode against train/valid/dev/eval/reviewed episodes: normalized exact and >=200-character 3-gram Jaccard>=0.9 flags, then independently assess semantic equivalence for suspicious pairs. Generic short politeness similarity alone is not episode equivalence. Uncertain/missing proof holds.',
        'input_integrity': 'Keep complete actual production input and serialization, verify actor/self/role and original source bindings. Do not cut earlier context or rewrite identifiers to force eligibility. Any display redaction is transient and does not change the input hash. Historical targets remain hidden from reviewers and model inputs.',
        'rubric': 'Before outputs, target-free reviewers freeze visible facts, unavailable facts, permissible dialogue acts, future check intentions, forbidden completion/status/authority claims, actor identity and context sufficiency. Several acts can be valid; historical self reply is not gold.',
        'privacy': 'Actual excluded credential/financial/private identifier sources blocked; purpose-uncertain access codes held. Public business contact or ordinary contact values do not automatically violate policy. Do not store original bodies/tokens.',
        'metrics': 'Warranted-answer sent-as-is denominator separate from justified no-reply safety. Both blinded independent judges must pass role/fact/authority/act and sent-as-is; errors and model abstentions remain failures in warranted-answer denominator, uncertainties reported. No automatic promotion.',
        'runtime': 'Data-ready is distinct from inference-ready; runtime model/prompt/weights/settings binding and authorisation are not part of this collection task.',
        'required_evidence': ['complete_prior_actual_use_and_review_scan', 'source_disjointness', 'exact_duplicate_audit', 'near_duplicate_audit', 'semantic_duplicate_clearance', 'full_input_integrity', 'preflight', 'privacy', 'target_hidden', 'frozen_rubric', 'independent_input_review'],
    }


EVIDENCE_KINDS = ('prior_use_audit', 'source_duplicate_audit', 'input_integrity',
                  'privacy_rubric', 'independent_input_review')


def split_addendum(frozen, previous_reservation, previous_raw_sha256):
    embargo = {row['chat']: row['split'] for row in previous_reservation['entries']
               if row.get('split') in ('development', 'final')}
    if len(embargo) != previous_reservation['reserved_rooms']:
        raise ValueError('previous_room_reservations_not_unique')
    return {
        'schema': 'reply-holdout-expansion-split-addendum-v1',
        'created_unix': time.time(), 'protocol_hash': digest(frozen),
        'status': 'append_only_correction_before_candidate_semantic_selection_or_outputs',
        'reason': 'Sorted room rank modulo3 moves assignments when inventories change; per-room hash modulo3 is invariant.',
        'rule': 'Existing4 room assignments take precedence. Otherwise int(SHA256({seed:20261006,room}),16)%3==0 development; else final. Never override embargo to improve coverage.',
        'old4_reservation_raw_sha256': previous_raw_sha256,
        'embargo_room_splits': embargo,
        'evidence_binding': 'Consumer requires externally recorded inventory, split-addendum and evidence-manifest digests; case assertion hashes bind every supplied field. Evidence refs must match external trusted receipt hashes and actual local bytes. Hash binding is integrity, not independent proof of semantic truth.',
    }


def reserve(inventory, frozen, expected_protocol_hash, *, split_contract,
            expected_split_contract_hash, expected_inventory_hash,
            evidence_manifest, expected_evidence_manifest_hash,
            trusted_receipt_hashes, receipt_root):
    if digest(frozen) != expected_protocol_hash:
        raise ValueError('frozen_protocol_changed')
    if frozen.get('schema') != 'reply-holdout-expansion-protocol-v2':
        raise ValueError('invalid_protocol')
    if digest(inventory) != expected_inventory_hash:
        raise ValueError('candidate_inventory_changed')
    if digest(split_contract) != expected_split_contract_hash or split_contract.get('protocol_hash') != expected_protocol_hash:
        raise ValueError('frozen_split_addendum_changed')
    if digest(evidence_manifest) != expected_evidence_manifest_hash or evidence_manifest.get('inventory_hash') != expected_inventory_hash:
        raise ValueError('frozen_evidence_manifest_changed')
    rows = inventory['entries']
    if len({row['id'] for row in rows}) != len(rows):
        raise ValueError('duplicate_candidate_id')
    bound = {row['id']: row for row in evidence_manifest['entries']}
    if len(bound) != len(evidence_manifest['entries']) or set(bound) != {row['id'] for row in rows}:
        raise ValueError('evidence_case_coverage_mismatch')
    splits = {room: split_contract['embargo_room_splits'].get(room) or
              ('development' if int(digest({'seed': 20261006, 'room': room}), 16) % 3 == 0 else 'final')
              for room in {row['chat'] for row in rows}}
    receipt_root = Path(receipt_root).resolve()
    out = []
    for row in rows:
        reasons = list(row.get('hard_exclusion_codes', []))
        evidence = bound[row['id']]
        if evidence.get('assertions_hash') != digest(row):
            raise ValueError('case_assertions_changed')
        for kind in EVIDENCE_KINDS:
            ref = evidence.get('evidence_refs', {}).get(kind)
            if not isinstance(ref, str) or ref not in trusted_receipt_hashes:
                reasons.append(kind + '_trusted_receipt_missing')
                continue
            path = (receipt_root / ref).resolve()
            if not path.is_relative_to(receipt_root) or not path.is_file():
                reasons.append(kind + '_receipt_missing_or_outside_root')
            elif hashlib.sha256(path.read_bytes()).hexdigest() != trusted_receipt_hashes[ref]:
                reasons.append(kind + '_receipt_hash_changed')
        for key in ['all_prior_use_scan_complete', 'source_audit_verified', 'lineage_verified', 'preflight_ready', 'historical_target_hidden', 'full_input_integrity_verified', 'rubric_frozen', 'independent_input_review_complete']:
            if row.get(key) is not True:
                reasons.append(key + '_missing_or_failed')
        if row.get('unresolved_lineage_relevant_to_case') is not False:
            reasons.append('relevant_unresolved_prior_lineage_or_unproven')
        if type(row.get('unresolved_source_count')) is not int or row['unresolved_source_count'] < 0:
            reasons.append('unresolved_source_count_missing')
        for key in ['source_comparison_coverage', 'semantic_comparison_coverage']:
            if not isinstance(row.get(key), dict) or not row[key]:
                reasons.append(key + '_missing')
        for key in ['actualused_source_intersection_count', 'prior_assessed_source_intersection_count', 'exact_duplicate_count', 'near_duplicate_count']:
            if type(row.get(key)) is not int or row[key] != 0:
                reasons.append(key + '_nonzero_or_unproven')
        if row.get('old54_overlap') is not False:
            reasons.append('old54_overlap_or_unproven')
        if row.get('semantic_duplicate_status') != 'clear':
            reasons.append('semantic_duplicate_or_uncertain')
        if row.get('privacy_status') != 'pass':
            reasons.append('privacy_not_cleared')
        if row.get('behavior_class') not in (
                'acknowledgement_only', 'visible_fact_answer', 'available_fact_action',
                'missing_information_clarification', 'future_check_or_coordination',
                'explicit_refusal', 'explicit_approval', 'bounded_scope',
                'actor_or_addressee_resolution', 'no_reply_warranted'):
            reasons.append('behavior_class_missing_or_unknown')
        if row.get('response_requirement') not in ('request_requires_response', 'optional_social_response', 'no_reply_safety', 'ambiguous_safety'):
            reasons.append('response_requirement_missing_or_unknown')
        if row.get('room_exposure_class') not in ('actual_used', 'semantic_tuning', 'reviewed_only', 'metadata_only', 'unexposed'):
            reasons.append('room_actual_use_unknown')
        for key in ['input_hash', 'context_hash', 'source_keys_hash', 'rubric_hash']:
            if not row.get(key):
                reasons.append(key + '_missing')
        ready = not reasons
        seen = row.get('room_exposure_class') in ('actual_used', 'semantic_tuning')
        out.append({
            'id': row['id'], 'chat': row['chat'],
            'input_hash': row.get('input_hash'), 'context_hash': row.get('context_hash'),
            'source_keys_hash': row.get('source_keys_hash'), 'rubric_hash': row.get('rubric_hash'),
            'split': splits[row['chat']],
            'axis': 'secondary_seen_room_unseen_episode' if seen else 'primary_actual_unseen_room',
            'room_exposure_class': row.get('room_exposure_class'),
            'prior_reviewer_familiarity': row.get('room_exposure_class') in ('actual_used', 'semantic_tuning', 'reviewed_only'),
            'pure_blind_room_subset': ready and row.get('room_exposure_class') in ('metadata_only', 'unexposed'),
            'strict_temporal_subset': ready and row.get('whole_context_after_cutoff') is True,
            'data_ready': ready, 'hold_codes': sorted(set(reasons)),
            'behavior_class': row.get('behavior_class'),
            'response_requirement': row.get('response_requirement'),
            'unresolved_source_count': row.get('unresolved_source_count'),
            'source_comparison_coverage': row.get('source_comparison_coverage'),
            'semantic_comparison_coverage': row.get('semantic_comparison_coverage'),
        })
    ready_rows = [row for row in out if row['data_ready']]
    result = {
        'schema': 'reply-holdout-expansion-data-reservation-v2',
        'created_unix': time.time(), 'protocol_hash': expected_protocol_hash,
        'split_contract_hash': expected_split_contract_hash,
        'evidence_manifest_hash': expected_evidence_manifest_hash,
        'inventory_hash': digest(inventory), 'candidate_count': len(rows),
        'data_ready_count': len(ready_rows),
        'data_ready_axis_counts': dict(Counter(row['axis'] for row in ready_rows)),
        'data_ready_split_counts': dict(Counter(row['split'] for row in ready_rows)),
        'response_requirement_counts': dict(Counter(row['response_requirement'] for row in ready_rows)),
        'warranted_answer_data_ready_count': sum(row['response_requirement'] == 'request_requires_response' for row in ready_rows),
        'optional_social_response_data_ready_count': sum(row['response_requirement'] == 'optional_social_response' for row in ready_rows),
        'ambiguous_safety_data_ready_count': sum(row['response_requirement'] == 'ambiguous_safety' for row in ready_rows),
        'no_reply_data_ready_count': sum(row['response_requirement'] == 'no_reply_safety' for row in ready_rows),
        'strict_temporal_subset_count': sum(row['strict_temporal_subset'] for row in ready_rows),
        'pure_blind_room_subset_count': sum(row['pure_blind_room_subset'] for row in ready_rows),
        'entries': out, 'inference_ready': False, 'new_model_outputs': 0,
    }
    result['reservation_sha256'] = digest(result)
    return result


def write(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--freeze', type=Path, required=True)
    args = parser.parse_args()
    frozen = protocol()
    write(args.freeze, frozen)
    print(json.dumps({'frozen_path': str(args.freeze), 'protocol_hash': digest(frozen)}))


if __name__ == '__main__':
    main()
