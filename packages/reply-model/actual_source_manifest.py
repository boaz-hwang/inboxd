"""Body-free historical model-use evidence, separate from pool preparation.

This does not claim that a declared failed-run dataset was fully consumed.
Exact metadata variants are retained, and unresolved variants stay conservative.
No model, tokenizer, daemon or plaintext output is used by this audit.
"""
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
from behavior_audit import digest, read, write_private


def walk(value):
    if isinstance(value, dict):
        yield value
        for key, child in value.items():
            if historical_id(key) and isinstance(child,dict) and 'id' not in child:
                yield {'id':key,**child}
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def historical_id(value):
    return isinstance(value, str) and value.startswith('hist:')


def manifest_use_class(data, split):
    status,mode=data.get('status'),data.get('mode')
    if mode=='train':
        step=data.get('saved_checkpoint_step',data.get('iters',0))
        completed=status=='complete' and isinstance(step,int) and step>=data.get('iters',0)
        return ('heldout_declared_not_used_in_train_run' if split=='test' else
                'completed_training_dataset' if completed and split=='train' else
                'completed_validation_dataset' if completed and split=='valid' else
                'declared_partial_or_failed_runtime_dataset')
    if mode=='evaluate' and status=='complete':
        return 'completed_loss_evaluation_dataset' if split=='test' else 'staged_unconsumed_evaluation_split'
    return 'declared_runtime_dataset_use_unresolved'


def run(base, output, *, persist=True):
    files = {}
    index = defaultdict(dict)
    inventory_ids, preflight_ids = set(), set()
    # Read existing records in RAM; copy only whitelisted lineage metadata.
    for root in (base/'learning', base/'evaluations'):
        for path in sorted(root.rglob('*.json')):
            if any(part.startswith(('fresh-expansion-', 'behavior-audit-', 'failure-eval-audit-')) for part in path.parts):
                continue
            try:
                data = read(path)
            except (ValueError, OSError):
                continue
            files[path] = data
            for row in walk(data):
                identity = row.get('id') or row.get('case_id') or row.get('candidate_id')
                if not historical_id(identity):
                    continue
                inventory_ids.add(identity)
                if row.get('preflight_status') is not None:
                    preflight_ids.add(identity)
                keys = row.get('source_message_keys') or row.get('source_keys')
                if not isinstance(keys, list) or not keys or not all(isinstance(k,str) and k.startswith('[') for k in keys):
                    continue
                packet = {k:row[k] for k in ('input_hash','target_hash','raw_content_hash','source_keys_hash','review_hash','example_hash','granite_token_sha256','timestamp','chat','target_source_keys','context_timestamps') if k in row}
                packet['id']=identity
                packet['source_message_keys'] = sorted(set(keys))
                packet['source_keys_sha256'] = digest(packet['source_message_keys'])
                signature = digest(packet)
                if signature not in index[identity]:
                    index[identity][signature] = {**packet,'metadata_evidence_paths':[]}
                index[identity][signature]['metadata_evidence_paths'].append(str(path))
    uses=[]
    def add(identity, kind, path, **fields):
        if historical_id(identity):
            uses.append({'id':identity,'use_class':kind,'evidence_path':str(path),**fields})
    for path, data in files.items():
        if path.name=='manifest.json' and isinstance(data,dict) and isinstance(data.get('splits'),dict):
            status, mode = data.get('status'), data.get('mode')
            for split, rows in data['splits'].items():
                for row in rows:
                    if not isinstance(row,dict):
                        continue
                    kind=manifest_use_class(data,split)
                    add(row.get('id'),kind,path,split=split,status=status,mode=mode,
                        example_hash=row.get('example_hash'),dataset_id=data.get('dataset_id'),
                        provenance_refs=row.get('provenance_refs',[]),
                        saved_checkpoint_step=data.get('saved_checkpoint_step'),
                        exact_gradient_batch_coverage=False)
        # Preserved generation reports contain outputs, not just reservations.
        if isinstance(data,dict) and data.get('generation_artifacts') and isinstance(data.get('cases'),list):
            for row in data['cases']:
                if isinstance(row,dict) and row.get('outputs'):
                    add(row.get('id'),'recorded_model_generation',path,
                        report_hash=data.get('report_hash'),input_hash=row.get('input_hash'))
    # Granite has explicit per-example gradient coverage and generation flags.
    for path in sorted((base/'learning/granite-training-20261006').rglob('coverage.jsonl')):
        for line in path.read_text().splitlines():
            row=json.loads(line)
            if not row.get('synthetic_resource_only'):
                add(row.get('id'),'exact_gradient_step',path,step=row['step'],token_sha256=row.get('token_sha256'))
    grantpath=base/'learning/granite-fullpool-20261006-v1/training-grant-full.json'
    grant=read(grantpath)
    receiptpath=base/'learning/granite-training-20261006/full-epoch/train/receipt.json'
    receipt=read(receiptpath)
    if receipt.get('status')=='complete' and receipt.get('base_validation',{}).get('examples')==len(grant['observed_validation_ids']):
        for identity in grant['observed_validation_ids']:
            add(identity,'observed_validation_loss',receiptpath,grant_path=str(grantpath),dataset_hash=receipt['dataset_hash'])
    for path in sorted((base/'evaluations').rglob('run_*.jsonl')):
        if any(part.startswith(('fresh-expansion-', 'failure-eval-audit-')) for part in path.parts):
            continue
        for line in path.read_text().splitlines():
            row=json.loads(line)
            if row.get('model_generated') is True:
                add(row.get('id'),'recorded_model_generation',path,input_hash=row.get('input_hash'),
                    prompt_token_sha256=row.get('prompt_token_sha256'),model_generated=True)
            elif historical_id(row.get('id')):
                preflight_ids.add(row['id'])
    byid=defaultdict(list)
    for use in uses:
        byid[use['id']].append(use)
    entries=[]
    known_keys=set();uncertain_keys=set();missing=[]
    actual_classes={'exact_gradient_step','observed_validation_loss','completed_training_dataset','completed_validation_dataset','completed_loss_evaluation_dataset','recorded_model_generation'}
    for identity in sorted(byid):
        variants=list(index.get(identity,{}).values())
        evidence=byid[identity]
        actual=[u for u in evidence if u['use_class'] in actual_classes]
        wanted_input={u['input_hash'] for u in actual if u['use_class']=='recorded_model_generation' and u.get('input_hash')}
        unmatched_input=sorted(wanted_input-{v.get('input_hash') for v in variants})
        gradient_tokens={u['token_sha256'] for u in actual if u['use_class']=='exact_gradient_step' and u.get('token_sha256')}
        unmatched_gradient=sorted(gradient_tokens-{v.get('granite_token_sha256') for v in variants})
        # Keep training variants even when the same ID had a generation context
        # with a different input hash. Never select a context by ID alone.
        selected=variants
        sourcekeys=sorted({k for v in selected for k in v['source_message_keys']})
        if actual and all(u['use_class']=='recorded_model_generation' for u in actual) and all(v.get('target_source_keys') for v in selected):
            sourcekeys=sorted({k for v in selected for k in set(v['source_message_keys'])-set(v['target_source_keys'])})
        if not sourcekeys:
            missing.append(identity)
        if actual:
            known_keys.update(sourcekeys)
        else:
            uncertain_keys.update(sourcekeys)
        entries.append({'id':identity,'use_classes':sorted({u['use_class'] for u in evidence}),
                        'actual_use_evidenced':bool(actual),'evidence':evidence,
                        'source_variants':selected,'metadata_source_variant_count':len(variants),
                        'variant_resolution':'conservative_union_of_metadata_variants',
                        'source_message_keys':sourcekeys,'known_source_keys_available':bool(sourcekeys),
                        'recorded_generation_input_hashes':sorted(wanted_input),
                        'unmatched_generation_input_hashes':unmatched_input,
                        'unmatched_exact_gradient_token_hashes':unmatched_gradient,
                        'some_exact_consumed_context_binding_evidenced':bool(sourcekeys) and (bool(wanted_input) and not unmatched_input or bool(gradient_tokens) and not unmatched_gradient),
                        'complete_all_historical_context_variants_binding_claimed':False,
                        'historical_targets_exposed_by_training_or_loss':any(u['use_class']!='recorded_model_generation' for u in actual),
                        'model_generation_context_only':bool(actual) and all(u['use_class']=='recorded_model_generation' for u in actual)})
    assessed_ids=set()
    assessed_evidence=defaultdict(set)
    for path,data in files.items():
        if path.name=='final-fullpool-coverage.json':
            for row in data['entries']:
                if isinstance(row.get('semantic_decision'),dict):
                    assessed_ids.add(row['id']);assessed_evidence[row['id']].add(str(path))
        elif path.name=='previous-source-observation-manifest.json':
            for identity in data['previous_candidate_ids']:
                if historical_id(identity):
                    assessed_ids.add(identity);assessed_evidence[identity].add(str(path))
        elif path.name.startswith('real-quality-') and data.get('quality_hash') and historical_id(data.get('id')):
            assessed_ids.add(data['id']);assessed_evidence[data['id']].add(str(path))
    assessed=[]
    for identity in sorted(assessed_ids):
        variants=list(index.get(identity,{}).values())
        assessed.append({'id':identity,'assessment_evidence_paths':sorted(assessed_evidence[identity]),
                         'source_message_keys':sorted({k for v in variants for k in v['source_message_keys']}),
                         'input_hashes':sorted({v['input_hash'] for v in variants if v.get('input_hash')}),
                         'lineage_scope':'Known source-bound semantic decision or original reviewed-observation manifest, not queue listing.'})
    previous=read(base/'learning/expansion-20261003/previous-source-observation-manifest.json')
    assessed_keys={k for r in assessed for k in r['source_message_keys']}|set(previous['previous_observed_source_keys'])
    source_files={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    for u in uses:
        p=Path(u['evidence_path']);source_files[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
    packet={'schema':'historical-model-use-source-manifest-v4','entries':entries,
            'model_used_or_runtime_uncertain_ids':len(entries),'actual_use_evidenced_ids':sum(r['actual_use_evidenced'] for r in entries),
            'declared_runtime_only_ids':sum(not r['actual_use_evidenced'] for r in entries),
            'source_keys_actual_use_union':sorted(known_keys),'source_keys_runtime_uncertain_union':sorted(uncertain_keys-known_keys),
            'prior_semantically_assessed_entries':assessed,'prior_semantically_assessed_source_union':sorted(assessed_keys),
            'unmatched_recorded_generation_input_cases':sum(bool(r['unmatched_generation_input_hashes']) for r in entries),
            'unmatched_exact_gradient_token_cases':sum(bool(r['unmatched_exact_gradient_token_hashes']) for r in entries),
            'some_exact_context_binding_evidenced_ids':sum(r['some_exact_consumed_context_binding_evidenced'] for r in entries),
            'missing_source_metadata_ids':missing,'inventory_only_ids':sorted(inventory_ids-set(byid)-preflight_ids),
            'preflight_only_ids':sorted(preflight_ids-set(byid)),
            'use_evidence_counts':dict(Counter(u['use_class'] for u in uses)),
            'source_files_raw_sha256':source_files,'bodies_persisted':0,'token_arrays_persisted':0,
            'limitations':['Completed Qwen manifest proves completed declared dataset; exact per-step batch coverage is unavailable for these older runs.',
                           'Failed or partial declared datasets stay separately uncertain; they are not called fully gradient-consumed.',
                           'Some older model-use IDs may lack full source keys or exact context variant binding; unresolved lineage cannot be declared fresh.',
                           'Multiple metadata context variants are conservatively unioned unless a generation input hash selects them.',
                           'A matching historical target key is not proof of its complete context window; source union must include all context keys.',
                           'No whole-room exclusion is inferred from source use; revised candidate admissibility is controlled by a separately frozen protocol.']}
    packet['manifest_hash']=digest(packet)
    if persist:
        write_private(output/'actual-model-used-source-manifest-v4.json',packet)
    files.clear(); index.clear()
    return packet


if __name__=='__main__':
    base=Path.home()/'.inboxd/reply-model'
    packet=run(base,base/'evaluations/fresh-expansion-20261006-v1')
    print(json.dumps({k:packet[k] for k in ('model_used_or_runtime_uncertain_ids','actual_use_evidenced_ids','declared_runtime_only_ids','use_evidence_counts','manifest_hash')}))
    print(json.dumps({'actual_source_keys':len(packet['source_keys_actual_use_union']),
                      'runtime_uncertain_source_keys':len(packet['source_keys_runtime_uncertain_union']),
                      'missing_source_ids':len(packet['missing_source_metadata_ids']),
                      'inventory_only_ids':len(packet['inventory_only_ids']),
                      'preflight_only_ids':len(packet['preflight_only_ids'])}))
