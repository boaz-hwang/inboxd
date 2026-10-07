import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from history_collect import execute, execute_full, make_full_plan, connected_inventory, identity, inventory, locked, make_plan, save_plan


class CollectionTests(unittest.TestCase):
    def plan(self, pages=2):
        return make_plan([{'chat': {'platform':'telegram','account':'a','chat_id':'room'},
                           'self_message_count':3}], from_ts=0, to_ts=10, pages_per_room=pages)

    def test_resume_obeys_local_budget_and_does_not_restart_terminal(self):
        plan, progress, reads = self.plan(), {'status':'unstarted','committed_pages':0}, []
        def request(group, action, payload, **kw):
            if action == 'status':
                return {'work': {'jobs': []}}
            if payload.get('status_only'):
                return {'progress': dict(progress)}
            reads.append(payload)
            progress.update(status='pending', committed_pages=progress['committed_pages']+1)
            return {'progress':dict(progress), 'event_count':2}
        save = lambda _: None
        first = execute(plan, request, save, max_requests=1)
        self.assertEqual(first['rooms'][0]['state'], 'pending')
        second = execute(plan, request, save, max_requests=10)
        self.assertEqual(second['rooms'][0]['state'], 'local_budget')
        execute(plan, request, save, max_requests=10)
        self.assertEqual(len(reads), 2)
        completed = self.plan()
        progress.update(status='complete',committed_pages=2)
        self.assertEqual(execute(completed,request,save)['rooms'][0]['state'],'complete')
        self.assertEqual(len(reads),2)

    def test_timeout_then_live_job_is_waited_without_restarting(self):
        plan, calls = self.plan(), []
        def timed(group, action, payload, **kw):
            if action == 'status': return {'work':{'jobs':[]}}
            if payload.get('status_only'): return {'progress':{'status':'unstarted','committed_pages':0}}
            calls.append(1)
            raise ValueError('request_outcome_unknown')
        self.assertEqual(execute(plan,timed,lambda _:None)['rooms'][0]['state'],'uncertain')
        def live(group, action, payload, **kw):
            self.assertEqual(action, 'status')
            return {'work':{'jobs':[{'id':'live-handle','operation':'sync.backfill','scope':{},'state':'running'}]}}
        result=execute(plan,live,lambda _:None)
        self.assertEqual(result['rooms'][0]['job_ids'],['live-handle'])
        self.assertEqual(len(calls),1)

    def test_checkpoint_reconciles_committed_page_after_client_timeout(self):
        plan=self.plan(pages=1)
        item=plan['spec']['rooms'][0]
        plan['results'][identity(item)]={'state':'uncertain','pages_read':0,'initial_committed_pages':0,
                                        'reason':'request_outcome_unknown'}
        def request(group,action,payload,**kw):
            if action=='status': return {'work':{'jobs':[]}}
            self.assertTrue(payload['status_only'])
            return {'progress':{'status':'pending','committed_pages':1}}
        result=execute(plan,request,lambda _:None)['rooms'][0]
        self.assertEqual(result['state'],'local_budget')
        self.assertNotIn('reason',result)

    def test_platform_sampling_pages_and_invalid_scope(self):
        calls=[]
        def request(group,action,payload):
            calls.append(payload)
            return {'rooms':[{'chat':{'platform':'kakao','account':'a','chat_id':str(len(calls))}}],
                    'next_cursor':'next' if len(calls)==1 else None}
        rows=inventory(request,['kakao'])
        self.assertEqual(len(rows),2)
        self.assertEqual(calls[1]['cursor'],'next')
        plan=make_plan(rows,from_ts=0,to_ts=10,max_rooms=1)
        self.assertEqual(len(plan['spec']['rooms']),1)
        changed=copy.deepcopy(plan)
        changed['spec']['rooms'][0]['page_budget']=100
        with self.assertRaisesRegex(ValueError,'plan_changed'):
            execute(changed,request,lambda _:None)

    def test_unknown_provider_error_is_not_persisted(self):
        plan=self.plan()
        def request(*args,**kw): raise ValueError('private-body-secret')
        result=execute(plan,request,lambda _:None)
        self.assertNotIn('private-body-secret',json.dumps(result))
        self.assertEqual(result['rooms'][0]['reason'],'response_failed')

    def test_connected_telegram_fallback_is_bounded_and_never_claims_coverage(self):
        plan=self.plan(pages=2)
        plan['spec']['rooms'][0]['chat']['chat_id']='telegram:chat:123'
        plan['plan_id']=identity(plan['spec'])
        calls=[]
        def request(group,action,payload,**kw):
            if action=='status': return {'work':{'jobs':[]}}
            if group=='sync': raise ValueError('unavailable')
            self.assertEqual((group,action),('account','messages'))
            self.assertEqual(payload['chat_id'],'123')
            calls.append(payload)
            return {'messages':[{'id':'m1','ts':8,'body':'private-target'}],
                    'complete':False,'next_cursor':f'account:{len(calls)}'}
        first=execute(plan,request,lambda _:None,max_requests=1)
        self.assertEqual(first['rooms'][0]['coverage_state'],'unknown')
        second=execute(plan,request,lambda _:None,max_requests=10)
        self.assertEqual(second['rooms'][0]['state'],'local_budget')
        self.assertEqual(second['rooms'][0]['event_count'],1)
        self.assertEqual(calls[1]['cursor'],'account:1')
        execute(plan,request,lambda _:None,max_requests=10)
        self.assertEqual(len(calls),2)
        self.assertNotIn('private-target',json.dumps(plan))
        self.assertNotIn('account_cursor',json.dumps(second))

    def test_expired_connected_cursor_restarts_without_skipping_buffered_messages(self):
        plan=self.plan(pages=3)
        item=plan['spec']['rooms'][0]; item['chat']['chat_id']='123'
        plan['plan_id']=identity(plan['spec'])
        result={'state':'pending','reader':'account_messages','pages_read':1,'account_requests':1,
                'account_cursor':'account:old','cursor_saved_at':0,'seen_message_ids':['m1']}
        plan['results'][identity(item)]=result
        def request(group,action,payload,**kw):
            if action=='status': return {'work':{'jobs':[]}}
            self.assertNotIn('cursor',payload)
            self.assertNotIn('message_id',payload)
            return {'messages':[{'id':'m1','ts':8},{'id':'m2','ts':7}],
                    'complete':False,'next_cursor':'account:new'}
        page=execute(plan,request,lambda _:None,max_requests=1)['rooms'][0]
        self.assertEqual(page['cursor_restarts'],1)
        self.assertEqual(page['event_count'],1)
        self.assertEqual(page['account_requests'],2)

    def test_uncertain_connected_read_consumes_attempt_budget(self):
        plan=self.plan(pages=1); item=plan['spec']['rooms'][0]
        item['chat']['chat_id']='123';plan['plan_id']=identity(plan['spec'])
        def request(group,action,payload,**kw):
            if action=='status': return {'work':{'jobs':[]}}
            if group=='sync': raise ValueError('unavailable')
            raise ValueError('request_outcome_unknown')
        self.assertEqual(execute(plan,request,lambda _:None)['rooms'][0]['state'],'uncertain')
        result=execute(plan,request,lambda _:None)
        self.assertEqual(result['rooms'][0]['state'],'local_budget')
        self.assertEqual(result['requests_this_run'],0)

    def test_sync_failed_attempts_have_a_durable_room_budget(self):
        plan=self.plan(pages=1)
        reads=[]
        def request(group,action,payload,**kw):
            if action=='status': return {'work':{'jobs':[]}}
            if payload.get('status_only'):
                return {'progress':{'status':'unstarted','committed_pages':0}}
            reads.append(1)
            raise ValueError('request_outcome_unknown')
        self.assertEqual(execute(plan,request,lambda _:None)['rooms'][0]['state'],'uncertain')
        resumed=execute(plan,request,lambda _:None)
        self.assertEqual(resumed['rooms'][0]['state'],'local_budget')
        self.assertEqual(resumed['requests_this_run'],0)
        self.assertEqual(len(reads),1)

    def test_progress_persistence_is_metadata_only_and_terminal_is_unknown_coverage(self):
        plan=self.plan()
        def request(group,action,payload,**kw):
            if action=='status': return {'work':{'jobs':[]}}
            return {'progress':{'status':'complete','committed_pages':1,'terminal':True,
                                'body':'private-target','provider_cursor':'private-token'}}
        result=execute(plan,request,lambda _:None)
        self.assertEqual(result['rooms'][0]['state'],'complete')
        self.assertEqual(result['rooms'][0]['coverage_state'],'unknown')
        self.assertNotIn('private',json.dumps(plan))

    def test_connected_page_deduplicates_within_page_and_handles_invalid_entries(self):
        for messages, expected in [([{'id':'m','ts':8},{'id':'m','ts':8}], 'complete'),
                                   ([None], 'uncertain')]:
            plan=self.plan(); item=plan['spec']['rooms'][0]
            item['chat']['chat_id']='123'; plan['plan_id']=identity(plan['spec'])
            def request(group,action,payload,**kw):
                if action=='status': return {'work':{'jobs':[]}}
                if group=='sync': raise ValueError('unavailable')
                return {'messages':messages,'complete':True}
            result=execute(plan,request,lambda _:None)['rooms'][0]
            self.assertEqual(result['state'],expected)
            if expected=='complete': self.assertEqual(result['event_count'],1)
            else: self.assertEqual(result['reason'],'response_failed')

    def test_connected_live_job_matches_raw_daemon_scope(self):
        plan=self.plan(); item=plan['spec']['rooms'][0]
        item['chat']['chat_id']='telegram:chat:123'; plan['plan_id']=identity(plan['spec'])
        plan['results'][identity(item)]={'state':'uncertain','reader':'account_messages','pages_read':0}
        def request(group,action,payload,**kw):
            self.assertEqual((group,action),('sync','status'))
            return {'work':{'jobs':[{'id':'live','operation':'account.messages','state':'running',
                                    'scope':{'platform':'telegram','account':'a','chat_id':'123'}}]}}
        result=execute(plan,request,lambda _:None)
        self.assertEqual(result['rooms'][0]['state'],'waiting')
        self.assertEqual(result['requests_this_run'],0)

    def test_private_atomic_plan_and_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/'collection'
            with locked(root):
                with self.assertRaises(BlockingIOError):
                    with locked(root): pass
                path=root/'plan.json'
                save_plan(path,self.plan())
                self.assertEqual(path.stat().st_mode & 0o777,0o600)
                self.assertEqual(root.stat().st_mode & 0o777,0o700)
                link=root/'link.json'; link.symlink_to(path)
                with self.assertRaisesRegex(ValueError,'invalid_plan_path'):
                    save_plan(link,{})

    def test_full_inventory_is_one_frozen_snapshot_and_kakao_first(self):
        calls=[]
        def request(group,action,payload):
            calls.append((group,payload))
            if group=='trajectory':return {'rooms':[]}
            if not payload.get('cursor'):
                return {'chats':[{'platform':'slack','account':'s','chat_id':'room'},{'platform':'kakao','account':'k','chat_id':'z'}], 'next_cursor':'page2','errors':[{'platform':'telegram','account':'t','message':'private error'}],'refreshing':False}
            return {'chats':[{'platform':'kakao','account':'k','chat_id':'a'}],'next_cursor':None}
        rooms,errors=connected_inventory(request,['kakao','telegram','slack'])
        self.assertEqual(sum(p.get('refresh') is True for g,p in calls if g=='account'),1)
        plan=make_full_plan(rooms,errors)
        self.assertEqual([i['chat']['platform'] for i in plan['spec']['rooms']],['kakao','kakao','slack'])
        self.assertFalse(plan['inventory_complete']);self.assertNotIn('private',json.dumps(plan))

    def test_full_collection_has_no_total_page_cap_and_resumes_durable_state(self):
        plan=make_full_plan([{'chat':{'platform':'kakao','account':'a','chat_id':'r'}}]); committed=[0]
        def request(group,action,payload,**kw):
            if action=='status':return {'work':{'jobs':[]}}
            self.assertEqual(payload['reader'],'connected_account')
            if not payload.get('status_only'):committed[0]+=1
            return {'progress':{'status':'complete' if committed[0]==1100 else 'pending','committed_pages':committed[0],'terminal':committed[0]==1100},'event_count':100,'inserted':100}
        first=execute_full(plan,request,lambda _:None,max_requests=1001)
        self.assertEqual(first['rooms'][0]['pages_read'],1001)
        second=execute_full(plan,request,lambda _:None,max_requests=1000)
        self.assertEqual(second['rooms'][0]['state'],'complete')
        self.assertEqual(second['rooms'][0]['pages_read'],1100)
        self.assertEqual(second['rooms'][0]['coverage_state'],'unknown')

    def test_full_timeout_reconciles_commit_before_retry_and_bounds_provider_failure(self):
        plan=make_full_plan([{'chat':{'platform':'kakao','account':'a','chat_id':'r'}}]);reads=[];committed=[0];clock=[0]
        def request(group,action,payload,**kw):
            if action=='status':return {'work':{'jobs':[]}}
            if payload.get('status_only'):return {'progress':{'status':'pending','committed_pages':committed[0]}}
            reads.append(1)
            if len(reads)==1:committed[0]+=1
            raise ValueError('request_outcome_unknown')
        execute_full(plan,request,lambda _:None,max_requests=1,now=lambda:clock[0])
        # A committed timeout clears the earlier backoff immediately.
        result=execute_full(plan,request,lambda _:None,max_requests=1,now=lambda:clock[0])['rooms'][0]
        self.assertEqual(result['pages_read'],1);self.assertEqual(len(reads),2)
        for _ in range(6):
            clock[0]+=300; result=execute_full(plan,request,lambda _:None,now=lambda:clock[0])['rooms'][0]
        self.assertEqual(result['state'],'blocked')
        self.assertEqual(result['terminal_reason'],'provider_failure_after_bounded_retries')
        self.assertEqual(len(reads),6)


if __name__ == '__main__':
    unittest.main()
