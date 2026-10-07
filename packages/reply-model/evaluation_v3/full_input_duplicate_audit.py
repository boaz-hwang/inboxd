"""Frozen actual-use input-only audit; corpus stays transient and unrendered."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

from independent import read, check_seal, digest, seal, write_private, now, worker_module
from checkpoint_dev import check_producer_digest
from input_duplicate_audit import feature, compare_groups
from final_inputs import fetch_inputs


def audit(root, manifest_path, model, worker_path, output):
    manifest = read(manifest_path)
    check_producer_digest(manifest, 'manifest_id')
    draft, snapshot = read(root / 'approved-history-draft-frozen.json'), read(root / 'dataset-snapshot.json')
    if draft['draft_hash'] != manifest['source']['approved_draft_hash']:
        raise ValueError('exact_used_approved_draft_required')
    final_path = root / 'independent-evaluation/final-compiled-v4-three-method-frozen.json'
    final = read(final_path)
    check_seal(final, 'suite_hash')
    if (final['split'] != 'sealed_final' or hashlib.sha256(worker_path.read_bytes()).hexdigest()
            != final['compilers']['production_base_v4']['source_sha256']):
        raise ValueError('frozen_production_input_required')
    module = worker_module(worker_path)
    sentinel = [{'role':'system','content':module.SYSTEM}, {'role':'user','content':json.dumps({
        'conversation':[{'message_id':'sentinel','author_role':'other','author_id':'x',
                         'ts':0,'reply_to':None,'unseen':True,'body':'sentinel'}],
        'preflight':{'reply_target_id':'sentinel','missing_reply_ids':[]}})}]
    instruction = module.build_generation_input(sentinel)[-1]['content']
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import expanded_training_bridge as bridge
    import history_snapshot as hs
    import personalization as producer
    import training_curriculum as curriculum
    from kakao_local_import import OwnerRpc
    from mlx_lm.utils import load_tokenizer
    tokenizer = load_tokenizer(str(model))  # No model weights are loaded.
    groups = {'train':[], 'valid':[], 'synthetic_final':[], 'real_final':[]}
    expected = {e['id']:e for e in manifest['records']}
    seen = set()

    def add_record(record, split):
        entry = expected.get(record['id'])
        if (entry is None or entry['split'] != split or record['id'] in seen
                or producer.digest(record) != entry['example_hash']):
            raise ValueError('actual_used_record_hash_or_assignment_mismatch')
        messages = record['messages']
        if messages[-1]['role'] != 'assistant':
            raise ValueError('gold_target_boundary_required')
        groups[split].append(feature(record['id'], messages[:-1], instruction))
        seen.add(record['id'])

    def progress(value):
        if value['rooms_completed'] % 5 == 0 or value['rooms_completed'] == value['rooms_total']:
            print(json.dumps({'phase':'approved_source_reconstruction', **value}), flush=True)

    rpc = OwnerRpc()
    try:
        real, entries, evidence = bridge.freeze_approved_history(
            hs.OwnerHistoryQuery(rpc), snapshot, draft, tokenizer, progress=progress)
    finally:
        rpc.close()
    actual_real = {entry['id']:entry['split'] for entry in entries}
    if ({split:sum(v == split for v in actual_real.values()) for split in ('train','valid')}
            != {'train':88,'valid':30}):
        raise ValueError('exact_used_real118_required')
    for record in real:
        add_record(record, actual_real[record['id']])
    del real
    print(json.dumps({'phase':'owner_rpc_closed','verified_real_records':118}), flush=True)
    source_files = []
    for source in manifest['source']['authored_synthetic_fixtures']:
        path = Path(source['path'])
        if hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
            raise ValueError('actual_used_authored_fixture_changed')
        builder = curriculum.build_records if source['split'] == 'train' else curriculum.build_validation_records
        records = builder(tokenizer, fixture=path, seq_length=4096)
        if isinstance(records, tuple):
            records = records[0]
        for record in records:
            if record['id'] in expected:
                add_record(record, source['split'])
        source_files.append({'sha256':source['sha256'],'split':source['split']})
        del records
    if seen != set(expected) or {k:len(groups[k]) for k in ('train','valid')} != {'train':152,'valid':46}:
        raise ValueError('all_actual_used_records_required')
    for case in final['cases']:
        groups['synthetic_final'].append(feature(case['id'], case['inputs']['production_base_v4'], instruction))
    admission_path = root / 'independent-evaluation/real-final48-admission-frozen.json'
    real_final = fetch_inputs(root / 'review-grant-final48-only.json', admission_path)
    for case_id, messages in real_final.items():
        groups['real_final'].append(feature(case_id, messages, instruction))
    del real_final
    result = compare_groups(groups)
    if result['pair_count'] != 28304:
        raise ValueError('full_cross_split_pair_accounting_mismatch')
    final_pairs = next(r['pair_count'] for r in result['comparisons']
                      if {r['left'],r['right']} == {'synthetic_final','real_final'})
    payload = seal({'schema':'full-actual-input-role-body-duplicate-audit-v1','frozen_at_utc':now(),
        'manifest_id':manifest['manifest_id'],'approved_draft_hash':draft['draft_hash'],
        'synthetic_final_suite_hash':final['suite_hash'],
        'real_final_admission_hash':read(admission_path)['admission_hash'],
        'source_files':source_files,'reconstruction_evidence':evidence,
        'actual_used_record_count':198,'all_actual_used_example_hashes_verified':True,
        'historical_records':{'train':88,'valid':30},'authored_records':{'train':64,'valid':16},
        'boundary_pair_count':result['pair_count']-final_pairs,
        'additional_final_vs_final_diagnostic_pairs':final_pairs,'result':result,
        'input_only_excludes_system_instruction_and_gold_targets':True,
        'normalization':'Unicode NFKC, whitespace collapsed, casefold, role/body sequence',
        'near_policy':{'minimum_chars_both':200,'character_ngram':3,'minimum_jaccard':.9},
        'shared_message_minimum_chars':80,
        'limitations':['Not exhaustive semantic paraphrase detection.',
            'Different full input/actor metadata context flags require independent diagnostic review.',
            'Supplemental context plus gold target audit is separate; synthetic final has no gold target.'],
        'no_body_or_target_values_persisted_or_rendered':True,
        'model_outputs_seen':False,'admission_or_gate_changed':False},'audit_hash')
    write_private(output,payload)
    return {'audit_hash':payload['audit_hash'],'pair_count':result['pair_count'],
            'boundary_pair_count':26000,'final_vs_final_diagnostic_pairs':2304,
            'group_counts':result['group_counts'],'flag_count':result['flag_count'],
            'full_input_identity_count':result['full_input_identity_count']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('root','manifest','model','worker','output'):
        parser.add_argument('--'+name,required=True,type=Path)
    args=parser.parse_args()
    print(json.dumps(audit(args.root,args.manifest,args.model,args.worker,args.output)))
