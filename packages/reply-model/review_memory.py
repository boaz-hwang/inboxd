"""Transient owner-only, split-scoped frozen-hash review packets; no body files."""
import contextlib
import json
import os
from pathlib import Path
import socket
import tempfile
import threading

import history
from learning_split import partition

MAX_REQUEST_BYTES = 65_536
MAX_RESPONSE_BYTES = 524_288
MAX_BATCH = 10
PACKET_FIELDS = ('id', 'review_hash', 'chat', 'timestamp', 'context', 'targets', 'messages',
                 'reply_linkage', 'coverage', 'context_edit_state', 'authorship', 'flags',
                 'reasons', 'versions', 'unseen_state', 'incoming_message_ids', 'room_type_state',
                 'author_count', 'source_message_keys', 'target_source_keys', 'provenance_refs')


class _ScopedReviewMemory:
    split = None
    label = None

    def __init__(self, records, shards, *, assignments, frozen, snapshot_hash,
                 response_budget=MAX_RESPONSE_BYTES):
        if type(response_budget) is not int or not 1024 <= response_budget <= MAX_RESPONSE_BYTES:
            raise ValueError('invalid_review_response_budget')
        if self.split not in ('train', 'valid', 'test'):
            raise ValueError('review_requires_explicit_typed_split')
        if any(assignments.get(record['id']) != self.split for record in records):
            raise ValueError(f'{self.label}_review_requires_explicit_{self.split}_assignments')
        # Partition annotates evaluation grouping. Keep that diagnostic out of
        # the original hash-bound review record and retain only its boundary result.
        kept, rejected = partition([dict(record) for record in records], assignments=assignments, frozen=frozen)
        if rejected:
            raise ValueError(f'{self.label}_review_crosses_evaluation_boundary')
        kept_ids = {record['id'] for record in kept[self.split]}
        self.records = {record['id']: record for record in records if record['id'] in kept_ids}
        if len(self.records) != len(records):
            raise ValueError('duplicate_review_record')
        self.grants, seen = {}, set()
        for shard in shards:
            index = shard['index']
            if type(index) is not int or index in self.grants or shard['hash'] != history.digest(shard['entries']):
                raise ValueError('invalid_review_shard')
            entries = {}
            for entry in shard['entries']:
                record = self.records.get(entry['id'])
                if record is None or entry['id'] in seen or not record['eligible_for_review'] or entry['hash'] != record['review_hash']:
                    raise ValueError('invalid_or_overlapping_review_grant')
                seen.add(entry['id'])
                entries[entry['id']] = entry['hash']
            self.grants[index] = {'hash': shard['hash'], 'entries': entries}
        self.snapshot_hash = snapshot_hash
        self.response_budget = response_budget
        self.audit = []

    def packet(self, request):
        if not isinstance(request, dict) or set(request) != {'shard_index', 'shard_hash', 'entries'}:
            raise ValueError('invalid_review_request')
        index, entries = request['shard_index'], request['entries']
        if type(index) is not int or not isinstance(entries, list) or not 1 <= len(entries) <= MAX_BATCH:
            raise ValueError('invalid_review_batch')
        grant = self.grants.get(index)
        if grant is None or request['shard_hash'] != grant['hash']:
            raise ValueError('invalid_review_shard_grant')
        packets, seen = [], set()
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != {'id', 'hash'}:
                raise ValueError('invalid_review_entry')
            candidate_id = entry['id']
            if not isinstance(candidate_id, str) or candidate_id in seen or grant['entries'].get(candidate_id) != entry['hash']:
                raise ValueError('ungranted_or_stale_review_entry')
            seen.add(candidate_id)
            record = self.records[candidate_id]
            # Frozen bodies may not silently mutate after grant creation.
            current_hash = history.digest({key: value for key, value in record.items()
                                            if key not in ('review_hash', 'reviewed')})
            if current_hash != entry['hash']:
                raise ValueError('review_record_changed_in_memory')
            packets.append({key: record[key] for key in PACKET_FIELDS if key in record})
        response = {'snapshot_hash': self.snapshot_hash, 'split': self.split, 'shard_index': index,
                    'cases': packets, 'case_count': len(packets)}
        encoded = json.dumps(response, ensure_ascii=False, separators=(',', ':')).encode() + b'\n'
        if len(encoded) > self.response_budget:
            raise ValueError('review_packet_over_budget_reduce_batch')
        self.audit.append({'shard_index': index, 'case_count': len(packets),
                           'packet_hash': history.digest(response), 'response_bytes': len(encoded)})
        return encoded

    def clear(self):
        self.records.clear()
        self.grants.clear()


class TrainingReviewMemory(_ScopedReviewMemory):
    split = 'train'
    label = 'training'


class ValidationReviewMemory(_ScopedReviewMemory):
    split = 'valid'
    label = 'validation'


class EvaluationReviewMemory(_ScopedReviewMemory):
    split = 'test'
    label = 'evaluation'


def _serve(server, corpus, stopping):
    while not stopping.is_set():
        try:
            connection, _ = server.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        with connection:
            connection.settimeout(2)
            try:
                frame = bytearray()
                while b'\n' not in frame and len(frame) <= MAX_REQUEST_BYTES:
                    chunk = connection.recv(min(8192, MAX_REQUEST_BYTES + 1 - len(frame)))
                    if not chunk:
                        raise ValueError('incomplete_review_request')
                    frame.extend(chunk)
                if len(frame) > MAX_REQUEST_BYTES or not frame.endswith(b'\n') or frame.count(b'\n') != 1:
                    raise ValueError('invalid_review_request_frame')
                response = corpus.packet(json.loads(frame))
            except (ValueError, TypeError, KeyError, OSError):
                # Parser/library errors can contain bodies; expose a fixed code.
                response = b'{"status":"error","error":"review_request_rejected"}\n'
            try:
                connection.sendall(response)
            except OSError:
                pass


@contextlib.contextmanager
def serve_review_memory(corpus):
    """One request per connection, fixed operation; directory/socket removed on exit."""
    with tempfile.TemporaryDirectory(prefix='inboxd-review-memory-') as temporary:
        directory = Path(temporary)
        os.chmod(directory, 0o700)
        path = directory / 'review.sock'
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        stopping = threading.Event()
        thread = None
        try:
            server.bind(str(path))
            os.chmod(path, 0o600)
            server.settimeout(.2)
            server.listen(8)
            thread = threading.Thread(target=_serve, args=(server, corpus, stopping), daemon=True)
            thread.start()
            yield path
        finally:
            stopping.set()
            server.close()
            if thread is not None:
                thread.join(timeout=3)
                if thread.is_alive():
                    raise ValueError('review_service_shutdown_incomplete')
            corpus.clear()
            path.unlink(missing_ok=True)
