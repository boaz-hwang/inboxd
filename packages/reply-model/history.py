#!/usr/bin/env python3
"""Owner-local historical reply inventory, candidate validation, and human review.

Bodies are fetched from the owner daemon into memory. Reports and review files
contain metadata only; show/review are the explicit body-displaying operations.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import os
import fcntl
from pathlib import Path
import random
import subprocess
import sys
import time

try:
    from worker import PROMPT_VERSION, build_generation_input, compile_prompt
except ModuleNotFoundError:
    import importlib.util
    spec = importlib.util.spec_from_file_location('reply_worker', Path(__file__).with_name('inboxd-reply-worker.py'))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    PROMPT_VERSION = worker.PROMPT_VERSION
    build_generation_input, compile_prompt = worker.build_generation_input, worker.compile_prompt

DEFAULT_ROOT = Path.home() / '.inboxd/reply-model/learning'
DEFAULT_MODEL = Path.home() / '.inboxd/reply-model/models/Qwen3.5-9B-4bit'
RULE_VERSION = 'history-v4'
PLATFORMS = ('kakao', 'telegram')
ALL_PLATFORMS = ('kakao', 'telegram', 'slack')
REVIEW_BEHAVIOR_CATEGORIES = frozenset({'acknowledgement_greeting', 'clarification_question',
    'grounded_information', 'future_action_intent', 'existing_decision_or_refusal', 'other', 'unknown'})
PROVISIONAL_MAX_TURN_GAP_SECONDS = 300
REVIEWABLE_REASONS = frozenset({'context_edit_unknown', 'coverage_unverified',
    'authorship_unknown', 'group_without_explicit_reply', 'long_reply_gap',
    'external_content_likely', 'target_edit_unknown', 'multi_message_turn', 'room_kind_unverified'})
ARCHIVE_HARD_REASONS = frozenset({'archive_type_unverified',
    'archive_deleted_context_unrecoverable', 'archive_revision_unrecoverable',
    'archive_linkage_unrecoverable'})


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def selected_platforms(values=None):
    """Slack participation is explicit and remains reproducible in schedules."""
    values = [values] if isinstance(values, str) else list(values or PLATFORMS)
    if not values or any(value not in (*ALL_PLATFORMS, 'all') for value in values):
        raise ValueError('unsupported_platform')
    return ALL_PLATFORMS if 'all' in values else tuple(dict.fromkeys(values))


def source_key(chat, message_id):
    return json.dumps([str(chat.get(k, '')) for k in ('platform', 'account', 'chat_id')]
                      + [str(message_id)], ensure_ascii=False, separators=(',', ':'))


def canonical_key(value):
    try:
        parts = json.loads(value) if isinstance(value, str) else value
        if isinstance(parts, list) and len(parts) == 4:
            return json.dumps([str(x) for x in parts], ensure_ascii=False, separators=(',', ':'))
    except (ValueError, TypeError):
        pass
    raise ValueError('invalid_source_message_key')


def _call(command, query):
    if callable(command):
        value = command(query)
    else:
        result = subprocess.run([str(command), 'trajectory', 'list', json.dumps(query, separators=(',', ':'))],
                                capture_output=True, text=True, timeout=90)
        if result.returncode:
            raise ValueError('history_export_failed')
        value = json.loads(result.stdout)
    if not isinstance(value, dict):
        raise ValueError('invalid_history_export')
    return value


def collect(command, *, platform=None, account=None, chat_id=None, limit=25, progress=None):
    if platform and platform not in ('kakao', 'telegram', 'slack'):
        raise ValueError('unsupported_platform')
    if type(limit) is not int or not 1 <= limit <= 25:
        raise ValueError('invalid_history_page_limit')
    rows, omitted, cursor, seen_cursors, seen_ids = [], [], None, set(), {}
    pages = 0
    while True:
        query = {'history_candidates': True, 'limit': limit}
        for key, value in (('platform', platform), ('account', account), ('chat_id', chat_id), ('cursor', cursor)):
            if value is not None:
                query[key] = value
        page = _call(command, query)
        if not isinstance(page.get('candidates'), list):
            raise ValueError('history_export_not_supported_by_daemon')
        for row in page['candidates']:
            fingerprint = digest(row)
            if row.get('id') in seen_ids and seen_ids[row.get('id')] != fingerprint:
                raise ValueError('history_export_candidate_changed')
            if row.get('id') not in seen_ids:
                rows.append(row)
                seen_ids[row.get('id')] = fingerprint
        omitted.extend(page.get('omitted') or [])
        pages += 1
        if progress:
            progress({'platform': platform, 'pages': pages, 'candidates': len(rows),
                      'omitted': len(omitted)})
        next_cursor = page.get('next_cursor')
        if next_cursor is None:
            return rows, omitted
        if next_cursor == cursor or next_cursor in seen_cursors:
            raise ValueError('history_export_cursor_repeated')
        seen_cursors.add(next_cursor)
        cursor = next_cursor


def collect_inventory(command, *, platform=None):
    query = {'history_inventory': True}
    if platform:
        query['platform'] = platform
    rooms, cursor, seen = [], None, set()
    while True:
        if cursor:
            query['cursor'] = cursor
        page = _call(command, query)
        if not isinstance(page.get('rooms'), list):
            raise ValueError('invalid_history_inventory')
        rooms.extend(page['rooms'])
        cursor = page.get('next_cursor')
        if cursor is None:
            return {'rooms': rooms, 'version': page.get('version')}
        if cursor in seen:
            raise ValueError('history_inventory_cursor_repeated')
        seen.add(cursor)


def _state(value):
    return value.get('state', value.get('status', 'unknown')) if isinstance(value, dict) else value or 'unknown'


def _target_keys(row):
    chat = row.get('chat') or {}
    return {source_key(chat, t['message_id']) for t in row.get('targets', []) if t.get('message_id') is not None}


def _session_keys(row):
    keys = set()
    for raw in row.get('target_source_keys') or row.get('sent_source_keys') or []:
        keys.add(canonical_key(raw))
    for raw in row.get('sent_message_keys') or []:
        keys.add(canonical_key(raw))
    chat = row.get('chat') or {}
    for field in ('sent_message_id', 'target_message_id'):
        if row.get(field):
            keys.add(source_key(chat, row[field]))
    for item in row.get('targets') or []:
        if item.get('message_id') is not None:
            keys.add(source_key(chat, item['message_id']))
    return keys


def _template_tokens(tokenizer, messages, *, add_generation_prompt=False):
    if tokenizer is None:
        return None
    value = tokenizer.apply_chat_template(messages, return_dict=False,
        add_generation_prompt=add_generation_prompt, enable_thinking=False)
    if isinstance(value, dict):
        value = value['input_ids']
    return value


def _completion_tokens(tokenizer, text):
    if hasattr(tokenizer, 'encode'):
        return len(tokenizer.encode(text, add_special_tokens=False))
    value = tokenizer(text, add_special_tokens=False)
    return len(value['input_ids'])


def _gap_seconds(targets):
    times = [t.get('ts') for t in targets]
    if any(not isinstance(x, (float, int)) for x in times):
        return []
    return [b - a for a, b in zip(times, times[1:])]


def group_turns(rows, gap_policy=None):
    """Join adjacent self sends without replacing the first reply's input snapshot."""
    gap_policy = gap_policy or {}
    if any(platform not in ('kakao', 'telegram', 'slack') or type(value) not in (int, float)
           or not math.isfinite(value) or value < 0 for platform, value in gap_policy.items()):
        raise ValueError('invalid_gap_policy')
    observed = defaultdict(list)
    ordered = sorted(rows, key=lambda r: (source_key(r.get('chat') or {}, ''), r.get('timestamp') or 0, r.get('id') or ''))
    for previous, current in zip(ordered, ordered[1:]):
        if _can_join(previous, current):
            observed[(current.get('chat') or {}).get('platform')].append(current['timestamp'] - previous['timestamp'])
    thresholds = {}
    for platform, gaps in observed.items():
        gaps.sort()
        median = gaps[(len(gaps) - 1) // 2]
        deviations = sorted(abs(value - median) for value in gaps)
        mad = deviations[(len(deviations) - 1) // 2]
        thresholds[platform] = min(gaps[math.ceil(len(gaps) * .75) - 1],
                                   median + 3 * mad, PROVISIONAL_MAX_TURN_GAP_SECONDS)
    thresholds.update(gap_policy)
    turns = []
    for row in ordered:
        if turns and _can_join(turns[-1], row):
            platform = (row.get('chat') or {}).get('platform')
            gap = row['timestamp'] - turns[-1]['targets'][-1]['ts']
            if gap >= 0 and gap <= thresholds.get(platform, -1):
                turn = turns[-1]
                turn['targets'].extend(row['targets'])
                turn['source_message_keys'] = sorted(set(turn.get('source_message_keys') or []) |
                                                     set(row.get('source_message_keys') or []))
                continue
        turns.append({**row, 'targets': list(row.get('targets') or [])})
    return turns, thresholds


def _can_join(previous, current):
    if previous.get('chat') != current.get('chat') or not previous.get('targets') or not current.get('targets'):
        return False
    last_id = str(previous['targets'][-1].get('message_id'))
    context = current.get('context') or []
    if not context or str(context[-1].get('message_id')) != last_id:
        return False
    first_link, next_link = previous.get('reply_linkage') or {}, current.get('reply_linkage') or {}
    return (first_link.get('actual_target_id') == next_link.get('actual_target_id')
            and first_link.get('model_target_id') == next_link.get('model_target_id'))


def candidate_record(row, *, tokenizer=None, max_seq_length=2048, generation_limit=192,
                     gap_policy=None, session_keys=frozenset(), unchanged_keys=frozenset()):
    if row.get('source') != 'history' or not str(row.get('id', '')).startswith('hist:'):
        raise ValueError('invalid_history_candidate')
    chat, targets, context = row.get('chat') or {}, row.get('targets') or [], row.get('context') or []
    if not targets or not isinstance(context, list):
        raise ValueError('invalid_history_candidate')
    target_keys = _target_keys(row)
    if not target_keys or len(target_keys) != len(targets):
        raise ValueError('invalid_target_identity')
    supplied_keys = {canonical_key(x) for x in row.get('source_message_keys') or []}
    all_keys = {source_key(chat, m.get('message_id')) for m in context if m.get('message_id') is not None} | target_keys
    if supplied_keys and not all_keys.issubset(supplied_keys):
        raise ValueError('source_message_keys_incomplete')
    reasons = set()
    excluded = set()
    if target_keys & session_keys:
        (excluded if target_keys <= session_keys else reasons).add(
            'duplicate_of_session_candidate' if target_keys <= session_keys else 'partial_session_overlap')
    if target_keys & unchanged_keys:
        (excluded if target_keys <= unchanged_keys else reasons).add(
            'unchanged_model_suggestion' if target_keys <= unchanged_keys else 'partial_unchanged_suggestion_overlap')
    if not all(isinstance(t.get('body'), str) and t['body'].strip()
               and t['body'] != '[ChatDeleteMember]' for t in targets):
        excluded.add('non_text_target')
    if any(t.get('content_kind') not in (None, 'text') for t in targets):
        excluded.add('non_text_target')
    # Native source evidence survives turn grouping. A readable placeholder is
    # not a text target, and present-day deletions/edits cannot reconstruct what
    # the user saw when writing the historical reply.
    for message in context:
        kind = message.get('content_kind')
        if kind not in (None, 'text'):
            reasons.add('external_content_likely')
        if kind == 'unknown':
            reasons.add('archive_type_unverified')
        if kind == 'deleted':
            reasons.add('archive_deleted_context_unrecoverable')
    for message in (*context, *targets):
        archive = message.get('archive_source') or {}
        revision = archive.get('revision') if isinstance(archive, dict) else None
        if isinstance(revision, (int, float)) and revision > 0:
            reasons.add('archive_revision_unrecoverable')
        native_parent = archive.get('parent_id') if isinstance(archive, dict) else None
        if (isinstance(archive, dict) and archive.get('linkage_unrecoverable') is True) or (
                native_parent is not None and (message.get('reply_to') is None or
                str(native_parent) != str(message['reply_to']))):
            reasons.add('archive_linkage_unrecoverable')
    if any(t.get('authorship') == 'unchanged_suggestion' for t in targets):
        excluded.add('unchanged_model_suggestion')
    if _state(row.get('authorship')) == 'unchanged_suggestion':
        excluded.add('unchanged_model_suggestion')
    if any(m.get('author_role') == 'unknown' for m in context) or any(t.get('author_role') not in (None, 'self') for t in targets):
        reasons.add('self_identity_unknown')
    link = row.get('reply_linkage') or {}
    room_type_state = _state(row.get('room_type_state'))
    if room_type_state not in ('verified_direct', 'verified_group'):
        room_type_state = 'unknown'
    if link.get('kind') != 'explicit_reply':
        if room_type_state == 'unknown':
            reasons.add('room_kind_unverified')
        elif room_type_state == 'verified_group':
            reasons.add('group_without_explicit_reply')
    actual = link.get('actual_target_id')
    model = link.get('model_target_id')
    if not actual or not model or str(actual) != str(model):
        reasons.add('reply_target_mismatch')
    if link.get('group_without_explicit_reply'):
        reasons.add('group_without_explicit_reply')
    edit = _state(row.get('context_edit_state'))
    if edit == 'edited_after_target':
        reasons.add('context_edited_after_target')
    elif edit != 'verified_unchanged':
        reasons.add('context_edit_unknown')
    if isinstance(row.get('context_edit_state'), dict) and row['context_edit_state'].get('deleted_message_ids'):
        reasons.add('context_deleted_after_target')
    if _state(row.get('coverage')) not in ('verified', 'complete'):
        reasons.add('coverage_unverified')
    coverage = row.get('coverage') or {}
    if isinstance(coverage, dict) and coverage.get('limits'):
        reasons.add('coverage_limit_active')
    if _state(row.get('authorship')) == 'unknown':
        reasons.add('authorship_unknown')
    if any(_state(t.get('authorship')) == 'unknown' for t in targets):
        reasons.add('authorship_unknown')
    if any(_state(t.get('edit_state')) == 'edited_after_target' for t in targets):
        reasons.add('target_edited_after_send')
    if any(_state(t.get('edit_state')) not in ('verified_unchanged', 'edited_after_target') for t in targets):
        reasons.add('target_edit_unknown')
    if len(targets) > 1:
        reasons.add('multi_message_turn')
    flags = row.get('flags') or {}
    if isinstance(flags, dict):
        reasons.update(key for key in ARCHIVE_HARD_REASONS if flags.get(key))
        if flags.get('tied_timestamp'):
            reasons.add('preflight_not_ready')
        if flags.get('self_identity_unknown'):
            reasons.add('self_identity_unknown')
        if flags.get('context_edited_after_target'):
            reasons.add('context_edited_after_target')
        if flags.get('target_edited_after_send'):
            reasons.add('target_edited_after_send')
        if flags.get('context_deleted_in_span') or flags.get('context_deleted_after_target'):
            reasons.add('context_deleted_after_target')
        if flags.get('reply_target_mismatch'):
            reasons.add('reply_target_mismatch')
        if flags.get('coverage_unverified'):
            reasons.add('coverage_unverified')
        if flags.get('authorship_unknown'):
            reasons.add('authorship_unknown')
        for key in ('external_content_likely', 'group_without_explicit_reply'):
            if flags.get(key):
                reasons.add(key)
    elif isinstance(flags, list):
        reasons.update(set(flags) & (ARCHIVE_HARD_REASONS |
            {'external_content_likely', 'group_without_explicit_reply'}))
    gaps = _gap_seconds(targets)
    if gap_policy and gaps:
        threshold = gap_policy.get(chat.get('platform'))
        if threshold is not None and any(g > threshold for g in gaps):
            reasons.add('long_reply_gap')
    if any(not isinstance(t.get('ts'), (float, int)) for t in targets):
        reasons.add('preflight_not_ready')
    elif any(not isinstance(m.get('ts'), (float, int)) or m['ts'] >= targets[0]['ts'] for m in context):
        reasons.add('preflight_not_ready')
    if len({m.get('message_id') for m in context}) != len(context):
        reasons.add('preflight_not_ready')
    if row.get('unseen_state') != 'known' and row.get('incoming_message_ids') is not None:
        reasons.add('preflight_not_ready')
    compiled = None
    try:
        compiled, omitted = compile_prompt({'chat': chat, 'context': context,
            'incoming_message_ids': row.get('incoming_message_ids')})
        payload = json.loads(compiled[-1]['content'])
        if omitted or payload['preflight']['status'] != 'ready':
            reasons.add('preflight_not_ready')
        if str(payload['preflight']['reply_target_id']) != str(model):
            reasons.add('reply_target_mismatch')
    except (ValueError, TypeError, KeyError):
        reasons.add('preflight_not_ready')
    text = '\n'.join(t['body'] for t in targets if isinstance(t.get('body'), str))
    messages = build_generation_input(compiled) + [{'role': 'assistant', 'content': text}] if compiled else []
    input_tokens = target_tokens = total_tokens = None
    if tokenizer is not None and messages:
        try:
            prefix = _template_tokens(tokenizer, messages[:-1], add_generation_prompt=True)
            full = _template_tokens(tokenizer, messages)
            input_tokens = len(prefix)
            total_tokens = len(full)
            target_tokens = _completion_tokens(tokenizer, text)
            if full[:len(prefix)] != prefix or len(prefix) >= len(full):
                reasons.add('training_prefix_mismatch')
            if total_tokens > max_seq_length:
                reasons.add('over_token_budget')
            if target_tokens > generation_limit:
                reasons.add('target_exceeds_generation_limit')
        except (ValueError, TypeError, KeyError):
            reasons.add('token_count_unavailable')
    else:
        reasons.add('token_count_unavailable')
    status = 'exclude' if excluded else 'hold' if reasons else 'candidate'
    record = {**row, 'source': 'history', 'source_message_keys': sorted(all_keys),
              'room_type_state': room_type_state,
              'target_source_message_keys': sorted(target_keys),
              'target_source_keys': sorted(target_keys), 'messages': messages,
              # Normalize producer evidence without granting quality approval;
              # the raw reply_linkage and all target/time/review gates remain.
              'input_kind': 'historical', 'linkage': ('temporal_reply'
                  if link.get('kind') == 'adjacent_turn' else link.get('kind', 'historical_reply')),
              'target_role': 'self',
              'conversation_id': digest(chat), 'target_message_id': targets[-1]['message_id'],
              'context_message_ids': [m['message_id'] for m in context],
              'context_timestamps': [m.get('ts') for m in context],
              'provenance_refs': sorted(target_keys), 'status': status,
              'reasons': sorted(excluded | reasons), 'turn_gaps_seconds': gaps,
              'turn_gap_policy_seconds': (gap_policy or {}).get(chat.get('platform')),
              'input_tokens': input_tokens, 'target_tokens': target_tokens,
              'total_tokens': total_tokens, 'reviewed': False,
              'eligible_for_review': not excluded and reasons <= REVIEWABLE_REASONS,
              'versions': {**(row.get('versions') or {}), 'history_rules': RULE_VERSION,
                           'prompt': PROMPT_VERSION}}
    record['review_hash'] = digest({k: v for k, v in record.items() if k not in ('review_hash', 'reviewed')})
    return record


def prepare_candidates(rows, session_rows=(), *, tokenizer=None, max_seq_length=2048,
                       generation_limit=192, gap_policy=None):
    session_keys, unchanged_keys = set(), set()
    for row in session_rows:
        if row.get('outcome') not in (None, 'sent') or row.get('send_state') not in (None, 'Sent', 'Verified'):
            continue
        keys = _session_keys(row)
        session_keys.update(keys)
        if (row.get('reason') == 'unchanged_model_suggestion'
                or row.get('authorship') == 'unchanged_suggestion'
                or (row.get('inserted') is True and isinstance(row.get('final_text'), str)
                    and row.get('final_text') == row.get('suggested_text'))):
            unchanged_keys.update(keys)
    records, rejected, seen = [], [], set()
    turns, selected_gap_policy = group_turns(rows, gap_policy)
    for row in turns:
        if row.get('id') in seen:
            continue
        seen.add(row.get('id'))
        try:
            record = candidate_record(row, tokenizer=tokenizer, max_seq_length=max_seq_length,
                generation_limit=generation_limit, gap_policy=selected_gap_policy,
                session_keys=session_keys, unchanged_keys=unchanged_keys)
            records.append(record)
            if record['status'] == 'exclude':
                rejected.append({'id': record['id'], 'reasons': record['reasons'],
                                 'source_message_keys': record['target_source_message_keys']})
        except (ValueError, TypeError, KeyError) as error:
            rejected.append({'id': row.get('id'), 'reasons': [str(error) if isinstance(error, ValueError) else 'invalid_candidate'],
                             'source_message_keys': sorted(_target_keys(row))})
    return records, rejected


def review_for_hash(reviews, candidate_id, review_hash):
    """Resolve only an exact reviewed input; preserve prior budget/hash evidence."""
    saved = reviews.get(candidate_id, {})
    if saved.get('hash') == review_hash:
        return saved
    variant = saved.get('review_variants', {}).get(review_hash, {})
    return variant if variant.get('hash') == review_hash else {}


def merge_review_registry(previous, additions):
    """Add new exact-hash verdicts without replacing any previous evidence."""
    import copy
    result = copy.deepcopy(previous)
    for candidate_id, verdict in additions.items():
        if not isinstance(verdict.get('hash'), str) or not verdict['hash']:
            raise ValueError('review_registry_hash_required')
        if candidate_id not in result:
            result[candidate_id] = copy.deepcopy(verdict)
            continue
        saved = result[candidate_id]
        if saved.get('hash') == verdict['hash']:
            if {k:v for k,v in saved.items() if k!='review_variants'} != verdict:
                raise ValueError('review_registry_conflicting_exact_hash')
            continue
        variants = saved.setdefault('review_variants', {})
        if verdict['hash'] in variants and variants[verdict['hash']] != verdict:
            raise ValueError('review_registry_conflicting_exact_hash')
        variants[verdict['hash']] = copy.deepcopy(verdict)
    return result


def reviewed_records(records, reviews):
    kept = []
    for record in records:
        review = review_for_hash(reviews, record['id'], record['review_hash'])
        if (record.get('eligible_for_review') and review.get('decision') == 'approve'
                and set(review.get('acknowledged_reasons') or []) ==
                    (set(record['reasons']) & REVIEWABLE_REASONS)):
            kept.append({**record, 'reviewed': True})
    return kept


def review_manifest(records, reviews=None, frozen=None):
    """Body-free queue tied to the exact source, input, target, and review hash."""
    reviews, frozen = reviews or {}, frozen or {}
    entries = []
    for record in records:
        review = review_for_hash(reviews, record['id'], record['review_hash'])
        state = ('stale' if not review and record['id'] in reviews else 'unreviewed' if not review else 'stale' if review.get('hash') != record['review_hash']
                 else review.get('decision', 'unreviewed'))
        entries.append({'id': record['id'], 'hash': record['review_hash'],
            'platform': record['chat']['platform'], 'chat': source_key(record['chat'], ''),
            'timestamp': record['timestamp'], 'review_state': state,
            'eligible_for_review': record['eligible_for_review'],
            'reasons': record['reasons'],
            'hard_blockers': sorted(set(record['reasons']) - REVIEWABLE_REASONS),
            'original_partition': frozen.get('assignments', {}).get(record['id']),
            'source_keys_hash': digest(record['source_message_keys']),
            'raw_content_hash': digest({'context': record['context'], 'targets': record['targets']}),
            'input_hash': digest(record['messages'][:-1]),
            'target_hash': digest(record['messages'][-1:]),
            'input_tokens': record['input_tokens'],
            'total_tokens': record['total_tokens'], 'target_tokens': record['target_tokens']})
    entries.sort(key=lambda entry: (not entry['eligible_for_review'],
        entry['review_state'] == 'approve', entry['platform'], entry['chat'], entry['timestamp'], entry['id']))
    return {'version': 'history-review-queue-v1', 'entries': entries,
            'manifest_hash': digest(entries),
            'state_counts': dict(Counter(entry['review_state'] for entry in entries))}


def apply_review_batch(records, reviews, decisions, *, delegation_ref):
    """Commit individually inspected delegated verdicts; no automatic labels.

    A stale hash anywhere rejects the whole batch, preventing a partial update
    when backfill runs during review. Metadata never grants human provenance.
    """
    if not isinstance(delegation_ref, str) or not delegation_ref.strip():
        raise ValueError('delegation_reference_required')
    by_id = {record['id']: record for record in records}
    result, seen = dict(reviews), set()
    for decision in decisions:
        record = by_id.get(decision.get('id'))
        if record is None or decision.get('id') in seen:
            raise ValueError('unknown_or_duplicate_review_id')
        seen.add(record['id'])
        if decision.get('hash') != record['review_hash']:
            raise ValueError('stale_review_hash')
        verdict = decision.get('decision')
        if verdict not in ('approve', 'hold', 'reject'):
            raise ValueError('invalid_review_decision')
        rationale = decision.get('rationale_codes')
        if not isinstance(rationale, list) or not rationale or any(
                not isinstance(value, str) or not value or not all(
                    char.isascii() and (char.isalnum() or char == '_') for char in value)
                for value in rationale):
            raise ValueError('review_rationale_codes_required')
        acknowledgements = set(decision.get('acknowledged_reasons') or [])
        method = decision.get('review_method', 'full_semantic')
        if method not in ('full_semantic', 'metadata_only_sensitive_exclusion'):
            raise ValueError('invalid_review_method')
        if method != 'full_semantic' and verdict == 'approve':
            raise ValueError('metadata_only_review_cannot_approve')
        behavior = decision.get('behavior_category', 'unknown')
        if behavior not in REVIEW_BEHAVIOR_CATEGORIES:
            raise ValueError('invalid_review_behavior_category')
        if verdict == 'approve' and (not record['eligible_for_review'] or
                acknowledgements != set(record['reasons']) & REVIEWABLE_REASONS):
            raise ValueError('review_warnings_must_be_acknowledged_or_hard_hold')
        result[record['id']] = {'hash': record['review_hash'], 'decision': verdict,
            'acknowledged_reasons': sorted(acknowledgements), 'at': time.time(),
            'review_provenance': 'agent_delegated', 'delegation_ref': delegation_ref,
            'rationale_codes': sorted(set(rationale)), 'behavior_category': behavior,
            'review_method': method}
    return result


def _bucket(values):
    if not values:
        return {'count': 0}
    values = sorted(values)
    return {'count': len(values), 'min': values[0], 'p50': values[(len(values)-1)//2],
            'p90': values[math.ceil(len(values)*.9)-1], 'max': values[-1]}


def report(records, omitted=(), inventory=None, raw_rows=None, gap_policy=None):
    by_platform = Counter(r.get('chat', {}).get('platform', 'unknown') for r in records)
    by_chat = Counter(source_key(r.get('chat', {}), '') for r in records)
    reasons = Counter(reason for r in records for reason in r['reasons'])
    gaps = defaultdict(list)
    delays = defaultdict(list)
    for r in records:
        platform = r.get('chat', {}).get('platform', 'unknown')
        gaps[platform].extend(r['turn_gaps_seconds'])
        context, targets = r.get('context') or [], r.get('targets') or []
        if context and targets and isinstance(context[-1].get('ts'), (int, float)) and isinstance(targets[0].get('ts'), (int, float)):
            delays[platform].append(targets[0]['ts'] - context[-1]['ts'])
    result = {'candidates': len(records), 'status_counts': dict(Counter(r['status'] for r in records)),
              'reason_counts': dict(reasons), 'platform_counts': dict(by_platform),
              'chat_counts': dict(by_chat), 'turn_gap_seconds': {k: _bucket(v) for k,v in gaps.items()},
              'reply_delay_seconds': {k: _bucket(v) for k,v in delays.items()},
              'input_tokens': _bucket([r['input_tokens'] for r in records if r['input_tokens'] is not None]),
              'target_tokens': _bucket([r['target_tokens'] for r in records if r['target_tokens'] is not None]),
              'total_tokens': _bucket([r['total_tokens'] for r in records if r['total_tokens'] is not None]),
              'omitted_count': len(omitted),
              'omitted_reasons': dict(Counter(x.get('reason','unknown') for x in omitted))}
    result['platform_gates'] = {platform: {
        'count': len(members), 'eligible_for_review': sum(r['eligible_for_review'] for r in members),
        'hard_blocker_counts': dict(Counter(reason for r in members
            for reason in set(r['reasons']) - REVIEWABLE_REASONS)),
        'review_warning_counts': dict(Counter(reason for r in members
            for reason in set(r['reasons']) & REVIEWABLE_REASONS)),
        'total_tokens': _bucket([r['total_tokens'] for r in members if r['total_tokens'] is not None])}
        for platform in sorted(by_platform)
        for members in [[r for r in records if r['chat'].get('platform') == platform]]}
    if inventory is not None:
        result['inventory'] = inventory
    if raw_rows is not None:
        _, selected = group_turns(raw_rows, gap_policy)
        result['turn_gap_policy'] = {'selected_seconds': selected,
            'method': 'platform p75 capped by median plus 3 MAD and provisional 300-second ceiling',
            'provisional': True, 'explicit_overrides': gap_policy or {}}
        ordered = sorted(raw_rows, key=lambda r: (source_key(r.get('chat') or {}, ''), r.get('timestamp') or 0, r.get('id') or ''))
        raw_gaps = defaultdict(list)
        for prior, current in zip(ordered, ordered[1:]):
            if _can_join(prior, current):
                raw_gaps[(current.get('chat') or {}).get('platform', 'unknown')].append(
                    current['timestamp'] - prior['timestamp'])
        result['observed_inter_self_gap_seconds'] = {k: _bucket(v) for k, v in raw_gaps.items()}
    return result


def sample(records, count=100, seed=1):
    groups = defaultdict(list)
    for r in records:
        key = (r.get('chat',{}).get('platform'), r.get('chat',{}).get('account'),
               r.get('chat',{}).get('chat_id'), r['status'],
               'empty' if not r['messages'] else 'short' if len(r['messages'][-1]['content']) <= 10 else 'long')
        groups[key].append(r)
    rng = random.Random(seed)
    for group in groups.values():
        rng.shuffle(group)
    chosen = []
    while groups and len(chosen) < count:
        for key in sorted(groups, key=str):
            chosen.append(groups[key].pop())
            if not groups[key]:
                del groups[key]
            if len(chosen) == count:
                break
    return [{'id': r['id'], 'hash': r['review_hash'], 'status': r['status'], 'platform': r.get('chat',{}).get('platform'),
             'chat': source_key(r.get('chat',{}), '')} for r in chosen]


def _private_json(path, value):
    from personalization import private_json
    private_json(path, value)


def _read_reviews(path):
    if not path.exists():
        return {}
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        return json.loads(os.read(fd, 10_000_000))
    finally:
        os.close(fd)


def _load_tokenizer(model):
    from mlx_lm.utils import load_tokenizer
    return load_tokenizer(str(model))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('report', 'status', 'show', 'review', 'sample', 'review-queue'))
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--inboxd', type=Path, default=Path.home()/'.local/bin/inboxd')
    parser.add_argument('--model', type=Path, default=DEFAULT_MODEL)
    parser.add_argument('--platform', action='append', choices=(*ALL_PLATFORMS, 'all'))
    parser.add_argument('--account')
    parser.add_argument('--chat-id')
    parser.add_argument('--id')
    parser.add_argument('--decision', choices=('approve', 'hold', 'reject'))
    parser.add_argument('--ack-reason', action='append', default=[],
                        help='Repeat for every reviewable warning when approving')
    parser.add_argument('--gap-policy', type=Path, help='JSON map of platform to maximum reply turn gap in seconds')
    parser.add_argument('--max-seq-length', type=int, default=2048)
    parser.add_argument('--generation-limit', type=int, default=192)
    parser.add_argument('--sample-size', type=int, default=100)
    parser.add_argument('--seed', type=int, default=1)
    args = parser.parse_args(argv)
    if args.max_seq_length < 1 or args.generation_limit < 1 or args.sample_size < 1:
        parser.error('limits must be positive')
    gap_policy = json.loads(args.gap_policy.read_text()) if args.gap_policy else {}
    args.root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.root.is_symlink() or args.root.stat().st_uid != os.getuid() or args.root.stat().st_mode & 0o077:
        raise ValueError('history_directory_must_be_owner_only')
    lock_fd = os.open(args.root/'cycle.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    platforms = selected_platforms(args.platform)
    tokenizer = _load_tokenizer(args.model)
    rows, omitted = [], []
    for platform in platforms:
        part, skipped = collect(args.inboxd, platform=platform, account=args.account, chat_id=args.chat_id)
        rows.extend(part); omitted.extend(skipped)
    from continual import collect as collect_sessions
    session_rows, session_omitted = collect_sessions(args.inboxd)
    session_rows = list(session_rows) + list(session_omitted)
    records, rejected = prepare_candidates(rows, session_rows=session_rows, tokenizer=tokenizer,
        max_seq_length=args.max_seq_length, generation_limit=args.generation_limit,
        gap_policy=gap_policy)
    review_path = args.root/'reviews.json'
    reviews = _read_reviews(review_path)
    if args.command in ('show', 'review'):
        record = next((r for r in records if r['id'] == args.id), None)
        if record is None:
            raise ValueError('candidate_not_found')
        if args.command == 'review':
            if not args.decision:
                raise ValueError('review_decision_required')
            acknowledgements = set(args.ack_reason)
            expected = set(record['reasons']) & REVIEWABLE_REASONS
            if args.decision == 'approve' and (not record['eligible_for_review'] or acknowledgements != expected):
                raise ValueError('review_warnings_must_be_acknowledged_or_hard_hold')
            reviews[record['id']] = {'hash': record['review_hash'], 'decision': args.decision,
                                     'acknowledged_reasons': sorted(acknowledgements), 'at': time.time()}
            _private_json(review_path, reviews)
        result = {'record': record, 'review': reviews.get(record['id'])}
    elif args.command == 'sample':
        result = {'sample': sample(records, args.sample_size, args.seed), 'count': min(len(records), args.sample_size)}
    elif args.command == 'review-queue':
        result = review_manifest(records, reviews, _read_reviews(args.root/'partitions.json'))
    else:
        result = report(records, omitted, raw_rows=rows, gap_policy=gap_policy)
        result['rejected_count'] = len(rejected)
        result['review_counts'] = dict(Counter(v['decision'] for r in records
            if (v := reviews.get(r['id'])) and v.get('hash') == r['review_hash']))
        result['approved_eligible'] = len(reviewed_records(records, reviews))
        if args.command == 'report':
            result['inventory_by_platform'] = {p: collect_inventory(args.inboxd, platform=p) for p in platforms}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status':'error', 'error_type':type(error).__name__}), file=sys.stderr)
        sys.exit(1)
