"""Reconstruct approved historical training inputs without opening final rooms.

Only hashes/counts leave the caller's memory. There is no CLI or corpus writer.
The frozen manifest must already contain independently approved train/valid
    entries and sealed test metadata; this module cannot grant review approval.
"""
import json
import math
import hashlib
import os
from pathlib import Path

import history as h
import history_snapshot as snapshot_tools
import personalization as p
import review_sensitive


def historical_key(identity):
    if not isinstance(identity, str) or not identity.startswith('hist:'):
        raise ValueError('historical_identity_required')
    value = identity[5:]
    parts = json.loads(value)
    if (not isinstance(parts, list) or len(parts) != 4 or
            any(not isinstance(part, str) or not part for part in parts) or
            h.canonical_key(value) != value):
        raise ValueError('historical_identity_required')
    return parts


def room_key(parts):
    return h.source_key(dict(zip(('platform', 'account', 'chat_id'), parts[:3])), '')


def observed_room_exception(snapshot, manifest, final_rooms):
    """One explicit already-observed regression room; fresh rooms stay sealed."""
    value = manifest['source'].get('observed_room_reconstruction_exception')
    if value is None:
        return set()
    if (value.get('version') != 1 or value.get('authorization') != 'root_explicit_observed_temporal_exception' or
            value.get('exception_hash') != h.digest({k: v for k, v in value.items() if k != 'exception_hash'}) or
            value.get('selected_test_allowlist_hash') != manifest['source'].get('selected_test_allowlist_hash')):
        raise ValueError('observed_room_exception_changed')
    fresh = value.get('fresh_final_room_keys')
    scope = value.get('room_key')
    if (not isinstance(fresh, list) or not fresh or len(set(fresh)) != len(fresh) or
            scope not in final_rooms or scope in fresh or
            any(h.canonical_key(key) != key or json.loads(key)[3] != '' for key in [scope, *fresh])):
        raise ValueError('sealed_final_room_exception_forbidden')
    path = Path(value['existing_observed_manifest_path'])
    if (not path.is_absolute() or any(part.is_symlink() for part in (path, *path.parents)) or
            not path.is_file() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077):
        raise ValueError('observed_manifest_owner_path_required')
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != value['existing_observed_manifest_sha256']:
        raise ValueError('observed_manifest_changed')
    old = json.loads(data)
    observed = {room_key(json.loads(key)) for entry in old['splits']['test']
                for key in entry.get('provenance_refs', [])
                if isinstance(key, str) and key.startswith('[')}
    observed.update(room_key(historical_key(entry['id'])) for entry in old['splits']['test']
                    if entry['id'].startswith('hist:'))
    if scope not in observed:
        raise ValueError('room_not_in_observed_regression_manifest')
    # Even an exception can never override the separately frozen fresh-room list.
    selected_rooms = {room_key(historical_key(entry['id'])) for entry in manifest['records']
                      if entry.get('split') in ('train', 'valid') and entry['id'].startswith('hist:')}
    if selected_rooms & set(fresh):
        raise ValueError('sealed_final_room_in_reconstruction')
    return {scope}


def reconstruct_approved_history(query, snapshot, manifest, tokenizer, *, progress=None):
    if (manifest.get('version') != 1 or manifest.get('manifest_id') != p.digest(
            {k: v for k, v in manifest.items() if k != 'manifest_id'})):
        raise ValueError('frozen_manifest_changed')
    return _reconstruct_history(query, snapshot, manifest, tokenizer, progress=progress,
                                require_example_hash=True)


def freeze_approved_history(query, snapshot, draft, tokenizer, *, progress=None):
    """CPU bootstrap: exact approved review hashes become final example hashes.

    The draft is body-free version=approved-history-draft-v1, records with
    id/review_hash/split/decision, source and reservations, sealed by draft_hash
    using history.digest (the historical metadata protocol).
    It cannot execute training. The returned records stay co-resident in memory;
    only returned entries/evidence may be serialized into a final manifest.
    """
    if (draft.get('version') != 'approved-history-draft-v1' or draft.get('draft_hash') != h.digest(
            {k: v for k, v in draft.items() if k != 'draft_hash'})):
        raise ValueError('approved_draft_changed')
    if any(entry.get('decision') != 'approve' for entry in draft['records']
           if entry.get('split') in ('train', 'valid')):
        raise ValueError('independent_approval_required')
    proof = draft.get('source', {}).get('review_decision_manifest')
    if (not isinstance(proof, dict) or proof.get('manifest_hash') != h.digest(
            {k: v for k, v in proof.items() if k != 'manifest_hash'}) or
            not proof.get('grant_hashes')):
        raise ValueError('immutable_delegated_decision_manifest_required')
    if any(not isinstance(value, str) or len(value) != 64 or
           any(char not in '0123456789abcdef' for char in value) for value in proof['grant_hashes']):
        raise ValueError('immutable_review_grant_reference_required')
    decisions = {(decision['id'], decision['hash']): decision for decision in proof['decisions']}
    if len(decisions) != len(proof['decisions']):
        raise ValueError('duplicate_delegated_review_identity')
    for entry in draft['records']:
        if entry.get('split') not in ('train', 'valid') or not entry['id'].startswith('hist:'):
            continue
        decision = decisions.get((entry['id'], entry['review_hash']))
        if (not decision or decision.get('decision') != 'approve' or
                decision.get('review_provenance') != 'agent_delegated' or
                not decision.get('delegation_ref') or decision.get('review_method', 'full_semantic') != 'full_semantic'):
            raise ValueError('immutable_delegated_approval_required')
    quarantine = draft.get('source', {}).get('sensitive_source_quarantine')
    if not isinstance(quarantine, dict):
        raise ValueError('sensitive_source_quarantine_required')
    records, evidence = _reconstruct_history(query, snapshot, draft, tokenizer, progress=progress,
                                             require_example_hash=False)
    # Re-run the normal quality/acknowledgment validator against reconstructed
    # exact records. This is validation of prior exported decisions, no approval.
    for record in records:
        decision = decisions[(record['id'], record['review_hash'])]
        h.apply_review_batch([record], {}, [decision], delegation_ref=decision['delegation_ref'])
    review_sensitive.assert_no_sensitive_sources(records, quarantine)
    entries = [{'id': record['id'], 'review_hash': record['review_hash'],
                'example_hash': p.digest(record),
                'split': next(entry['split'] for entry in draft['records'] if entry['id'] == record['id'])}
               for record in records]
    return records, entries, {**evidence, 'approved_draft_hash': draft['draft_hash'],
                              'decision_manifest_hash': proof['manifest_hash'],
                              'example_hashes_frozen': len(entries), 'gpu_started': False}


def _reconstruct_history(query, snapshot, manifest, tokenizer, *, progress, require_example_hash):
    """Return only exact frozen approved historical train/valid records in memory.

    Whole captured rooms are reconstructed before grouping, preserving adjacent
    turn boundaries. Current targets newer than the frozen watermark are
    deferred; all captured targets in these rooms must still match exactly.
    Synthetic records are supplied separately by the coordinator.
    """
    if (snapshot.get('snapshot_hash') != h.digest({k: v for k, v in snapshot.items()
                                                  if k not in ('created_at', 'snapshot_hash')}) or
            manifest.get('source', {}).get('snapshot_hash') != snapshot['snapshot_hash']):
        raise ValueError('frozen_snapshot_changed')
    source = snapshot['source']
    if source['hash'] != h.digest({'rows': source['rows'], 'omitted': source['omitted']}):
        raise ValueError('frozen_raw_metadata_changed')
    watermark = source.get('watermark_ts')
    if type(watermark) not in (int, float) or not math.isfinite(watermark):
        raise ValueError('frozen_watermark_required')
    entries = manifest['records']
    if any(entry.get('split') not in ('train', 'valid', 'test') for entry in entries):
        raise ValueError('invalid_manifest_split')
    if len({entry['id'] for entry in entries}) != len(entries):
        raise ValueError('duplicate_manifest_identity')
    selected = [entry for entry in entries if entry.get('split') in ('train', 'valid')
                and entry['id'].startswith('hist:')]
    if not selected:
        raise ValueError('approved_history_required')
    rooms = {room_key(historical_key(entry['id'])) for entry in selected}
    final_rooms = {room_key(historical_key(entry['id'])) for entry in entries
                   if entry.get('split') == 'test' and entry['id'].startswith('hist:')}
    for field in ('source_keys', 'evaluation_target_keys'):
        for key, split in manifest['reservations'].get(field, {}).items():
            if split == 'test':
                parts = json.loads(h.canonical_key(key))
                final_rooms.add(room_key(parts))
    exceptions = observed_room_exception(snapshot, manifest, final_rooms)
    if rooms & (final_rooms - exceptions):
        raise ValueError('sealed_final_room_in_reconstruction')
    expected = {entry['id']: entry for entry in source['rows']
                if room_key(historical_key(entry['id'])) in rooms}
    if len(expected) != sum(room_key(historical_key(entry['id'])) in rooms for entry in source['rows']):
        raise ValueError('duplicate_frozen_raw_identity')
    if any(entry['id'] not in expected for entry in selected):
        raise ValueError('approved_identity_missing_from_snapshot')
    policy = snapshot['gap_policy_seconds']
    if any(platform not in policy for platform in h.ALL_PLATFORMS):
        raise ValueError('explicit_frozen_gap_policy_required')
    observed, deferred = {}, 0
    for ordinal, scope in enumerate(sorted(rooms), 1):
        platform, account, chat_id, _ = json.loads(scope)
        rows, omitted = h.collect(query, platform=platform, account=account, chat_id=chat_id)
        # Any omitted row could change a grouped target or captured context.
        if omitted:
            raise ValueError('scoped_history_omitted')
        for row in rows:
            if h.source_key(row['chat'], '') != scope:
                raise ValueError('owner_history_scope_changed')
            if row['timestamp'] > watermark:
                deferred += 1
                continue
            identity = row['id']
            metadata = snapshot_tools.source_manifest([row], [])['rows'][0]
            if identity not in expected or metadata != expected[identity]:
                raise ValueError('frozen_raw_record_changed')
            if identity in observed:
                raise ValueError('duplicate_scoped_raw_identity')
            observed[identity] = row
        if progress:
            progress({'rooms_completed': ordinal, 'rooms_total': len(rooms),
                      'captured_raw_count': len(observed), 'newer_targets_deferred': deferred})
    if set(observed) != set(expected):
        raise ValueError('frozen_raw_record_missing')
    records, _ = h.prepare_candidates(list(observed.values()), session_rows=(), tokenizer=tokenizer,
                                      max_seq_length=4096, gap_policy=policy)
    by_budget = {4096: {record['id']: record for record in records},
                 2048: {record['id']: record for record in snapshot_tools.with_budget(records, 2048)}}
    admitted = []
    for entry in selected:
        budget = 2048 if entry['split'] == 'train' else 4096
        record = by_budget[budget].get(entry['id'])
        if (record is None or not record['eligible_for_review'] or
                record['review_hash'] != entry['review_hash']):
            raise ValueError('approved_history_review_changed')
        record = {**record, 'reviewed': True}
        if require_example_hash and p.digest(record) != entry['example_hash']:
            raise ValueError('approved_history_example_changed')
        admitted.append(record)
    assignments = {entry['id']: entry['split'] for entry in selected}
    splits, boundary = p.prepare_examples(admitted, assignments=assignments, frozen=manifest['reservations'])
    if boundary['rejected'] or splits['test']:
        raise ValueError('frozen_source_interval_boundary_rejected')
    return admitted, {'snapshot_hash': snapshot['snapshot_hash'], 'source_hash': source['hash'],
                      'scoped_rooms_verified': len(rooms), 'scoped_raw_records_verified': len(observed),
                      'approved_history_records': len(admitted), 'newer_targets_deferred': deferred,
                      'fresh_final_rooms_requested': 0, 'final_rooms_requested': 0,
                      'observed_temporal_exception_room_count': len(rooms & exceptions),
                      'source_interval_boundary_verified': True, 'corpus_written': False}
