"""Body-free metadata from a stable, owner-local historical dataset snapshot.

No model is loaded here. The caller supplies only the production tokenizer and
retains raw/compiled bodies in memory. Re-reading verifies dataset stability;
individual review still requires the same exact candidate hash at commit time.
"""
from collections import Counter
import math
import time

import history
from learning_split import reserve_refreshed_evaluation, quarantine_omitted_evaluation


class OwnerHistoryQuery:
    """Reuse the importer's audited owner authentication for one read-only RPC."""
    def __init__(self, rpc):
        self.rpc = rpc

    def __call__(self, query):
        return self.rpc.request('trajectory.list', query)


def archive_gate_contributions(records):
    """Count native evidence behind each archive gate; no inferred re-labeling."""
    contributions = {}
    reasons = (*sorted(history.ARCHIVE_HARD_REASONS), 'non_text_target')
    for record in records:
        for reason in reasons:
            if reason not in record['reasons']:
                continue
            if reason == 'archive_type_unverified':
                messages = [message for message in record['context'] if message.get('content_kind') == 'unknown']
            elif reason == 'archive_deleted_context_unrecoverable':
                messages = [message for message in record['context'] if message.get('content_kind') == 'deleted']
            elif reason == 'archive_revision_unrecoverable':
                messages = [message for message in (*record['context'], *record['targets'])
                            if isinstance(message.get('archive_source'), dict)
                            and type(message['archive_source'].get('revision')) in (int, float)
                            and message['archive_source']['revision'] > 0]
            elif reason == 'archive_linkage_unrecoverable':
                messages = [message for message in (*record['context'], *record['targets'])
                            if isinstance(message.get('archive_source'), dict)
                            and (message['archive_source'].get('linkage_unrecoverable') is True or
                                 (message['archive_source'].get('parent_id') is not None and
                                  (message.get('reply_to') is None or
                                   str(message['archive_source']['parent_id']) != str(message['reply_to']))))]
            else:
                messages = [message for message in record['targets'] if message.get('content_kind') not in (None, 'text')]
            seen_types = set()
            for message in messages:
                archive = message.get('archive_source') or {}
                native_type = str(archive.get('type', 'unknown'))
                item = contributions.setdefault(reason, {}).setdefault(native_type,
                    {'candidate_count': 0, 'held_candidate_count': 0, 'message_occurrences': 0,
                     'status_counts': Counter(), '_source_keys': set()})
                item['message_occurrences'] += 1
                item['status_counts'][str(archive.get('status', 'unknown'))] += 1
                item['_source_keys'].add(history.source_key(record['chat'], message['message_id']))
                if native_type not in seen_types:
                    item['candidate_count'] += 1
                    item['held_candidate_count'] += record['status'] == 'hold'
                    seen_types.add(native_type)
    for counts in contributions.values():
        for item in counts.values():
            item['unique_source_messages'] = len(item.pop('_source_keys'))
            item['status_counts'] = dict(item['status_counts'])
    return contributions


def source_manifest(rows, omitted, *, watermark_ts=None):
    entries = sorted(({'id': row['id'], 'timestamp': row['timestamp'],
                       'source_keys_hash': history.digest(row.get('source_message_keys') or sorted(
                           {history.source_key(row['chat'], message['message_id'])
                            for message in row.get('context', [])} | history._target_keys(row))),
                       'raw_hash': history.digest(row)} for row in rows),
                     key=lambda item: item['id'])
    omissions = sorted(({'id': item.get('id'), 'reason': item.get('reason'),
                         'raw_hash': history.digest(item)} for item in omitted), key=history.digest)
    return {'rows': entries, 'omitted': omissions, 'watermark_ts': watermark_ts,
            'hash': history.digest({'rows': entries, 'omitted': omissions})}


def export_snapshot(query, *, platforms=history.ALL_PLATFORMS, progress=None):
    watermark_ts = time.time()
    rows, omitted = [], []
    for platform in platforms:
        found, skipped = history.collect(query, platform=platform, progress=progress)
        rows.extend(found)
        omitted.extend(skipped)
    if any(type(row.get('timestamp')) not in (int, float) or not math.isfinite(row['timestamp']) for row in rows):
        raise ValueError('snapshot_invalid_target_timestamp')
    deferred = [row for row in rows if row['timestamp'] > watermark_ts]
    rows = [row for row in rows if row['timestamp'] <= watermark_ts]
    manifest = source_manifest(rows, omitted, watermark_ts=watermark_ts)
    manifest['post_watermark_deferred_count'] = len(deferred)
    manifest['post_watermark_deferred_hash'] = history.digest(
        [{'id': row['id'], 'raw_hash': history.digest(row)} for row in deferred])
    return rows, omitted, manifest


def _verify_snapshot_manifest(original, latest):
    captured = {entry['id']: entry for entry in original['rows']}
    current = {entry['id']: entry for entry in latest['rows']}
    if any(current.get(candidate_id) != entry for candidate_id, entry in captured.items()):
        raise ValueError('history_snapshot_changed_during_extraction')
    watermark = original.get('watermark_ts')
    additional = [entry for candidate_id, entry in current.items() if candidate_id not in captured]
    if any(type(entry.get('timestamp')) not in (int, float) or watermark is None or
           entry['timestamp'] <= watermark for entry in additional):
        raise ValueError('history_snapshot_historical_inventory_changed')
    # The bounded IPC omission record has no timestamp. Never classify a new
    # omission as future-only without evidence, or silently lose an old one.
    if latest['omitted'] != original['omitted']:
        raise ValueError('history_snapshot_omissions_changed')
    return {'source_manifest_hash': original['hash'], 'verified_at': time.time(),
            'candidate_count': len(captured), 'omitted_count': len(latest['omitted']),
            'watermark_ts': watermark, 'post_watermark_deferred_count': len(additional),
            'post_watermark_deferred_hash': history.digest(additional)}


def reconstruct_snapshot(query, original, *, platforms=history.ALL_PLATFORMS, progress=None):
    """Recover only the exact already-verified snapshot into transient memory.

    Each complete candidate (including context) must match its original raw hash.
    New future targets are deferred; no changed or missing captured row is accepted.
    """
    rows, omitted, latest = export_snapshot(query, platforms=platforms, progress=progress)
    verification = _verify_snapshot_manifest(original, latest)
    captured_ids = {entry['id'] for entry in original['rows']}
    return [row for row in rows if row['id'] in captured_ids], omitted, verification


def assert_snapshot_unchanged(query, original, *, platforms=history.ALL_PLATFORMS, progress=None):
    _, _, verification = reconstruct_snapshot(query, original, platforms=platforms, progress=progress)
    return verification


def with_budget(records, max_seq_length):
    """Derive the exact normal candidate record without repeating tokenization."""
    if type(max_seq_length) is not int or max_seq_length < 1:
        raise ValueError('invalid_max_seq_length')
    result = []
    for source in records:
        record = {**source}
        reasons = set(record['reasons']) - {'over_token_budget'}
        if record['total_tokens'] is not None and record['total_tokens'] > max_seq_length:
            reasons.add('over_token_budget')
        record['reasons'] = sorted(reasons)
        excluded = source['status'] == 'exclude'
        record['status'] = 'exclude' if excluded else 'hold' if reasons else 'candidate'
        record['eligible_for_review'] = not excluded and reasons <= history.REVIEWABLE_REASONS
        record['review_hash'] = history.digest({k: value for k, value in record.items()
                                               if k not in ('review_hash', 'reviewed')})
        result.append(record)
    return result


def prepare_snapshot(rows, omitted, *, tokenizer, previous_partitions, session_rows=(),
                     reviews=None, gap_policy=None, budgets=(2048, 4096), source_snapshot=None):
    """One token pass; preserve all original evaluation sources before approval."""
    if not budgets or any(type(value) is not int or value < 1 for value in budgets):
        raise ValueError('invalid_snapshot_budgets')
    maximum = max(budgets)
    records, rejected = history.prepare_candidates(rows, session_rows=session_rows,
        tokenizer=tokenizer, max_seq_length=maximum, gap_policy=gap_policy)
    # Reserve raw targets too: grouping, an invalid candidate, or token gates may
    # hide a changed representation but cannot make evaluation sources trainable.
    raw_reservations = [{**row,
        'context_timestamps': [message.get('ts') for message in row.get('context', [])],
        'source_message_keys': sorted(set(row.get('source_message_keys') or []) |
            {history.source_key(row['chat'], message['message_id'])
             for message in row.get('context', [])} | history._target_keys(row)),
        'target_source_keys': sorted(history._target_keys(row))} for row in rows]
    frozen = reserve_refreshed_evaluation(previous_partitions, raw_reservations + records)
    frozen = quarantine_omitted_evaluation(frozen, omitted)
    budget_records, metrics = {}, {}
    for budget in sorted(set(budgets)):
        selected = records if budget == maximum else with_budget(records, budget)
        budget_records[budget] = selected
        metrics[str(budget)] = history.report(selected, omitted, raw_rows=rows, gap_policy=gap_policy)
        metrics[str(budget)]['eligible_for_review'] = sum(record['eligible_for_review'] for record in selected)
        metrics[str(budget)]['operational_input_3904_eligible'] = sum(record['eligible_for_review']
            and record['input_tokens'] is not None and record['input_tokens'] <= 3904 for record in selected)
        metrics[str(budget)]['hard_blocker_combination_counts'] = dict(Counter(
            '|'.join(sorted(set(record['reasons']) - history.REVIEWABLE_REASONS)) or 'none'
            for record in selected))
        metrics[str(budget)]['archive_gate_contributions'] = archive_gate_contributions(selected)
        metrics[str(budget)]['recipient_evidence_analysis'] = {
            'explicit_reply': sum(record['linkage'] == 'explicit_reply' for record in selected),
            'without_explicit_reply': sum(record['linkage'] != 'explicit_reply' for record in selected),
            'without_explicit_reply_observed_authors_le2': sum(
                record['linkage'] != 'explicit_reply' and type(record.get('author_count')) is int
                and record['author_count'] <= 2 for record in selected),
            'room_kind_unverified': sum(record.get('room_type_state') == 'unknown' for record in selected),
            'observed_authors_do_not_establish_room_kind': True}
    source = source_manifest(rows, omitted)
    if source_snapshot is not None:
        if source_snapshot['hash'] != source['hash']:
            raise ValueError('snapshot_source_manifest_mismatch')
        source = source_snapshot
    _, selected_gap_policy = history.group_turns(rows, gap_policy)
    rooms = {}
    for record in records:
        room = rooms.setdefault(history.source_key(record['chat'], ''), {
            'chat': record['chat'], 'candidate_count': 0, 'first_target_ts': record['timestamp'],
            'last_target_ts': record['timestamp'], 'eligible_counts': {str(budget): 0 for budget in budget_records},
            'reason_counts': Counter(), 'linkage_counts': Counter(), 'target_tokens': [],
            'room_type_states': Counter(), 'context_turn_counts': [], 'original_heldout_room': False})
        room['candidate_count'] += 1
        room['first_target_ts'] = min(room['first_target_ts'], record['timestamp'])
        room['last_target_ts'] = max(room['last_target_ts'], record['timestamp'])
        room['reason_counts'].update(record['reasons'])
        room['linkage_counts'].update([record['linkage']])
        room['room_type_states'].update([record['room_type_state']])
        room['target_tokens'].append(record['target_tokens'])
        room['context_turn_counts'].append(len(record['context']))
        room['original_heldout_room'] = history.source_key(record['chat'], '') in frozen['heldout_chats']
    for budget, selected in budget_records.items():
        for record in selected:
            rooms[history.source_key(record['chat'], '')]['eligible_counts'][str(budget)] += record['eligible_for_review']
    for room in rooms.values():
        room['reason_counts'] = dict(room['reason_counts'])
        room['linkage_counts'] = dict(room['linkage_counts'])
        room['room_type_states'] = dict(room['room_type_states'])
        room['target_tokens'] = history._bucket([value for value in room['target_tokens'] if value is not None])
        room['context_turn_counts'] = history._bucket(room['context_turn_counts'])
    metadata = {'version': 'history-snapshot-v1', 'created_at': time.time(),
        'prompt_version': history.PROMPT_VERSION, 'history_rule_version': history.RULE_VERSION,
        'gap_policy_seconds': selected_gap_policy,
        'source': source, 'token_metrics': metrics,
        'room_metrics': rooms,
        'preparation_rejected_counts': dict(Counter(reason for item in rejected for reason in item['reasons'])),
        'original_partitions_hash': history.digest(previous_partitions),
        'expanded_partitions_hash': history.digest(frozen),
        'queue': history.review_manifest(records, reviews, frozen)}
    quarantines = frozen['evaluation_context_quarantines']
    metadata['evaluation_context_quarantine_impact'] = {
        'room_count': len(quarantines), 'rooms': quarantines,
        'candidate_count': sum(history.source_key(record['chat'], '') in quarantines for record in records),
        'eligible_counts': {str(budget): sum(record['eligible_for_review'] and
            history.source_key(record['chat'], '') in quarantines for record in selected)
            for budget, selected in budget_records.items()}}
    metadata['snapshot_hash'] = history.digest({key: value for key, value in metadata.items()
                                                if key not in ('created_at', 'snapshot_hash')})
    return budget_records, frozen, metadata


def review_shards(training_records, assignments, frozen, *, shard_count=3):
    """Keep each room with one reviewer; return exact hashes, never bodies.

    The caller must reserve every new evaluation source first. A reviewer can
    receive only explicitly assigned, boundary-safe training candidates.
    """
    from learning_split import partition, chat_key
    if type(shard_count) is not int or shard_count < 1:
        raise ValueError('invalid_review_shard_count')
    if any(assignments.get(record['id']) != 'train' for record in training_records):
        raise ValueError('training_review_shards_require_explicit_train_assignments')
    kept, rejected = partition(training_records, assignments=assignments, frozen=frozen)
    if rejected:
        raise ValueError('training_review_shard_crosses_evaluation_boundary')
    rooms = {}
    for record in kept['train']:
        if record['eligible_for_review']:
            rooms.setdefault(chat_key(record), []).append(record)
    shards = [{'index': index, 'entries': [], 'estimated_input_tokens': 0}
              for index in range(shard_count)]
    ordered = sorted(rooms.items(), key=lambda item: (
        -sum(record.get('input_tokens') or 0 for record in item[1]), item[0]))
    for room, records in ordered:
        selected = min(shards, key=lambda shard: (shard['estimated_input_tokens'], shard['index']))
        selected['entries'].extend({'id': record['id'], 'hash': record['review_hash'], 'chat': room}
                                  for record in records)
        selected['estimated_input_tokens'] += sum(record.get('input_tokens') or 0 for record in records)
    for shard in shards:
        shard['hash'] = history.digest(shard['entries'])
        shard['count'] = len(shard['entries'])
    return shards
