"""Materialize full historical input windows from actual-unused rooms in RAM."""
from collections import Counter
import json
from pathlib import Path
import time
from behavior_audit import read, write_private, digest, serve
from kakao_local_import import OwnerRpc
from incoming_behavior_owner import operational_prefix_tokens
import history as h
from history_snapshot import OwnerHistoryQuery

ROOT=Path.home()/'.inboxd/reply-model/evaluations/fresh-expansion-20261006-v1'

def main():
    used=read(ROOT/'actual-model-used-source-manifest-v2.json')
    usedrooms={h.source_key(dict(zip(('platform','account','chat_id'),json.loads(e['id'][5:])[:3])), '')
               for e in used['entries'] if e['id'].startswith('hist:')}
    usedkeys=set(used['source_keys_actual_use_union'])|set(used['source_keys_runtime_uncertain_union'])
    fullpool=read(Path.home()/'.inboxd/reply-model/learning/granite-fullpool-20261006-v1/final-fullpool-coverage.json')
    assessedkeys={k for e in fullpool['entries'] for k in e['source_message_keys']}
    assessedrooms={h.source_key(dict(zip(('platform','account','chat_id'),json.loads(k)[:3])),'') for k in assessedkeys}
    rpc=OwnerRpc()
    inventory=h.collect_inventory(OwnerHistoryQuery(rpc))
    storepath=ROOT/'post-additional-store-inventory.json'
    if not storepath.exists():write_private(storepath,inventory)
    selected=[r for r in inventory['rooms'] if r['chat']['platform'] in ('kakao','telegram')
              and h.source_key(r['chat'],'') not in usedrooms and r.get('self_message_count',0)>0]
    plan={'schema':'actual-unused-room-extraction-plan-v1','frozen_at':time.time(),
        'rooms':selected,'actual_model_use_manifest_hash':used['manifest_hash'],
        'complete_original_history_windows':True,'historical_target_hidden':True,
        'maximum_body_file_count':0,'semantic_selection_performed':False}
    planpath=ROOT/'primary-extraction-plan-frozen.json'
    if planpath.exists():
        plan=read(planpath);selected=plan['rooms']
    else:write_private(planpath,plan)
    raw=[];rooms=[]
    try:
        for scope in selected:
            chat=scope['chat']
            found,omitted=h.collect(OwnerHistoryQuery(rpc),**chat,limit=5)
            raw.extend(found)
            rooms.append({'chat':h.source_key(chat,''),'raw_candidates':len(found),'omitted':len(omitted)})
            print(json.dumps({'phase':'primary_room_extraction','completed':len(rooms),'planned':len(selected),
                'raw_candidates_total':len(raw)}),flush=True)
    finally:
        rpc.close()
    grouped,gaps=h.group_turns(raw)
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(str(Path.home()/'.inboxd/reply-model/models/Qwen3.5-9B-4bit'),local_files_only=True)
    records={};tokens={};entries=[];metadata={}
    for row in grouped:
        record=h.candidate_record(row,gap_policy=gaps)
        inputs=record['messages'][:-1]
        context=record['context'];keys=record['source_message_keys'];room=h.source_key(record['chat'],'')
        codes=set(record['reasons'])&(h.ARCHIVE_HARD_REASONS|{'preflight_not_ready','self_identity_unknown','reply_target_mismatch'})
        prefix=operational_prefix_tokens(tokenizer,inputs) if inputs else []
        if not inputs or len(prefix)>3904:
            codes.add('operational_input_unavailable_or_over_budget')
        actual_overlap=len(set(keys)&usedkeys);assessed_overlap=len(set(keys)&assessedkeys)
        if actual_overlap:codes.add('actual_model_used_source_overlap')
        if assessed_overlap:codes.add('prior_assessed_source_overlap')
        entry={'id':record['id'],'chat':room,'timestamp':record['timestamp'],
            'input_hash':digest(inputs),'context_hash':digest(context),'source_keys_hash':digest(keys),
            'source_message_keys':keys,'context_source_message_keys':[h.source_key(record['chat'],m['message_id']) for m in context],
            'lineage_verified':True,'preflight_ready':'preflight_not_ready' not in record['reasons'] and bool(inputs),
            'privacy_status':'pending','historical_target_hidden':True,'historical_target_exists':True,
            'room_exposure_class':'reviewed_only' if room in assessedrooms else 'metadata_only',
            'actualused_source_intersection_count':actual_overlap,'prior_assessed_source_intersection_count':assessed_overlap,
            'hard_exclusion_codes':sorted(codes),'prompt_tokens':len(prefix),'context_message_count':len(context),
            'context_timestamps':[m['ts'] for m in context],'context_only_information_limits':record['reasons'],
            'after_cutoff':record['timestamp']>1791007957.03615,
            'wholecontextaftercutoff':bool(context) and all(m['ts']>1791007957.03615 for m in context),
            'full_input_integrity_verified':True,'exact_duplicate_count':None,'near_duplicate_count':None,
            'semantic_duplicate_status':'uncertain','source_audit_verified':False,'all_prior_use_scan_complete':False,
            'rubric_frozen':False,'independent_input_review_complete':False,'old54_overlap':None}
        entries.append(entry)
        if not codes:
            record=dict(record);record['targets']=[]
            # Blank compatibility assistant is removed by serve() on every read.
            record['messages']=inputs+[{'role':'assistant','content':''}]
            record['target_source_keys']=record.get('target_source_keys',[])
            record['target_source_message_keys']=record.get('target_source_message_keys',[])
            records[record['id']]=record;tokens[record['id']]={'prompt_tokens':prefix,'answer_tokens':[]}
            metadata[record['id']]=entry
    raw.clear();grouped.clear()
    packet={'schema':'fresh-expansion-context-inventory-v1','entries':entries,'room_counts':rooms,
        'actual_unused_room_count':len(selected),'raw_candidate_count':sum(r['raw_candidates'] for r in rooms),
        'grouped_candidate_count':len(entries),'retained_for_context_review':len(records),
        'data_ready_claimed':False,'inference_ready':False,'bodies_saved':0,
        'hard_exclusion_counts':dict(Counter(c for e in entries for c in e['hard_exclusion_codes'])),
        'collected_at':time.time()}
    write_private(ROOT/'primary-context-inventory.json',packet)
    print(json.dumps({'phase':'primary_contexts_materialized','rooms':len(selected),'grouped':len(entries),
        'reviewable':len(records),'hard_exclusion_counts':packet['hard_exclusion_counts']}),flush=True)
    output=ROOT/'primary-owner';output.mkdir(mode=0o700,exist_ok=True)
    serve(records,tokens,metadata,set(),set(records),output)

if __name__=='__main__':
    try:main()
    except Exception as e:
        import traceback
        print(json.dumps({'phase':'owner_failed','error_type':type(e).__name__,
            'stack':[(x.name,x.lineno) for x in traceback.extract_tb(e.__traceback__)],
            'bodies_logged':False}),flush=True)
        raise SystemExit(1)
