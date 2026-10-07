"""Materialize latest incoming-only context snapshots without a self gold reply."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import time
from behavior_audit import client, digest, read, serve, write_private
import history as h
from kakao_local_import import OwnerRpc
from worker import compile_prompt, build_generation_input


def operational_prefix_tokens(tokenizer, inputs):
    rendered = tokenizer.apply_chat_template(inputs,tokenize=False,add_generation_prompt=True,enable_thinking=False)
    return tokenizer.encode(rendered,add_special_tokens=False)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan', required=True, type=Path)
    p.add_argument('--frozen-grant', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    a = p.parse_args()
    plan = read(a.plan)
    grant = read(a.frozen_grant)
    # Authenticated adapter identity already verified by exact original recovery.
    identity_scopes = {}
    for identity in grant['train_ids'] + grant['quality_context_ids']:
        scope = tuple(json.loads(identity[5:])[:2])
        identity_scopes.setdefault(scope,identity)
    identity_records = client(grant, {'op':'records', 'ids':list(identity_scopes.values())})['cases']
    identities = {(c['record']['chat']['platform'],c['record']['chat']['account']): c['record']['self_identity']['author_id'] for c in identity_records if c['record'].get('self_identity',{}).get('state') == 'known'}
    rooms = [r for r in plan['rooms'] if r.get('potential_new_room') and r.get('after_original_cutoff')]
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(str(Path.home()/'.inboxd/reply-model/models/Qwen3.5-9B-4bit'),local_files_only=True)
    entries, records, tokens, metadata = [], {}, {}, {}
    rpc = OwnerRpc()
    try:
        for scope in rooms:
            platform, account, cid, _ = json.loads(scope['chat'])
            chat = {'platform':platform,'account':account,'chat_id':cid}
            result = rpc.request('message.inbox',{'chat':chat,'limit':40})
            messages = sorted(result.get('messages',[]),key=lambda m:(m['ts'],m['msg_id']))
            own = identities.get((platform,account))
            context = [{'message_id':m['msg_id'],'author_role': ('self' if str(m.get('author_id')) == str(own) else 'other') if own is not None and m.get('author_id') is not None else 'unknown',
                        'author_id':m.get('author_id'),'body':m['body'],'ts':m['ts'],
                        'reply_to':None,'content_kind':'unverified_message_inbox_projection'} for m in messages if isinstance(m.get('body'),str)]
            hard = []
            if own is None:
                hard.append('self_identity_unavailable')
            if not context:
                hard.append('no_human_context')
            compiled, omitted = compile_prompt({'chat':chat,'context':context})
            preflight = json.loads(compiled[-1]['content'])['preflight']
            if preflight['status'] != 'ready':
                hard.append(preflight['reason'])
            if omitted:
                hard.append('context_compiler_omitted_messages')
            inputs = build_generation_input(compiled)
            prefix = operational_prefix_tokens(tokenizer,inputs)
            if len(prefix)>3904:
                hard.append('operational_context_token_budget_exceeded')
            target_id = context[-1]['message_id'] if context else 'empty'
            identity = 'incoming:'+h.source_key(chat,target_id)
            keys = sorted(h.source_key(chat,m['message_id']) for m in context)
            row = {'id':identity,'chat':scope['chat'],'timestamp':context[-1]['ts'] if context else None,
                   'context_hash':digest(inputs),'source_keys_hash':digest(keys),'source_message_keys':keys,
                   'lineage_verified':True,'hard_exclusion_codes': sorted(set(hard)),
                   'prompt_tokens':len(prefix),'context_message_count':len(context),
                   'earliest_context_ts':context[0]['ts'] if context else None,
                   'context_timestamps':[m['ts'] for m in context],
                   'latest_snapshot_matches_inventory_latest':bool(context) and context[-1]['ts']==scope.get('latest_ts'),
                   'preflight':preflight,'privacy_review_status':'pending_whole_context_semantic_policy_review',
                   'native_content_kind_and_reply_linkage_verified':False,
                   'historical_target_exists':False,'historical_target_excluded':True,
                   'bounded_latest_context_limit':40,'input_information_limits':['message.inbox projection omits native content-kind and reply-to evidence; source sufficiency needs review','No historical self target in these snapshots.']}
            entries.append(row)
            # Retain even projection-limited cases for inspection; ready is never
            # asserted by this acquisition process or by preflight alone.
            record = {'id':identity,'chat':chat,'context':context,'targets':[],
                      'messages':inputs+[{'role':'assistant','content':''}],
                      'source_message_keys':keys,'self_identity':{'state':'known' if own else 'unknown','author_id':own}}
            record['review_hash']=digest(record)
            row['review_hash']=record['review_hash']
            records[identity]=record
            tokens[identity]={'prompt_tokens':prefix,'answer_tokens':[]}
            metadata[identity]=row
    finally:
        rpc.close()
    packet={'schema':'fresh-candidate-inventory-v1','axis':'incoming_only_never_exposed_room',
            'entries':entries,'exposure_scan_complete':True,'exposure_evidence_scope':'Recorded artifact union only',
            'current_room_count':len(rooms),'snapshot_count':len(entries),
            'hard_exclusion_counts':dict(Counter(c for r in entries for c in r['hard_exclusion_codes'])),
            'privacy_review_status':'pending_whole_context_semantic_policy_review',
            'full_policy_hashes':{str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in (Path.home()/'.inboxd/reply-model/learning/granite-fullpool-20261006-v1').glob('*policy*.json')},
            'selected_or_ready_claimed':False,'bodies_persisted':0,'token_arrays_persisted':0,
            'plan_raw_sha256':hashlib.sha256(a.plan.read_bytes()).hexdigest(),'collected_at':time.time()}
    packet['inventory_hash']=digest(packet)
    write_private(a.output/'incoming-context-inventory.json',packet)
    print(json.dumps({'phase':'incoming_acquired','snapshot_count':len(entries),'context_messages':sum(r['context_message_count'] for r in entries),'hard_exclusion_counts':packet['hard_exclusion_counts']}),flush=True)
    serve(records,tokens,metadata,set(),set(records),a.output)


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'phase':'failed','error_type':type(error).__name__,'bodies_logged':False}),flush=True)
        raise SystemExit(1)
