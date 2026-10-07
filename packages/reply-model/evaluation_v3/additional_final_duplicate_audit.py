"""Authorized local-memory new39 vs sealed final96 boundary comparison only.

No OwnerRpc, tokenizer, model, generation, admission changes or corpus files.
Only metadata reports persist; complete input/target bodies remain transient.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import socket
import sys

from independent import read, check_seal, digest, seal, write_private, now, load_suite
from checkpoint_dev import sha
from input_duplicate_audit import feature, compare_groups

NEW39_HELPER_SHA = '647764bb98f7aeeda394703d6daee242eeba4bc4154c8ac42af7151d70228de7'
FINAL_GRANT_HASH = '689afe62fce2e8fb1c82d77ec583c6b032f4004adb5397042d56988c905346e9'
ADMISSION_HASH = 'f8d6b617a8056db642728f4eae3c91a794dd2985bca3b8c1efb5994010b1c2e9'
OLD49 = 'fbd4cad7c22edaedd8e04e5e8931c352fc0c4e1c75163b9f3379d6d07879d2bc'
NEW95 = 'c4be24d1427a194cde12b64c7fa37585c7dd7a9186078b1fea4645104c31c4f6'
ORIGINAL_AUDIT_HASH = 'b33c5ac6bd9e59d037d700deb030575989c2787a885f763b85e5e2afd983d4e7'


def require(condition, reason):
    if not condition:raise ValueError(reason)


def validate_final_packet(packet, selected, grant):
    require(packet['split']=='test' and packet['snapshot_hash']==grant['snapshot_hash']
            and packet['case_count']==len(selected)
            and len(packet['cases'])==len(selected)
            and {r['id'] for r in packet['cases']}=={e['id'] for e in selected},
            'exact_final_packet_scope_required')
    expected={e['id']:e for e in selected}
    for record in packet['cases']:
        e=expected[record['id']];messages=record['messages']
        require(record.get('approvable') is not False and record['review_hash']==e['hash']
                and messages[-1]['role']=='assistant'
                and digest({'context':record['context'],'targets':record['targets']})==e['raw_content_hash']
                and digest(messages[:-1])==e['input_hash']
                and digest(messages[-1:])==e['target_hash']
                and digest(record['source_message_keys'])==e['source_keys_hash']
                and '\n'.join(t['body'] for t in record['targets'])==messages[-1]['content'],
                'original_final_hash_and_target_boundary_required')
    return packet['cases']


def fetch_final_records(grant_path, admission_path):
    require(Path(grant_path).name=='review-grant-final48-only.json', 'final_only_grant_filename_required')
    grant,admission=read(grant_path),read(admission_path)
    check_seal(grant,'grant_hash');check_seal(admission,'admission_hash')
    require(grant['grant_hash']==FINAL_GRANT_HASH and admission['admission_hash']==ADMISSION_HASH
            and grant['count']==len(admission['entries'])==48 and grant['split']=='test'
            and grant['selected_allowlist_hash']==admission['allowlist_hash']
            and grant['selection_freeze_hash']==admission['selection_freeze_hash']
            and grant['snapshot_hash']==admission['snapshot_hash']
            and grant['quarantine_hash']==admission['latest_quarantine_hash']==OLD49
            and grant['fresh_screening_quarantine_hash']==NEW95
            and grant['historical_targets_model_input'] is False
            and grant['model_input_field']=='messages[:-1]'
            and grant['entries']==[{k:e[k] for k in ('id','hash','chat')} for e in admission['entries']],
            'exact_restored_final_admission_and_both_policy_bindings_required')
    out=[]
    for e in admission['entries']:
        request={'shard_index':grant['shard_index'],'shard_hash':grant['shard_hash'],
                 'entries':[{k:e[k] for k in ('id','hash')}]}
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
            client.settimeout(30);client.connect(grant['socket_path'])
            client.sendall(json.dumps(request).encode()+b'\n');data=bytearray()
            while b'\n' not in data:
                chunk=client.recv(min(8192,grant['max_response_bytes']+1-len(data)))
                if not chunk:raise ValueError('final_packet_incomplete')
                data.extend(chunk)
                require(len(data)<=grant['max_response_bytes'],'final_packet_over_budget')
        out.extend(validate_final_packet(json.loads(data),[e],grant))
    require(len(out)==48 and len({r['id'] for r in out})==48,'all_final48_required')
    return out,{'grant_hash':grant['grant_hash'],'admission_hash':admission['admission_hash'],
        'snapshot_hash':grant['snapshot_hash'],'old_quarantine_hash':OLD49,'fresh_quarantine_hash':NEW95,
        'count':48,'review_raw_input_target_source_hashes_verified':True}


def compare(new_records,real_records,synthetic_cases):
    sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
    import review_duplicates as duplicates
    require(len(new_records)==39 and len(real_records)==48 and len(synthetic_cases)==48,
            'exact39_real48_synthetic48_required')
    require(len({r['id'] for r in new_records})==39 and len({r['id'] for r in real_records})==48
            and len({r['id'] for r in synthetic_cases})==48,'unique_case_scope_required')
    instruction=new_records[0]['messages'][-2]['content']
    new=[feature(r['id'],r['messages'][:-1],instruction) for r in new_records]
    real=[feature(r['id'],r['messages'][:-1],instruction) for r in real_records]
    synthetic=[feature(r['id'],r['inputs']['production_base_v4'],instruction) for r in synthetic_cases]
    # Separate calls avoid including the already frozen real48/synthetic48
    # cross-final2304 diagnostics in this new39 admission boundary proof.
    real_input=compare_groups({'additional39':new,'real_final48':real})
    synth_input=compare_groups({'additional39':new,'synthetic_final48':synthetic})
    episode=duplicates.cross_split_audit(new_records,real_records)
    require(real_input['pair_count']==synth_input['pair_count']==episode['comparison_count']==1872,
            'all39_times48_boundary_pairs_required')
    return {'input_only_real_boundary':real_input,'input_only_synthetic_boundary':synth_input,
            'full_episode_real_boundary':episode,'input_only_boundary_pair_count':3744,
            'full_episode_supplemental_pair_count':1872}


def audit(root, new39_helper, output):
    root,output,new39_helper=Path(root),Path(output),Path(new39_helper)
    require(not output.exists(),'new_audit_no_overwrite')
    require(sha(new39_helper)==NEW39_HELPER_SHA,'scoped_new39_fetcher_changed')
    original=read(root/'independent-evaluation/full-used-input-audit-frozen.json')
    check_seal(original,'audit_hash')
    require(original['audit_hash']==ORIGINAL_AUDIT_HASH,'original_audit_unchanged_required')
    synthetic_path=root/'independent-evaluation/final-compiled-v4-three-method-frozen.json'
    synthetic=load_suite(synthetic_path)
    require(synthetic['suite_hash']==original['synthetic_final_suite_hash']
            and synthetic['split']=='sealed_final' and synthetic['case_count']==48,
            'original_sealed_synthetic48_required')
    spec=importlib.util.spec_from_file_location('scoped_additional39',new39_helper)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    new,new_proof=module.fetch_new39()
    final,final_proof=fetch_final_records(root/'final48-restoration-v2/review-grant-final48-only.json',
        root/'independent-evaluation/real-final48-admission-frozen.json')
    import review_sensitive as sensitive
    quarantine=read(root/'additional-real-review-batch-128-v1/sensitive-source-quarantine-additive95-v1.json')
    check_seal(quarantine,'quarantine_hash')
    require(quarantine['quarantine_hash']==NEW95 and len(quarantine['source_keys'])==95,'fresh95_required')
    screened,blocked=sensitive.sensitive_admission_report(final,quarantine)
    require(len(screened)==48 and not blocked,'final_fresh95_admission_barrier')
    quarantine_source_keys=set(quarantine['source_keys'])
    source_matches=sum(bool(set(r['source_message_keys'])&quarantine_source_keys) for r in final)
    require(source_matches==0,'final_fresh95_source_key_overlap')
    result=compare(new,final,synthetic['cases'])
    payload=seal({'schema':'additional39-sealed-final96-boundary-audit-v1','frozen_at_utc':now(),
        'new39_identity_proof':new_proof,'real_final_identity_proof':final_proof,
        'synthetic_final_suite_hash':synthetic['suite_hash'],'original_full_audit_hash':original['audit_hash'],
        'group_counts':{'additional39':39,'real_final48':48,'synthetic_final48':48},
        'additional39_fresh95_excluded_count':new_proof['fresh_sensitive95_excluded_count'],
        'real_final_fresh95_excluded_count':len(blocked),'real_final_fresh95_source_key_overlap_count':source_matches,
        'result':result,'synthetic_final_no_gold_target_full_episode_not_compared':True,
        'helper_sha256':{str(Path(__file__).resolve()):sha(Path(__file__)),str(new39_helper.resolve()):NEW39_HELPER_SHA,
            'input_duplicate_audit.py':sha(Path(__file__).with_name('input_duplicate_audit.py')),
            'review_duplicates.py':sha(Path(__file__).resolve().parent.parent/'review_duplicates.py'),
            'review_sensitive.py':sha(Path(sensitive.__file__))},
        'input_only_excludes_system_final_instruction_and_gold_target':True,
        'no_corpus_or_target_or_full_inputs_persisted_or_rendered':True,
        'owner_rpc_opened':False,'model_or_tokenizer_loaded':False,'model_outputs_seen':False,
        'admission_or_rubric_or_gate_changed':False,
        'limitations':['No exhaustive semantic paraphrase detection claim.',
            'Shared source/context and different full actor/recipient metadata require explicit adjudication; no automatic replacement or omission.',
            'Old49 binding preserved; additive95 comparison and screening are separate supplemental evidence.']},'audit_hash')
    # All persisted result arrays contain only IDs, hashes, counts and scores.
    write_private(output,payload)
    del new,final,screened,synthetic
    episode=result['full_episode_real_boundary']
    return {'audit_hash':payload['audit_hash'],'input_boundary_pairs':3744,'supplemental_episode_pairs':1872,
        'input_real_flags':result['input_only_real_boundary']['flag_count'],
        'input_synthetic_flags':result['input_only_synthetic_boundary']['flag_count'],
        'full_input_identity_count':sum(result[k]['full_input_identity_count'] for k in
            ('input_only_real_boundary','input_only_synthetic_boundary')),
        'full_episode_exact_count':len(episode['normalized_full_episode_exact_pairs']),
        'full_episode_near_count':len(episode['long_episode_near_pairs']),
        'shared_source_count':len(episode['shared_source_pairs']),
        'shared_long_message_count':len(episode['shared_long_message_diagnostics']),
        'final_fresh95_excluded_count':len(blocked),'final_fresh95_source_key_overlap_count':source_matches}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('root','new39-helper','output'):p.add_argument('--'+name,required=True,type=Path)
    args=p.parse_args()
    print(json.dumps(audit(args.root,args.new39_helper,args.output)))
