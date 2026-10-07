import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import history
from review_stage import build_review_stage, validate_frozen_selection
from test_history import row, Tokenizer


class ReviewStageTests(unittest.TestCase):
    def fixture(self):
        records = [history.candidate_record(row(id='hist:'+name,
            chat={'platform':'kakao','account':'a','chat_id':name}),
            tokenizer=Tokenizer(),max_seq_length=4096) for name in ('train','valid','test')]
        snapshot = {'snapshot_hash':'snapshot','source':{'hash':'source'}}
        selection = {'snapshot_hash':'snapshot','source_hash':'source','frozen_at':1,
                     'room_splits':{},'assignments':{}}
        for name, record in zip(('train','valid','test'),records):
            if name != 'train':
                selection['room_splits'][history.source_key(record['chat'],'')] = name
                selection['assignments'][record['id']] = name
                selection[name] = {'entries':[{'id':record['id'],'hash':record['review_hash']}]}
        selection['test']['initial_review_allowlist_count']=1
        selection['freeze_hash']=history.digest(selection)
        return records,selection,snapshot

    def test_full_payload_hash_covers_timestamp_and_all_metadata(self):
        records,selection,snapshot = self.fixture()
        validate_frozen_selection(selection,snapshot)
        changed = {**selection,'frozen_at':2}
        with self.assertRaisesRegex(ValueError,'hash_mismatch'):
            validate_frozen_selection(changed,snapshot)
        with self.assertRaisesRegex(ValueError,'snapshot_mismatch'):
            validate_frozen_selection(selection,{**snapshot,'snapshot_hash':'different'})

    def test_whole_eval_rooms_reserved_before_train_grants_without_record_mutation(self):
        records,selection,snapshot = self.fixture()
        before = copy.deepcopy(records)
        stage = build_review_stage({2048:records,4096:records},{},selection,snapshot)
        self.assertEqual(records,before)
        self.assertEqual(stage['summary']['train_count'],1)
        self.assertEqual(set(stage['frozen']['heldout_chats']),set(selection['room_splits']))
        for split in ('valid','test'):
            record=stage['records'][split][0]
            self.assertTrue(all(stage['frozen']['source_keys'][key]==split for key in record['source_message_keys']))
        alias = {**records[2],'id':'send:alias'}
        stage = build_review_stage({2048:records+[alias],4096:records},{},selection,snapshot)
        self.assertNotIn('send:alias',[r['id'] for r in stage['records']['train']])

    def test_changed_eval_hash_or_room_inventory_fails_before_grants(self):
        records,selection,snapshot = self.fixture()
        changed = copy.deepcopy(records)
        changed[2]['review_hash']='changed'
        with self.assertRaisesRegex(ValueError,'eval_record_changed'):
            build_review_stage({2048:changed,4096:changed},{},selection,snapshot)
        with self.assertRaisesRegex(ValueError,'whole_room_inventory_changed'):
            build_review_stage({2048:records,4096:records+[dict(records[2],id='extra')]},{},selection,snapshot)


if __name__=='__main__':
    unittest.main()
