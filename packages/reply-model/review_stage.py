"""Pure review-stage preparation; exact records remain in owner process memory."""
from collections import Counter

import history
from history_snapshot import review_shards
from learning_split import chat_key, freeze, partition


def validate_frozen_selection(selection, snapshot):
    if selection.get('freeze_hash') != history.digest({key: value for key, value in selection.items()
                                                      if key != 'freeze_hash'}):
        raise ValueError('frozen_selection_hash_mismatch')
    if selection.get('snapshot_hash') != snapshot['snapshot_hash'] or selection.get('source_hash') != snapshot['source']['hash']:
        raise ValueError('frozen_selection_snapshot_mismatch')
    if set(selection['room_splits'].values()) - {'valid', 'test'}:
        raise ValueError('invalid_reserved_room_split')


def _grant(index, records):
    entries = [{'id': record['id'], 'hash': record['review_hash'], 'chat': chat_key(record)}
               for record in records]
    return {'index': index, 'entries': entries, 'hash': history.digest(entries),
            'count': len(entries), 'estimated_input_tokens': sum(record['input_tokens'] for record in records)}


def build_review_stage(budget_records, previous_reservations, selection, snapshot, *, root_target=15):
    """Reserve every selected room/source before deriving any training grant."""
    validate_frozen_selection(selection, snapshot)
    records = budget_records[4096]
    by_id = {record['id']: record for record in records}
    eval_records = {}
    for split in ('valid', 'test'):
        entries = selection[split]['entries']
        for entry in entries:
            record = by_id.get(entry['id'])
            if record is None or record['review_hash'] != entry['hash'] or not record['eligible_for_review']:
                raise ValueError('frozen_eval_record_changed')
            if selection['room_splits'].get(chat_key(record)) != split:
                raise ValueError('frozen_eval_room_changed')
        eval_records[split] = [by_id[entry['id']] for entry in entries]
    reserved = {name: [] for name in ('train', 'valid', 'test')}
    for record in records:
        name = selection['room_splits'].get(chat_key(record))
        if name is not None:
            reserved[name].append({**record, **({'evaluation_group': 'heldout_chat'} if name == 'test' else {})})
    actual_reserved_assignments = {record['id']: name for name in ('valid', 'test')
                                   for record in reserved[name]}
    if actual_reserved_assignments != selection['assignments']:
        raise ValueError('frozen_whole_room_inventory_changed')
    frozen = freeze(previous_reservations, reserved)
    # Whole-room holds also protect omitted, invalid, and later-arriving targets.
    frozen['heldout_chats'] = sorted(set(frozen['heldout_chats']) | set(selection['room_splits']))
    assignments = dict(frozen['assignments'])
    eligible = []
    for record in budget_records[2048]:
        if not record['eligible_for_review'] or chat_key(record) in selection['room_splits']:
            continue
        if assignments.get(record['id']) in ('valid', 'test'):
            continue
        assignments[record['id']] = 'train'
        eligible.append(record)
    kept, rejected = partition(eligible, assignments=assignments, frozen=frozen)
    train = kept['train']
    rooms = {}
    for record in train:
        rooms.setdefault(chat_key(record), []).append(record)
    # A small disjoint root grant keeps whole rooms with one reviewer.
    root_records = []
    for room, members in sorted(rooms.items(), key=lambda item: (len(item[1]), item[0])):
        if len(root_records) >= root_target:
            break
        if len(members) <= 5 and len(root_records) + len(members) <= root_target + 3:
            root_records.extend(members)
    root_ids = {record['id'] for record in root_records}
    bulk_records = [record for record in train if record['id'] not in root_ids]
    shards = review_shards(bulk_records, assignments, frozen, shard_count=2)
    shards.append(_grant(2, root_records))
    primary_count = selection['test']['initial_review_allowlist_count']
    grants = {'train': shards,
              'valid': [_grant(0, eval_records['valid'])],
              'test': [_grant(0, eval_records['test'][:primary_count])],
              'test_reserve': [_grant(1, eval_records['test'][primary_count:])]}
    summary = {'train_count': len(train), 'train_platform_counts': dict(Counter(record['chat']['platform'] for record in train)),
               'training_boundary_rejections': dict(Counter(item['reason'] for item in rejected)),
               'valid_initial_count': len(eval_records['valid']), 'test_initial_count': primary_count,
               'test_conditional_reserve_count': len(eval_records['test']) - primary_count,
               'root_disjoint_count': len(root_records), 'bulk_counts': [shard['count'] for shard in shards[:2]],
               'frozen_reservations_hash': history.digest(frozen),
               'train_target_tokens': history._bucket([record['target_tokens'] for record in train])}
    return {'records': {'train': train, **eval_records}, 'assignments': assignments,
            'frozen': frozen, 'grants': grants, 'summary': summary}
