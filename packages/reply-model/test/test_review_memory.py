import json
import os
from pathlib import Path
import socket
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import history
import history_snapshot
import learning_split
from review_memory import TrainingReviewMemory, ValidationReviewMemory, EvaluationReviewMemory, serve_review_memory
from test_history import row, Tokenizer


class ReviewMemoryTests(unittest.TestCase):
    def setup_corpus(self, *, response_budget=524288):
        record = history.candidate_record(row(),tokenizer=Tokenizer(),max_seq_length=10000)
        assignments = {record['id']:'train'}
        shards = history_snapshot.review_shards([record],assignments,{},shard_count=1)
        corpus = TrainingReviewMemory([record],shards,assignments=assignments,frozen={},
            snapshot_hash='snapshot',response_budget=response_budget)
        request = {'shard_index':0,'shard_hash':shards[0]['hash'],
                   'entries':[{'id':record['id'],'hash':record['review_hash']}]}
        return record,corpus,request

    def test_complete_exact_packet_and_body_free_audit(self):
        record,corpus,request = self.setup_corpus()
        packet = json.loads(corpus.packet(request))
        self.assertEqual(packet['cases'][0]['context'],record['context'])
        self.assertEqual(packet['cases'][0]['targets'],record['targets'])
        self.assertEqual(packet['cases'][0]['messages'],record['messages'])
        self.assertNotIn(record['targets'][0]['body'],json.dumps(corpus.audit,ensure_ascii=False))

    def test_stale_ungranted_oversized_and_modified_records_fail(self):
        record,corpus,request = self.setup_corpus()
        for changes in ({'shard_hash':'stale'},
                        {'entries':[{'id':'test:sealed','hash':'hidden'}]},
                        {'entries':request['entries'] * 11},
                        {'path':'unexpected'}):
            with self.assertRaises(ValueError):
                corpus.packet({**request,**changes})
        record['targets'][0]['body'] = 'changed'
        with self.assertRaisesRegex(ValueError,'changed_in_memory'):
            corpus.packet(request)
        _,small,request = self.setup_corpus(response_budget=1024)
        with self.assertRaisesRegex(ValueError,'over_budget_reduce_batch'):
            small.packet(request)

    def test_eval_source_is_rejected_even_if_candidate_id_and_assignment_change(self):
        record,corpus,request = self.setup_corpus()
        frozen = learning_split.freeze({}, {'train':[],'valid':[],'test':[record]})
        alias = {**record,'id':'send:other-path'}
        with self.assertRaisesRegex(ValueError,'evaluation_boundary'):
            TrainingReviewMemory([alias],[],assignments={alias['id']:'train'},frozen=frozen,snapshot_hash='hidden')

    def test_typed_validation_and_evaluation_never_relabel_original_records(self):
        for name, klass in [('valid', ValidationReviewMemory), ('test', EvaluationReviewMemory)]:
            record = history.candidate_record(row(),tokenizer=Tokenizer(),max_seq_length=10000)
            original = history.digest(record)
            assignments = {record['id']:name}
            shards = [{'index':0,'entries':[{'id':record['id'],'hash':record['review_hash']}]}]
            shards[0]['hash'] = history.digest(shards[0]['entries'])
            corpus = klass([record],shards,assignments=assignments,frozen={},snapshot_hash='snapshot')
            response = json.loads(corpus.packet({'shard_index':0,'shard_hash':shards[0]['hash'],
                                                'entries':shards[0]['entries']}))
            self.assertEqual(response['split'],name)
            self.assertEqual(history.digest(record),original)
            self.assertEqual(response['cases'][0]['targets'],record['targets'])
            with self.assertRaisesRegex(ValueError,'explicit'):
                klass([record],[],assignments={record['id']:'train'},frozen={},snapshot_hash='hidden')

    def test_owner_private_socket_fixed_operation_and_cleanup(self):
        record,corpus,request = self.setup_corpus()
        with serve_review_memory(corpus) as path:
            self.assertEqual(path.parent.stat().st_mode & 0o777,0o700)
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertEqual(path.stat().st_uid,os.getuid())
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
                client.settimeout(2)
                client.connect(str(path))
                client.sendall(json.dumps(request).encode()+b'\n')
                packet = json.loads(client.makefile('rb').readline())
                self.assertEqual(packet['cases'][0]['targets'],record['targets'])
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
                client.settimeout(2)
                client.connect(str(path))
                client.sendall(b'{"sql":"SELECT all","path":"/tmp/data"}\n')
                self.assertEqual(json.loads(client.makefile('rb').readline())['error'],'review_request_rejected')
        self.assertFalse(path.parent.exists())
        self.assertEqual(corpus.records,{})
        self.assertEqual(corpus.grants,{})


if __name__ == '__main__':
    unittest.main()
