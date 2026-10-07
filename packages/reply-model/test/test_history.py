import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import history as h

CHAT = {'platform': 'kakao', 'account': 'a', 'chat_id': 'c'}


def row(**changes):
    value = {'id': 'hist:1', 'source': 'history', 'chat': CHAT, 'timestamp': 3,
             'room_type_state':'verified_direct',
             'context': [{'message_id':'m1','author_role':'other','author_id':'them','ts':1,'body':'직접 만드셨어요?'}],
             'targets': [{'message_id':'m2','author_role':'self','ts':3,'body':'네, 직접 만들었어요.', 'authorship':'manual', 'edit_state':'verified_unchanged'}],
             'reply_linkage': {'actual_target_id':'m1','model_target_id':'m1'},
             'unseen_state':'unknown', 'incoming_message_ids':None,
             'context_edit_state':'verified_unchanged', 'coverage':'verified',
             'authorship':'manual', 'versions':{'extract':'v1'}}
    value.update(changes)
    return value


class Tokenizer:
    def apply_chat_template(self, messages, **kwargs):
        self.last_enable_thinking = kwargs.get('enable_thinking')
        return list(range(sum(len(x['content']) for x in messages)))

    def encode(self, text, **kwargs):
        return list(text)


class HistoryTest(unittest.TestCase):
    def test_native_explicit_parent_mismatch_holds_context_and_later_grouped_targets(self):
        original = row()
        for changes in ({'context':[{**original['context'][0], 'archive_source':{'parent_id':'missing','type':26}}]},
                        {'targets':[original['targets'][0], {**original['targets'][0],
                            'message_id':'later','ts':4,'archive_source':{'parent_id':'m1','type':26}}]},
                        {'flags':{'archive_linkage_unrecoverable':True}}):
            held = h.candidate_record(row(**changes),tokenizer=Tokenizer(),max_seq_length=10000)
            self.assertFalse(held['eligible_for_review'])
            self.assertIn('archive_linkage_unrecoverable',held['reasons'])
        matching = h.candidate_record(row(targets=[{**original['targets'][0],
            'reply_to':'m1','archive_source':{'parent_id':'m1','type':26}}]),tokenizer=Tokenizer(),max_seq_length=10000)
        self.assertNotIn('archive_linkage_unrecoverable',matching['reasons'])
        scope_mismatch = h.candidate_record(row(targets=[{**original['targets'][0],
            'reply_to':'m1','archive_source':{'parent_id':'m1','type':26,'linkage_unrecoverable':True}}]),
            tokenizer=Tokenizer(),max_seq_length=10000)
        self.assertIn('archive_linkage_unrecoverable',scope_mismatch['reasons'])
        later = row(id='hist:later',timestamp=4,
            context=original['context']+[original['targets'][0]],
            targets=[{**original['targets'][0], 'message_id':'m3','ts':4,
                      'archive_source':{'parent_id':'m1','type':26}}],
            flags={'archive_linkage_unrecoverable':True})
        grouped, _ = h.prepare_candidates([original,later],tokenizer=Tokenizer(),max_seq_length=10000,
                                          gap_policy={'kakao':64})
        self.assertEqual(len(grouped),1)
        self.assertEqual(len(grouped[0]['targets']),2)
        self.assertIn('archive_linkage_unrecoverable',grouped[0]['reasons'])
        self.assertFalse(grouped[0]['eligible_for_review'])

    def test_unknown_room_recipient_requires_review_even_with_two_observed_authors(self):
        unknown = h.candidate_record(row(room_type_state=None,author_count=2),tokenizer=Tokenizer(),max_seq_length=10000)
        self.assertEqual(unknown['room_type_state'],'unknown')
        self.assertTrue(unknown['eligible_for_review'])
        self.assertIn('room_kind_unverified',unknown['reasons'])
        explicit = h.candidate_record(row(room_type_state=None,reply_linkage={
            'kind':'explicit_reply','actual_target_id':'m1','model_target_id':'m1'}),tokenizer=Tokenizer(),max_seq_length=10000)
        self.assertNotIn('room_kind_unverified',explicit['reasons'])
        self.assertNotEqual(unknown['review_hash'],explicit['review_hash'])
        known_group = h.candidate_record(row(room_type_state='verified_group'),tokenizer=Tokenizer(),max_seq_length=10000)
        self.assertIn('group_without_explicit_reply',known_group['reasons'])
        self.assertNotIn('room_kind_unverified',known_group['reasons'])

    def test_explicit_all_platforms_includes_slack_and_default_does_not(self):
        self.assertEqual(h.selected_platforms(), ('kakao','telegram'))
        self.assertEqual(h.selected_platforms(['all']), ('kakao','telegram','slack'))
        self.assertEqual(h.selected_platforms(['slack','kakao','slack']), ('slack','kakao'))

    def test_review_queue_has_hashes_without_bodies_and_marks_stale(self):
        record = h.candidate_record(row(), tokenizer=Tokenizer(), max_seq_length=10000)
        manifest = h.review_manifest([record], {record['id']:{'hash':'old','decision':'approve'}})
        serialized = json.dumps(manifest,ensure_ascii=False)
        self.assertNotIn(row()['targets'][0]['body'],serialized)
        self.assertNotIn(row()['context'][0]['body'],serialized)
        self.assertEqual(manifest['entries'][0]['review_state'],'stale')
        self.assertEqual(manifest['entries'][0]['input_hash'],h.digest(record['messages'][:-1]))

    def test_delegated_batch_is_atomic_hash_bound_and_requires_explicit_warning_ack(self):
        record = h.candidate_record(row(authorship='unknown'),tokenizer=Tokenizer(),max_seq_length=10000)
        decision = {'id':record['id'],'hash':record['review_hash'],'decision':'approve',
                    'rationale_codes':['supported_reaction'],'acknowledged_reasons':['authorship_unknown']}
        original = {'untouched':{'hash':'prior','decision':'approve'}}
        result = h.apply_review_batch([record],original,[decision],delegation_ref='user_delegation_20261003')
        self.assertEqual(result[record['id']]['review_provenance'],'agent_delegated')
        self.assertEqual(result[record['id']]['behavior_category'],'unknown')
        categorized = h.apply_review_batch([record],{},[{**decision,
            'behavior_category':'existing_decision_or_refusal'}],delegation_ref='user_delegation_20261003')
        self.assertEqual(categorized[record['id']]['behavior_category'],'existing_decision_or_refusal')
        self.assertNotIn(record['id'],original)
        with self.assertRaisesRegex(ValueError,'invalid_review_behavior_category'):
            h.apply_review_batch([record],original,[{**decision,'behavior_category':'invented'}],
                                 delegation_ref='user_delegation_20261003')
        with self.assertRaisesRegex(ValueError,'stale_review_hash'):
            h.apply_review_batch([record],original,[{**decision,'hash':'stale'}],delegation_ref='user_delegation_20261003')
        with self.assertRaisesRegex(ValueError,'review_warnings'):
            h.apply_review_batch([record],original,[{**decision,'acknowledged_reasons':[]}],delegation_ref='user_delegation_20261003')

    def test_cursor_pagination_and_retry_dedup(self):
        pages = [{'candidates':[row()], 'omitted':[], 'next_cursor':'opaque'},
                 {'candidates':[row(), row(id='hist:2')], 'omitted':[], 'next_cursor':None}]
        with patch.object(h.subprocess, 'run', side_effect=[SimpleNamespace(returncode=0, stdout=json.dumps(p)) for p in pages]) as call:
            rows, omitted = h.collect('/inboxd', platform='kakao')
        self.assertEqual([x['id'] for x in rows], ['hist:1', 'hist:2'])
        self.assertEqual(json.loads(call.call_args.args[0][-1])['cursor'], 'opaque')
        self.assertEqual(omitted, [])

    def test_model_input_preserves_body_and_unknown_unseen(self):
        record = h.candidate_record(row(), tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertEqual(record['messages'][-1]['content'], '네, 직접 만들었어요.')
        self.assertEqual(record['status'], 'candidate')
        self.assertEqual(record['source_message_keys'], [h.source_key(CHAT,'m1'),h.source_key(CHAT,'m2')])
        metadata = json.loads(record['messages'][0]['content'].split('메타데이터: ', 1)[1])
        self.assertIsNone(metadata['turn_metadata'][0][metadata['turn_fields'].index('unseen')])
        self.assertEqual(record['target_source_keys'], [h.source_key(CHAT,'m2')])

    def test_target_mismatch_and_future_context_hold(self):
        a = h.candidate_record(row(reply_linkage={'actual_target_id':'other','model_target_id':'m1'}), tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertIn('reply_target_mismatch', a['reasons'])
        b = h.candidate_record(row(context=[{'message_id':'m1','author_role':'other','ts':4,'body':'future'}]), tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertIn('preflight_not_ready', b['reasons'])

    def test_archive_placeholders_are_not_learned_as_written_replies(self):
        for kind in ('media', 'deleted', 'unknown'):
            target = {**row()['targets'][0], 'content_kind':kind,
                      'body':'[삭제 상태 메시지: 원문 미확인]'}
            record = h.candidate_record(row(targets=[target]),
                tokenizer=Tokenizer(), max_seq_length=10000)
            self.assertEqual(record['status'], 'exclude')
            self.assertIn('non_text_target', record['reasons'])
        literal = {**target, 'content_kind':'text'}
        record = h.candidate_record(row(targets=[literal]),
            tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertTrue(record['eligible_for_review'])

    def test_unrecoverable_archive_context_cannot_be_approved(self):
        for kind, reason in (('deleted','archive_deleted_context_unrecoverable'),
                             ('unknown','archive_type_unverified')):
            context = [{**row()['context'][0], 'content_kind':kind}]
            record = h.candidate_record(row(context=context),
                tokenizer=Tokenizer(), max_seq_length=10000)
            self.assertIn(reason, record['reasons'])
            self.assertFalse(record['eligible_for_review'])
            review = {record['id']:{'hash':record['review_hash'], 'decision':'approve',
                                    'acknowledged_reasons':record['reasons']}}
            self.assertEqual(h.reviewed_records([record], review), [])
        for reason in h.ARCHIVE_HARD_REASONS:
            record = h.candidate_record(row(flags={reason:True}),
                tokenizer=Tokenizer(), max_seq_length=10000)
            self.assertIn(reason, record['reasons'])
            self.assertFalse(record['eligible_for_review'])
        media = [{**row()['context'][0], 'content_kind':'media'}]
        record = h.candidate_record(row(context=media),
            tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertIn('external_content_likely', record['reasons'])
        self.assertTrue(record['eligible_for_review'])

    def test_later_grouped_target_revision_retains_hard_hold(self):
        first = row()
        second = row(id='hist:2', timestamp=4,
            context=[*first['context'], {**first['targets'][0], 'author_role':'self'}],
            targets=[{**first['targets'][0], 'message_id':'m3','ts':4,
                      'body':'덧붙여요.', 'archive_source':{'revision':1}}],
            flags={'archive_revision_unrecoverable':True})
        records, _ = h.prepare_candidates([first, second], tokenizer=Tokenizer(),
            max_seq_length=10000, gap_policy={'kakao':2})
        self.assertEqual(len(records), 1)
        self.assertEqual(len(records[0]['targets']), 2)
        self.assertIn('archive_revision_unrecoverable', records[0]['reasons'])
        self.assertFalse(records[0]['eligible_for_review'])

    def test_per_target_session_duplicate_and_unchanged_suggestion(self):
        duplicate = {'target_source_keys':[h.source_key(CHAT,'m2')], 'source_message_keys':[h.source_key(CHAT,'m1')]}
        records, rejected = h.prepare_candidates([row()], [duplicate], tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertEqual(records[0]['status'], 'exclude')
        self.assertIn('duplicate_of_session_candidate', rejected[0]['reasons'])
        self.assertEqual(rejected[0]['source_message_keys'], [h.source_key(CHAT,'m2')])
        records, _ = h.prepare_candidates([row()], [{**duplicate,'reason':'unchanged_model_suggestion'}], tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertIn('unchanged_model_suggestion', records[0]['reasons'])
        other = {'target_source_keys':[h.source_key(CHAT,'different')], 'source_message_keys':[h.source_key(CHAT,'m2')]}
        records, _ = h.prepare_candidates([row()], [other], tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertEqual(records[0]['status'], 'candidate')

    def test_storage_export_shape_and_raw_session_suggestion(self):
        """Matches historical_candidate/training_candidates JSON from responses.rs."""
        producer = row(id='hist:' + h.source_key(CHAT,'m2'),
            targets=[{'message_id':'m2','ts':3.0,'body':'네, 직접 만들었어요.',
                      'reply_to':None,'authorship':{'state':'unknown','session_id':None}}],
            source_message_keys=[h.source_key(CHAT,'m1'),h.source_key(CHAT,'m2')],
            context_edit_state={'state':'unknown'},
            coverage={'state':'partial_evidence','ranges':[{'from_ts':1,'to_ts':3}], 'limits':[]},
            authorship={'state':'unknown','session_id':None,'receipt_state':None},
            flags={'tied_timestamp':False,'self_identity_unknown':False,
                   'reply_target_mismatch':False,'context_edited_after_target':False,
                   'coverage_unverified':False,'authorship_unknown':True,
                   'group_without_explicit_reply':False})
        record = h.candidate_record(producer, tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertTrue(record['eligible_for_review'])
        self.assertEqual(set(record['reasons']), {'context_edit_unknown','coverage_unverified','authorship_unknown','target_edit_unknown'})
        session = {'outcome':'sent','send_state':'Verified','inserted':True,
                   'final_text':'네, 직접 만들었어요.','suggested_text':'네, 직접 만들었어요.',
                   'source_message_keys':[h.source_key(CHAT,'m1'),h.source_key(CHAT,'m2')],
                   'sent_message_keys':[h.source_key(CHAT,'m2')],
                   'target_source_keys':[h.source_key(CHAT,'m2')], 'chat':CHAT}
        records, rejected = h.prepare_candidates([producer], [session],
            tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertIn('unchanged_model_suggestion', records[0]['reasons'])
        self.assertEqual(rejected[0]['source_message_keys'], [h.source_key(CHAT,'m2')])

    def test_actual_token_budgets_and_no_truncated_target(self):
        r = h.candidate_record(row(), tokenizer=Tokenizer(), max_seq_length=5, generation_limit=4)
        self.assertIn('over_token_budget', r['reasons'])
        self.assertIn('target_exceeds_generation_limit', r['reasons'])
        self.assertEqual(r['messages'][-1]['content'], '네, 직접 만들었어요.')

    def test_training_template_prefix_and_producer_hard_flags(self):
        class BrokenTokenizer(Tokenizer):
            def apply_chat_template(self, messages, **kwargs):
                values = super().apply_chat_template(messages, **kwargs)
                return [999] + values if kwargs.get('add_generation_prompt') else values
        broken = h.candidate_record(row(), tokenizer=BrokenTokenizer(), max_seq_length=10000)
        self.assertIn('training_prefix_mismatch', broken['reasons'])
        self.assertFalse(broken['eligible_for_review'])
        flagged = h.candidate_record(row(flags={'tied_timestamp':True,
              'context_edited_after_target':True, 'context_deleted_after_target':True,
              'reply_target_mismatch':True},
              coverage={'state':'partial_evidence','limits':[{'reason':'gap'}]},
              targets=[{**row()['targets'][0], 'edit_state':'edited_after_target'}]),
              tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertFalse(flagged['eligible_for_review'])
        for reason in ('preflight_not_ready','context_edited_after_target',
                       'context_deleted_after_target','reply_target_mismatch',
                       'coverage_limit_active','target_edited_after_send'):
            self.assertIn(reason, flagged['reasons'])

    def test_installed_qwen_tokenizer_masks_only_final_reply(self):
        model = Path.home()/'.inboxd/reply-model/models/Qwen3.5-9B-4bit'
        if not model.is_dir():
            self.skipTest('local Qwen model not installed')
        try:
            from mlx_lm.utils import load_tokenizer
        except ImportError:
            self.skipTest('MLX tokenizer unavailable')
        tokenizer = load_tokenizer(model)
        record = h.candidate_record(row(), tokenizer=tokenizer, max_seq_length=2048)
        full = tokenizer.apply_chat_template(record['messages'], return_dict=False,
                                             enable_thinking=False)
        prefix = tokenizer.apply_chat_template(record['messages'][:-1],
            add_generation_prompt=True, return_dict=False, enable_thinking=False)
        self.assertEqual(full[:len(prefix)], prefix)
        self.assertIn(record['messages'][-1]['content'], tokenizer.decode(full[len(prefix):]))
        self.assertEqual(record['input_tokens'], len(prefix))
        self.assertEqual(record['total_tokens'], len(full))
        self.assertNotIn('training_prefix_mismatch', record['reasons'])

    def test_reviewable_unknowns_require_explicit_acknowledgement(self):
        r = h.candidate_record(row(context_edit_state='unknown', coverage={'state':'unverified'},
                                   authorship={'state':'unknown'}), tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertEqual(r['status'], 'hold')
        self.assertTrue(r['eligible_for_review'])
        review = {r['id']:{'hash':r['review_hash'],'decision':'approve',
                           'acknowledged_reasons':r['reasons']}}
        self.assertEqual(len(h.reviewed_records([r], review)), 1)
        review[r['id']]['acknowledged_reasons'] = []
        self.assertEqual(h.reviewed_records([r], review), [])

    def test_adjacent_turn_grouping_and_partial_session_overlap(self):
        first = row()
        second = row(id='hist:2', timestamp=4,
            context=[*first['context'], {'message_id':'m2','author_role':'self','ts':3,'body':'네, 직접 만들었어요.'}],
            targets=[{'message_id':'m3','ts':4,'body':'ㅎㅎ', 'authorship':'manual'}],
            source_message_keys=[h.source_key(CHAT, mid) for mid in ('m1','m2','m3')])
        turns, _ = h.group_turns([first,second], {'kakao':2})
        self.assertEqual(len(turns), 1)
        self.assertEqual([x['message_id'] for x in turns[0]['targets']], ['m2','m3'])
        records, _ = h.prepare_candidates([first,second],
            [{'target_source_keys':[h.source_key(CHAT,'m3')]}],
            tokenizer=Tokenizer(), max_seq_length=10000, gap_policy={'kakao':2})
        self.assertEqual(len(records), 1)
        self.assertIn('partial_session_overlap', records[0]['reasons'])
        self.assertIn('multi_message_turn', records[0]['reasons'])
        self.assertFalse(records[0]['eligible_for_review'])

    def test_provisional_gap_rule_keeps_long_outlier_separate(self):
        first = row()
        second = row(id='hist:long', timestamp=4003,
            context=[*first['context'], {**first['targets'][0], 'author_role':'self'}],
            targets=[{'message_id':'m3','ts':4003,'body':'새 이야기입니다.',
                      'authorship':'manual','edit_state':'verified_unchanged'}])
        turns, thresholds = h.group_turns([first,second])
        self.assertEqual(len(turns), 2)
        self.assertLessEqual(thresholds['kakao'], h.PROVISIONAL_MAX_TURN_GAP_SECONDS)
        report = h.report([], raw_rows=[first, second])
        self.assertTrue(report['turn_gap_policy']['provisional'])
        self.assertEqual(report['turn_gap_policy']['selected_seconds'], thresholds)
        base, _ = h.prepare_candidates([first], tokenizer=Tokenizer(), max_seq_length=10000)
        adjusted, _ = h.prepare_candidates([first], tokenizer=Tokenizer(), max_seq_length=10000,
                                           gap_policy={'kakao':30})
        self.assertNotEqual(base[0]['review_hash'], adjusted[0]['review_hash'])

    def test_hash_bound_review_and_metadata_only_reports(self):
        r = h.candidate_record(row(), tokenizer=Tokenizer(), max_seq_length=10000)
        approved = {r['id']:{'hash':r['review_hash'],'decision':'approve'}}
        self.assertEqual(len(h.reviewed_records([r], approved)), 1)
        changed = h.candidate_record(row(targets=[{'message_id':'m2','ts':3,'body':'수정됨'}]), tokenizer=Tokenizer(), max_seq_length=10000)
        self.assertEqual(h.reviewed_records([changed], approved), [])
        report = h.report([r])
        self.assertNotIn('직접 만드셨어요', json.dumps(report, ensure_ascii=False))
        manifest = h.sample([r])
        self.assertEqual(manifest[0]['hash'], r['review_hash'])
        self.assertNotIn('직접 만드셨어요', json.dumps(manifest, ensure_ascii=False))


class ProductionLinkageTest(unittest.TestCase):
    def record(self):
        # Exact linkage vocabulary emitted by historical_candidate in Rust.
        return h.candidate_record(row(reply_linkage={
            'kind': 'adjacent_turn', 'actual_target_id': 'm1',
            'model_target_id': 'm1', 'group_without_explicit_reply': False}),
            tokenizer=Tokenizer(), max_seq_length=10000)

    def test_reviewed_production_adjacent_turn_reaches_training(self):
        from personalization import prepare_examples
        candidate = self.record()
        self.assertEqual(candidate['linkage'], 'temporal_reply')
        self.assertEqual(candidate['reply_linkage']['kind'], 'adjacent_turn')
        reviews = {candidate['id']: {'hash': candidate['review_hash'], 'decision': 'approve'}}
        approved = h.reviewed_records([candidate], reviews)
        splits, manifest = prepare_examples(approved, assignments={candidate['id']: 'train'})
        self.assertEqual(len(splits['train']), 1)
        self.assertEqual(manifest['rejected'], [])

    def test_adjacency_does_not_bypass_review_target_or_time_gates(self):
        from personalization import prepare_examples
        candidate = self.record()
        splits, manifest = prepare_examples([candidate], assignments={candidate['id']: 'train'})
        self.assertEqual(len(splits['train']), 0)
        self.assertEqual(manifest['rejected'][0]['reason'], 'unreviewed_or_not_self')
        for changes, reason in (
            ({'reply_linkage': {'kind': 'adjacent_turn', 'actual_target_id': 'different',
                               'model_target_id': 'm1'}}, 'reply_target_mismatch'),
            ({'context': [{'message_id': 'm1', 'author_role': 'other', 'author_id': 'them',
                          'ts': 4, 'body': 'future'}]}, 'preflight_not_ready')):
            value = row(**changes)
            if 'reply_linkage' not in changes:
                value['reply_linkage']['kind'] = 'adjacent_turn'
            held = h.candidate_record(value, tokenizer=Tokenizer(), max_seq_length=10000)
            self.assertIn(reason, held['reasons'])
            self.assertFalse(held['eligible_for_review'])
            reviews = {held['id']: {'hash': held['review_hash'], 'decision': 'approve',
                                   'acknowledged_reasons': held['reasons']}}
            self.assertEqual(h.reviewed_records([held], reviews), [])


if __name__ == '__main__':
    unittest.main()
