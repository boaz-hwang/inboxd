import copy
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from validation_holdout_protocol import digest, protocol, reserve, split_addendum, EVIDENCE_KINDS


class HoldoutScientificControls(unittest.TestCase):
    def setUp(self):
        self.frozen = protocol()
        self.hash = digest(self.frozen)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.receipt_root = pathlib.Path(self.temp.name)
        import hashlib
        self.trusted = {}
        for kind in EVIDENCE_KINDS:
            path = self.receipt_root / (kind + '.json')
            path.write_text('{"synthetic_fixture":true}')
            self.trusted[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.split = split_addendum(self.frozen, {'entries': [], 'reserved_rooms': 0}, 'synthetic-old-reservation')
        self.case = {'id': 'synthetic-case', 'chat': 'synthetic-room',
                     'room_exposure_class': 'metadata_only',
                     'actualused_source_intersection_count': 0,
                     'prior_assessed_source_intersection_count': 0,
                     'exact_duplicate_count': 0, 'near_duplicate_count': 0,
                     'old54_overlap': False, 'semantic_duplicate_status': 'clear',
                     'privacy_status': 'pass', 'input_hash': 'input',
                     'context_hash': 'context', 'source_keys_hash': 'sources',
                     'rubric_hash': 'rubric', 'behavior_class': 'visible_fact_answer',
                     'response_requirement': 'request_requires_response',
                     'whole_context_after_cutoff': False,
                     'unresolved_lineage_relevant_to_case': False,
                     'unresolved_source_count': 88,
                     'source_comparison_coverage': {'known_source_keys': 16828, 'unresolved_ids': 88},
                     'semantic_comparison_coverage': {'scope': 'synthetic_test_coverage'}}
        for key in ('all_prior_use_scan_complete', 'source_audit_verified',
                    'lineage_verified', 'preflight_ready', 'historical_target_hidden',
                    'full_input_integrity_verified', 'rubric_frozen',
                    'independent_input_review_complete'):
            self.case[key] = True

    def run_case(self, **updates):
        case = {**self.case, **updates}
        return self.run_inventory({'entries': [case]})

    def binding(self, inventory):
        manifest = {'inventory_hash': digest(inventory), 'entries': [
            {'id': row['id'], 'assertions_hash': digest(row),
             'evidence_refs': {kind: kind + '.json' for kind in EVIDENCE_KINDS}}
            for row in inventory['entries']]}
        return {'split_contract': self.split,
                'expected_split_contract_hash': digest(self.split),
                'expected_inventory_hash': digest(inventory),
                'evidence_manifest': manifest,
                'expected_evidence_manifest_hash': digest(manifest),
                'trusted_receipt_hashes': self.trusted, 'receipt_root': self.receipt_root}

    def run_inventory(self, inventory):
        return reserve(inventory, self.frozen, self.hash, **self.binding(inventory))

    def test_metadata_listing_and_old_timestamp_do_not_become_model_leakage(self):
        result = self.run_case()
        self.assertEqual(result['data_ready_count'], 1)
        self.assertEqual(result['entries'][0]['axis'], 'primary_actual_unseen_room')
        self.assertTrue(result['entries'][0]['pure_blind_room_subset'])
        self.assertEqual(result['strict_temporal_subset_count'], 0)
        self.assertFalse(result['inference_ready'])

    def test_reviewed_only_is_reported_as_familiar_not_model_used(self):
        result = self.run_case(room_exposure_class='reviewed_only')
        self.assertEqual(result['data_ready_count'], 1)
        self.assertEqual(result['entries'][0]['axis'], 'primary_actual_unseen_room')
        self.assertTrue(result['entries'][0]['prior_reviewer_familiarity'])
        self.assertFalse(result['entries'][0]['pure_blind_room_subset'])

    def test_seen_room_is_secondary_and_time_label_is_subset_only(self):
        result = self.run_case(room_exposure_class='actual_used', whole_context_after_cutoff=True)
        self.assertEqual(result['data_ready_axis_counts'], {'secondary_seen_room_unseen_episode': 1})
        self.assertEqual(result['strict_temporal_subset_count'], 1)

    def test_old_evaluation_and_source_duplicates_never_become_fresh(self):
        for updates in ({'old54_overlap': True},
                        {'actualused_source_intersection_count': 1},
                        {'prior_assessed_source_intersection_count': 1},
                        {'semantic_duplicate_status': 'duplicate'}):
            with self.subTest(updates=updates):
                self.assertEqual(self.run_case(**updates)['data_ready_count'], 0)

    def test_missing_uncertain_or_boolean_zero_evidence_does_not_pass(self):
        for updates in ({'room_exposure_class': 'unknown'},
                        {'semantic_duplicate_status': 'uncertain'},
                        {'actualused_source_intersection_count': False},
                        {'unresolved_lineage_relevant_to_case': True},
                        {'independent_input_review_complete': False},
                        {'behavior_class': None}):
            with self.subTest(updates=updates):
                self.assertEqual(self.run_case(**updates)['data_ready_count'], 0)

    def test_no_reply_cannot_inflate_warranted_answer_coverage(self):
        result = self.run_case(behavior_class='no_reply_warranted', response_requirement='no_reply_safety')
        self.assertEqual(result['data_ready_count'], 1)
        self.assertEqual(result['no_reply_data_ready_count'], 1)
        self.assertEqual(result['warranted_answer_data_ready_count'], 0)

    def test_optional_ack_and_ambiguous_question_do_not_inflate_answer_denominator(self):
        for requirement in ('optional_social_response', 'ambiguous_safety'):
            result = self.run_case(behavior_class='acknowledgement_only', response_requirement=requirement)
            self.assertEqual(result['data_ready_count'], 1)
            self.assertEqual(result['warranted_answer_data_ready_count'], 0)
        self.assertEqual(self.run_case(response_requirement=None)['data_ready_count'], 0)

    def test_changed_frozen_protocol_and_repeated_identity_are_rejected(self):
        changed = copy.deepcopy(self.frozen)
        changed['prior_evaluation'] = 'allow reuse'
        inventory = {'entries': [self.case]}
        with self.assertRaises(ValueError):
            reserve(inventory, changed, self.hash, **self.binding(inventory))
        with self.assertRaises(ValueError):
            self.run_inventory({'entries': [self.case, self.case]})

    def test_pool_changes_do_not_move_existing_room_and_old_embargo_wins(self):
        first = self.run_case()['entries'][0]['split']
        another = {**self.case, 'id': 'another-case', 'chat': 'another-room'}
        result = self.run_inventory({'entries': [another, self.case]})
        self.assertEqual(next(row['split'] for row in result['entries'] if row['id'] == self.case['id']), first)
        forced = 'final' if first == 'development' else 'development'
        self.split = split_addendum(self.frozen, {'entries': [{'chat': self.case['chat'], 'split': forced}], 'reserved_rooms': 1}, 'previous')
        self.assertEqual(self.run_case()['entries'][0]['split'], forced)

    def test_assertions_cannot_override_frozen_receipt_and_manifest(self):
        inventory = {'entries': [self.case]}
        binding = self.binding(inventory)
        changed = copy.deepcopy(inventory)
        changed['entries'][0]['privacy_status'] = 'hold'
        with self.assertRaises(ValueError):
            reserve(changed, self.frozen, self.hash, **binding)
        binding['expected_inventory_hash'] = digest(changed)
        binding['evidence_manifest']['inventory_hash'] = digest(changed)
        binding['expected_evidence_manifest_hash'] = digest(binding['evidence_manifest'])
        with self.assertRaises(ValueError):
            reserve(changed, self.frozen, self.hash, **binding)
        (self.receipt_root / 'source_duplicate_audit.json').write_text('{"tampered":true}')
        self.assertEqual(self.run_case()['data_ready_count'], 0)


if __name__ == '__main__':
    unittest.main()
