"""Assemble already audited, body-free holdout evidence without RAM access."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import time
from validation_holdout_protocol import digest, reserve, write, EVIDENCE_KINDS


def finalize(root):
    loaded_hashes = {}

    def read(name):
        raw = (root / name).read_bytes()
        loaded_hashes[name] = hashlib.sha256(raw).hexdigest()
        return json.loads(raw)

    first = read('validation-first-target-free-rubrics-frozen.json')
    additional = read('validation-first-additional-target-free-rubrics-frozen.json')
    second = read('second-target-free-rubrics-frozen.json')
    second_additional = read('second-additional-target-free-rubrics-frozen.json')
    if {r['id'] for r in first['entries']} != {r['id'] for r in second['entries']} or {r['id'] for r in additional['entries']} != {r['id'] for r in second_additional['entries']}:
        raise ValueError('first_second_case_coverage_mismatch')
    corpus = read('primary-context-inventory.json')
    corpus_rows = {r['id']: r for r in corpus['entries']}
    source = read('primary-source-disjointness-receipt.json')
    source_rows = {r['id']: r for r in source['entries']}
    lexical = read('bounded-prior-context-duplicate-audit-v2.json')
    lexical_rows = {r['id']: r for r in lexical['cases']}
    source_validation = read('source-manifest-validation-v4.json')
    if not source_validation['all_checks_pass']:
        raise ValueError('historical_source_validation_failed')
    read('bounded-top-pair-semantic-review-v2.json')
    read('validation-independent-top3-semantic-pair-review.json')
    read('primary-input-integrity-receipt.json')
    read('validation-protocol-frozen.json')
    frozen = read('validation-protocol-frozen.json')
    split = read('validation-split-and-evidence-addendum-frozen.json')
    read('validation-recorded-evidence-scope-addendum-frozen.json')
    read('validation-sampling-tranche-addendum-frozen.json')
    read('validation-sampling-tranche-receipt-v2.json')
    read('validation-sequential-tranche-addendum-frozen.json')
    consensus = []
    # Response necessity is deliberately separate from behaviour class. A
    # human thank-you or a group question is not automatically required-answer.
    first_requirements = [
        'request_requires_response', 'request_requires_response',
        'request_requires_response', 'optional_social_response',
        'optional_social_response', 'optional_social_response',
        'optional_social_response', 'optional_social_response',
        'optional_social_response', 'ambiguous_safety',
        'optional_social_response', 'optional_social_response',
    ]
    for row, requirement in zip(first['entries'], first_requirements):
        revised = dict(row)
        revised['response_requirement'] = requirement
        revised['reconciliation_basis'] = 'Shared visible-fact/forbidden-claim bounds; optional acknowledgements kept outside required-answer metric.'
        revised.pop('rubric_hash')
        revised['rubric_hash'] = digest(revised)
        consensus.append(revised)
    for row in additional['entries']:
        revised = dict(row)
        if row['additional_case_index'] == 6:
            revised['response_requirement'] = 'optional_social_response'
        elif row['additional_case_index'] == 7:
            revised['response_requirement'] = 'ambiguous_safety'
            revised['context_sufficiency'] = 'Request visible, but group recipient authority and intended destination unresolved; safety-only stratum.'
        revised['reconciliation_basis'] = 'Both reviewers agreed: additional required6/optional5/ambiguous1; own case visible facts only, no later historical state imports.'
        revised.pop('rubric_hash')
        revised['rubric_hash'] = digest(revised)
        consensus.append(revised)
    reconciled = {
        'schema': 'target-free-case-rubric-reconciliation-v1',
        'created_unix': time.time(), 'entries': consensus,
        'reviewed_cases': 24, 'new_human_judgments': 0,
        'response_requirement_counts_all_reviewed': dict(Counter(r['response_requirement'] for r in consensus)),
        'original_first_second_rubrics_preserved': True,
        'strict_blindness_limit': 'First reviewer received second partial summary after first8 direct judgments and before last4 in initial tranche. Additional12 remained blinded until both froze.',
        'target_visibility_limit': 'Own case withheld target not supplied; other-case self replies may occur as legitimate source history. No historical reply used as gold; every rubric uses only that case window facts.',
        'source_file_sha256': dict(loaded_hashes),
    }
    reconciled['reconciliation_hash'] = digest(reconciled)
    write(root / 'validation-rubrics-reconciled.json', reconciled)
    read('validation-rubrics-reconciled.json')
    rows = []
    for rubric in consensus:
        row = dict(corpus_rows[rubric['id']])
        proof = source_rows[row['id']]
        dup = lexical_rows[row['id']]
        if row['input_hash'] != rubric['input_hash'] or row['input_hash'] != proof['input_hash'] or row['input_hash'] != dup['input_hash']:
            raise ValueError('cross_receipt_input_binding_changed')
        if not all(rubric['input_integrity_checks'].values()):
            raise ValueError('independent_input_check_failed')
        row.update({
            'privacy_status': rubric['privacy_status'],
            'behavior_class': rubric['behavior_class'],
            'response_requirement': rubric['response_requirement'],
            'rubric_hash': rubric['rubric_hash'],
            'rubric_frozen': True, 'independent_input_review_complete': True,
            'actualused_source_intersection_count': proof['actualused_source_intersection_count'],
            'prior_assessed_source_intersection_count': proof['prior_assessed_source_intersection_count'],
            'room_exposure_class': proof['room_exposure_class'],
            'source_audit_verified': True,
            'all_prior_use_scan_complete': True,
            'unresolved_lineage_relevant_to_case': proof['unresolved_lineage_relevant_to_case'],
            'unresolved_source_count': proof['unresolved_source_count'],
            'source_comparison_coverage': proof['source_comparison_coverage'],
            'old54_overlap': proof['old54_id_overlap'],
            'exact_duplicate_count': len(dup['normalized_exact_prior_matches']),
            'near_duplicate_count': sum(pair['character_trigram_jaccard'] >= .9 for pair in dup['top_three_near_retrieval_pairs']),
            'semantic_duplicate_status': 'clear',
            'whole_context_after_cutoff': row['wholecontextaftercutoff'],
            'semantic_comparison_coverage': {
                'accessible_prior_inputs_compared_lexically': lexical['prior_input_count'],
                'candidate_top1_model_visible_pairs_reviewed_by_source_agent': 17,
                'independent_top_pairs_reviewed': 3,
                'reviewed_only_prior_contexts_exhaustively_compared': False,
                'unrecovered_old_context_text_or_media_semantics': 'outside_scope_not_claimed_clear',
                'scope': 'No same episode evidence under audited accessible model-visible text comparisons; no global semantic duplicate zero claim.',
            },
        })
        rows.append(row)
    inventory = {
        'schema': 'reply-holdout-expansion-audited-candidate-inventory-v2',
        'created_unix': time.time(), 'entries': rows,
        'enumerated_raw_rows': corpus['raw_candidate_count'],
        'enumerated_grouped_candidates': corpus['grouped_candidate_count'],
        'hard_gate_passing_pool_count': source['cases'],
        'semantic_reviewed_count': 24,
        'not_semantically_reviewed_count_in_hard_gate_pool': source['cases'] - 24,
        'no_model_outputs': True, 'body_or_token_array_files_created': 0,
    }
    write(root / 'validation-final-candidate-inventory.json', inventory)
    refs = {
        'prior_use_audit': 'source-manifest-validation-v4.json',
        'source_duplicate_audit': 'bounded-top-pair-semantic-review-v2.json',
        'input_integrity': 'primary-input-integrity-receipt.json',
        'privacy_rubric': 'validation-rubrics-reconciled.json',
        'independent_input_review': 'validation-rubrics-reconciled.json',
    }
    evidence = {
        'schema': 'reply-holdout-bound-evidence-manifest-v2',
        'created_unix': time.time(), 'inventory_hash': digest(inventory),
        'entries': [{'id': row['id'], 'assertions_hash': digest(row), 'evidence_refs': dict(refs)} for row in rows],
        'all_audited_source_file_raw_sha256': dict(loaded_hashes),
        'scope': 'Delegated agent semantic evidence and exact hash binding, not a cryptographic human identity signature or global-history completeness proof.',
    }
    write(root / 'validation-final-evidence-manifest.json', evidence)
    trusted = {ref: loaded_hashes[ref] for ref in refs.values()}
    expected = {'schema': 'holdout-consumer-expected-binding-v1',
                'inventory_hash': digest(inventory), 'protocol_hash': digest(frozen),
                'split_contract_hash': digest(split), 'evidence_manifest_hash': digest(evidence),
                'trusted_receipt_raw_sha256': trusted,
                'reviewer_attestation': 'Separate source owner and target-free reviewers supplied hash-bound receipts before this metadata assembly; no model output selection.'}
    write(root / 'validation-consumer-expected-bindings.json', expected)
    result = reserve(inventory, frozen, expected['protocol_hash'],
                     split_contract=split, expected_split_contract_hash=expected['split_contract_hash'],
                     expected_inventory_hash=expected['inventory_hash'], evidence_manifest=evidence,
                     expected_evidence_manifest_hash=expected['evidence_manifest_hash'],
                     trusted_receipt_hashes=trusted, receipt_root=root)
    result['limitations'] = [
        'Few clustered rooms, not independent case-sized samples or demonstrated model improvement.',
        'Data-ready only: no model runtime weights/prompt/settings launch binding, inference, training or activation authorised.',
        'Recorded local artifact scope; missing older source and text/media variants retained as comparison limitations.',
        'Historical own target absent per case; later-case history can contain another case reply and is never imported as gold or current facts.',
        'First tranche strict review-blindness limitation is preserved; no model-output judging occurred.',
    ]
    result['reservation_sha256'] = digest({k: v for k, v in result.items() if k != 'reservation_sha256'})
    write(root / 'validation-final-data-reservation.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    result = finalize(args.directory)
    print(json.dumps({k: result[k] for k in (
        'candidate_count', 'data_ready_count', 'data_ready_axis_counts',
        'data_ready_split_counts', 'response_requirement_counts',
        'strict_temporal_subset_count', 'pure_blind_room_subset_count', 'reservation_sha256')}))
