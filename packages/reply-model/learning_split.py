"""Source based, persistent partitions for reviewed reply episodes."""
import hashlib
import json
import math

NAMES = ('train', 'valid', 'test')


def key(platform, account, chat_id, message_id):
    return json.dumps([str(platform), str(account), str(chat_id), str(message_id)], ensure_ascii=False, separators=(',', ':'))


def source_keys(record):
    values = record.get('source_message_keys')
    if not isinstance(values, list) or not values:
        raise ValueError('missing_source_message_keys')
    keys = set()
    for value in values:
        try:
            parts = json.loads(value)
        except (TypeError, ValueError) as error:
            raise ValueError('invalid_source_message_key') from error
        if not isinstance(parts, list) or len(parts) != 4 or not all(isinstance(p, str) and p for p in parts):
            raise ValueError('invalid_source_message_key')
        canonical = key(*parts)
        if value != canonical:
            raise ValueError('noncanonical_source_message_key')
        keys.add(value)
    return keys


def chat_key(record):
    chat = record.get('chat') or {}
    if not all(chat.get(part) for part in ('platform', 'account', 'chat_id')):
        raise ValueError('missing_chat_identity')
    return key(chat['platform'], chat['account'], chat['chat_id'], '')


def interval(record):
    times = record.get('context_timestamps', []) + [record['timestamp']]
    times += [item.get('ts') for item in record.get('targets', [])]
    if any(type(t) not in (int, float) or not math.isfinite(t) for t in times):
        raise ValueError('invalid_timestamps')
    return [min(times), max(times)]


def overlaps(left, right):
    return left[0] <= right[1] and right[0] <= left[1]


def identity(record):
    """Actual transmission identity, independent of hist:/send: candidate IDs."""
    target_keys = record.get('target_source_keys')
    if target_keys:
        return tuple(sorted(target_keys))
    targets = record.get('targets') or []
    if targets:
        chat = record['chat']
        return tuple(sorted(key(chat['platform'], chat['account'], chat['chat_id'], t.get('message_id') or t.get('msg_id')) for t in targets))
    return (record['id'],)


def reserve_refreshed_evaluation(frozen, records):
    """Protect backfilled evaluation context before semantic re-review.

    Approval controls training eligibility, not the heldout boundary. A changed
    input for a known valid/test transmission therefore expands its reservation
    even while its old review hash is stale. Original reservations never shrink.
    """
    result = freeze(frozen, {name: [] for name in NAMES})
    protected = {name: [] for name in NAMES}
    targets = dict(result['evaluation_target_keys'])
    # Migrate the legacy historical-ID format without using conversation bodies.
    for candidate_id, name in frozen.get('assignments', {}).items():
        if name not in ('valid', 'test') or not candidate_id.startswith('hist:'):
            continue
        try:
            parts = json.loads(candidate_id[5:])
            if isinstance(parts, list) and len(parts) == 4 and all(isinstance(p, str) and p for p in parts):
                canonical = key(*parts)
                if canonical in frozen.get('source_keys', {}):
                    targets.setdefault(canonical, name)
        except (TypeError, ValueError):
            pass
    result['evaluation_target_keys'] = targets
    for record in records:
        name = frozen.get('assignments', {}).get(record['id'])
        names = {name} if name in ('valid', 'test') else {
            targets[value] for value in record.get('target_source_keys', []) if value in targets}
        if names:
            source_keys(record)
            interval(record)
            # Different extraction IDs must reserve the new context without
            # granting that candidate an evaluation assignment or approval.
            for partition_name in names:
                protected[partition_name].append({**record,
                    'id': record['id'] if name == partition_name else
                        'reserved:' + partition_name + ':' + record['id']})
    grown = freeze(result, protected)
    for candidate_id in set(grown['assignments']) - set(frozen.get('assignments', {})):
        # Reservation-only aliases are bookkeeping, never split assignments.
        if candidate_id.startswith('reserved:'):
            grown['assignments'].pop(candidate_id)
            grown['evaluation_groups'].pop(candidate_id, None)
    return grown


def quarantine_omitted_evaluation(frozen, omitted):
    """Keep a known evaluation room out of training when new context is unavailable."""
    result = freeze(frozen, {name: [] for name in NAMES})
    for item in omitted:
        candidate_id = item.get('id')
        if not isinstance(candidate_id, str):
            continue
        known_evaluation = frozen.get('assignments', {}).get(candidate_id) in ('valid', 'test')
        scope = None
        if candidate_id.startswith('hist:'):
            try:
                parts = json.loads(candidate_id[5:])
                if isinstance(parts, list) and len(parts) == 4 and all(isinstance(value, str) and value for value in parts):
                    source = key(*parts)
                    known_evaluation |= frozen.get('source_keys', {}).get(source) in ('valid', 'test')
                    known_evaluation |= source in frozen.get('evaluation_target_keys', {})
                    scope = key(*parts[:3], '')
            except (ValueError, TypeError):
                pass
        if not known_evaluation:
            continue
        if scope is None:
            raise ValueError('omitted_evaluation_scope_unrecoverable')
        quarantine = result['evaluation_context_quarantines'].setdefault(scope,
            {'reason': 'omitted_evaluation_context_unavailable', 'candidate_ids': []})
        if candidate_id not in quarantine['candidate_ids']:
            quarantine['candidate_ids'].append(candidate_id)
            quarantine['candidate_ids'].sort()
        result['heldout_chats'].append(scope)
    result['heldout_chats'] = sorted(set(result['heldout_chats']))
    return result


def extend_temporal_assignments(records, assignments, frozen, *, episode_gap=21600):
    """Reserve one latest independent new episode after earlier training in a chat."""
    if episode_gap <= 0:
        raise ValueError('invalid_episode_gap')
    result = dict(assignments)
    by_chat = {}
    for r in records:
        by_chat.setdefault(chat_key(r), []).append(r)
    for chat, members in by_chat.items():
        if chat in frozen.get('heldout_chats', []):
            continue
        members.sort(key=lambda r: (r['timestamp'], r['id']))
        new = [r for r in members if r['id'] not in frozen.get('assignments', {})]
        episodes = []
        current = []
        anchor = previous = None
        for r in new:
            ts = r['timestamp']
            if current and (ts - previous > episode_gap or ts - anchor > episode_gap):
                episodes.append(current)
                current = []
            if not current:
                anchor = ts
            current.append(r)
            previous = ts
        if current:
            episodes.append(current)
        for episode in reversed(episodes):
            start = min(interval(r)[0] for r in episode)
            prior_train = any(result.get(r['id']) == 'train' and interval(r)[1] < start
                              for r in members if r not in episode)
            if not prior_train:
                continue
            safe = all(not (source_keys(r) & frozen.get('source_keys', {}).keys())
                       and not any(overlaps(interval(r), span) for span, _ in frozen.get('intervals', {}).get(chat, []))
                       and not (r.get('duplicate_group') and
                                str(r['duplicate_group']) in frozen.get('duplicate_groups', {}))
                       for r in episode)
            if safe:
                for r in episode:
                    result[r['id']] = 'test'
                break
    return result


def partition(records, *, assignments=None, frozen=None, episode_gap=21600):
    """Assign independent episodes, then reject only actual boundary intersections.

    Frozen test/validation sources and intervals remain excluded from all future
    training, including candidate IDs newly produced by another import path.
    """
    if episode_gap <= 0:
        raise ValueError('invalid_episode_gap')
    frozen = frozen or {'assignments': {}, 'source_keys': {}, 'intervals': {},
                        'duplicate_groups': {}, 'heldout_chats': [], 'evaluation_groups': {}}
    provided = assignments if assignments is not None else frozen.get('assignments', {})
    rows = sorted(records, key=lambda r: (r['timestamp'], r['id']))
    by_chat = {}
    for r in rows:
        by_chat.setdefault(chat_key(r), []).append(r)
    episode_of = {}
    episodes = []
    for chat, members in sorted(by_chat.items()):
        current = []
        anchor = previous = None
        for r in members:
            ts = r['timestamp']
            if current and (ts - previous > episode_gap or ts - anchor > episode_gap):
                episodes.append((chat, current))
                current = []
            if not current:
                anchor = ts
            current.append(r)
            previous = ts
        if current:
            episodes.append((chat, current))
    for index, (_, members) in enumerate(episodes):
        for r in members:
            episode_of[r['id']] = index
    if assignments is None and not frozen.get('assignments'):
        # Reserve a whole chat for unseen-contact testing when possible.
        chats = sorted(by_chat, key=lambda c: max(r['timestamp'] for r in by_chat[c]))
        heldout = chats[-1] if len(chats) >= 3 else None
        available = [(i, members) for i, (chat, members) in enumerate(episodes) if chat != heldout]
        ordered_available = sorted(available, key=lambda item: item[1][0]['timestamp'])
        train_end = max(1, int(len(ordered_available)*.7))
        valid_end = max(train_end+1, int(len(ordered_available)*.85))
        auto = {}
        for rank, (i, members) in enumerate(ordered_available):
            for r in members:
                auto[r['id']] = 'train' if rank < train_end else 'valid' if rank < valid_end else 'test'
        for r in by_chat.get(heldout, []):
            auto[r['id']] = 'test'
        train_chats = {chat_key(r) for r in rows if auto.get(r['id']) == 'train'}
        for r in rows:
            if auto.get(r['id']) == 'test':
                r['evaluation_group'] = 'temporal' if chat_key(r) in train_chats else 'heldout_chat'
        if heldout is None:
            # One/two-chat datasets can still support temporal evaluation.
            ordered = sorted(episodes, key=lambda item: item[1][0]['timestamp'])
            for i, (_, members) in enumerate(ordered):
                name = 'train' if i < int(len(ordered)*.7) else 'valid' if i < int(len(ordered)*.85) else 'test'
                for r in members:
                    auto[r['id']] = name
            train_chats = {chat_key(r) for r in rows if auto.get(r['id']) == 'train'}
            for r in rows:
                if auto.get(r['id']) == 'test':
                    r['evaluation_group'] = 'temporal' if chat_key(r) in train_chats else 'heldout_chat'
        provided = auto
    if any(provided.get(r['id']) not in NAMES for r in rows):
        raise ValueError('invalid_split_assignments')
    rejected, kept = [], {name: [] for name in NAMES}
    # Priority protects frozen evaluation evidence and explicit heldout rows.
    priority = {'train': 0, 'valid': 1, 'test': 2}
    ordered = sorted(rows, key=lambda r: (-priority[provided[r['id']]], r['timestamp'], r['id']))
    ownership = {}
    duplicate_ownership = {}
    occupied = []
    frozen_keys = frozen.get('source_keys', {})
    frozen_intervals = frozen.get('intervals', {})
    frozen_duplicates = frozen.get('duplicate_groups', {})
    for r in ordered:
        name = provided[r['id']]
        original_name = frozen.get('assignments', {}).get(r['id'])
        if original_name is not None and original_name != name:
            rejected.append({'id': r['id'], 'reason': 'frozen_assignment_changed'})
            continue
        if name == 'test' and 'evaluation_group' not in r:
            r['evaluation_group'] = frozen.get('evaluation_groups', {}).get(r['id']) or (
                'heldout_chat' if chat_key(r) in frozen.get('heldout_chats', []) else 'temporal')
        keys = source_keys(r)
        chat = chat_key(r)
        span = interval(r)
        duplicate = r.get('duplicate_group')
        known_id = r['id'] in frozen.get('assignments', {})
        conflict = any(k in frozen_keys and (not known_id or frozen_keys[k] != name) for k in keys)
        conflict |= any(overlaps(span, item) and owner != name for item, owner in frozen_intervals.get(chat, []))
        conflict |= bool(duplicate and frozen_duplicates.get(str(duplicate)) not in (None, name))
        conflict |= name == 'train' and chat in frozen.get('heldout_chats', [])
        conflict |= bool(duplicate and duplicate_ownership.get(str(duplicate)) not in (None, name))
        conflict |= any(ownership.get(k) not in (None, name) for k in keys)
        conflict |= any(other_chat == chat and other_name != name and overlaps(span, other_span) for other_chat, other_span, other_name in occupied)
        if conflict:
            rejected.append({'id': r['id'], 'reason': 'cross_split_source_boundary'})
            continue
        kept[name].append(r)
        for k in keys:
            ownership[k] = name
        if duplicate:
            duplicate_ownership[str(duplicate)] = name
        occupied.append((chat, span, name))
    for name in NAMES:
        kept[name].sort(key=lambda r: (r['timestamp'], r['id']))
    train_latest = {}
    for r in kept['train']:
        chat = chat_key(r)
        train_latest[chat] = max(train_latest.get(chat, -math.inf), interval(r)[1])
    for r in kept['test']:
        if r.get('evaluation_group') == 'temporal':
            latest = train_latest.get(chat_key(r))
            if latest is None:
                r['evaluation_group'] = ('retrospective' if r['id'] in frozen.get('assignments', {})
                                         else 'heldout_chat')
            elif latest >= interval(r)[0]:
                r['evaluation_group'] = 'retrospective'
    return kept, rejected


def freeze(previous, splits):
    result = {'assignments': dict(previous.get('assignments', {})),
              'source_keys': dict(previous.get('source_keys', {})),
              'intervals': {k: list(v) for k, v in previous.get('intervals', {}).items()},
              'duplicate_groups': dict(previous.get('duplicate_groups', {})),
              'heldout_chats': list(previous.get('heldout_chats', [])),
              'evaluation_groups': dict(previous.get('evaluation_groups', {})),
              'evaluation_target_keys': dict(previous.get('evaluation_target_keys', {})),
              'evaluation_context_quarantines': {scope: {**value, 'candidate_ids': list(value['candidate_ids'])}
                  for scope, value in previous.get('evaluation_context_quarantines', {}).items()}}
    for name in ('valid', 'test'):
        for r in splits[name]:
            if result['assignments'].get(r['id'], name) != name:
                raise ValueError('frozen_assignment_changed')
            result['assignments'][r['id']] = name
            if name == 'test':
                result['evaluation_groups'][r['id']] = r.get('evaluation_group',
                    result['evaluation_groups'].get(r['id'], 'temporal'))
            for k in source_keys(r):
                # A refreshed test input may reach an original validation
                # source. Keep its original owner and reject that new input at
                # partition time; either reservation still excludes training.
                result['source_keys'].setdefault(k, name)
            for target in r.get('target_source_keys', []):
                result['evaluation_target_keys'].setdefault(target, name)
            item = [interval(r), name]
            intervals = result['intervals'].setdefault(chat_key(r), [])
            if item not in intervals:
                intervals.append(item)
            if r.get('duplicate_group'):
                result['duplicate_groups'].setdefault(str(r['duplicate_group']), name)
    test_chats = {chat_key(r) for r in splits['test'] if r.get('evaluation_group') == 'heldout_chat'}
    other_chats = {chat_key(r) for name in ('train', 'valid') for r in splits[name]}
    result['heldout_chats'].extend(test_chats - other_chats)
    result['heldout_chats'] = sorted(set(result['heldout_chats']))
    return result
