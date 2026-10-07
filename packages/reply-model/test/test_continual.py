import importlib.util
import contextlib
import io
import plistlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import continual as c


def row(**kwargs):
    return {'id':'send:r1', 'session_id':'s1', 'chat':{'platform':'kakao','account':'a','chat_id':'c'},
            'timestamp':10, 'outcome':'sent', 'send_state':'Verified', 'first_input':True,
            'shown':True, 'inserted':False, 'final_text':'직접 만드신 게 대단한 거죠!',
            'suggested_text':'제가 만들었어요', 'target_message_id':'sent1',
            'context':[{'message_id':'m1','author_role':'other','author_id':'them','ts':1,'body':'제가 만든 앱입니다.'}], **kwargs}


def varied_records():
    records=[]
    for i in range(20):
        timestamp = 100000 if i == 18 else 200000 if i == 19 else 10+i
        chat_id = 'shared' if i in (0,18) else str(i)
        context=[{'message_id':f'm{i}','author_role':'other','author_id':'them',
                  'ts':timestamp-1,'body':'제가 만든 앱입니다.'}]
        records.append(c.candidate_record(row(id=f'send:{i}',timestamp=timestamp,
            chat={'platform':'kakao','account':'a','chat_id':chat_id},
            target_message_id=f'target{i}',context=context,final_text=f'답장 {i}')))
    return records


class ContinualTest(unittest.TestCase):
    def test_manual_send_keeps_exact_context_and_self_target_without_negative_label(self):
        record = c.candidate_record(row())
        self.assertFalse(record['reviewed'])
        self.assertEqual(record['messages'][-1], {'role':'assistant','content':'직접 만드신 게 대단한 거죠!'})
        self.assertNotIn('제가 만들었어요', json.dumps(record, ensure_ascii=False))
        self.assertEqual(record['input_kind'], 'manual')

    def test_unsent_uncertain_unchanged_or_missing_context_never_train(self):
        for change in ({'outcome':'uncertain'}, {'send_state':'Failed'}, {'first_input':False},
                       {'inserted':True,'final_text':'제가 만들었어요'}, {'context':None}, {'timestamp':0}):
            records, rejected = c.prepare_candidates([row(**change)])
            self.assertEqual(records, [])
            self.assertEqual(len(rejected), 1)

    def test_review_is_bound_to_text_and_source_and_prompt(self):
        record = c.candidate_record(row())
        reviews = {record['id']:{'hash':record['review_hash'],'decision':'approve'}}
        self.assertEqual(len(c.reviewed_records([record],reviews)), 1)
        changed = c.candidate_record(row(final_text='다른 답장'))
        self.assertEqual(c.reviewed_records([changed],reviews), [])
        self.assertEqual(c.reviewed_records([],reviews), [])

    def test_edited_suggestion_is_separate_from_manual_input(self):
        self.assertEqual(c.candidate_record(row(inserted=True))['input_kind'],'edited_suggestion')

    def test_export_paginates_and_deduplicates(self):
        pages = [{'candidates':[row()], 'next_after_event_id':'a'}, {'candidates':[row()], 'next_after_event_id':None}]
        with patch.object(c.subprocess,'run',side_effect=[SimpleNamespace(returncode=0,stdout=json.dumps(p)) for p in pages]) as run:
            rows, _ = c.collect('/inboxd')
        self.assertEqual(len(c.prepare_candidates(rows)[0]), 1)
        self.assertEqual(json.loads(run.call_args.args[0][-1])['after_event_id'],'a')

    def test_small_or_unreviewed_dataset_never_starts_training(self):
        with tempfile.TemporaryDirectory() as directory:
            args=SimpleNamespace(root=Path(directory), min_train=100,min_eval=20,min_new=25)
            with patch.object(c,'run_local') as train:
                state=c.cycle(args,[c.candidate_record(row())],{})
            self.assertEqual(state['status'],'waiting_for_reviewed_data')
            train.assert_not_called()
            self.assertEqual(state['activation'],'manual')

    def test_sensitive_screen_always_runs_on_new_roots_and_installed_keys_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            args=SimpleNamespace(root=Path(directory),min_train=100,min_eval=20,min_new=25)
            record=c.candidate_record(row(final_text='password: synthetic-credential-42'))
            reviews={record['id']:{'hash':record['review_hash'],'decision':'approve'}}
            with patch.object(c,'run_local') as train:
                state=c.cycle(args,[record],reviews)
                self.assertEqual(state['approved_count'],0)
                train.assert_not_called()
            c.private_json(args.root/'sensitive-source-policy.json',{'required':True,'quarantine_hash':'expected'})
            with self.assertRaisesRegex(ValueError,'quarantine_missing'):
                c.cycle(args,[],{})
            q={'version':'isolated-test','source_keys':[],'values_retained':False}
            q['quarantine_hash']=c.history.digest(q)
            c.private_json(args.root/'sensitive-source-quarantine.json',q)
            with self.assertRaisesRegex(ValueError,'quarantine_changed'):
                c.cycle(args,[],{})

    def test_explicit_partitions_do_not_move_test_into_training(self):
        records=[]
        for i in range(9):
            r=c.candidate_record(row(id=f'send:{i}',timestamp=10+i,chat={'platform':'kakao','account':'a','chat_id':str(i)},final_text=f'답장 {i}'))
            r['reviewed']=True
            records.append(r)
        assignments={r['id']:('test' if i==0 else 'valid' if i==1 else 'train') for i,r in enumerate(records)}
        splits,_=c.prepare_examples(records,assignments=assignments)
        self.assertEqual([r['id'] for r in splits['test']],['send:0'])
        self.assertNotIn('send:0',[r['id'] for r in splits['train']])

    def test_training_and_loss_evaluation_only_stage_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            args=SimpleNamespace(root=Path(directory),model='/model',min_train=1,min_eval=1,min_new=1,iters=1)
            records=varied_records()
            reviews={r['id']:{'hash':r['review_hash'],'decision':'approve'} for r in records}
            from types import ModuleType
            mlx = ModuleType('mlx_lm'); utils = ModuleType('mlx_lm.utils'); utils.load_tokenizer=lambda _: object()
            with patch.dict(sys.modules, {'mlx_lm': mlx, 'mlx_lm.utils': utils}), \
                 patch.object(c,'run_local') as train, \
                 patch.object(c,'loss_from_log',side_effect=[2.0,1.5]), \
                 patch.object(c,'select_validation_checkpoint',return_value={'loss':1.0}), \
                 patch.object(c,'compare_outputs',return_value='report.json') as compare:
                state=c.cycle(args,records,reviews)
            self.assertEqual(compare.call_args.kwargs['gap_policy'],{})
            self.assertEqual(train.call_count,3)
            self.assertTrue(all(call.kwargs['max_swap_bytes']==4*1024**3 for call in train.call_args_list))
            self.assertEqual(state['status'],'awaiting_quality_review')
            self.assertTrue(state['loss_improved'])
            with patch.object(c,'run_local') as train:
                state=c.cycle(args,records,reviews)
            train.assert_not_called()
            self.assertEqual(state['status'],'awaiting_quality_review')
            self.assertTrue(state['no_new_dataset'])

    def attempt(self, directory):
        args=SimpleNamespace(root=Path(directory),model='/model',min_train=1,min_eval=1,min_new=1,
                             iters=1,max_runtime_seconds=35,max_rss_gib=3)
        records=varied_records()
        reviews={r['id']:{'hash':r['review_hash'],'decision':'approve'} for r in records}
        return args,records,reviews

    def test_resource_failure_is_latched_across_dataset_changes_until_config_or_explicit_retry(self):
        class ResourceError(ValueError):
            reason='training_rss_limit'
        with tempfile.TemporaryDirectory() as directory:
            args,records,reviews=self.attempt(directory)
            with patch.object(c,'run_local',side_effect=ResourceError('private target')) as run:
                failed=c.cycle(args,records,reviews)
                self.assertEqual(failed['failure_reason'],'training_rss_limit')
                self.assertEqual(run.call_args.kwargs['max_runtime_seconds'],35)
                self.assertEqual(run.call_args.kwargs['max_rss_bytes'],3*1024**3)
                changed=records + [c.candidate_record(row(id='send:new',timestamp=300000,
                    chat={'platform':'kakao','account':'a','chat_id':'new'},target_message_id='new'))]
                reviews[changed[-1]['id']]={'hash':changed[-1]['review_hash'],'decision':'approve'}
                self.assertEqual(c.cycle(args,changed,reviews)['status'],'training_retry_blocked')
                self.assertEqual(run.call_count,1)
                args.max_rss_gib=4
                self.assertEqual(c.cycle(args,changed,reviews)['status'],'training_failed')
                self.assertEqual(run.call_count,2)
                args.retry_failed=True
                self.assertEqual(c.cycle(args,changed,reviews)['status'],'training_failed')
                self.assertEqual(run.call_count,3)
            self.assertNotIn('private target',json.dumps(failed))

    def test_memory_and_swap_failures_block_new_datasets_and_swap_limit_is_fingerprinted(self):
        for reason in ('training_memory_error', 'training_swap_limit'):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                args,records,reviews=self.attempt(directory)
                args.max_swap_gib=2
                error=ValueError('private error'); error.reason=reason
                with patch.object(c,'run_local',side_effect=error) as run:
                    failed=c.cycle(args,records,reviews)
                    self.assertEqual(failed['failure_reason'],reason)
                    self.assertEqual(run.call_args.kwargs['max_swap_bytes'],2*1024**3)
                    changed=records + [c.candidate_record(row(id='send:new',timestamp=300000,
                        chat={'platform':'kakao','account':'a','chat_id':'new'},target_message_id='new'))]
                    reviews[changed[-1]['id']]={'hash':changed[-1]['review_hash'],'decision':'approve'}
                    self.assertEqual(c.cycle(args,changed,reviews)['status'],'training_retry_blocked')
                    self.assertEqual(run.call_count,1)
                    args.max_swap_gib=3
                    self.assertEqual(c.cycle(args,changed,reviews)['status'],'training_failed')
                    self.assertEqual(run.call_count,2)

    def test_same_generic_failure_is_not_retried_and_runtime_change_allows_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            args,records,reviews=self.attempt(directory)
            with patch.object(c,'run_local',side_effect=RuntimeError('private')) as run:
                c.cycle(args,records,reviews)
                self.assertEqual(c.cycle(args,records,reviews)['status'],'training_retry_blocked')
                self.assertEqual(run.call_count,1)
                with patch('training_runtime.RUNTIME_VERSION','new-runtime'):
                    self.assertEqual(c.cycle(args,records,reviews)['status'],'training_failed')
                self.assertEqual(run.call_count,2)

    def test_dead_training_run_requires_explicit_retry_and_preserves_prior_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            args,records,reviews=self.attempt(directory)
            c.private_json(args.root/'status.json',{'status':'training','run':'old',
                'trained_dataset_id':'old-dataset','trained_examples':{'old':'hash'},
                'comparison_report':'prior-review.json'})
            with patch.object(c,'run_local',side_effect=RuntimeError('failure')) as run:
                state=c.cycle(args,records,reviews)
                self.assertEqual(state['status'],'training_retry_blocked')
                run.assert_not_called()
                self.assertEqual(state['trained_dataset_id'],'old-dataset')
                self.assertEqual(state['comparison_report'],'prior-review.json')
                args.retry_failed=True
                self.assertEqual(c.cycle(args,records,reviews)['status'],'training_failed')
                self.assertEqual(run.call_count,1)

    def test_gap_policy_content_is_fingerprinted_and_shared_with_history_review(self):
        with tempfile.TemporaryDirectory() as directory:
            args,_,_=self.attempt(directory)
            policy=Path(directory)/'gap.json'; policy.write_text('{"telegram": 60}')
            args.gap_policy=policy
            first=c.training_identity(args,'dataset')
            policy.write_text('{"telegram": 64}')
            second=c.training_identity(args,'dataset')
            self.assertNotEqual(first['configuration_fingerprint'],second['configuration_fingerprint'])
            with patch.object(sys,'argv',['continual','status','--root',str(Path(directory)/'learning'),
                '--model','/missing-model','--gap-policy',str(policy)]), \
                patch.object(c,'collect',return_value=([],[])), \
                patch.object(c.history,'collect',return_value=([],[])), \
                patch.object(c.history,'prepare_candidates',return_value=([],[])) as prepare, \
                contextlib.redirect_stdout(io.StringIO()):
                c.main()
            self.assertEqual(prepare.call_args.kwargs['gap_policy'],{'telegram':64})

    def test_schedule_propagates_limits_and_policy_without_daily_explicit_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            args,_,_=self.attempt(directory)
            args.inboxd=Path('/inboxd'); args.seq_length=2048; args.batch_size=1; args.epochs=2
            args.gap_policy=Path(directory)/'gap.json'; args.retry_failed=True
            with patch.object(c.sys,'platform','darwin'), patch.object(c.Path,'home',return_value=Path(directory)), \
                 patch.object(c.subprocess,'run',return_value=SimpleNamespace(returncode=0)):
                result=c.schedule(args)
            with open(result['plist'],'rb') as stream:
                command=plistlib.load(stream)['ProgramArguments']
            self.assertEqual(command[command.index('--max-runtime-seconds')+1],'35')
            self.assertEqual(command[command.index('--max-rss-gib')+1],'3')
            self.assertEqual(command[command.index('--max-swap-gib')+1],'4')
            self.assertEqual(command[command.index('--gap-policy')+1],str(args.gap_policy))
            self.assertNotIn('--retry-failed',command)

    def test_failed_training_is_reported_without_activation_or_private_error(self):
        with tempfile.TemporaryDirectory() as directory:
            args=SimpleNamespace(root=Path(directory),model='/model',min_train=1,min_eval=1,min_new=1,iters=1)
            records=varied_records()
            reviews={r['id']:{'hash':r['review_hash'],'decision':'approve'} for r in records}
            with patch.object(c,'run_local',side_effect=RuntimeError('private content')):
                state=c.cycle(args,records,reviews)
            self.assertEqual(state['status'],'training_failed')
            self.assertNotIn('private content',json.dumps(state))
            self.assertNotIn('trained_dataset_id',state)

    def test_current_cycle_clears_prior_dataset_flags_but_keeps_training_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            args,records,reviews=self.attempt(directory)
            failures={'prior':{'reason':'training_swap_limit','configuration_fingerprint':'other-config'}}
            c.private_json(args.root/'status.json',{'status':'waiting_for_reviewed_data',
                'insufficient_evidence':{'train':{'available':0,'required':1}},
                'no_new_dataset':True,'failed_attempts':failures,
                'trained_dataset_id':'prior-dataset','trained_examples':{'old':'hash'},
                'comparison_report':'prior-review.json'})
            error=ValueError('synthetic failure'); error.reason='training_swap_limit'
            with patch.object(c,'run_local',side_effect=error):
                state=c.cycle(args,records,reviews)
            self.assertEqual(state['status'],'training_failed')
            self.assertTrue(all(state['split_counts'][name]>0 for name in ('train','valid','test')))
            self.assertNotIn('insufficient_evidence',state)
            self.assertNotIn('no_new_dataset',state)
            self.assertEqual(state['failed_attempts']['prior'],failures['prior'])
            self.assertEqual(state['trained_dataset_id'],'prior-dataset')
            self.assertEqual(state['trained_examples'],{'old':'hash'})
            self.assertEqual(state['comparison_report'],'prior-review.json')
            with patch.object(c,'run_local') as train:
                blocked=c.cycle(args,records,reviews)
            train.assert_not_called()
            self.assertEqual(blocked['status'],'training_retry_blocked')
            self.assertNotIn('insufficient_evidence',blocked)
            self.assertNotIn('no_new_dataset',blocked)
