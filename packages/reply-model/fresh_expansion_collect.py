"""Bounded additional owner collection; receipts never contain message bodies."""
import hashlib
import json
from pathlib import Path
import plistlib
import time
from behavior_audit import write_private, read, digest
from kakao_local_import import (OwnerRpc, local_reader, metadata, snapshot_hash,
    observations, pages, encoded, message_digest, save_metadata)

ROOT = Path.home()/'.inboxd/reply-model/evaluations/fresh-expansion-20261006-v1'

def inbox(rpc, chat):
    # Daemon's bounded response frame can reject text-heavy larger pages.
    params = {'chat': chat, 'limit': 5}
    seen = set()
    while True:
        page = rpc.request('message.inbox', params)
        yield from page.get('messages', [])
        cursor = page.get('next_cursor')
        if cursor is None:
            break
        if cursor in seen:
            raise ValueError('cursor_repeated')
        seen.add(cursor)
        params['cursor'] = cursor

def seal_inventory():
    base = Path.home()/'.inboxd/reply-model'
    roots = [base/'learning/granite-fullpool-20261006-v1',
             base/'evaluations/granite-finetune-20261006',
             base/'learning/expansion-20261003']
    return {str(p):hashlib.sha256(p.read_bytes()).hexdigest()
            for r in roots for p in r.rglob('*') if p.is_file()}

def main():
    discovery = read(ROOT/'source-discovery.json')
    now = discovery['captured_unix']
    plan = {'schema':'additional-collection-plan-v1','frozen_at':time.time(),
        'kakao':{'snapshot_sha256':discovery['kakao_local']['snapshot_sha256'],
                 'rooms':discovery['kakao_local']['rooms'],
                 'policy':'absent_canonical_ids_only; preserve_existing_native_provenance',
                 'maximum_new_records':5000,'maximum_records_per_page':100},
        'telegram':{'rooms':[x for x in discovery['provider_directory']['rooms'] if x['platform']=='telegram'],
                    'interval':{'from_ts':now-365*86400,'to_ts':now},
                    'pages_per_room':4,'records_per_page':30,'maximum_requests':44,
                    'reader':'authenticated_account.messages; no coverage certification'},
        'bodies_persisted_outside_encrypted_daemon':0,'send_messages':False}
    plan['plan_hash']=digest(plan)
    if (ROOT/'additional-collection-plan-frozen.json').exists():
        plan=read(ROOT/'additional-collection-plan-frozen.json')
    else:
        write_private(ROOT/'additional-collection-plan-frozen.json',plan)
    if (ROOT/'sealed-baseline.json').exists():
        sealed=read(ROOT/'sealed-baseline.json')['sha256_by_path']
    else:
        sealed=seal_inventory()
        write_private(ROOT/'sealed-baseline.json',{'sha256_by_path':sealed})
    rpc = OwnerRpc()
    report = {'schema':'additional-collection-receipt-v1','plan_hash':plan['plan_hash'],
              'state':'collecting','kakao':{},'telegram':[],'bodies_saved':0}
    try:
        with local_reader() as (reader,user_id,account,sizes):
            summary = metadata(reader,user_id)
            actualsha = snapshot_hash(reader.path)
            if actualsha != plan['kakao']['snapshot_sha256']:
                # Body selection starts only after binding this stable encrypted snapshot.
                refreeze=ROOT/('kakao-snapshot-refreeze-'+actualsha[:16]+'.json')
                binding={
                    'frozen_at':time.time(),'original_plan_hash':plan['plan_hash'],
                    'snapshot_sha256':actualsha,'metadata':summary,'encrypted_sizes':sizes,
                    'selection_policy':plan['kakao']['policy'],'budget':5000}
                if not refreeze.exists():
                    write_private(refreeze,binding)
            baseline = {}
            for row in plan['kakao']['rooms']:
                chat={'platform':'kakao','account':account,'chat_id':row['chat_id']}
                for message in inbox(rpc,chat):
                    key=message.get('key',message); identity=(key['chat_id'],key['msg_id'])
                    baseline[identity]=message_digest(message)
            delta=[]; tombstone=0
            for row in observations(reader):
                identity=(row['chat_id'],row['id'])
                if identity in baseline:
                    continue
                existing=rpc.request('message.get',{'chat':{'platform':'kakao','account':account,
                    'chat_id':row['chat_id']},'msg_id':row['id']}).get('message')
                if existing is not None:
                    tombstone+=1
                    continue
                delta.append(row)
                if len(delta)>5000:
                    raise ValueError('delta_budget_exceeded')
            app=plistlib.loads(Path('/Applications/KakaoTalk.app/Contents/Info.plist').read_bytes())
            source={'snapshot_sha256':actualsha,'schema':'kakao-mac-sqlcipher-v1',
                'app_version':app['CFBundleShortVersionString'],'app_build':app['CFBundleVersion'],
                'compatibility':3,'snapshot_integrity':summary['integrity'],
                'snapshot_encrypted_sizes':sizes,'record_count':len(delta),
                'snapshot_record_count':summary['message_summary'][0],
                'room_count':len({x['chat_id'] for x in delta}),
                'from_ts':summary['message_summary'][2],'to_ts':summary['message_summary'][3],
                'timestamp_policy':'preserve_existing_canonical; raw_local_sentAt_retained',
                'native_delete_flag':16384,'selection_policy':'absent_canonical_ids_only',
                'schema_sha256':hashlib.sha256(encoded(list(reader.query(
                    'SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name')))).hexdigest(),
                'room_classification_policy':'native_type_retained_without_inference'}
            receipt={'snapshot_sha256':actualsha,'existing_live_baseline_count':len(baseline),
                'existing_hidden_records_omitted':tombstone,'new_records_selected':len(delta),
                'new_source_keys':[['kakao',account,x['chat_id'],x['id']] for x in delta],
                'pages':[],'old_canonical_changed':0,'old_canonical_missing':0}
            write_private(ROOT/'kakao-incremental-selection-frozen.json',receipt)
            for page in pages(delta,account,user_id,source):
                response=rpc.request('sync.backfill',page)
                if response.get('page_id')!=page['page_id'] or response.get('event_count')!=len(page['messages']):
                    raise ValueError('archive_ack_invalid')
                receipt['pages'].append({k:response.get(k) for k in ('page_id','event_count','inserted','stored','replayed')})
                report['kakao']=receipt
                save_metadata(ROOT/'additional-collection-progress.json',report)
            delta.clear()
            remaining=set(baseline)
            for row in plan['kakao']['rooms']:
                chat={'platform':'kakao','account':account,'chat_id':row['chat_id']}
                for message in inbox(rpc,chat):
                    key=message.get('key',message); identity=(key['chat_id'],key['msg_id'])
                    if identity in baseline:
                        remaining.discard(identity)
                        receipt['old_canonical_changed']+=message_digest(message)!=baseline[identity]
            receipt['old_canonical_missing']=len(remaining)
            report['kakao']=receipt
            print(json.dumps({'phase':'kakao_incremental_complete','new_records':receipt['new_records_selected'],
                'pages':len(receipt['pages']),'old_changed':receipt['old_canonical_changed'],
                'old_missing':len(remaining)}),flush=True)
        for chat in plan['telegram']['rooms']:
            row={'chat':chat,'page_count':0,'message_count':0,'in_range_count':0,
                 'source_keys':[],'state':'pending','coverage':'not_certified'}
            params={**chat,'limit':30}; seen=set()
            for _ in range(4):
                row['attempt_count']=row.get('attempt_count',0)+1
                try:
                    page=rpc.request('account.messages',params)
                except Exception as e:
                    row.update(state='request_failed',error_type=type(e).__name__)
                    break
                messages=page.get('messages',[])
                row['page_count']+=1
                for message in messages:
                    identity=str(message['id'])
                    if identity in seen:
                        continue
                    seen.add(identity);row['message_count']+=1
                    ts=message['ts']
                    row['in_range_count']+=plan['telegram']['interval']['from_ts']<=ts<=now
                    row['earliest_ts']=min(row.get('earliest_ts',ts),ts)
                    row['latest_ts']=max(row.get('latest_ts',ts),ts)
                    row['source_keys'].append(['telegram',chat['account'],chat['chat_id'],identity])
                cursor=page.get('next_cursor')
                if page.get('complete') is True:
                    row['state']='provider_complete';break
                if row.get('earliest_ts',now)<=plan['telegram']['interval']['from_ts']:
                    row['state']='interval_reached';break
                if not cursor or cursor==params.get('cursor'):
                    row['state']='cursor_unavailable';break
                params['cursor']=cursor
                row['state']='page_budget_exhausted'
            report['telegram'].append(row)
            save_metadata(ROOT/'additional-collection-progress.json',report)
            print(json.dumps({'phase':'telegram_room_read','rooms_completed':len(report['telegram']),
                'pages':row['page_count'],'records':row['message_count'],'state':row['state']}),flush=True)
    finally:
        rpc.close()
    report['sealed_files_verified']=len(sealed)
    report['sealed_files_changed']=[p for p,s in sealed.items() if not Path(p).exists() or hashlib.sha256(Path(p).read_bytes()).hexdigest()!=s]
    report['state']='complete';report['completed_at']=time.time()
    write_private(ROOT/'additional-collection-receipt.json',report)

if __name__=='__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'phase':'collection_failed','error_type':type(e).__name__,'bodies_logged':False}),flush=True)
        raise SystemExit(1)
