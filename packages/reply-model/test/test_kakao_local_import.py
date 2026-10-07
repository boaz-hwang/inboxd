import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import kakao_local_import as k


class LocalImportTest(unittest.TestCase):
    def row(self, identifier, room='7', body='테스트'):
        return {'id': str(identifier), 'chat_id': room, 'author_id': '3',
                'ts': 10, 'body': body, 'type': 1,
                'archive_metadata': {'logId': identifier, 'message': body}}

    def test_page_boundaries_preserve_all_records_and_room_scope(self):
        rows = [self.row(i) for i in range(6)] + [self.row(7, room='8')]
        source = {'snapshot_sha256': 'a' * 64}
        pages = list(k.pages(rows, 'owner', '3', source, max_records=2))
        self.assertEqual([m for p in pages for m in p['messages']], rows)
        self.assertEqual([len(p['messages']) for p in pages], [2, 2, 2, 1])
        self.assertTrue(all(all(m['chat_id'] == p['chat']['chat_id'] for m in p['messages']) for p in pages))
        self.assertEqual(pages, list(k.pages(rows, 'owner', '3', source, max_records=2)))
        changed = list(k.pages([self.row(0, body='changed')], 'owner', '3', source))[0]
        self.assertNotEqual(changed['page_id'], pages[0]['page_id'])

    def test_utf8_frame_budget_and_oversized_record_fail_without_truncation(self):
        rows = [self.row(i, body='가' * 1000) for i in range(10)]
        pages = list(k.pages(rows, 'owner', '3', {'snapshot_sha256': 'b' * 64}, max_frame_bytes=8000))
        self.assertEqual([m for p in pages for m in p['messages']], rows)
        for p in pages:
            self.assertLessEqual(len(k.encoded({'type': 'request', 'id': '999999999', 'method': 'sync.backfill', 'params': p})) + 1, 8000)
        with self.assertRaisesRegex(k.LocalKakaoError, '^single_record_exceeds_ipc_budget$'):
            list(k.pages([self.row(1, body='가' * 20000)], 'owner', '3', {'snapshot_sha256': 'b' * 64}))

    def test_explicit_quote_parent_and_full_native_fields_survive(self):
        columns = ['chatId', 'logId', 'authorId', 'sentAt', 'message', 'type', 'prevId', 'attachment']
        class FakeReader:
            def query(self, sql):
                if sql.startswith('PRAGMA'):
                    return iter([(i, col) for i, col in enumerate(columns)])
                if sql.startswith('SELECT chatId,type'):
                    return iter([(7, 4, 3)])
                return iter([(7, 50, 3, 10, 'quoted', 26, 49, '{"src_logId":42,"src_message":"original"}'),
                             (7, 51, 3, 11, None, 0, 50, None)])
        rows = list(k.observations(FakeReader()))
        self.assertEqual(rows[0]['id'], '50')
        self.assertEqual(rows[0]['parent_id'], '42')
        self.assertEqual(rows[0]['archive_metadata']['prevId'], 49)
        self.assertEqual(rows[0]['archive_metadata']['room_metadata'],
                         {'native_type': 4, 'active_member_count': 3})
        self.assertNotIn('parent_id', rows[1])
        self.assertEqual(rows[1]['body'], '')
        self.assertEqual(rows[1]['archive_metadata']['message'], None)

    def test_snapshot_is_private_includes_wal_and_keeps_source_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source'
            source.write_bytes(b'encrypted-main')
            wal = root / 'source-wal'
            wal.write_bytes(b'encrypted-wal')
            destination = root / 'snapshot'
            destination.mkdir(mode=0o700)
            before = [k.stamp(source), k.stamp(wal)]
            path, sizes = k.encrypted_snapshot(source, destination)
            self.assertEqual(path.read_bytes(), source.read_bytes())
            self.assertEqual(Path(str(path) + '-wal').read_bytes(), wal.read_bytes())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(before, [k.stamp(source), k.stamp(wal)])
            self.assertEqual(sizes, {'main_bytes': 14, 'wal_bytes': 13})
            initial = k.snapshot_hash(path)
            Path(str(path) + '-wal').write_bytes(b'changed')
            self.assertNotEqual(initial, k.snapshot_hash(path))

    def test_unstable_encrypted_source_is_rejected(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source'
            source.write_bytes(b'opaque')
            destination = root / 'snapshot'
            destination.mkdir()
            sequence = iter([(1, 6, i) if j % 2 == 0 else None for i in range(6) for j in range(2)])
            with patch.object(k, 'stamp', side_effect=lambda path: next(sequence)):
                with self.assertRaisesRegex(k.LocalKakaoError, '^source_changed_during_snapshot$'):
                    k.encrypted_snapshot(source, destination)

    def test_baseline_audit_detects_unchanged_changed_and_missing_without_body_artifacts(self):
        original = {'chat_id': '7', 'msg_id': '1', 'author_id': '3', 'ts': 10,
                    'body': 'private synthetic body'}
        baseline = {'messages': {json.dumps(['7', str(i)], separators=(',', ':')):
                                 k.message_digest(original) for i in (1, 2, 3)}}
        class Rpc:
            def request(self, method, params):
                if params['msg_id'] == '1':
                    return {'message': original}
                if params['msg_id'] == '2':
                    return {'message': {**original, 'ts': 11}}
                return {'message': None}
        report = k.verify_baseline(baseline, 'owner', Rpc())
        self.assertEqual(report, {'baseline_records': 3, 'unchanged': 1, 'changed': 1, 'missing': 1})
        self.assertNotIn(original['body'], json.dumps(baseline))


if __name__ == '__main__':
    unittest.main()
