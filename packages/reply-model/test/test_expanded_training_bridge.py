import copy
import hashlib
import json
import tempfile
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import expanded_training_bridge as bridge
import history as h
import history_snapshot as snapshot_tools
import personalization as p
from test_history import row, Tokenizer


class ScopedReconstruction(unittest.TestCase):
    def fixture(self):
        rows = []
        for room, target, timestamp in (('train', 'm2', 3), ('train', 'm4', 5), ('valid', 'm6', 7), ('sealed', 'm8', 9)):
            chat = {'platform': 'kakao', 'account': 'a', 'chat_id': room}
            original = row()
            rows.append(row(id='hist:' + h.source_key(chat, target), chat=chat, timestamp=timestamp,
                targets=[{**original['targets'][0], 'message_id': target, 'ts': timestamp}]))
        policy = {'kakao': 64, 'telegram': 115, 'slack': 300}
        snapshot = {'source': snapshot_tools.source_manifest(rows, [], watermark_ts=10),
                    'gap_policy_seconds': policy}
        snapshot['snapshot_hash'] = h.digest(snapshot)
        records, _ = h.prepare_candidates(rows, tokenizer=Tokenizer(), max_seq_length=4096, gap_policy=policy)
        by_id = {record['id']: record for record in records}
        entries = []
        for record, split in ((by_id[rows[0]['id']], 'train'), (by_id[rows[2]['id']], 'valid'), (by_id[rows[3]['id']], 'test')):
            if split == 'train': record = snapshot_tools.with_budget([record], 2048)[0]
            entries.append({'id': record['id'], 'split': split, 'review_hash': record['review_hash'],
                            'example_hash': p.digest({**record, 'reviewed': True})})
        manifest = {'version': 1, 'records': entries, 'source': {'snapshot_hash': snapshot['snapshot_hash']},
                    'reservations': {'source_keys': {}, 'evaluation_target_keys': {h.source_key(rows[3]['chat'], 'm8'): 'test'}}}
        self.seal(manifest)
        return rows, snapshot, manifest

    def seal(self, manifest):
        manifest['manifest_id'] = p.digest({k: v for k, v in manifest.items() if k != 'manifest_id'})

    def query(self, rows, calls):
        def request(query):
            calls.append(query)
            return {'candidates': [copy.deepcopy(r) for r in rows if r['chat']['chat_id'] == query['chat_id']],
                    'omitted': [], 'next_cursor': None}
        return request

    def test_exact_approved_inputs_without_any_sealed_room_request(self):
        rows, snapshot, manifest = self.fixture(); calls = []
        newer = copy.deepcopy(rows[1]); newer.update(id='hist:' + h.source_key(newer['chat'], 'newer'), timestamp=11)
        records, evidence = bridge.reconstruct_approved_history(self.query(rows + [newer], calls), snapshot, manifest, Tokenizer())
        self.assertEqual({q['chat_id'] for q in calls}, {'train', 'valid'})
        self.assertEqual(len(records), 2)
        self.assertEqual([p.digest(r) for r in records], [e['example_hash'] for e in manifest['records'][:2]])
        self.assertEqual(evidence['scoped_raw_records_verified'], 3)
        self.assertEqual(evidence['newer_targets_deferred'], 1)
        self.assertEqual(evidence['final_rooms_requested'], 0)

    def test_final_source_overlap_refused_before_first_owner_read(self):
        rows, snapshot, manifest = self.fixture(); calls = []
        manifest['reservations']['source_keys'][h.source_key(rows[0]['chat'], 'm1')] = 'test'; self.seal(manifest)
        with self.assertRaisesRegex(ValueError, 'sealed_final_room'):
            bridge.reconstruct_approved_history(self.query(rows, calls), snapshot, manifest, Tokenizer())
        self.assertEqual(calls, [])

    def test_only_frozen_observed_room_exception_preserves_source_boundary(self):
        rows, snapshot, manifest = self.fixture()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp).resolve() / 'observed-manifest.json'
            old_key = h.source_key(rows[0]['chat'], 'old-observed-target')
            path.write_text(json.dumps({'splits': {'test': [{'id': 'hist:' + old_key, 'provenance_refs': [old_key]}]}}))
            path.chmod(0o600)
            manifest['reservations']['source_keys'][old_key] = 'test'
            manifest['source']['selected_test_allowlist_hash'] = 'a' * 64
            exception = {'version': 1, 'authorization': 'root_explicit_observed_temporal_exception',
                'room_key': h.source_key(rows[0]['chat'], ''),
                'existing_observed_manifest_path': str(path),
                'existing_observed_manifest_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'fresh_final_room_keys': [h.source_key(rows[3]['chat'], '')],
                'selected_test_allowlist_hash': 'a' * 64}
            exception['exception_hash'] = h.digest(exception)
            manifest['source']['observed_room_reconstruction_exception'] = exception
            self.seal(manifest)
            admitted, evidence = bridge.reconstruct_approved_history(self.query(rows, []), snapshot, manifest, Tokenizer())
            self.assertEqual(len(admitted), 2)
            self.assertEqual(evidence['observed_temporal_exception_room_count'], 1)
            # Same-room permission cannot permit a heldout source in the actual input.
            conflict = copy.deepcopy(manifest)
            conflict['reservations']['source_keys'][h.source_key(rows[0]['chat'], 'm1')] = 'test'
            self.seal(conflict)
            with self.assertRaisesRegex(ValueError, 'source_interval_boundary'):
                bridge.reconstruct_approved_history(self.query(rows, []), snapshot, conflict, Tokenizer())
            # A fresh sealed room can never receive this exception.
            exception['fresh_final_room_keys'].append(exception['room_key'])
            exception['exception_hash'] = h.digest({k: v for k, v in exception.items() if k != 'exception_hash'})
            self.seal(manifest); calls = []
            with self.assertRaisesRegex(ValueError, 'sealed_final_room_exception_forbidden'):
                bridge.reconstruct_approved_history(self.query(rows, calls), snapshot, manifest, Tokenizer())
            self.assertEqual(calls, [])

    def test_missing_or_changed_unapproved_raw_row_blocks_reconstruction(self):
        rows, snapshot, manifest = self.fixture()
        changed = copy.deepcopy(rows); changed[1]['targets'][0]['body'] += ' changed'
        for observed in (changed, rows[:1] + rows[2:]):
            with self.assertRaisesRegex(ValueError, 'frozen_raw_record_(changed|missing)'):
                bridge.reconstruct_approved_history(self.query(observed, []), snapshot, manifest, Tokenizer())

    def test_exact_review_and_example_hashes_are_both_mandatory(self):
        rows, snapshot, manifest = self.fixture()
        for key, error in (('review_hash', 'review_changed'), ('example_hash', 'example_changed')):
            changed = copy.deepcopy(manifest); changed['records'][0][key] = 'changed'; self.seal(changed)
            with self.assertRaisesRegex(ValueError, error):
                bridge.reconstruct_approved_history(self.query(rows, []), snapshot, changed, Tokenizer())

    def test_cpu_draft_freeze_binds_complete_records_without_body_files(self):
        rows, snapshot, manifest = self.fixture()
        draft = copy.deepcopy(manifest); draft.pop('manifest_id')
        draft['version'] = 'approved-history-draft-v1'
        quarantine = {'source_keys': [], 'values_retained': False}
        draft['source']['sensitive_source_quarantine'] = {**quarantine, 'quarantine_hash': h.digest(quarantine)}
        for entry in draft['records']:
            entry.pop('example_hash')
            if entry['split'] != 'test': entry['decision'] = 'approve'
        proof = {'grant_hashes': ['a' * 64], 'decisions': [
            {'id': entry['id'], 'hash': entry['review_hash'], 'decision': 'approve',
             'review_provenance': 'agent_delegated', 'delegation_ref': 'explicit_owner_authorization',
             'rationale_codes': ['grounded_context'], 'behavior_category': 'grounded_information',
             'acknowledged_reasons': []} for entry in draft['records'] if entry['split'] != 'test']}
        proof['manifest_hash'] = h.digest(proof)
        draft['source']['review_decision_manifest'] = proof
        draft['draft_hash'] = h.digest(draft)
        records, entries, evidence = bridge.freeze_approved_history(self.query(rows, []), snapshot, draft, Tokenizer())
        self.assertEqual(entries, manifest['records'][:2])
        self.assertEqual(len(records), 2)
        self.assertFalse(evidence['gpu_started'])
        self.assertFalse(evidence['corpus_written'])
        approved_draft = copy.deepcopy(draft)
        calls = []; draft['records'][0]['decision'] = 'hold'
        draft['draft_hash'] = h.digest({k: v for k, v in draft.items() if k != 'draft_hash'})
        with self.assertRaisesRegex(ValueError, 'independent_approval_required'):
            bridge.freeze_approved_history(self.query(rows, calls), snapshot, draft, Tokenizer())
        self.assertEqual(calls, [])
        # A re-sealed draft is still insufficient without the original
        # delegated decision export and exact warning acknowledgments.
        draft = copy.deepcopy(approved_draft)
        draft['source']['review_decision_manifest']['decisions'][0]['review_provenance'] = 'human'
        proof = draft['source']['review_decision_manifest']
        proof['manifest_hash'] = h.digest({k: v for k, v in proof.items() if k != 'manifest_hash'})
        draft['draft_hash'] = h.digest({k: v for k, v in draft.items() if k != 'draft_hash'})
        with self.assertRaisesRegex(ValueError, 'immutable_delegated_approval_required'):
            bridge.freeze_approved_history(self.query(rows, calls), snapshot, draft, Tokenizer())
        self.assertEqual(calls, [])
        draft = copy.deepcopy(approved_draft)
        proof = draft['source']['review_decision_manifest']
        proof['decisions'][0]['acknowledged_reasons'] = ['coverage_unverified']
        proof['manifest_hash'] = h.digest({k: v for k, v in proof.items() if k != 'manifest_hash'})
        draft['draft_hash'] = h.digest({k: v for k, v in draft.items() if k != 'draft_hash'})
        with self.assertRaisesRegex(ValueError, 'warnings_must_be_acknowledged'):
            bridge.freeze_approved_history(self.query(rows, []), snapshot, draft, Tokenizer())


if __name__ == '__main__':
    unittest.main()
