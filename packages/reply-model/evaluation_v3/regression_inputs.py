"""Observed real22 input reconstruction, with injected read-only owner transport.

No CLI, RPC connection, generation, or file writes occur here. After an authorized
CPU window, callers may pass history_snapshot.OwnerHistoryQuery. The existing
daemon supports room filters, not target/time filters: six authorized old rooms
are paged in memory, then original target identities are selected. Other bodies
must never be rendered or persisted. Returned inputs are transient model inputs;
only ``metadata`` is suitable for persistence. These are observed regressions,
never fresh final evidence or training supervision.
"""
import copy
import hashlib
import json
import math
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import history as h
from personalization import digest as old_digest
from review_sensitive import sensitive_admission_report
import worker

OLD_HASH_SCHEME = 'sha256_UTF8_sorted_JSON_ensure_ascii_false_default_separators'
METADATA_HASH_SCHEME = 'sha256_UTF8_sorted_compact_JSON_ensure_ascii_false'


def _sealed(value, key):
    return {**value, key: h.digest(value)}


def _check(value, key):
    if value.get(key) != h.digest({k: v for k, v in value.items() if k != key}):
        raise ValueError('regression_metadata_seal_mismatch')


def _hash(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def _identity(case_id):
    if not isinstance(case_id, str) or not case_id.startswith('hist:'):
        raise ValueError('historical_regression_identity_required')
    return h.canonical_key(case_id[5:])


def _room(key):
    return h.canonical_key([*json.loads(key)[:3], ''])


def build_grant(old_report, old_manifest, quarantine_hash, authorization):
    """Bind exactly the original22 report/manifest entries and their six rooms.

    Timestamp bounds were not stored in the old artifacts. Do not invent them.
    Authorization is an explicit caller-supplied reference, not inferred here.
    """
    if not isinstance(authorization, str) or not authorization.strip() or not _hash(quarantine_hash):
        raise ValueError('explicit_regression_authorization_and_quarantine_required')
    cases = [c for c in old_report['cases'] if c.get('source') == 'heldout_reply']
    entries = old_manifest['splits']['test']
    originals = {c['id']: c for c in cases}
    manifests = {c['id']: c for c in entries}
    if len(originals) != 22 or len(cases) != 22 or len(manifests) != 22 or set(originals) != set(manifests):
        raise ValueError('original_real22_case_set_required')
    if old_report.get('gap_policy') != {'kakao': 64, 'telegram': 115}:
        raise ValueError('original_regression_gap_policy_required')
    if old_report.get('gap_policy_hash') != old_digest(old_report['gap_policy']):
        raise ValueError('original_regression_gap_hash_changed')
    result = []
    for case in cases:
        first = _identity(case['id'])
        keys = [h.canonical_key(k) for k in manifests[case['id']]['provenance_refs']]
        if not keys or len(set(keys)) != len(keys) or first not in keys or any(_room(k) != _room(first) for k in keys):
            raise ValueError('original_regression_target_scope_invalid')
        if not _hash(case.get('source_hash')) or not _hash(case.get('rubric_hash')):
            raise ValueError('original_regression_source_hash_required')
        result.append({'id': case['id'], 'first_target_key': first,
            'target_keys': sorted(keys), 'room_key': _room(first),
            # Missing prompt hashes remain explicit unavailable, never guessed.
            'original_prompt_hash': case.get('prompt_hash'),
            'original_source_hash': case['source_hash'], 'rubric_hash': case['rubric_hash'],
            'original_example_hash': manifests[case['id']].get('example_hash'),
            'evaluation_group': case.get('evaluation_group')})
    rooms = sorted({e['room_key'] for e in result})
    if len(rooms) != 6 or any(json.loads(k)[0] not in ('kakao', 'telegram') for k in rooms):
        raise ValueError('original_six_observed_rooms_required')
    return _sealed({'version': 'observed-real22-input-grant-v1',
        'authorization': authorization, 'evidence_class': 'observed_regression',
        'old_report_hash': old_digest(old_report), 'old_manifest_hash': old_digest(old_manifest),
        'old_input_hash_scheme': OLD_HASH_SCHEME, 'metadata_hash_scheme': METADATA_HASH_SCHEME,
        'original_timestamp_bounds_available': False, 'roomwide_read_authorized': True,
        'quarantine_hash': quarantine_hash, 'room_keys': rooms,
        'gap_policy': old_report['gap_policy'], 'entries': result}, 'grant_hash')


def _validate_grant(grant, quarantine):
    _check(grant, 'grant_hash')
    _check(quarantine, 'quarantine_hash')
    if (grant.get('version') != 'observed-real22-input-grant-v1'
            or grant.get('evidence_class') != 'observed_regression'
            or grant.get('roomwide_read_authorized') is not True
            or not grant.get('authorization') or worker.PROMPT_VERSION != 'reply-v4'
            or grant.get('old_input_hash_scheme') != OLD_HASH_SCHEME
            or grant.get('quarantine_hash') != quarantine['quarantine_hash']):
        raise ValueError('regression_scope_or_policy_changed')
    entries, rooms = grant['entries'], grant['room_keys']
    if len(entries) != 22 or len({e['id'] for e in entries}) != 22 or len(set(rooms)) != 6:
        raise ValueError('original_real22_six_rooms_required')
    if (set(rooms) != {e['room_key'] for e in entries}
            or any(h.canonical_key(k) != k or json.loads(k)[3] != ''
                   or json.loads(k)[0] not in ('kakao', 'telegram') for k in rooms)):
        raise ValueError('regression_room_allowlist_changed')
    for e in entries:
        if (e['first_target_key'] != _identity(e['id']) or e['room_key'] != _room(e['first_target_key'])
                or e['room_key'] not in rooms or e['first_target_key'] not in e['target_keys']
                or len(set(e['target_keys'])) != len(e['target_keys'])
                or any(h.canonical_key(k) != k or _room(k) != e['room_key'] for k in e['target_keys'])):
            raise ValueError('regression_target_scope_changed')
    # Validate all source-key policy syntax before any transport call.
    sensitive_admission_report([], quarantine)


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _input(entry, raw_rows, quarantine):
    """Pin the original first target and exact grouped target identities.

    Do not use today's regrouped hist:firstTarget ID or expand target membership.
    The raw candidate already contains context_snapshot(before=target.ts).
    """
    indexed = {}
    for row in raw_rows:
        for target in row.get('targets') or []:
            key = h.source_key(row['chat'], target.get('message_id'))
            if key in indexed and h.digest(indexed[key]) != h.digest({'row': row, 'target': target}):
                return None, {'reason': 'ambiguous_current_target'}
            indexed[key] = {'row': row, 'target': target}
    if any(key not in indexed for key in entry['target_keys']):
        return None, {'reason': 'original_target_missing'}
    primary = indexed[entry['first_target_key']]['row']
    targets = [indexed[key]['target'] for key in entry['target_keys']]
    context = primary.get('context')
    if (not isinstance(context, list) or not context or any(not _finite(t.get('ts')) for t in targets)
            or any(not isinstance(t.get('body'), str) for t in targets)
            or any(not isinstance(m, dict) or not isinstance(m.get('body'), str)
                   or not m.get('message_id') for m in context)):
        return None, {'reason': 'invalid_current_source'}
    targets.sort(key=lambda t: (t['ts'], str(t['message_id'])))
    if h.source_key(primary['chat'], targets[0]['message_id']) != entry['first_target_key']:
        return None, {'reason': 'original_target_chronology_changed'}
    boundary = targets[0]['ts']
    if (any(not _finite(m.get('ts')) or m['ts'] >= boundary for m in context)
            or len({str(m.get('message_id')) for m in context}) != len(context)
            or any(h.source_key(primary['chat'], m.get('message_id')) in entry['target_keys'] for m in context)):
        return None, {'reason': 'context_target_time_boundary_invalid'}
    if (primary.get('self_identity', {}).get('state') != 'known'
            or not primary.get('self_identity', {}).get('author_id')):
        return None, {'reason': 'self_identity_unverified'}
    record = {'id': entry['id'], 'chat': primary['chat'], 'context': context, 'targets': targets,
        'source_message_keys': sorted({h.source_key(primary['chat'], m['message_id'])
            for m in [*context, *targets]})}
    _, blocked = sensitive_admission_report([record], quarantine)
    if blocked:
        return None, {'reason': 'quarantined_sensitive_source',
            'source_keys': blocked[0]['source_keys'], 'message_rules': blocked[0]['message_rules']}
    if any((indexed[key]['row'].get('flags') or {}).get(flag)
           for key in entry['target_keys'] for flag in h.ARCHIVE_HARD_REASONS):
        return None, {'reason': 'current_source_quality_unrecoverable'}
    if (primary.get('flags') or {}).get('reply_target_mismatch'):
        return None, {'reason': 'current_reply_target_mismatch'}
    try:
        compiled, omitted = worker.compile_prompt({'chat': primary['chat'], 'context': context,
            'incoming_message_ids': primary.get('incoming_message_ids')})
        preflight = json.loads(compiled[-1]['content'])['preflight']
        if omitted or preflight['status'] != 'ready':
            return None, {'reason': 'current_preflight_unavailable'}
        messages = worker.build_generation_input(compiled)
    except (KeyError, TypeError, ValueError):
        return None, {'reason': 'current_compilation_invalid'}
    current = old_digest(messages)
    evidence = {'current_prompt_hash': current,
        'current_raw_content_hash': h.digest({'context': context, 'targets': targets}),
        'current_source_keys_hash': h.digest(record['source_message_keys']),
        'current_first_target_ts': boundary, 'current_last_target_ts': targets[-1]['ts'],
        'current_context_min_ts': min(m['ts'] for m in context),
        'original_target_content_hash_available': False,
        'historical_target_used_as_model_input': False}
    if current != entry['original_prompt_hash']:
        return None, {**evidence, 'reason': 'original_prompt_hash_mismatch'}
    # A second screen includes exact generation messages. Return no targets.
    _, blocked = sensitive_admission_report([{**record, 'messages': messages}], quarantine)
    if blocked:
        return None, {**evidence, 'reason': 'quarantined_sensitive_source'}
    return messages, evidence


def resolve_inputs(query, grant, quarantine):
    """Return ``inputs`` transiently and sealed body-free ``metadata`` for all22.

    Only the caller controls the owner-query lifecycle; never call during GPU
    training/daemon pause. No timestamp filter is sent because none exists. Old
    source/record hashes are evidence labels, not new review approval claims.
    """
    _validate_grant(grant, quarantine)
    inputs, availability, reads = {}, {}, []
    for room in grant['room_keys']:
        selected = [e for e in grant['entries'] if e['room_key'] == room]
        readable = [e for e in selected if _hash(e.get('original_prompt_hash'))]
        for e in selected:
            if e not in readable:
                availability[e['id']] = {'reason': 'original_prompt_hash_missing'}
        if not readable:
            continue
        p, a, c, _ = json.loads(room)
        pages = 0
        def scoped(request):
            nonlocal pages
            if (set(request) - {'history_candidates', 'platform', 'account', 'chat_id', 'limit', 'cursor'}
                    or request.get('history_candidates') is not True
                    or (request.get('platform'), request.get('account'), request.get('chat_id')) != (p, a, c)):
                raise ValueError('ungranted_regression_room_query')
            pages += 1
            response = query(request)
            if not isinstance(response, dict):
                raise ValueError('invalid_regression_room_response')
            for row in response.get('candidates') or []:
                if row.get('chat') != {'platform': p, 'account': a, 'chat_id': c}:
                    raise ValueError('regression_response_outside_room')
            return response
        try:
            rows, omitted = h.collect(scoped, platform=p, account=a, chat_id=c)
            read = {'room_key': room, 'pages': pages, 'raw_candidate_count': len(rows),
                'omitted_count': len(omitted), 'raw_inventory_hash': h.digest([h.digest(r) for r in rows]),
                'omissions_hash': h.digest(omitted), 'target_selection_after_roomwide_read': True}
            omitted_ids = {item.get('id') for item in omitted if isinstance(item, dict)}
            for e in readable:
                if any('hist:' + key in omitted_ids for key in e['target_keys']):
                    availability[e['id']] = {'reason': 'original_target_export_omitted'}
                    continue
                messages, evidence = _input(e, rows, quarantine)
                availability[e['id']] = evidence
                if messages is not None:
                    inputs[e['id']] = copy.deepcopy(messages)
            del rows, omitted
        except (KeyError, TypeError, ValueError, OSError, TimeoutError, RuntimeError, AttributeError):
            # Never expose transport/body exception text in metadata.
            read = {'room_key': room, 'pages': pages, 'read_failed': True}
            for e in readable:
                inputs.pop(e['id'], None)
                availability[e['id']] = {'reason': 'scoped_source_read_failed'}
        reads.append(read)
    entries = [{'id': e['id'], 'status': 'ready' if e['id'] in inputs else 'unavailable',
        'original_prompt_hash': e.get('original_prompt_hash'),
        'original_source_hash': e['original_source_hash'], 'rubric_hash': e['rubric_hash'],
        **availability[e['id']]} for e in grant['entries']]
    metadata = _sealed({'version': 'observed-real22-input-proof-v1',
        'evidence_class': 'observed_regression', 'grant_hash': grant['grant_hash'],
        'quarantine_hash': quarantine['quarantine_hash'], 'prompt_version': worker.PROMPT_VERSION,
        'old_input_hash_scheme': OLD_HASH_SCHEME, 'metadata_hash_scheme': METADATA_HASH_SCHEME,
        'resolver_source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'worker_source_sha256': hashlib.sha256(Path(worker.__file__).read_bytes()).hexdigest(),
        'entries': entries, 'ready_count': len(inputs), 'unavailable_count': 22 - len(inputs),
        'roomwide_read': True, 'original_timestamp_bounds_available': False,
        'historical_targets_model_input': False, 'reads': reads,
        'exact_all22_reproduced': len(inputs) == 22,
        'credential_detection_not_exhaustive': True}, 'proof_hash')
    return {'inputs': inputs, 'metadata': metadata}
