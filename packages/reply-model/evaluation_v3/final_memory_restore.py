"""Independent CPU-only exact final48 restoration; never renders bodies."""
import gc
import json
import os
from pathlib import Path
import signal
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
import history as h
import history_snapshot as hs
from kakao_local_import import OwnerRpc
from review_memory import PACKET_FIELDS,serve_review_memory
from review_sensitive import sensitive_admission_report
from independent import read,check_seal,seal,write_private,now
from checkpoint_dev import sha

STOP=False
def stop(*_):
    global STOP
    STOP=True

def roomof(identity):
    if not identity.startswith('hist:'):return None
    return h.source_key(dict(zip(('platform','account','chat_id'),json.loads(identity[5:])[:3])),'')

def verify_record(record,entry):
    values={'hash':record['review_hash'],
        'raw_content_hash':h.digest({'context':record['context'],'targets':record['targets']}),
        'input_hash':h.digest(record['messages'][:-1]),'target_hash':h.digest(record['messages'][-1:]),
        'source_keys_hash':h.digest(record['source_message_keys']),
        'input_tokens':record['input_tokens'],'target_tokens':record['target_tokens']}
    differences=[k for k,v in values.items() if v!=entry[k]]
    if differences:raise ValueError('selected_hash_mismatch')
    if not record['eligible_for_review'] or record['input_tokens']>3904:
        raise ValueError('selected_not_eligible')
    compiled,omitted=h.compile_prompt({'chat':record['chat'],'context':record['context'],
        'incoming_message_ids':record.get('incoming_message_ids')})
    if (omitted or h.build_generation_input(compiled)!=record['messages'][:-1]
            or record['messages'][-1]['role']!='assistant'
            or record['messages'][-1]['content']!='\n'.join(t['body'] for t in record['targets'])):
        raise ValueError('selected_compile_target_parity_mismatch')


class Memory:
    def __init__(self,cases,availability,entries,plan,q49,q95):
        self.cases=cases;self.availability=availability;self.entries=entries
        self.plan=plan;self.q49=q49;self.q95=q95;self.audit=[]
        self.hashes={i:h.digest(c) for i,c in cases.items()}
        self.shard_hash=h.digest(entries)
    def packet(self,request):
        if (not isinstance(request,dict) or set(request)!={'shard_index','shard_hash','entries'}
                or request['shard_index']!=0 or request['shard_hash']!=self.shard_hash):
            raise ValueError('ungranted_request')
        es=request['entries'];allowed={e['id']:e['hash'] for e in self.entries}
        if (not isinstance(es,list) or not 1<=len(es)<=10
                or len({e.get('id') for e in es if isinstance(e,dict)})!=len(es)
                or any(not isinstance(e,dict) or set(e)!={'id','hash'}
                       or allowed.get(e['id'])!=e['hash'] for e in es)):
            raise ValueError('ungranted_entry')
        packets=[]
        for e in es:
            c=self.cases.get(e['id'])
            if c is None:
                packets.append({**self.availability[e['id']],'approvable':False,'split':'test'})
                continue
            if h.digest(c)!=self.hashes[e['id']]:raise ValueError('memory_changed')
            for q in (self.q49,self.q95):
                kept,blocked=sensitive_admission_report([c],q)
                if blocked or len(kept)!=1:raise ValueError('screening_changed')
            packets.append(c)
        response={'snapshot_hash':self.plan['snapshot_hash'],'split':'test','shard_index':0,
            'cases':packets,'case_count':len(packets),'selected_allowlist_hash':self.plan['allowlist_hash'],
            'quarantine_hash':self.q49['quarantine_hash'],
            'fresh_screening_quarantine_hash':self.q95['quarantine_hash'],
            'historical_targets_model_input':False,'model_input_field':'messages[:-1]'}
        encoded=json.dumps(response,ensure_ascii=False,separators=(',',':')).encode()+b'\n'
        if len(encoded)>524288:raise ValueError('response_budget_exceeded')
        self.audit.append({'case_count':len(packets),'packet_hash':h.digest(response),'response_bytes':len(encoded)})
        return encoded
    def clear(self):self.cases.clear();self.hashes.clear();self.availability.clear()


def restore(plan_path):
    plan=read(plan_path);check_seal(plan,'plan_hash');folder=Path(plan['output'])
    if sha(__file__)!=plan['producer_sha256']:raise ValueError('producer_changed')
    if any(sha(path)!=v for path,v in plan['file_sha256'].items()):raise ValueError('frozen_source_changed')
    snapshot=read(plan['snapshot_path']);selected=read(plan['allowlist_path']);admission=read(plan['admission_path'])
    check_seal(selected,'allowlist_hash');check_seal(admission,'admission_hash')
    if h.digest({k:v for k,v in snapshot.items() if k not in ('snapshot_hash','created_at')})!=plan['snapshot_hash']:
        raise ValueError('snapshot_changed')
    entries=selected['entries'];byid={e['id']:e for e in entries};rooms=sorted({e['chat'] for e in entries})
    if (len(entries)!=48 or len(byid)!=48 or rooms!=plan['rooms']
            or entries!=admission['entries'] or snapshot['source']['watermark_ts']!=plan['watermark']):
        raise ValueError('frozen_selection_changed')
    quality={q['id']:q for q in admission['case_quality_records']}
    for e in entries:
        q=quality[e['id']];check_seal(q,'quality_hash')
        if q['quality_hash']!=e['quality_hash'] or h.digest(q['rubric'])!=plan['rubric_hashes'][e['id']]:
            raise ValueError('frozen_rubric_changed')
    q49=read(plan['quarantine49_path']);q95=read(plan['quarantine95_path'])
    for q in (q49,q95):check_seal(q,'quarantine_hash')
    if (q49['quarantine_hash']!=plan['quarantine49_hash'] or q95['quarantine_hash']!=plan['quarantine95_hash']
            or not set(q49['source_keys'])<=set(q95['source_keys'])):
        raise ValueError('immutable_quarantines_changed')
    from mlx_lm.utils import load_tokenizer
    tokenizer=load_tokenizer(plan['model_path'])
    expected={room:{x['id']:x for x in snapshot['source']['rows'] if roomof(x['id'])==room} for room in rooms}
    cases={};availability={};reads=[];rpc=None;started=time.monotonic()
    screen_counts={'old49_screened':0,'old49_excluded':0,'fresh95_screened':0,'fresh95_excluded':0}
    def unavailable(e,reason):
        availability[e['id']]={'id':e['id'],'hash':e['hash'],'status':'unavailable','reason':reason}
    try:
        rpc=OwnerRpc(timeout=30);status=rpc.request('system.status',{})
        if not (status.get('ready') is True and status.get('encryption',{}).get('ready') is True
                and status['encryption'].get('schema_valid') is True and status['encryption'].get('schema_version')==7):
            raise ValueError('owner_not_ready')
        write_private(folder/'rpc-open.json',seal({'plan_hash':plan['plan_hash'],'owner_pid':os.getpid(),
            'opened_at_utc':now(),'scope_room_count':10},'open_hash'))
        query=hs.OwnerHistoryQuery(rpc)
        for room in rooms:
            if STOP:raise ValueError('restoration_interrupted')
            platform,account,chat_id,_=json.loads(room);scope_entries=[e for e in entries if e['chat']==room]
            pages=[0]
            rows,omitted=h.collect(query,platform=platform,account=account,chat_id=chat_id,
                progress=lambda p:pages.__setitem__(0,p['pages']))
            if any(h.source_key(row['chat'],'')!=room for row in rows):raise ValueError('room_scope_changed')
            captured=[r for r in rows if r['timestamp']<=plan['watermark']]
            newer=[r for r in rows if r['timestamp']>plan['watermark']]
            meta=hs.source_manifest(captured,omitted);actual={r['id']:r for r in meta['rows']};ex=expected[room]
            source_ok=(actual==ex and not omitted and len(actual)==len(captured))
            reads.append({'room':room,'captured_count':len(captured),'expected_count':len(ex),'pages':pages[0],
                'newer_deferred_count':len(newer),'raw_metadata_hash':h.digest(meta),'source_exact':source_ok})
            if not source_ok:
                for e in scope_entries:unavailable(e,'frozen_room_source_mismatch')
            else:
                prepared,_=h.prepare_candidates(captured,session_rows=(),tokenizer=tokenizer,
                    max_seq_length=4096,generation_limit=192,gap_policy=snapshot['gap_policy_seconds'])
                records={r['id']:r for r in prepared if r['id'] in byid}
                for e in scope_entries:
                    record=records.get(e['id'])
                    if record is None:unavailable(e,'selected_grouped_candidate_missing');continue
                    try:verify_record(record,e)
                    except (ValueError,KeyError,TypeError):unavailable(e,'selected_hash_or_parity_mismatch');continue
                    rejected=False
                    for label,q in (('old49',q49),('fresh95',q95)):
                        screen_counts[label+'_screened']+=1
                        kept,blocked=sensitive_admission_report([record],q)
                        if blocked or len(kept)!=1:
                            rejected=True;screen_counts[label+'_excluded']+=1
                    if rejected:unavailable(e,'sensitive_source_exclusion');continue
                    packet={k:record[k] for k in PACKET_FIELDS if k in record}
                    cases[e['id']]=packet;availability[e['id']]={'id':e['id'],'hash':e['hash'],'status':'ready',
                        'source_input_target_raw_hashes_exact':True,'compiled_target_parity_exact':True,
                        'quality_hash':e['quality_hash'],'rubric_hash':plan['rubric_hashes'][e['id']],
                        'screen49_pass':True,'screen95_pass':True}
                del prepared,records
            rows.clear();captured.clear();newer.clear();gc.collect()
    except BaseException as exc:
        for e in entries:
            if e['id'] not in availability:unavailable(e,'restoration_rpc_or_preparation_failed')
        failure=type(exc).__name__
    else:failure=None
    finally:
        if rpc is not None:rpc.close()
        rpc=None;query=None;del tokenizer;gc.collect()
        write_private(folder/'rpc-closed.json',seal({'plan_hash':plan['plan_hash'],'owner_pid':os.getpid(),
            'closed_at_utc':now(),'rpc_closed':True},'closed_hash'))
    assert set(availability)==set(byid)
    public=[{k:e[k] for k in ('id','hash','chat')} for e in entries]
    memory=Memory(cases,availability,public,plan,q49,q95)
    with serve_review_memory(memory) as path:
        grant=seal({'version':'final48-restored-memory-v2','split':'test','socket_path':str(path),
            'snapshot_hash':plan['snapshot_hash'],'selection_freeze_hash':selected['selection_freeze_hash'],
            'selected_allowlist_hash':selected['allowlist_hash'],'quarantine_hash':q49['quarantine_hash'],
            'fresh_screening_quarantine_hash':q95['quarantine_hash'],'shard_index':0,'shard_hash':memory.shard_hash,
            'entries':public,'count':48,'ready_count':len(cases),'unavailable_count':48-len(cases),
            'max_batch':10,'max_response_bytes':524288,'request_keys':['shard_index','shard_hash','entries'],
            'owner_pid':os.getpid(),'only_assigned_evaluator_access':True,'model_input_field':'messages[:-1]',
            'historical_targets_model_input':False,'restoration_plan_hash':plan['plan_hash']},'grant_hash')
        write_private(folder/'review-grant-final48-only.json',grant)
        proof=seal({'schema':'final48-restoration-proof-v2','plan_hash':plan['plan_hash'],'owner_pid':os.getpid(),
            'grant_hash':grant['grant_hash'],'selected_allowlist_hash':selected['allowlist_hash'],
            'admission_hash':admission['admission_hash'],'snapshot_hash':plan['snapshot_hash'],
            'room_count':10,'captured_raw_count':sum(r['captured_count'] for r in reads),'rooms':reads,
            'watermark':plan['watermark'],'rpc_closed':True,'count':48,'ready_count':len(cases),
            'unavailable_count':48-len(cases),'availability':[availability[e['id']] for e in entries],
            'old49_screen_hash':q49['quarantine_hash'],'fresh95_screen_hash':q95['quarantine_hash'],
            'screen_counts':screen_counts,
            'fresh95_ready_exclusions':0,'all48_exact':len(cases)==48,'failure_class':failure,
            'old_artifacts_unchanged':True,'rubrics_unchanged':True,'no_bodies_persisted_or_rendered':True,
            'GPU_or_generation_executed':False,'elapsed_seconds':round(time.monotonic()-started,2)},'proof_hash')
        write_private(folder/'restoration-proof.json',proof)
        # Fixed granted packets are checked entirely in memory; no contents emitted.
        for e in public:memory.packet({'shard_index':0,'shard_hash':memory.shard_hash,'entries':[{'id':e['id'],'hash':e['hash']}]})
        print(json.dumps({k:proof[k] for k in ('owner_pid','plan_hash','grant_hash','proof_hash','room_count',
            'captured_raw_count','count','ready_count','unavailable_count','rpc_closed','all48_exact','elapsed_seconds')}),flush=True)
        while not STOP:time.sleep(.5)
        write_private(folder/'shutdown-audit.json',seal({'grant_hash':grant['grant_hash'],
            'packet_audit':memory.audit,'body_values_persisted':False},'audit_hash'))


if __name__=='__main__':
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try:restore(Path(sys.argv[1]))
    except BaseException as exc:
        print(json.dumps({'status':'restoration_failed','error_class':type(exc).__name__}),flush=True)
        sys.exit(1)
