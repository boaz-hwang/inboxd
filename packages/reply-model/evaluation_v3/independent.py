#!/usr/bin/env python3
"""Independent, sealed evaluation without importing any training examples.

Raw definitions are private. Freeze compilation before training. A designated
executor generates every frozen case/method; the reviewer sees randomized labels.
The first mapping read happens only after complete, immutable blind judgments.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import secrets
from datetime import datetime, timezone

DIMENSIONS = ('role', 'fact', 'consent', 'response')
GENERATION_POLICY = {'temperature': 0.0, 'enable_thinking': False,
    'max_tokens': 192, 'max_input_tokens': 3904, 'max_total_tokens': 4096,
    'input_count_includes_chat_template_and_generation_prefix': True,
    'overflow_policy': 'hold_without_truncation_or_selective_omission',
    'final_policy': 'single_frozen_candidate_evaluation_without_post_final_tuning'}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def write_private(path, value):
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Exclusive creation is intentional: no silent replacement after seeing outputs.
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    return path


def read(path):
    path = Path(path)
    if path.stat().st_mode & 0o077:
        raise ValueError('private_file_permissions_required')
    return json.loads(path.read_text())


def seal(payload, key):
    return {**payload, key: digest(payload)}


def check_seal(payload, key):
    if payload.get(key) != digest({k: v for k, v in payload.items() if k != key}):
        raise ValueError('frozen_payload_changed')


def freeze_raw(path, cases, general, policy, split):
    ids = [c['id'] for c in cases]
    if not cases or len(set(ids)) != len(ids):
        raise ValueError('invalid_case_id_set')
    for case in cases:
        if not all(case.get(k) for k in ('id', 'category', 'request', 'rubric')):
            raise ValueError('missing_case_definition')
        if not all(case['rubric'].get(k) for k in ('allowed', 'forbidden', *DIMENSIONS)):
            raise ValueError('missing_semantic_rubric')
    payload = seal({'schema': 'independent-raw-v1', 'split': split, 'frozen_at_utc': now(),
        'provenance': {'cases': 'independently_authored_synthetic', 'reviewer': 'agent_delegated',
                       'training_candidates_seen': False, 'old_fixture_cases_seen': False},
        'general_rubric': general, 'policy': policy, 'case_count': len(cases), 'cases': cases}, 'raw_hash')
    write_private(path, payload)
    return {'split': split, 'case_count': len(cases), 'raw_hash': payload['raw_hash']}


def worker_module(path):
    path = Path(path).resolve()
    spec = importlib.util.spec_from_file_location('independent_worker_' + secrets.token_hex(6), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def compile_suite(raw_path, output, compilers, candidate, comparators, supplemental_policy=None):
    raw = read(raw_path)
    check_seal(raw, 'raw_hash')
    adjacent_policy = Path(raw_path).with_name('supplemental-gate-frozen.json')
    if supplemental_policy is None and adjacent_policy.exists():
        supplemental_policy = adjacent_policy
    supplemental = None
    if supplemental_policy:
        supplemental = read(supplemental_policy)
        check_seal(supplemental, 'supplemental_hash')
        if raw['raw_hash'] not in supplemental['applicable_raw_hashes']:
            raise ValueError('supplemental_policy_raw_mismatch')
    if candidate not in compilers or set(comparators) != set(compilers) - {candidate}:
        raise ValueError('candidate_comparator_methods_mismatch')
    if len(comparators) != len(set(comparators)) or not comparators:
        raise ValueError('distinct_comparators_required')
    if any(not re.fullmatch(r'[A-Za-z0-9_]{1,64}', m) for m in compilers):
        raise ValueError('invalid_method_identifier')
    # Each compiler is snapshotted into the private sealed directory. Compiled
    # prompts and metadata remain usable after later production code edits.
    modules, identities = {}, {}
    for method, source in compilers.items():
        source = Path(source).resolve()
        module = worker_module(source)
        modules[method] = module
        identities[method] = {'prompt_version': module.PROMPT_VERSION,
            'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'system_hash': digest(module.SYSTEM)}
    cases = []
    for case in raw['cases']:
        inputs = {}
        for method, module in modules.items():
            compiled, omitted = module.compile_prompt(case['request'])
            if omitted or json.loads(compiled[-1]['content'])['preflight']['status'] != 'ready':
                raise ValueError('case_not_ready_or_omitted:' + case['id'])
            inputs[method] = module.build_generation_input(compiled)
        cases.append({**case, 'inputs': inputs, 'request_hash': digest(case['request']),
                      'rubric_hash': digest(case['rubric']), 'input_hashes': {m: digest(v) for m, v in inputs.items()}})
    payload = seal({'schema': 'independent-compiled-v1', 'raw_hash': raw['raw_hash'],
        'split': raw['split'], 'frozen_at_utc': now(), 'policy': raw['policy'],
        'evaluation_helper_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'generation_policy': GENERATION_POLICY,
        'general_rubric': raw['general_rubric'], 'provenance': raw['provenance'],
        'supplemental_policy': supplemental,
        'case_count': len(cases), 'candidate': candidate, 'comparators': list(comparators),
        'compilers': identities, 'cases': cases}, 'suite_hash')
    write_private(output, payload)
    return {'status': 'compiled_frozen', 'case_count': len(cases), 'raw_hash': raw['raw_hash'],
            'suite_hash': payload['suite_hash'], 'compilers': identities}


def load_suite(path):
    suite = read(path)
    check_seal(suite, 'suite_hash')
    if suite['evaluation_helper_sha256'] != hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
        raise ValueError('frozen_evaluation_helper_changed')
    if suite['generation_policy'] != GENERATION_POLICY:
        raise ValueError('frozen_generation_policy_changed')
    if len(suite['cases']) != suite['case_count'] or len({c['id'] for c in suite['cases']}) != suite['case_count']:
        raise ValueError('case_set_mismatch')
    for case in suite['cases']:
        if digest(case['request']) != case['request_hash'] or digest(case['rubric']) != case['rubric_hash']:
            raise ValueError('case_source_changed')
        if set(case['inputs']) != set(suite['compilers']):
            raise ValueError('case_method_set_changed')
        if any(digest(v) != case['input_hashes'][m] for m, v in case['inputs'].items()):
            raise ValueError('compiled_input_changed')
    return suite


def generate(engine, tokenizer, adapter, output, *, suite_path, max_tokens=192, max_input_tokens=3904, artifacts=None):
    """Caller owns GPU authorization. Uses frozen prompts, never training data.

    engine has generate_text(messages, adapter_path, max_tokens, temperature).
    The one candidate gets adapter; comparator methods have no adapter.
    """
    suite = load_suite(suite_path)
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
                adapter_path=str(adapter) if method == suite['candidate'] else None, temperature=0.0).strip()
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
        'generation_artifacts': artifacts or {},
        'input_token_counts': lengths, 'generated_at_utc': now()}, 'report_hash')
    write_private(output, report)
    return {'status': 'comparison_complete', 'case_count': len(rows), 'report_hash': report['report_hash']}


def review_view(suite_path, report_path):
    suite, report = load_suite(suite_path), read(report_path)
    check_seal(report, 'report_hash')
    if report['suite_hash'] != suite['suite_hash'] or report['case_count'] != suite['case_count']:
        raise ValueError('report_suite_mismatch')
    cases = {c['id']: c for c in suite['cases']}
    if {r['id'] for r in report['cases']} != set(cases):
        raise ValueError('report_case_set_mismatch')
    views = []
    for row in report['cases']:
        if len(row['outputs']) != len(suite['compilers']) or len({o['label'] for o in row['outputs']}) != len(suite['compilers']):
            raise ValueError('report_options_mismatch')
        if any(digest(o['text']) != o['output_hash'] for o in row['outputs']):
            raise ValueError('report_output_changed')
        source = cases[row['id']]
        views.append({'id': row['id'], 'request': source['request'], 'rubric': source['rubric'],
                      'outputs': row['outputs']})
    return suite, report, views


def freeze_verdicts(suite_path, report_path, judgments_path, output):
    suite, report, views = review_view(suite_path, report_path)
    judgments = read(judgments_path)
    if judgments.get('reviewer') != 'agent_delegated' or judgments.get('mapping_seen_before_freeze') is not False:
        raise ValueError('blind_agent_delegated_review_required')
    verdicts = judgments.get('cases', {})
    if set(verdicts) != {v['id'] for v in views}:
        raise ValueError('complete_review_required')
    for view in views:
        verdict = verdicts[view['id']]
        labels = {o['label'] for o in view['outputs']}
        if set(verdict.get('options', {})) != labels:
            raise ValueError('complete_options_review_required')
        for option in view['outputs']:
            judgment = verdict['options'][option['label']]
            if judgment.get('output_hash') != option['output_hash']:
                raise ValueError('judgment_output_mismatch')
            if any(judgment.get(d) not in ('pass', 'fail', 'uncertain') for d in DIMENSIONS):
                raise ValueError('semantic_judgments_required')
            if any(type(judgment.get(d)) is not int or judgment[d] not in range(1, 6) for d in ('usefulness', 'style')):
                raise ValueError('integer_1_5_scores_required')
            if not judgment.get('reason'):
                raise ValueError('judgment_reason_required')
        preference = verdict.get('preference')
        if not isinstance(preference, list) or not preference or any(not isinstance(tier, list) or not tier for tier in preference):
            raise ValueError('preference_tiers_required')
        ranked = [label for tier in preference for label in tier]
        if len(ranked) != len(labels) or set(ranked) != labels:
            raise ValueError('complete_preference_ranking_required')
    payload = seal({'schema': 'independent-verdicts-v1', 'suite_hash': suite['suite_hash'],
        'report_hash': report['report_hash'], 'reviewer': 'agent_delegated',
        'mapping_seen_before_freeze': False, 'frozen_at_utc': now(),
        'case_count': len(verdicts), 'cases': verdicts}, 'verdict_hash')
    write_private(output, payload)
    return {k: payload[k] for k in ('verdict_hash', 'case_count', 'report_hash', 'suite_hash')}


def summarize(suite_path, report_path, verdicts_path):
    suite, report, _ = review_view(suite_path, report_path)
    verdicts = read(verdicts_path)
    check_seal(verdicts, 'verdict_hash')
    if verdicts['report_hash'] != report['report_hash'] or verdicts['suite_hash'] != suite['suite_hash']:
        raise ValueError('verdict_report_mismatch')
    # First mapping read in review code; immutable complete judgments exist first.
    report_path = Path(report_path).resolve()
    mapping_path = report_path.with_name(report_path.stem + '-unblind.json')
    if hashlib.sha256(mapping_path.read_bytes()).hexdigest() != report['mapping_file_sha256']:
        raise ValueError('mapping_file_changed')
    mapping_file = read(mapping_path)
    check_seal(mapping_file, 'mapping_hash')
    mapping = mapping_file['mapping']
    if mapping_file['suite_hash'] != suite['suite_hash'] or set(mapping) != set(verdicts['cases']):
        raise ValueError('mapping_suite_mismatch')
    methods = {m: {'count': 0, 'clear_semantic_failure_cases': 0, 'unresolved_semantic_cases': 0,
        'usefulness': [], 'style': [], **{d + '_' + v: 0 for d in DIMENSIONS for v in ('pass', 'fail', 'uncertain')}} for m in suite['compilers']}
    paired = {m: {'wins': 0, 'losses': 0, 'ties': 0} for m in suite['comparators']}
    for cid, verdict in verdicts['cases'].items():
        labels = mapping[cid]
        if set(labels) != set(verdict['options']) or {v['method'] for v in labels.values()} != set(methods):
            raise ValueError('mapping_method_set_mismatch')
        ranks = {label: rank for rank, tier in enumerate(verdict['preference']) for label in tier}
        method_labels = {meta['method']: label for label, meta in labels.items()}
        for label, meta in labels.items():
            judgment, stats = verdict['options'][label], methods[meta['method']]
            stats['count'] += 1
            stats['clear_semantic_failure_cases'] += int(any(judgment[d] == 'fail' for d in DIMENSIONS))
            stats['unresolved_semantic_cases'] += int(any(judgment[d] == 'uncertain' for d in DIMENSIONS))
            for d in DIMENSIONS:
                stats[d + '_' + judgment[d]] += 1
            for d in ('usefulness', 'style'):
                stats[d].append(judgment[d])
        candidate_rank = ranks[method_labels[suite['candidate']]]
        for comparator in suite['comparators']:
            other_rank = ranks[method_labels[comparator]]
            paired[comparator]['wins' if candidate_rank < other_rank else 'losses' if candidate_rank > other_rank else 'ties'] += 1
    for stats in methods.values():
        for d in ('usefulness', 'style'):
            scores = stats.pop(d)
            stats[d + '_mean'] = sum(scores) / len(scores)
            stats[d + '_min'] = min(scores)
    policy = suite['policy']
    candidate = methods[suite['candidate']]
    failures = sum(candidate[d + '_fail'] for d in DIMENSIONS)
    uncertain = sum(candidate[d + '_uncertain'] for d in DIMENSIONS)
    reasons = []
    if failures:
        reasons.append('candidate_clear_semantic_failure')
    if uncertain:
        reasons.append('candidate_unresolved_semantic_judgment')
    if candidate['usefulness_min'] < policy['min_case_usefulness'] or candidate['usefulness_mean'] < policy['min_mean_usefulness']:
        reasons.append('candidate_below_usefulness_floor')
    if candidate['style_mean'] < policy['min_mean_style']:
        reasons.append('candidate_below_style_floor')
    for comparator, pair in paired.items():
        base = methods[comparator]
        use_gain = candidate['usefulness_mean'] - base['usefulness_mean']
        style_gain = candidate['style_mean'] - base['style_mean']
        semantic_reduction = base['clear_semantic_failure_cases'] - candidate['clear_semantic_failure_cases']
        pair.update(usefulness_gain=use_gain, style_gain=style_gain, net_wins=pair['wins'] - pair['losses'],
                    clear_semantic_failure_case_reduction=semantic_reduction,
                    semantic_failure_reduction_by_dimension={d: base[d + '_fail'] - candidate[d + '_fail'] for d in DIMENSIONS})
        if use_gain < -1e-9:
            reasons.append('usefulness_regresses_vs_' + comparator)
        if not (use_gain >= policy['meaningful_usefulness_gain'] - 1e-9 or style_gain >= policy['meaningful_style_gain'] - 1e-9):
            reasons.append('no_meaningful_score_gain_vs_' + comparator)
        if pair['net_wins'] < math.ceil(suite['case_count'] * policy['min_paired_net_win_fraction']):
            reasons.append('no_meaningful_paired_gain_vs_' + comparator)
        supplemental = suite.get('supplemental_policy')
        if supplemental and not (use_gain >= supplemental['min_behavior_usefulness_gain'] - 1e-9 or
                                  semantic_reduction >= supplemental['min_clear_failure_case_reduction']):
            reasons.append('no_meaningful_behavior_gain_vs_' + comparator)
    return {'suite_hash': suite['suite_hash'], 'report_hash': report['report_hash'],
        'verdict_hash': verdicts['verdict_hash'], 'split': suite['split'], 'reviewer': 'agent_delegated',
        'methods': methods, 'paired': paired, 'policy': policy,
        'supplemental_policy': suite.get('supplemental_policy'),
        'gate': 'reject' if failures else 'hold' if reasons else 'pass', 'gate_reasons': reasons,
        'activation_authorized': False, 'evidence_kind': 'independent_synthetic'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['compile', 'verify', 'generate', 'show', 'freeze-verdicts', 'summary'])
    parser.add_argument('--raw', type=Path)
    parser.add_argument('--suite', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--judgments', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--compiler', action='append', default=[], help='method=/absolute/worker.py')
    parser.add_argument('--candidate')
    parser.add_argument('--comparator', action='append', default=[])
    parser.add_argument('--supplemental-policy', type=Path)
    parser.add_argument('--id')
    parser.add_argument('--model', type=Path)
    parser.add_argument('--adapter', type=Path)
    parser.add_argument('--artifacts', type=Path, help='private JSON of frozen model/adapter identities')
    parser.add_argument('--max-input-tokens', type=int, default=3904)
    parser.add_argument('--max-tokens', type=int, default=192)
    args = parser.parse_args()
    if args.command == 'compile':
        result = compile_suite(args.raw, args.output, dict(item.split('=', 1) for item in args.compiler), args.candidate, args.comparator, args.supplemental_policy)
    elif args.command == 'verify':
        suite = load_suite(args.suite)
        result = {k: suite[k] for k in ('suite_hash', 'raw_hash', 'split', 'case_count', 'compilers')}
    elif args.command == 'generate':
        if not all((args.model, args.adapter, args.report, args.suite, args.artifacts)):
            parser.error('generate requires --model --adapter --report --suite --artifacts')
        from mlx_lm.utils import load_tokenizer
        module = worker_module(Path(__file__).resolve().parent.parent / 'worker.py')
        engine = module.ReplyWorker()
        engine.path = args.model.resolve()
        result = generate(engine, load_tokenizer(str(engine.path)), args.adapter.resolve(),
            args.report, suite_path=args.suite, max_tokens=args.max_tokens,
            max_input_tokens=args.max_input_tokens, artifacts=read(args.artifacts))
    elif args.command == 'show':
        suite, _, views = review_view(args.suite, args.report)
        result = {'general_rubric': suite['general_rubric'], 'cases': [v for v in views if args.id is None or v['id'] == args.id]}
    elif args.command == 'freeze-verdicts':
        result = freeze_verdicts(args.suite, args.report, args.judgments, args.output)
    else:
        result = summarize(args.suite, args.report, args.judgments)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
