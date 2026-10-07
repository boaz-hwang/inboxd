#!/usr/bin/env python3
"""Read only the authorized screened real-test grant into transient memory.

Never opens training/validation grants, writes source bodies, or masks approved
inputs. Metadata-only exclusions are rejection evidence, not evaluated inputs.
"""
import argparse
import json
from pathlib import Path
import socket

from independent import check_seal, digest, read


def fetch(grant_path, frozen_split_path, indices, metadata_only=False):
    grant_path = Path(grant_path).resolve()
    allowed_names = {'review-grant-screened-test-0.json': (0, 60),
                     'review-grant-screened-test-1.json': (60, 36)}
    if grant_path.name not in allowed_names:
        raise ValueError('scoped_screened_test_grant_only')
    offset, count = allowed_names[grant_path.name]
    grant, frozen = read(grant_path), read(frozen_split_path)
    check_seal(frozen, 'freeze_hash')
    if grant['split'] != 'test' or grant['selection_freeze_hash'] != frozen['freeze_hash']:
        raise ValueError('frozen_test_grant_required')
    if grant['count'] != count or len(grant['entries']) != count:
        raise ValueError('fixed_scope_count_required')
    if offset:
        activation = read(grant_path.parent / 'test-reserve-review-activation.json')
        check_seal(activation, 'activation_hash')
        if activation['activation_hash'] != grant['activation_hash']:
            raise ValueError('reserve_activation_hash_mismatch')
        if not activation['maximum_possible_initial_admissible'] < activation['minimum_required']:
            raise ValueError('reserve_activation_shortfall_required')
        if activation['ordered_reserve_count'] != count:
            raise ValueError('reserve_activation_scope_mismatch')
    if not indices or len(set(indices)) != len(indices) or len(indices) > grant['max_batch']:
        raise ValueError('distinct_bounded_indices_required')
    if any(type(i) is not int or i < 0 or i >= count for i in indices):
        raise ValueError('index_outside_scoped_grant')
    if grant['entries'] != [{k: e[k] for k in ('id', 'hash', 'chat')} for e in frozen['test']['entries'][offset:offset + count]]:
        raise ValueError('frozen_priority_allowlist_changed')
    selected = [grant['entries'][i] for i in indices]
    request = {'shard_index': grant['shard_index'], 'shard_hash': grant['shard_hash'],
               'entries': [{k: e[k] for k in ('id', 'hash')} for e in selected]}
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(30)
        client.connect(grant['socket_path'])
        client.sendall(json.dumps(request, ensure_ascii=False).encode() + b'\n')
        data = b''
        while not data.endswith(b'\n'):
            chunk = client.recv(65536)
            if not chunk:
                break
            data += chunk
            if len(data) > grant['max_response_bytes']:
                raise ValueError('response_over_grant_budget')
    packet = json.loads(data)
    if packet['split'] != 'test' or packet['snapshot_hash'] != grant['snapshot_hash']:
        raise ValueError('response_not_frozen_test_snapshot')
    if {c['id'] for c in packet['cases']} != {e['id'] for e in selected}:
        raise ValueError('response_case_set_mismatch')
    metadata = {e['id']: e for e in frozen['test']['entries']}
    index_by_id = {grant['entries'][i]['id']: offset + i for i in indices}
    lean = []
    for case in packet['cases']:
        source = metadata[case['id']]
        if case['review_hash'] != source['hash']:
            raise ValueError('source_record_changed')
        row = {'index': index_by_id[case['id']], 'id': case['id'],
               'review_hash': case['review_hash']}
        if case.get('approvable') is False:
            # No masked contents can pass this branch into an approved view.
            row.update({k: v for k, v in case.items() if k not in ('context', 'targets', 'messages')})
            row['disposition'] = 'reject_sensitive_metadata'
            lean.append(row)
            continue
        checks = {'raw_content_hash': digest({'context': case['context'], 'targets': case['targets']}) == source['raw_content_hash'],
                  'input_hash': digest(case['messages'][:-1]) == source['input_hash'],
                  'target_hash': digest(case['messages'][-1:]) == source['target_hash']}
        if not all(checks.values()):
            raise ValueError('original_input_or_target_changed')
        row.update(source_hashes={k: source[k] for k in ('source_keys_hash', 'raw_content_hash', 'input_hash', 'target_hash')},
                   hash_checks=checks, input_tokens=source['input_tokens'])
        if not metadata_only:
            row.update(context_fields=['id', 'role', 'author', 'ts', 'reply_to', 'kind', 'body'],
                context=[[t.get(k) for k in ('message_id', 'author_role', 'author_id', 'ts', 'reply_to', 'content_kind', 'body')] for t in case['context']],
                targets=[[t.get(k) for k in ('message_id', 'ts', 'reply_to', 'body')] for t in case['targets']])
            for key in ('reply_linkage', 'coverage', 'authorship', 'flags', 'reasons',
                        'room_type_state', 'author_count', 'target_source_keys'):
                row[key] = case[key]
        lean.append(row)
    return {'split': 'test', 'snapshot_hash': packet['snapshot_hash'],
            'grant_hash': grant['grant_hash'], 'selection_freeze_hash': frozen['freeze_hash'],
            'screening_metadata': {k: v for k, v in packet.items() if k not in ('cases', 'snapshot_hash', 'split', 'shard_index')},
            'cases': lean}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--grant', required=True, type=Path)
    parser.add_argument('--frozen', required=True, type=Path)
    parser.add_argument('--indices', required=True, help='Comma-separated local indices within the scoped grant')
    parser.add_argument('--metadata-only', action='store_true')
    args = parser.parse_args()
    print(json.dumps(fetch(args.grant, args.frozen, [int(i) for i in args.indices.split(',')],
        args.metadata_only), ensure_ascii=False))


if __name__ == '__main__':
    main()
