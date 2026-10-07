"""Collect authorized, never-exposed rooms into a small context-only RAM owner."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import tempfile
import time
from behavior_audit import digest, read, write_private
import history as h
import history_snapshot as hs
from kakao_local_import import OwnerRpc
import review_sensitive as sensitive


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--cutoff', type=float)
    a = p.parse_args()
    plan = read(a.plan)
    raw = []
    rpc = OwnerRpc()
    room_counts = []
    try:
        for item in plan['rooms']:
            if not item.get('collect_candidates'):
                continue
            platform, account, chat_id, _ = json.loads(item['chat'])
            found, omitted = h.collect(hs.OwnerHistoryQuery(rpc), platform=platform, account=account, chat_id=chat_id)
            raw.extend(found)
            room_counts.append({'chat': item['chat'], 'raw_candidates': len(found), 'omitted_count': len(omitted)})
    finally:
        rpc.close()
    grouped, gap_policy = h.group_turns(raw)
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(str(Path.home()/'.inboxd/reply-model/models/Qwen3.5-9B-4bit'), local_files_only=True)
    values = set()
    for row in raw:
        for m in (*row.get('context', []), *row.get('targets', [])):
            values.update(sensitive.credential_values(m.get('body')))
    quarantined = sensitive.sensitive_source_evidence(raw, known_values=values)
    records, entries = {}, []
    for row in grouped:
        if a.cutoff is not None and row['timestamp'] <= a.cutoff:
            continue
        record = h.candidate_record(row, tokenizer=tokenizer, max_seq_length=4096, generation_limit=192, gap_policy=gap_policy)
        codes = []
        if set(record['source_message_keys']) & set(quarantined):
            codes.append('sensitive_source_context')
        for reason in record['reasons']:
            if reason in h.ARCHIVE_HARD_REASONS or reason in ('preflight_not_ready', 'self_identity_unknown', 'reply_target_mismatch'):
                codes.append(reason)
        if not record['messages'] or record['input_tokens'] is None or record['input_tokens'] > 3904:
            codes.append('context_token_budget_or_compilation_unavailable')
        identity = record['id']
        entries.append({'id': identity, 'chat': h.source_key(record['chat'], ''), 'timestamp': record['timestamp'],
                        'context_hash': digest(record['messages'][:-1]),
                        'source_keys_hash': digest(record['source_message_keys']),
                        'source_message_keys': record['source_message_keys'],
                        'context_timestamps': [m.get('ts') for m in record['context']],
                        'review_hash': record['review_hash'], 'lineage_verified': True,
                        'hard_exclusion_codes': sorted(set(codes)), 'prompt_tokens': record['input_tokens'],
                        'context_message_count': len(record['context']),
                        'nontext_context_count': sum(m.get('content_kind') not in (None, 'text') for m in record['context'])})
        if not codes:
            # Historical self target is not part of fresh model input or rubric display.
            record = dict(record)
            record['targets'] = []
            record['messages'] = record['messages'][:-1]
            records[identity] = record
    raw.clear()
    grouped.clear()
    values.clear()
    packet = {'schema': 'fresh-candidate-inventory-v1', 'entries': entries,
              'exposure_scan_complete': True, 'exposure_evidence_scope': 'Recorded owner-local artifacts, not absolute unseen-history proof.',
              'collected_at': time.time(), 'collection_plan_sha256': hashlib.sha256(a.plan.read_bytes()).hexdigest(),
              'room_counts': room_counts, 'raw_candidate_count': sum(r['raw_candidates'] for r in room_counts),
              'target_timestamp_strictly_after': a.cutoff,
              'grouped_candidate_count': len(entries), 'context_ready_count': len(records),
              'bodies_persisted': 0, 'historical_targets_excluded': True}
    packet['inventory_hash'] = digest(packet)
    write_private(a.output/'fresh-candidate-inventory.json', packet)
    stopping = False
    def stop(*_):
        nonlocal stopping
        stopping = True
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    with tempfile.TemporaryDirectory(prefix='inboxd-fresh-behavior-') as temp:
        directory = Path(temp)
        directory.chmod(0o700)
        path = directory/'fresh.sock'
        grant = {'schema': 'fresh-context-read-only-grant-v1', 'owner_pid': os.getpid(),
                 'socket_path': str(path), 'ids': sorted(records), 'inventory_hash': packet['inventory_hash'],
                 'historical_targets_excluded': True, 'operations': ['records'], 'max_batch': 20}
        grant['grant_hash'] = digest(grant)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(path))
            path.chmod(0o600)
            server.listen(4)
            server.settimeout(.5)
            write_private(a.output/'fresh-owner-grant.json', grant)
            print(json.dumps({'phase': 'fresh_serving', 'raw_candidates': packet['raw_candidate_count'], 'grouped_candidates': len(entries), 'ready_contexts': len(records), 'socket_path': str(path), 'pid': os.getpid()}), flush=True)
            while not stopping:
                try:
                    sock, _ = server.accept()
                except socket.timeout:
                    continue
                with sock:
                    try:
                        sock.settimeout(90)
                        data = bytearray()
                        while not data.endswith(b'\n'):
                            chunk = sock.recv(65536)
                            if not chunk or len(data) + len(chunk) > 65536:
                                raise ValueError('request_budget')
                            data.extend(chunk)
                        req = json.loads(data)
                        ids = req['ids']
                        if set(req) != {'op', 'ids', 'grant_hash'} or req['op'] != 'records' or req['grant_hash'] != grant['grant_hash'] or not 1 <= len(ids) <= 20 or set(ids)-set(records):
                            raise ValueError('grant_required')
                        response = {'cases': [{'record': records[i], 'metadata': next(e for e in entries if e['id'] == i)} for i in ids], 'historical_targets_excluded': True}
                        body = json.dumps(response, ensure_ascii=False).encode()+b'\n'
                    except Exception:
                        body = b'{"error":"fresh_request_rejected"}\n'
                    try:
                        sock.sendall(body)
                    except OSError:
                        pass
    records.clear()
    write_private(a.output/'fresh-owner-shutdown.json', {'pid': os.getpid(), 'socket_removed': True, 'bodies_persisted': 0})


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'phase': 'failed', 'error_type': type(e).__name__, 'bodies_logged': False}), flush=True)
        raise SystemExit(1)
