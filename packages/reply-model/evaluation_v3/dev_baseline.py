#!/usr/bin/env python3
"""Designated GPU owner's diagnostic-only baseline runner.

Accepts the frozen development filename and expected suite hash only. It never
opens final cases, loads an adapter, or authorizes activation. Daemon pause and
resource supervision remain the caller's responsibility.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

from independent import digest, load_suite, now, seal, worker_module, write_private


def allowed_dev_suite(path, expected_hash):
    path = Path(path).resolve()
    if path.name != 'dev-compiled-v4-frozen.json':
        raise ValueError('dev_filename_required_before_any_suite_read')
    suite = load_suite(path)
    if suite['split'] != 'development_diagnostic' or suite['suite_hash'] != expected_hash:
        raise ValueError('authorized_development_suite_hash_required')
    if 'production_base_v4' not in suite['compilers']:
        raise ValueError('production_base_v4_required')
    return suite


def generate_dev_baseline(engine, tokenizer, suite_path, expected_hash, output, artifacts):
    suite = allowed_dev_suite(suite_path, expected_hash)
    output = Path(output).resolve()
    if output.exists():
        raise ValueError('diagnostic_exists_no_overwrite')
    policy = suite['generation_policy']
    token_counts = {}
    for case in suite['cases']:
        tokens = tokenizer.apply_chat_template(case['inputs']['production_base_v4'],
            add_generation_prompt=True, enable_thinking=False, return_dict=False)
        token_counts[case['id']] = len(tokens)
        if len(tokens) > policy['max_input_tokens']:
            raise ValueError('common_input_budget_exceeded:' + case['id'])
    # Entire-suite eligibility is established before the first model call.
    rows = []
    started = time.monotonic()
    for case in suite['cases']:
        case_started = time.monotonic()
        text = engine.generate_text(case['inputs']['production_base_v4'],
            adapter_path=None, max_tokens=policy['max_tokens'], temperature=0.0).strip()
        if not text:
            raise ValueError('empty_generation:' + case['id'])
        rows.append({'id': case['id'], 'method': 'production_base_v4', 'text': text,
            'output_hash': digest(text), 'input_hash': case['input_hashes']['production_base_v4'],
            'request_hash': case['request_hash'], 'rubric_hash': case['rubric_hash'],
            'input_tokens': token_counts[case['id']],
            'duration_seconds': time.monotonic() - case_started})
    report = seal({'schema': 'independent-dev-baseline-diagnostic-v1',
        'suite_hash': suite['suite_hash'], 'raw_hash': suite['raw_hash'],
        'split': suite['split'], 'case_count': len(rows), 'cases': rows,
        'generation_policy': policy, 'generation_artifacts': artifacts,
        'compiler': suite['compilers']['production_base_v4'],
        'generated_at_utc': now(), 'duration_seconds': time.monotonic() - started,
        'diagnostic_only': True, 'method_blinded': False,
        'final_holdout_evidence': False, 'activation_authorized': False,
        'adapter_loaded': False}, 'report_hash')
    write_private(output, report)
    return {'status': 'diagnostic_complete', 'case_count': len(rows),
        'suite_hash': suite['suite_hash'], 'report_hash': report['report_hash'],
        'diagnostic_only': True, 'final_holdout_evidence': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', required=True, type=Path)
    parser.add_argument('--expected-suite-hash', required=True)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--artifacts', required=True, type=Path)
    args = parser.parse_args()
    suite = allowed_dev_suite(args.suite, args.expected_suite_hash)
    worker_path = Path(__file__).resolve().parent.parent / 'worker.py'
    if hashlib.sha256(worker_path.read_bytes()).hexdigest() != suite['compilers']['production_base_v4']['source_sha256']:
        raise ValueError('production_worker_changed')
    from independent import read
    artifacts = read(args.artifacts)
    from mlx_lm.utils import load_tokenizer
    module = worker_module(worker_path)
    engine = module.ReplyWorker()
    engine.path = args.model.resolve()
    result = generate_dev_baseline(engine, load_tokenizer(str(engine.path)), args.suite,
        args.expected_suite_hash, args.report, artifacts)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
