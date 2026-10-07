#!/usr/bin/env python3
"""Three-method generation with independently frozen adapter bindings.

GPU authorization, actual model/adapter identity checks, per-method clean loading,
and resource/daemon lifecycle belong to the execution controller. This module
never selects a checkpoint or activates a model. A base binding is None; selected
and prior bindings are distinct exact adapter paths. Bindings are frozen BEFORE
any final generation. The prior adapter is a diagnostic comparator only.
"""
import hashlib
from pathlib import Path
import secrets
from independent import (load_suite, read, check_seal, digest, seal, write_private,
                         now, summarize)

def generate_multi(engine, tokenizer, bindings_path, output, *, suite_path, max_tokens=192, max_input_tokens=3904, artifacts=None):
    """Caller owns GPU authorization. Uses frozen prompts, never training data.

    engine has generate_text(messages, adapter_path, max_tokens, temperature).
    Every method uses its separately frozen adapter binding, including None for base.
    """
    suite = load_suite(suite_path)
    bindings = read(bindings_path)
    check_seal(bindings, 'binding_hash')
    if bindings['suite_hash'] != suite['suite_hash']:
        raise ValueError('binding_suite_mismatch')
    if bindings['generator_sha256'] != hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
        raise ValueError('frozen_generator_changed')
    method_adapters = bindings['method_adapters']
    if set(method_adapters) != set(suite['compilers']):
        raise ValueError('adapter_binding_method_set_mismatch')
    if method_adapters[suite['candidate']] is None:
        raise ValueError('candidate_adapter_required')
    if bindings['generation_policy'] != suite['generation_policy']:
        raise ValueError('binding_policy_mismatch')
    if max_tokens != suite['generation_policy']['max_tokens'] or max_input_tokens != suite['generation_policy']['max_input_tokens']:
        raise ValueError('generation_must_match_frozen_budget_policy')
    output = Path(output).resolve()
    mapping_path = output.with_name(output.stem + '-unblind.json')
    if output.exists() or mapping_path.exists():
        raise ValueError('comparison_exists_no_overwrite')
    lengths = {}
    for case in suite['cases']:
        lengths[case['id']] = {}
        for method, messages in case['inputs'].items():
            tokens = tokenizer.apply_chat_template(messages, add_generation_prompt=True,
                enable_thinking=False, return_dict=False)
            lengths[case['id']][method] = len(tokens)
            if len(tokens) > max_input_tokens:
                raise ValueError('common_input_budget_exceeded:' + case['id'])
    rows, mapping = [], {}
    for case in suite['cases']:
        methods = list(suite['compilers'])
        secrets.SystemRandom().shuffle(methods)
        labels = ['option_' + str(i + 1) for i in range(len(methods))]
        options = []
        mapping[case['id']] = {}
        for label, method in zip(labels, methods):
            text = engine.generate_text(case['inputs'][method], max_tokens=max_tokens,
                adapter_path=method_adapters[method], temperature=0.0).strip()
            if not text:
                raise ValueError('empty_generation:' + case['id'])
            options.append({'label': label, 'text': text, 'output_hash': digest(text)})
            mapping[case['id']][label] = {'method': method}
        rows.append({'id': case['id'], 'outputs': options})
    mapping_payload = seal({'schema': 'independent-mapping-v1', 'suite_hash': suite['suite_hash'],
                            'mapping': mapping}, 'mapping_hash')
    write_private(mapping_path, mapping_payload)
    report = seal({'schema': 'independent-report-v1', 'suite_hash': suite['suite_hash'],
        'split': suite['split'], 'case_count': len(rows), 'cases': rows,
        'mapping_file_sha256': hashlib.sha256(mapping_path.read_bytes()).hexdigest(),
        'generation_settings': {'temperature': 0.0, 'enable_thinking': False,
            'max_tokens': max_tokens, 'max_input_tokens': max_input_tokens},
        'generation_artifacts': {'binding_hash': bindings['binding_hash'], 'frozen_artifacts': bindings['artifacts'], 'runtime_verification': artifacts or {}},
        'input_token_counts': lengths, 'generated_at_utc': now()}, 'report_hash')
    write_private(output, report)
    return {'status': 'comparison_complete', 'case_count': len(rows), 'report_hash': report['report_hash']}


def summarize_with_diagnostics(suite_path, report_path, verdict_path,
                               comparison_policy_path):
    """Unblind only complete frozen judgments; prior never adds activation gates."""
    policy = read(comparison_policy_path)
    check_seal(policy, 'comparison_hash')
    suite = load_suite(suite_path)
    if policy['suite_hash'] != suite['suite_hash']:
        raise ValueError('comparison_policy_suite_mismatch')
    if set(policy['gating_comparators']) | set(policy['diagnostic_comparators']) != set(suite['comparators']):
        raise ValueError('comparison_partition_mismatch')
    if set(policy['gating_comparators']) & set(policy['diagnostic_comparators']):
        raise ValueError('comparison_partition_overlap')
    result = summarize(suite_path, report_path, verdict_path)
    diagnostic_suffixes = tuple('_vs_' + m for m in policy['diagnostic_comparators'])
    result['diagnostic_gate_reasons'] = [r for r in result['gate_reasons'] if r.endswith(diagnostic_suffixes)]
    result['gate_reasons'] = [r for r in result['gate_reasons'] if not r.endswith(diagnostic_suffixes)]
    candidate = result['methods'][suite['candidate']]
    failures = candidate['clear_semantic_failure_cases']
    result['gate'] = 'reject' if failures else 'hold' if result['gate_reasons'] else 'pass'
    result['comparison_hash'] = policy['comparison_hash']
    result['gating_comparators'] = policy['gating_comparators']
    result['diagnostic_comparators'] = policy['diagnostic_comparators']
    result['activation_authorized'] = False
    return result
