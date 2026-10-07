import json
import fcntl
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import learning_split as s
import learning_evaluation as e
import personalization as p


def record(id, chat, timestamp, *, context_time=None, context_id=None, target=None, duplicate=None):
    context_time = timestamp - 1 if context_time is None else context_time
    context_id = context_id or f'c-{id}'
    target = target or f't-{id}'
    location = {'platform':'kakao','account':'owner','chat_id':chat}
    return {'id': id, 'chat':location, 'conversation_id':chat, 'timestamp':timestamp,
            'reviewed':True, 'linkage':'explicit_reply','target_role':'self',
            'target_message_id':target, 'context_message_ids':[context_id],
            'context_timestamps':[context_time], 'provenance_refs':[target],
            'source_message_keys':[s.key('kakao','owner',chat,context_id), s.key('kakao','owner',chat,target)],
            'target_source_keys':[s.key('kakao','owner',chat,target)],
            'duplicate_group':duplicate,
            'messages':[{'role':'user','content':f'question {id}'},{'role':'assistant','content':'감사합니다'}]}


class SplitTests(unittest.TestCase):
    def test_same_short_answer_in_independent_contexts_is_allowed(self):
        rows=[record('a','one',10),record('b','two',20),record('c','three',30)]
        splits,manifest=p.prepare_examples(rows,assignments={'a':'train','b':'valid','c':'test'})
        self.assertEqual([len(splits[n]) for n in s.NAMES],[1,1,1])
        self.assertEqual(manifest['rejected'],[])

    def test_cross_boundary_source_and_interval_only_drop_conflicts(self):
        rows=[record('far','one',1,context_time=0),
              record('train','one',10,context_time=8),
              record('test','one',20,context_time=9),
              record('other','two',11)]
        splits,rejected=s.partition(rows,assignments={'train':'train','test':'test','far':'train','other':'train'})
        self.assertEqual([r['id'] for r in splits['train']],['far','other'])
        self.assertEqual([r['id'] for r in rejected],['train'])

    def test_frozen_source_interval_duplicate_and_whole_chat(self):
        test=record('hist:one','heldout',20,context_time=10,duplicate='same-send')
        frozen=s.freeze({}, {'train':[],'valid':[],'test':[test]})
        rows=[record('send:one','heldout',25,context_time=24,target='t-hist:one'),
              record('overlap','heldout',21,context_time=15),
              record('duplicate','elsewhere',50000,duplicate='same-send'),
              record('safe','elsewhere',60000)]
        splits,rejected=s.partition(rows,assignments={r['id']:'train' for r in rows},frozen=frozen)
        self.assertEqual([r['id'] for r in splits['train']],['safe'])
        self.assertEqual(len(rejected),3)

    def test_later_independent_training_renews_temporal_holdout(self):
        old_train=record('old-train','same',10)
        old_test=record('old-test','same',20)
        old_test['evaluation_group']='temporal'
        frozen=s.freeze({}, {'train':[old_train],'valid':[],'test':[old_test]})
        frozen['assignments']['old-train']='train'
        later_train=record('later-train','same',50000)
        later_test=record('later-test','same',100000)
        rows=[old_train,old_test,later_train,later_test]
        assignments={r['id']:frozen['assignments'].get(r['id'],'train') for r in rows}
        assignments=s.extend_temporal_assignments(rows,assignments,frozen)
        self.assertEqual(assignments['later-test'],'test')
        splits,rejected=s.partition(rows,assignments=assignments,frozen=frozen)
        self.assertEqual(rejected,[])
        self.assertEqual([r['id'] for r in splits['train']],['old-train','later-train'])
        self.assertEqual({r['id']:r['evaluation_group'] for r in splits['test']},
                         {'old-test':'retrospective','later-test':'temporal'})
        grown=s.freeze(frozen,splits)
        self.assertEqual(len(grown['intervals'][s.chat_key(old_test)]),2)
        self.assertEqual(s.freeze(grown,splits)['intervals'],grown['intervals'])

    def test_canonical_keys_required(self):
        row=record('x','one',10)
        row['source_message_keys']=['["kakao", "owner", "one", "bad"]']
        _,manifest=p.prepare_examples([row])
        self.assertEqual(manifest['rejected'][0]['reason'],'noncanonical_source_message_key')

    def test_frozen_assignment_cannot_migrate_when_backfill_changes_all_sources(self):
        old = record('fixed','one',100)
        frozen = s.freeze({}, {'train': [], 'valid': [old], 'test': []})
        changed = record('fixed','one',50000,context_id='new',target='new-target')
        splits, rejected = s.partition([changed], assignments={'fixed':'train'}, frozen=frozen)
        self.assertEqual(splits['train'], [])
        self.assertEqual(rejected, [{'id':'fixed','reason':'frozen_assignment_changed'}])

    def test_unreviewed_backfilled_evaluation_context_is_reserved_before_training(self):
        old = record('eval','one',100,context_time=90)
        frozen = s.freeze({}, {'train': [], 'valid': [], 'test': [old]})
        refreshed = record('eval','one',100,context_id='newly-collected',context_time=10)
        refreshed['reviewed'] = False
        grown = s.reserve_refreshed_evaluation(frozen, [refreshed])
        training = record('other','one',30,context_id='newly-collected',context_time=10)
        splits, rejected = s.partition([training], assignments={'other':'train'}, frozen=grown)
        self.assertEqual(splits['train'], [])
        self.assertEqual(rejected[0]['reason'], 'cross_split_source_boundary')
        self.assertTrue(set(frozen['source_keys']) <= set(grown['source_keys']))
        self.assertEqual(s.reserve_refreshed_evaluation(grown,[refreshed]),grown)

    def test_refreshed_test_cannot_overwrite_original_validation_source_owner(self):
        valid = record('valid','one',20,context_id='shared')
        test = record('test','one',50000)
        frozen = s.freeze({}, {'train': [], 'valid': [valid], 'test': [test]})
        changed = record('test','one',50000,context_id='shared')
        grown = s.reserve_refreshed_evaluation(frozen,[changed])
        self.assertEqual(grown['source_keys'][s.key('kakao','owner','one','shared')],'valid')
        splits, rejected = s.partition([changed],assignments={'test':'test'},frozen=grown)
        self.assertEqual(splits['test'],[])
        self.assertEqual(rejected[0]['reason'],'cross_split_source_boundary')

    def test_backfilled_evaluation_with_new_candidate_id_reserves_new_context(self):
        old = record('old-id','one',100,target='same-transmission')
        frozen = s.freeze({}, {'train': [], 'valid': [], 'test': [old]})
        changed = record('new-id','one',100,target='same-transmission',context_id='added',context_time=10)
        grown = s.reserve_refreshed_evaluation(frozen,[changed])
        self.assertEqual(grown['source_keys'][s.key('kakao','owner','one','added')],'test')
        self.assertNotIn('new-id',grown['assignments'])
        self.assertEqual(s.reserve_refreshed_evaluation(grown,[changed]),grown)

    def test_legacy_embedded_target_identity_migrates_without_original_bodies(self):
        old_id = 'hist:' + s.key('kakao','owner','one','same-transmission')
        old = record(old_id,'one',100,target='same-transmission')
        frozen = s.freeze({}, {'train': [], 'valid': [old], 'test': []})
        frozen.pop('evaluation_target_keys')
        changed = record('send:new-path','one',100,target='same-transmission',context_id='added',context_time=10)
        grown = s.reserve_refreshed_evaluation(frozen,[changed])
        self.assertEqual(grown['source_keys'][s.key('kakao','owner','one','added')],'valid')
        self.assertEqual(grown['assignments'],frozen['assignments'])

    def test_omitted_original_evaluation_source_quarantines_only_its_room(self):
        old = record('hist:' + s.key('kakao','owner','one','eval-target'),'one',100,target='eval-target')
        frozen = s.freeze({}, {'train': [], 'valid': [old], 'test': []})
        omitted = [{'id':old['id'],'reason':'candidate_too_large'},
                   {'id':'hist:' + s.key('kakao','owner','unrelated','other'),'reason':'candidate_too_large'}]
        protected = s.quarantine_omitted_evaluation(frozen,omitted)
        self.assertEqual(protected['heldout_chats'],[s.chat_key(old)])
        self.assertEqual(protected['source_keys'],frozen['source_keys'])
        self.assertEqual(s.quarantine_omitted_evaluation(protected,omitted),protected)
        rows = [record('unsafe','one',200000),record('safe','elsewhere',200000)]
        kept,rejected = s.partition(rows,assignments={row['id']:'train' for row in rows},frozen=protected)
        self.assertEqual([row['id'] for row in kept['train']],['safe'])
        self.assertEqual(rejected,[{'id':'unsafe','reason':'cross_split_source_boundary'}])

    def test_interval_includes_last_message_of_multi_message_reply(self):
        r=record('multi','one',10)
        r['targets']=[{'message_id':'first','ts':10},{'message_id':'second','ts':30}]
        self.assertEqual(s.interval(r),[9,30])


class TrainingTests(unittest.TestCase):
    def test_training_adapter_config_drops_ephemeral_paths(self):
        class Tokenizer:
            def apply_chat_template(self,messages,**_):
                return list(range(10 if messages[-1]['role']=='assistant' else 5))
        rows=[record('train','a',10),record('valid','b',20),record('test','c',30)]
        with tempfile.TemporaryDirectory() as tmp:
            model=Path(tmp)/'model';model.mkdir()
            (model/'config.json').write_text('{}')
            (model/'model.safetensors').write_bytes(b'fake')
            output=Path(tmp)/'adapter'
            def fake_subprocess(command,**kwargs):
                self.assertEqual(len(kwargs['pass_fds']),1)
                config=json.loads(Path(command[-1]).read_text())
                p.private_json(output/'adapter_config.json',config)
                (output/'adapters.safetensors').write_bytes(b'fake-adapter')
                return SimpleNamespace(returncode=0)
            with patch.dict(sys.modules, {'mlx_lm':SimpleNamespace(),
                                          'mlx_lm.utils':SimpleNamespace(load_tokenizer=lambda _:Tokenizer())}), \
                 patch.object(p,'stage_training_model',return_value=Path(tmp)/'ephemeral-model'), \
                 patch.object(p,'guarded_training_run',side_effect=fake_subprocess):
                p.run_local(rows,model,output,iters=1,
                            assignments={'train':'train','valid':'valid','test':'test'})
            saved=json.loads((output/'adapter_config.json').read_text())
            self.assertEqual(saved['model'],str(model.resolve()))
            self.assertNotIn('data',saved)
            self.assertNotIn('ephemeral-model',json.dumps(saved))

    def test_cleanup_preserves_live_lock_and_removes_abandoned_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            live=root/'inboxd-training-live';live.mkdir(mode=0o700)
            dead=root/'inboxd-checkpoints-dead';dead.mkdir(mode=0o700)
            for path in (live,dead):
                (path/'.active.lock').write_text(json.dumps({'version':1,'pid':99999999,'created_at':1}))
                os.chmod(path/'.active.lock',0o600)
            fd=os.open(live/'.active.lock',os.O_RDONLY)
            fcntl.flock(fd,fcntl.LOCK_EX)
            try:
                with patch.object(p.tempfile,'gettempdir',return_value=tmp):
                    self.assertEqual(p.cleanup_stale_training_dirs(),1)
                self.assertTrue(live.exists())
                self.assertFalse(dead.exists())
            finally:
                os.close(fd)
            with patch.object(p.tempfile,'gettempdir',return_value=tmp):
                self.assertEqual(p.cleanup_stale_training_dirs(),1)
            self.assertFalse(live.exists())

    def test_cleanup_legacy_requires_no_process_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            legacy=Path(tmp)/'inboxd-training-legacy';legacy.mkdir(mode=0o700)
            with patch.object(p.tempfile,'gettempdir',return_value=tmp), \
                 patch.object(p,'_legacy_process_uses',side_effect=[True,False]):
                self.assertEqual(p.cleanup_stale_training_dirs(legacy_grace_seconds=0),0)
                self.assertTrue(legacy.exists())
                self.assertEqual(p.cleanup_stale_training_dirs(legacy_grace_seconds=0),1)

    def test_length_prefilter_rejects_only_long_case_and_checks_target(self):
        class Tokenizer:
            def apply_chat_template(self,messages,**_):
                return list(range(80 if messages[-1]['content'] == 'long' else 8 if messages[-1]['role'] == 'assistant' else 4))
        short=record('short','one',10)
        long=record('long','two',20)
        long['messages'][-1]['content']='long'
        kept,rejected=p.prefilter_length([short,long],Tokenizer(),64)
        self.assertEqual([r['id'] for r in kept],['short'])
        self.assertEqual(rejected,[{'id':'long','reason':'over_token_budget'}])

    def test_iterations_follow_dataset_batch_epochs_with_override(self):
        self.assertEqual(p.iterations_for(101,8,2),26)
        self.assertEqual(p.iterations_for(101,8,2,7),7)
        with self.assertRaises(ValueError): p.iterations_for(10,0,2)

    def test_batch_larger_than_validation_split_stops_before_mlx(self):
        rows=[record('train','a',10),record('valid','b',20),record('test','c',30)]
        with tempfile.TemporaryDirectory() as tmp:
            model=Path(tmp)/'model'; model.mkdir(); (model/'config.json').write_text('{}')
            with patch.dict(sys.modules, {'mlx_lm':SimpleNamespace(),
                                          'mlx_lm.utils':SimpleNamespace(load_tokenizer=lambda _: type('T',(),{
                                              'apply_chat_template':lambda self,messages,**_:list(range(10 if messages[-1]['role']=='assistant' else 5))})())}):
                with self.assertRaisesRegex(ValueError,'split_smaller_than_batch_size'):
                    p.run_local(rows,model,Path(tmp)/'out',batch_size=2,
                                assignments={'train':'train','valid':'valid','test':'test'})

    def test_checkpoint_selection_uses_validation_and_copies_best(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); adapter=root/'adapter';adapter.mkdir()
            for name,data in [('adapters.safetensors',b'final'),('0000005_adapters.safetensors',b'best'),
                              ('0000010_adapters.safetensors',b'poor')]:
                (adapter/name).write_bytes(data)
            (adapter/'adapter_config.json').write_text('{}')
            p.private_json(adapter/'manifest.json',{'status':'complete','mode':'train','base_model_id':'model','iters':11})
            values=iter([0.4,0.8,0.7])
            runtime_fields={
                'runtime_configuration':{'backend':'legacy','compile_mode':'default'},
                'runtime_source_sha256':{'personalization.py':'a'*64,'training_runtime.py':'b'*64},
                'runtime_dependency_versions':{'mlx':'synthetic-mlx','mlx-lm':'synthetic-mlx-lm'},
                'runtime_fingerprint':'c'*64,
            }
            def fake_run(*args,**kwargs):
                self.assertTrue(kwargs['evaluate'])
                self.assertEqual(kwargs['split_name'],'valid')
                report=Path(args[2]);report.mkdir();(report/'runtime.log').write_text(f'Test loss {next(values)}')
                p.private_json(report/'manifest.json',{
                    'status':'complete','base_model_id':'model','dataset_id':'valid-dataset',
                    **runtime_fields,
                })
                p.private_json(report/'resources.json',{'status':'complete','elapsed_seconds':1})
            with patch.object(p,'run_local',side_effect=fake_run):
                result=p.select_validation_checkpoint([], '/model', adapter, assignments={})
            self.assertEqual(result['checkpoint_iteration'],5)
            self.assertEqual((adapter/'adapters.safetensors').read_bytes(),b'best')


class EvaluationTests(unittest.TestCase):
    def test_retrieval_keeps_current_turn_metadata_aligned_and_example_metadata_local(self):
        import copy
        from worker import compile_prompt, build_generation_input
        current, _ = compile_prompt({'context': [
            {'message_id': 'current-1', 'author_id': 'them', 'author_role': 'other',
             'body': '제가 만든 앱입니다.', 'ts': 1, 'reply_to': None}],
            'incoming_message_ids': ['current-1']})
        prompt = build_generation_input(current)
        example = record('past', 'other-chat', 0)
        example['messages'].insert(0, {'role': 'system', 'content': 'example-local-metadata'})
        original = copy.deepcopy((prompt, example))
        combined = e.retrieval_prompt(prompt, [example])
        # Metadata position zero must still refer to the current other person's
        # app, rather than the old example's first message.
        self.assertEqual(combined[1:], prompt[1:])
        self.assertEqual([m['role'] for m in combined], [m['role'] for m in prompt])
        self.assertIn('example-local-metadata', combined[0]['content'])
        self.assertIn('question past', combined[0]['content'])
        self.assertIn('현재 turn_metadata의 순서에는 과거 예시를 포함하지 않습니다', combined[0]['content'])
        self.assertEqual((prompt, example), original)
        no_system = e.retrieval_prompt(prompt[1:], [example])
        self.assertEqual(no_system[1:], prompt[1:])

    def test_retrieval_uses_train_only_past_nonoverlapping_cases(self):
        case=record('test','one',100,context_time=90)
        train=[record('future','two',110),record('overlap','one',95,context_time=90),
               record('past','two',80),record('old','three',70)]
        self.assertEqual([r['id'] for r in e.retrieval_examples(train,case)],['past','old'])

    def test_blinded_report_has_no_fabricated_verdicts(self):
        class Tokenizer:
            def apply_chat_template(self,messages,**_): return list(range(len(str(messages))))
            def encode(self,text): return text.split()
        class Engine:
            def generate_text(self,messages,**kwargs): return '답변'
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'report.json'
            rubric={'role':'who acted','fact':'supported facts','abstain':'answerability'}
            e.compare(Engine(),Tokenizer(),[record('train','other',10)],
                      [record('test','heldout',20)],'/adapter',output,heldout_rubric=rubric,gap_policy={'telegram':60})
            report=json.loads(output.read_text())
            self.assertEqual(report['sample_count'],1)
            self.assertEqual(report['gap_policy'],{'telegram':60})
            self.assertEqual(report['gap_policy_hash'],p.digest({'telegram':60}))
            self.assertTrue(report['comparison_complete'])
            self.assertTrue(report['cases'][0]['comparison_complete'])
            self.assertEqual(report['comparable_abc_count'], 1)
            self.assertFalse(report['human_review_complete'])
            self.assertEqual(len(report['cases'][0]['outputs']),3)
            self.assertTrue(all(x['human_verdict'] is None for x in report['cases'][0]['outputs']))
            self.assertEqual(report['cases'][0]['prompt_hash'],p.digest(record('test','heldout',20)['messages'][:-1]))
            self.assertNotIn('method',json.dumps(report))
            self.assertNotIn('example_ids',json.dumps(report))
            mapping=json.loads((Path(tmp)/'report-unblind.json').read_text())
            self.assertEqual({x['method'] for x in mapping['test'].values()},
                             {'base','trained','retrieval'})


if __name__=='__main__': unittest.main()
