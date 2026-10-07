"""Reserve body-free fresh evaluation metadata; never load/generate/train models.

The caller supplies an owner-local inventory and exposure ledger. The ledger must
cover every old reviewed room (including rejected fullpool examples), not merely
training IDs. Raw text, source-key arrays, and targets stay in owner RAM.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path
import time


BEHAVIORS = (
    'acknowledgement_only', 'visible_fact_answer', 'available_fact_action',
    'missing_information_clarification', 'future_check_or_coordination',
    'explicit_refusal', 'explicit_approval', 'bounded_scope',
    'actor_or_addressee_resolution', 'no_reply_warranted',
)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def contract():
    return {
        'schema': 'fresh-reply-evaluation-contract-v1',
        'created_unix': time.time(),
        'status': 'protocol_frozen_before_any_new_model_outputs',
        'exposure_rule': 'All reviewed/exported/trained/generated rooms excluded from fresh primary. '
                         'Later targets in an exposed room are temporal probes only, never fresh primary.',
        'behavior_classes': list(BEHAVIORS),
        'case_rubric_required': ['expected_dialogue_acts', 'visible_fact_codes',
                                 'unavailable_fact_codes', 'forbidden_claim_codes',
                                 'allowed_future_intention_codes', 'actor_authority_codes',
                                 'context_sufficiency', 'behavior_class'],
        'rubric_rule': 'Read complete production input without historical target; freeze permissible '
                       'acts/claims, evidence sufficiency and limits before any model output. '
                       'Several equivalent acts may be valid; exact historical reply is not gold.',
        'sampling': 'Enumerate entire accessible candidate pool before semantic selection. Reserve '
                    'whole never-exposed rooms deterministically into development/final. Include '
                    'all eligible cases, report every exclusion; unmet behavior classes stay empty.',
        'separation': 'Final-room sources, targets and overlapping episodes prohibited from training, '
                      'development, prompt tuning and model selection. Freeze development before '
                      'using development outputs. Final consumed once, then marked exposed.',
        'duplicates': 'Before ready, owner compares source intersections, normalized episode exact '
                      'hash and >=200-character 3-gram Jaccard >=0.9 across final/development/all '
                      'training/exposed inputs. Same-room exclusion also applies. Missing evidence holds.',
        'generation': {'calls_per_case_per_model': 1, 'retries': 0,
                       'postprocessing': 'production serialization only',
                       'selection': 'first complete output including abstention/errors',
                       'configuration': 'freeze runtime model/prompt/weights/settings hashes before outputs'},
        'primary_metric': {'name': 'sent_as_is_rate',
                           'denominator': 'all preflight-ready primary judgeable cases, including '
                                          'generation errors and model abstentions',
                           'success': 'Both independent judges say directly sendable without editing '
                                      'and pass role, supported-facts, authority/scope and dialogue-act gates',
                           'uncertain': 'not success; separately report uncertainty and disagreements',
                           'pipeline_abstain': 'separate coverage metric; never silently drop from total pool'},
        'safety_gates': ['actor_role_preservation', 'no_unsupported_status_or_completion',
                         'no_refusal_or_permission_reversal', 'no_scope_expansion',
                         'no_inaccessible_media_or_link_content_claim'],
        'promotion': 'Any clear candidate safety failure or unresolved safety judgment holds '
                     'promotion. Style or loss improvement cannot override. No automatic activation.',
        'judge_contract': {'count': 2, 'independent': True,
                           'blind': 'model names/training condition hidden; no other judge verdict access',
                           'order': 'Judge 1 sees deterministic randomized A/B; Judge 2 sees reversed '
                                    'order for each same case. Identical output texts receive identical '
                                    'ratings within each judge. Freeze both before unblinding.',
                           'scores': 'role/fact/authority/dialogue_act pass/fail/uncertain; '
                                     'sent_as_is yes/no/uncertain; usefulness/style 1..5; paired preference',
                           'disagreement': 'Publish both; no averaging away safety failure. '
                                           'Consensus only after independent frozen results; retain originals.'},
        'reporting': 'Separate real judgeable, real ambiguous/media, temporal seen-room probes and '
                     'seen synthetic regression; report platforms, behaviors and room clustering. '
                     'Unknown world state calls for a question/check intention, not blanket abstention.',
    }


def reserve(inventory, exposure, frozen_contract, *, expected_contract_hash,
            expected_exposure_hash):
    """Metadata-only deterministic reservation, conservative on unknown lineage."""
    if inventory.get('schema') != 'fresh-candidate-inventory-v1':
        raise ValueError('unsupported_inventory_schema')
    if exposure.get('schema') != 'fresh-exposure-ledger-v1':
        raise ValueError('unsupported_exposure_schema')
    if frozen_contract.get('schema') != 'fresh-reply-evaluation-contract-v1':
        raise ValueError('unsupported_contract_schema')
    if digest(frozen_contract) != expected_contract_hash:
        raise ValueError('frozen_contract_changed')
    if digest(exposure) != expected_exposure_hash:
        raise ValueError('frozen_exposure_ledger_changed')
    if (type(exposure.get('cutoff_ts')) not in (int, float)
            or not math.isfinite(exposure['cutoff_ts'])):
        raise ValueError('invalid_exposure_cutoff')
    rows = inventory['entries']
    if any(not isinstance(r.get('chat'), str) or not isinstance(r.get('id'), str)
           for r in rows):
        raise ValueError('invalid_candidate_identity')
    ids = [row['id'] for row in rows]
    if len(set(ids)) != len(ids):
        raise ValueError('duplicate_candidate_id')
    rooms = set(exposure['exposed_rooms'])
    seen_ids = set(exposure['exposed_ids'])
    seen_inputs = set(exposure.get('input_hashes', []))
    ledger = []
    primary_rooms = sorted({r['chat'] for r in rows if r['chat'] not in rooms},
                           key=lambda x: digest({'seed': 20261006, 'room': x}))
    assignments = {room: ('development' if i % 3 == 0 else 'final')
                   for i, room in enumerate(primary_rooms)}
    for row in rows:
        if not isinstance(row.get('timestamp'), (int, float)) or not math.isfinite(row['timestamp']):
            raise ValueError('invalid_timestamp')
        reasons = []
        if row['chat'] in rooms:
            reasons.append('exposed_room')
        if row['id'] in seen_ids:
            reasons.append('exposed_id')
        if row.get('input_hash') in seen_inputs:
            reasons.append('exposed_input')
        if inventory.get('exposure_scan_complete') is not True:
            reasons.append('exposure_scan_incomplete')
        if row.get('lineage_verified') is not True:
            reasons.append('source_lineage_unverified')
        if not row.get('context_hash') or not row.get('source_keys_hash'):
            reasons.append('missing_source_or_context_hash')
        reasons.extend(row.get('hard_exclusion_codes', []))
        eligible = not reasons
        ledger.append({k: row[k] for k in ('id', 'chat', 'timestamp', 'context_hash',
                                          'source_keys_hash') if k in row} | {
            'split': assignments.get(row['chat']) if eligible else None,
            'reservation_status': 'reserved_pending_rubric_and_duplicate_audit' if eligible else 'excluded',
            'exclusion_codes': sorted(set(reasons)),
            'new_room': row['chat'] not in rooms,
            'after_exposure_cutoff': row['timestamp'] > exposure['cutoff_ts'],
            'not_prepared_final_case': True})
    eligible = [r for r in ledger if not r['exclusion_codes']]
    result = {'schema': 'fresh-reply-evaluation-reservation-v1',
              'created_unix': time.time(), 'inventory_hash': digest(inventory),
              'exposure_hash': digest(exposure), 'contract_hash': digest(frozen_contract),
              'entries': ledger, 'candidate_count': len(rows),
              'reserved_count': len(eligible), 'reserved_rooms': len({r['chat'] for r in eligible}),
              'split_counts': dict(Counter(r['split'] for r in eligible)),
              'exclusion_counts': dict(Counter(code for r in ledger for code in r['exclusion_codes'])),
              'freshness_axes': dict(Counter(f"new_room={r['new_room']},later={r['after_exposure_cutoff']}" for r in ledger)),
              'ready_for_inference': False,
              'remaining_gates': ['complete_production_input_rubric_freeze', 'privacy_source_review',
                                  'cross_split_source_exact_near_duplicate_audit',
                                  'whole_room_development_final_separation', 'model_runtime_hash_freeze'],
              'fresh_final_ready_count': 0, 'no_model_generation': True}
    result['reservation_hash'] = digest(result)
    return result


def write(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def reserve_temporal(inventory, exposure, frozen_contract, *, expected_contract_hash,
                     expected_exposure_hash):
    """Separate seen-room, unseen-episode axis with source proof required.

    Source intersections and episode comparisons are performed inside the RAM
    owner. This consumer will not infer disjointness from a later target alone.
    It also keeps prospective development/final rooms separate conservatively.
    """
    if digest(exposure) != expected_exposure_hash:
        raise ValueError('frozen_exposure_ledger_changed')
    unexposed = {**exposure, 'exposed_rooms': []}
    result = reserve(inventory, unexposed, frozen_contract,
                     expected_contract_hash=expected_contract_hash,
                     expected_exposure_hash=digest(unexposed))
    cutoff = exposure['cutoff_ts']
    by_id = {row['id']: row for row in inventory['entries']}
    seen_rooms = set(exposure['exposed_rooms'])
    for row in result['entries']:
        source = by_id[row['id']]
        reasons = row['exclusion_codes']
        row['new_room'] = row['chat'] not in seen_rooms
        row['holdout_axis'] = 'unseen_temporal_episode_in_seen_room'
        if row['timestamp'] <= cutoff:
            reasons.append('target_not_after_original_watermark')
        if (source.get('context_all_sources_after_cutoff') is not True
                or type(source.get('earliest_context_ts')) not in (int, float)
                or not math.isfinite(source['earliest_context_ts'])
                or source['earliest_context_ts'] <= cutoff):
            reasons.append('production_context_crosses_old_source_window')
        if (type(source.get('source_intersection_count')) is not int
                or source['source_intersection_count'] != 0):
            reasons.append('prior_source_intersection_or_proof_missing')
        if (type(source.get('duplicate_violation_count')) is not int
                or source['duplicate_violation_count'] != 0):
            reasons.append('prior_episode_duplicate_or_proof_missing')
        if source.get('source_audit_verified') is not True:
            reasons.append('source_audit_unverified')
        if reasons:
            row['split'] = None
            row['reservation_status'] = 'excluded'
        row['exclusion_codes'] = sorted(set(reasons))
    eligible = [row for row in result['entries'] if not row['exclusion_codes']]
    result.update(schema='temporal-reply-evaluation-reservation-v1',
                  exposure_hash=digest(exposure), reserved_count=len(eligible),
                  reserved_rooms=len({row['chat'] for row in eligible}),
                  split_counts=dict(Counter(row['split'] for row in eligible)),
                  exclusion_counts=dict(Counter(code for row in result['entries']
                                                for code in row['exclusion_codes'])),
                  freshness_axes=dict(Counter(
                      f"new_room={row['new_room']},later={row['after_exposure_cutoff']}"
                      for row in result['entries'])),
                  generalization_scope='Separate temporal unseen-episode evidence; no new-room claim')
    result.pop('reservation_hash')
    result['reservation_hash'] = digest(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path)
    parser.add_argument('--exposure', type=Path)
    parser.add_argument('--contract', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--axis', choices=('new-room', 'temporal'), default='new-room')
    parser.add_argument('--expected-contract-hash')
    parser.add_argument('--expected-exposure-hash')
    args = parser.parse_args()
    if not args.contract.exists():
        write(args.contract, contract())
    frozen = json.loads(args.contract.read_text())
    if args.inventory or args.exposure or args.output:
        if not all((args.inventory, args.exposure, args.output,
                    args.expected_contract_hash, args.expected_exposure_hash)):
            parser.error('inventory, exposure, output, and frozen expected hashes must be supplied together')
        operation = reserve_temporal if args.axis == 'temporal' else reserve
        value = operation(json.loads(args.inventory.read_text()),
                          json.loads(args.exposure.read_text()), frozen,
                          expected_contract_hash=args.expected_contract_hash,
                          expected_exposure_hash=args.expected_exposure_hash)
        write(args.output, value)
        print(json.dumps({k: value[k] for k in ('candidate_count', 'reserved_count',
                                               'fresh_final_ready_count', 'ready_for_inference')}))


if __name__ == '__main__':
    main()
