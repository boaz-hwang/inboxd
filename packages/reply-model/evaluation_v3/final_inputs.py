"""Verify final-only owner packets and return generation inputs only in memory.

No CLI renders messages. Historical targets are hash-checked and discarded;
they never enter returned model inputs. The caller owns authorized final access.
"""
import json
from pathlib import Path
import socket

from independent import read, check_seal, digest


def fetch_inputs(grant_path, admission_path):
    grant_path = Path(grant_path)
    if grant_path.name != 'review-grant-final48-only.json':
        raise ValueError('final_only_grant_required_before_read')
    grant, admission = read(grant_path), read(admission_path)
    check_seal(grant, 'grant_hash')
    check_seal(admission, 'admission_hash')
    if (grant['split'] != 'test' or grant['selected_allowlist_hash'] != admission['allowlist_hash']
            or grant['selection_freeze_hash'] != admission['selection_freeze_hash']
            or grant['snapshot_hash'] != admission['snapshot_hash']
            or grant['quarantine_hash'] != admission['latest_quarantine_hash']
            or grant.get('historical_targets_model_input') is not False
            or grant['model_input_field'] != 'messages[:-1]'):
        raise ValueError('final_admission_binding_mismatch')
    entries = admission['entries']
    if grant['count'] != len(entries) or grant['entries'] != [
            {k: e[k] for k in ('id', 'hash', 'chat')} for e in entries]:
        raise ValueError('final_exact_allowlist_mismatch')
    inputs = {}
    for start in range(0, len(entries), grant['max_batch']):
        selected = entries[start:start + grant['max_batch']]
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
                    raise ValueError('final_packet_over_budget')
        packet = json.loads(data)
        if (packet['split'] != 'test' or packet['snapshot_hash'] != grant['snapshot_hash']
                or {c['id'] for c in packet['cases']} != {e['id'] for e in selected}):
            raise ValueError('final_packet_boundary_mismatch')
        source = {e['id']: e for e in selected}
        for case in packet['cases']:
            e = source[case['id']]
            if case.get('approvable') is False or case['review_hash'] != e['hash']:
                raise ValueError('final_source_excluded_or_changed')
            messages = case['messages']
            if not messages or messages[-1]['role'] != 'assistant':
                raise ValueError('historical_target_boundary_invalid')
            if (digest({'context': case['context'], 'targets': case['targets']}) != e['raw_content_hash']
                    or digest(messages[:-1]) != e['input_hash']
                    or digest(messages[-1:]) != e['target_hash']):
                raise ValueError('original_final_source_hash_mismatch')
            inputs[case['id']] = messages[:-1]
        # Targets and corpus bodies stay in transient parser memory only.
        del packet, data
    if set(inputs) != {e['id'] for e in entries}:
        raise ValueError('incomplete_final_inputs')
    return inputs
