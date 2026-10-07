import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import history
import history_snapshot as snapshot
import learning_split
from test_history import row, Tokenizer


class SnapshotTests(unittest.TestCase):
    def test_persistent_read_query_only_dispatches_trajectory_list(self):
        calls = []
        class Rpc:
            def request(self, method, query):
                calls.append((method,query))
                return {'candidates': [], 'next_cursor': None}
        query = snapshot.OwnerHistoryQuery(Rpc())
        rows, omitted = history.collect(query,platform='kakao')
        self.assertEqual((rows,omitted),([],[]))
        self.assertEqual(calls,[('trajectory.list',{'history_candidates':True,'limit':25,'platform':'kakao'})])

    def test_duplicate_id_with_changed_row_is_rejected(self):
        pages = iter([{'candidates':[row()],'next_cursor':'page2'},
                      {'candidates':[row(timestamp=4)],'next_cursor':None}])
        with self.assertRaisesRegex(ValueError,'history_export_candidate_changed'):
            history.collect(lambda _:next(pages))

    def test_budget_derivation_matches_fresh_exact_record_hash(self):
        source = row()
        higher = history.candidate_record(source,tokenizer=Tokenizer(),max_seq_length=10000)
        lower = history.candidate_record(source,tokenizer=Tokenizer(),max_seq_length=50)
        derived = snapshot.with_budget([higher],50)[0]
        self.assertEqual(derived,lower)
        excluded = row(targets=[{**source['targets'][0],'content_kind':'image'}])
        higher = history.candidate_record(excluded,tokenizer=Tokenizer(),max_seq_length=10000)
        lower = history.candidate_record(excluded,tokenizer=Tokenizer(),max_seq_length=50)
        self.assertEqual(snapshot.with_budget([higher],50)[0],lower)

    def test_snapshot_detects_context_or_candidate_inventory_change(self):
        original = snapshot.source_manifest([row()],[])
        query = lambda _:{'candidates':[row()],'next_cursor':None}
        self.assertEqual(snapshot.assert_snapshot_unchanged(query,original,platforms=['kakao'])['candidate_count'],1)
        changed = row(context=[{**row()['context'][0],'body':'changed'}])
        with self.assertRaisesRegex(ValueError,'snapshot_changed'):
            snapshot.assert_snapshot_unchanged(lambda _:{'candidates':[changed],'next_cursor':None},original,platforms=['kakao'])

    def test_post_watermark_targets_are_deferred_but_missing_or_backfilled_targets_fail(self):
        original = snapshot.source_manifest([row()],[],watermark_ts=100)
        future = row(id='hist:future',timestamp=101)
        query = lambda _:{'candidates':[row(),future],'next_cursor':None}
        verified = snapshot.assert_snapshot_unchanged(query,original,platforms=['kakao'])
        self.assertEqual(verified['post_watermark_deferred_count'],1)
        self.assertEqual(verified['source_manifest_hash'],original['hash'])
        historical = row(id='hist:backfilled',timestamp=99)
        with self.assertRaisesRegex(ValueError,'historical_inventory_changed'):
            snapshot.assert_snapshot_unchanged(lambda _:{'candidates':[row(),historical],'next_cursor':None},original,platforms=['kakao'])
        with self.assertRaisesRegex(ValueError,'snapshot_changed'):
            snapshot.assert_snapshot_unchanged(lambda _:{'candidates':[],'next_cursor':None},original,platforms=['kakao'])
        with self.assertRaisesRegex(ValueError,'omissions_changed'):
            snapshot.assert_snapshot_unchanged(lambda _:{'candidates':[row()],'omitted':[{'id':'missing','reason':'candidate_too_large'}],'next_cursor':None},original,platforms=['kakao'])

    def test_snapshot_metadata_is_body_free_and_reserves_unreviewed_evaluation(self):
        old = history.candidate_record(row(),tokenizer=Tokenizer(),max_seq_length=10000)
        frozen = learning_split.freeze({}, {'train':[],'valid':[],'test':[old]})
        changed = row(context=[{**row()['context'][0],'message_id':'added'}],
                      reply_linkage={'actual_target_id':'added','model_target_id':'added'})
        records, reserved, metadata = snapshot.prepare_snapshot([changed],[],tokenizer=Tokenizer(),
            previous_partitions=frozen,budgets=(50,10000))
        self.assertEqual(reserved['source_keys'][history.source_key(changed['chat'],'added')],'test')
        encoded = json.dumps(metadata,ensure_ascii=False)
        self.assertNotIn(changed['context'][0]['body'],encoded)
        self.assertNotIn(changed['targets'][0]['body'],encoded)
        self.assertEqual(metadata['token_metrics']['10000']['eligible_for_review'],1)
        self.assertEqual(metadata['token_metrics']['50']['eligible_for_review'],0)

    def test_review_shards_require_training_boundary_and_keep_room_with_one_reviewer(self):
        first = history.candidate_record(row(),tokenizer=Tokenizer(),max_seq_length=10000)
        second = {**first,'id':'hist:other','timestamp':4}
        shards = snapshot.review_shards([first,second],{first['id']:'train',second['id']:'train'}, {},shard_count=2)
        self.assertEqual(sorted(shard['count'] for shard in shards),[0,2])
        frozen = learning_split.freeze({}, {'train':[],'valid':[],'test':[first]})
        with self.assertRaisesRegex(ValueError,'crosses_evaluation_boundary'):
            snapshot.review_shards([second],{second['id']:'train'},frozen)

    def test_native_archive_types_and_statuses_are_counted_without_relaxing_gates(self):
        context = [{**row()['context'][0], 'content_kind':'unknown',
                    'archive_source':{'type':6,'status':1,'revision':0}}]
        record = history.candidate_record(row(context=context),tokenizer=Tokenizer(),max_seq_length=10000)
        self.assertFalse(record['eligible_for_review'])
        counts = snapshot.archive_gate_contributions([record])
        self.assertEqual(counts['archive_type_unverified']['6']['held_candidate_count'],1)
        self.assertEqual(counts['archive_type_unverified']['6']['status_counts'],{'1':1})
        self.assertEqual(counts['archive_type_unverified']['6']['unique_source_messages'],1)


if __name__ == '__main__':
    unittest.main()
