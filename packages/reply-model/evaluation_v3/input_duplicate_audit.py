"""CPU, metadata-only input comparison. Never prints or persists corpus text.

Run under the model venv. Training records are reconstructed by their existing
builder solely to verify hashes against the frozen manifest, then reduced to
role/body fingerprints in process memory. No targets enter input-only features.
Context flags are diagnostics, not automatic changes to admission or gates.
"""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import re
import sys
import unicodedata

from independent import read, check_seal, digest, seal, write_private, now, worker_module
from final_inputs import fetch_inputs
from checkpoint_dev import check_producer_digest


def normalized(text):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text)).strip().casefold()


def conversation_input(messages, instruction):
    if not messages or messages[0]['role'] != 'system':
        raise ValueError('explicit_system_boundary_required')
    if messages[-1]['role'] != 'user' or messages[-1]['content'] != instruction:
        raise ValueError('explicit_final_instruction_boundary_required')
    turns = messages[1:-1]
    if any(m['role'] not in ('assistant', 'user') or not isinstance(m['content'], str) for m in turns):
        raise ValueError('role_body_conversation_required')
    if not turns:
        raise ValueError('empty_input_conversation_not_auditable')
    return [{'role': m['role'], 'body': m['content']} for m in turns]


def feature(case_id, messages, instruction):
    turns = conversation_input(messages, instruction)
    text = normalized('\n'.join(t['role'] + ': ' + t['body'] for t in turns))
    long_messages = {digest(normalized(t['body'])) for t in turns if len(normalized(t['body'])) >= 80}
    return {'case_ref': digest(case_id), 'input_hash': digest(messages),
            'normalized_role_body_hash': digest(text), 'text': text,
            'grams': {text[i:i + 3] for i in range(max(0, len(text) - 2))},
            'long_message_hashes': long_messages,
            'metadata_hash': digest(messages[0]['content'])}


def compare_groups(groups):
    pairs, reports = 0, []
    for left, right in itertools.combinations(groups, 2):
        flags, count = [], 0
        for a in groups[left]:
            for b in groups[right]:
                count += 1
                exact = a['normalized_role_body_hash'] == b['normalized_role_body_hash']
                jaccard = None
                if min(len(a['text']), len(b['text'])) >= 200:
                    union = a['grams'] | b['grams']
                    jaccard = len(a['grams'] & b['grams']) / len(union) if union else 0
                shared = sorted(a['long_message_hashes'] & b['long_message_hashes'])
                if exact or (jaccard is not None and jaccard >= .9) or shared:
                    same_input = a['input_hash'] == b['input_hash']
                    flags.append({'left_case_ref': a['case_ref'], 'right_case_ref': b['case_ref'],
                        'normalized_context_exact': exact,
                        'long_context_near': jaccard is not None and jaccard >= .9,
                        'jaccard': jaccard, 'shared_long_message_hashes': shared,
                        'full_input_identity': same_input,
                        'system_actor_reply_metadata_identity': a['metadata_hash'] == b['metadata_hash'],
                        'reason': 'full_model_input_identity' if same_input else
                            'context_or_message_flag_with_different_full_input_metadata_requires_independent_review'})
        pairs += count
        reports.append({'left': left, 'right': right, 'pair_count': count, 'flags': flags,
            'flag_count': len(flags), 'full_input_identity_count': sum(f['full_input_identity'] for f in flags)})
    return {'pair_count': pairs, 'group_counts': {k: len(v) for k, v in groups.items()},
            'comparisons': reports, 'flag_count': sum(r['flag_count'] for r in reports),
            'full_input_identity_count': sum(r['full_input_identity_count'] for r in reports)}


def audit_authored_and_final(manifest_path, final_suite_path, final_grant_path,
                             admission_path, model, worker_path, output):
    manifest = read(manifest_path)
    check_producer_digest(manifest, 'manifest_id')
    final = read(final_suite_path)
    check_seal(final, 'suite_hash')
    if final['split'] != 'sealed_final':
        raise ValueError('frozen_sealed_final_suite_required')
    module = worker_module(worker_path)
    if hashlib.sha256(Path(worker_path).read_bytes()).hexdigest() != final['compilers']['production_base_v4']['source_sha256']:
        raise ValueError('frozen_production_worker_required')
    sentinel = [{'role': 'system', 'content': module.SYSTEM}, {'role': 'user', 'content': json.dumps({
        'conversation': [{'message_id': 'sentinel', 'author_role': 'other', 'author_id': 'x',
                          'ts': 0, 'reply_to': None, 'unseen': True, 'body': 'sentinel'}],
        'preflight': {'reply_target_id': 'sentinel', 'missing_reply_ids': []}})}]
    instruction = module.build_generation_input(sentinel)[-1]['content']
    groups = {'authored_train': [], 'authored_valid': [], 'synthetic_final': [], 'real_final': []}
    expected = {e['id']: e for e in manifest['records'] if e.get('source') == 'authored_synthetic_supervision'}
    seen, source_files = set(), []
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import training_curriculum as curriculum
    import personalization as personalization
    from mlx_lm.utils import load_tokenizer
    tokenizer = load_tokenizer(str(model))  # CPU tokenizer only; no model load.
    for source in manifest['source']['authored_synthetic_fixtures']:
        path = Path(source['path'])
        file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if file_hash != source['sha256']:
            raise ValueError('actual_used_authored_fixture_changed')
        source_files.append({'sha256': file_hash, 'split': source['split']})
        builder = curriculum.build_records if source['split'] == 'train' else curriculum.build_validation_records
        records = builder(tokenizer, fixture=path, seq_length=4096)
        # Builders may return additional metadata alongside the records.
        if isinstance(records, tuple):
            records = records[0]
        for record in records:
            entry = expected.get(record['id'])
            if entry is None:
                continue  # A source-ineligible record is not claimed as used.
            if record['id'] in seen or entry['split'] != source['split']:
                raise ValueError('authored_assignment_or_identity_mismatch')
            if personalization.digest(record) != entry['example_hash']:
                raise ValueError('actual_used_authored_record_hash_mismatch')
            messages = record['messages']
            if messages[-1]['role'] != 'assistant':
                raise ValueError('gold_target_boundary_required')
            groups['authored_' + source['split']].append(feature(record['id'], messages[:-1], instruction))
            seen.add(record['id'])
    if seen != set(expected):
        raise ValueError('actual_used_authored_coverage_incomplete')
    for case in final['cases']:
        groups['synthetic_final'].append(feature(case['id'], case['inputs']['production_base_v4'], instruction))
    real = fetch_inputs(final_grant_path, admission_path)
    for case_id, messages in real.items():
        groups['real_final'].append(feature(case_id, messages, instruction))
    result = compare_groups(groups)
    payload = seal({'schema': 'actual-input-role-body-duplicate-audit-v1', 'frozen_at_utc': now(),
        'manifest_id': manifest['manifest_id'], 'synthetic_final_suite_hash': final['suite_hash'],
        'real_final_admission_hash': read(admission_path)['admission_hash'],
        'scope': 'actualused authored64train/16valid and both48 finals; realtrain88/valid30 not reconstructed in this phase',
        'scope_counts': result['group_counts'], 'source_files': source_files,
        'authored_records_all_verified_against_manifest_example_hash': True,
        'input_only_excludes_system_instruction_and_gold_targets': True,
        'normalization': 'Unicode NFKC, whitespace collapsed, casefold, role/body sequence',
        'near_policy': {'minimum_chars_both': 200, 'character_ngram': 3, 'minimum_jaccard': .9},
        'shared_message_minimum_chars': 80, 'result': result,
        'limitations': ['Context/message flags with different full input may be intentional actor/recipient/reply metadata contrasts; independent review required.',
                       'No exhaustive semantic paraphrase detection claim.',
                       'Realtrain/valid vs authored opposite splits and syntheticfinal remains pending reconstruction.',
                       'Supplemental context+gold-target audit not included here; syntheticfinal has no gold target.'],
        'no_body_or_target_values_persisted_or_rendered': True,
        'model_outputs_seen': False, 'admission_or_gate_changed': False}, 'audit_hash')
    write_private(output, payload)
    return {'audit_hash': payload['audit_hash'], 'pair_count': result['pair_count'],
            'group_counts': result['group_counts'], 'flag_count': result['flag_count'],
            'full_input_identity_count': result['full_input_identity_count']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('manifest', 'final-suite', 'final-grant', 'admission', 'model', 'worker', 'output'):
        parser.add_argument('--' + name, required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(audit_authored_and_final(args.manifest, args.final_suite, args.final_grant,
        args.admission, args.model, args.worker, args.output)))


if __name__ == '__main__':
    main()
