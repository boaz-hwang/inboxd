"""Policy boundary checks with invented metadata; no messenger/model access."""
import copy
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fresh_eval_contract as evaluation


class FreshReservationPolicy(unittest.TestCase):
    def setUp(self):
        self.contract = evaluation.contract()
        self.exposure = {'schema': 'fresh-exposure-ledger-v1',
                         'exposed_rooms': ['old-room'], 'exposed_ids': ['old-id'],
                         'input_hashes': ['old-input'], 'cutoff_ts': 100.0}
        self.binding = {'expected_contract_hash': evaluation.digest(self.contract),
                        'expected_exposure_hash': evaluation.digest(self.exposure)}

    def row(self, identity='new', room='new-room', **overrides):
        return {'id': identity, 'chat': room, 'timestamp': 110.0,
                'context_hash': 'invented-context', 'source_keys_hash': 'invented-keys',
                'lineage_verified': True, **overrides}

    def reserve(self, rows, *, temporal=False, complete=True):
        inventory = {'schema': 'fresh-candidate-inventory-v1', 'entries': rows,
                     'exposure_scan_complete': complete}
        operation = evaluation.reserve_temporal if temporal else evaluation.reserve
        return operation(inventory, self.exposure, self.contract, **self.binding)

    def test_later_target_in_seen_room_is_not_new_room_evidence(self):
        result = self.reserve([self.row(room='old-room'), self.row('actually-new')])
        self.assertEqual(result['reserved_count'], 1)
        self.assertIn('exposed_room', result['entries'][0]['exclusion_codes'])
        self.assertTrue(result['entries'][0]['after_exposure_cutoff'])
        self.assertFalse(result['ready_for_inference'])

    def test_room_move_cannot_launder_exposed_id_or_input(self):
        result = self.reserve([self.row('old-id'),
                               self.row('copied', input_hash='old-input')])
        self.assertEqual(result['reserved_count'], 0)
        self.assertIn('exposed_id', result['entries'][0]['exclusion_codes'])
        self.assertIn('exposed_input', result['entries'][1]['exclusion_codes'])

    def test_unknown_lineage_or_incomplete_scan_never_claims_fresh(self):
        self.assertEqual(self.reserve([self.row()], complete=False)['reserved_count'], 0)
        self.assertEqual(self.reserve([self.row(lineage_verified='yes')])['reserved_count'], 0)

    def test_changed_frozen_contract_or_exposure_is_rejected(self):
        original_contract = copy.deepcopy(self.contract)
        self.contract['generation']['calls_per_case_per_model'] = 5
        with self.assertRaisesRegex(ValueError, 'frozen_contract_changed'):
            self.reserve([self.row()])
        self.contract = original_contract
        self.exposure['exposed_rooms'] = []
        with self.assertRaisesRegex(ValueError, 'frozen_exposure_ledger_changed'):
            self.reserve([self.row(room='old-room')], temporal=True)

    def test_source_proven_temporal_episode_has_separate_scope(self):
        row = self.row(room='old-room', context_all_sources_after_cutoff=True,
                       earliest_context_ts=101.0, source_intersection_count=0,
                       duplicate_violation_count=0, source_audit_verified=True)
        result = self.reserve([row], temporal=True)
        self.assertEqual(result['reserved_count'], 1)
        self.assertFalse(result['entries'][0]['new_room'])
        self.assertEqual(result['entries'][0]['holdout_axis'],
                         'unseen_temporal_episode_in_seen_room')
        self.assertFalse(result['ready_for_inference'])

    def test_temporal_target_alone_or_old_source_window_is_insufficient(self):
        self.assertEqual(self.reserve([self.row(room='old-room')], temporal=True)
                         ['reserved_count'], 0)
        row = self.row(room='old-room', context_all_sources_after_cutoff=True,
                       earliest_context_ts=99.0, source_intersection_count=0,
                       duplicate_violation_count=0, source_audit_verified=True)
        result = self.reserve([row], temporal=True)
        self.assertIn('production_context_crosses_old_source_window',
                      result['entries'][0]['exclusion_codes'])

    def test_exact_overlap_and_unknown_duplicate_proof_block_temporal(self):
        row = self.row(room='old-room', context_all_sources_after_cutoff=True,
                       earliest_context_ts=101.0, source_intersection_count=1,
                       duplicate_violation_count=None, source_audit_verified=True)
        result = self.reserve([row], temporal=True)
        self.assertEqual(result['reserved_count'], 0)
        self.assertIn('prior_source_intersection_or_proof_missing',
                      result['entries'][0]['exclusion_codes'])
        self.assertIn('prior_episode_duplicate_or_proof_missing',
                      result['entries'][0]['exclusion_codes'])

    def test_whole_room_split_and_privacy_exclusion_remain_visible(self):
        result = self.reserve([self.row('one'), self.row('two'),
                               self.row('blocked', hard_exclusion_codes=['personal_financial_account'])])
        self.assertEqual(result['entries'][0]['split'], result['entries'][1]['split'])
        self.assertEqual(result['reserved_count'], 2)
        self.assertIsNone(result['entries'][2]['split'])
        self.assertEqual(result['exclusion_counts']['personal_financial_account'], 1)


if __name__ == '__main__':
    unittest.main()
