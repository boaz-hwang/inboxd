#!/usr/bin/env python3
"""Owner-local blind quality review; source inputs are re-fetched only for show/review.

No historical context or reviewer judgment is fabricated or copied into review files.
"""
import argparse
from collections import Counter, defaultdict
import fcntl
import json
import os
from pathlib import Path
import sys
import time

import history
from personalization import digest, private_json

RUBRIC_FILE = Path(__file__).with_name('learning_evaluation_rubrics.json')
if not RUBRIC_FILE.exists():
    RUBRIC_FILE = Path(__file__).parent / 'fixtures/learning_evaluation_rubrics.json'
DEFAULT_MODEL = Path.home() / '.inboxd/reply-model/models/Qwen3.5-9B-4bit'
DEFAULT_INBOXD = Path.home() / '.local/bin/inboxd'
DIMENSIONS = ('role', 'fact', 'abstain')
SCORES = ('usefulness', 'style')


def _read_private(path):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or path.parent.is_symlink():
        raise ValueError('private_absolute_file_required')
    stat = path.stat()
    if stat.st_uid != os.getuid() or stat.st_mode & 0o077:
        raise ValueError('private_owner_only_file_required')
    parent = path.parent.stat()
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('private_owner_only_directory_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(fd, 'r') as stream:
            return json.load(stream)
    except Exception:
        raise


def _rubric_bundle():
    return json.loads(RUBRIC_FILE.read_text())


def _fixture(case_id):
    return next((r for r in _rubric_bundle()['fixtures'] if r['id'] == case_id), None)


def report_gap_policy(report):
    # Older v2 reports used automatic thresholds. New reports bind explicit
    # overrides to a hash so reconstruction and stored judgments share policy.
    policy = report.get('gap_policy', {})
    if not isinstance(policy, dict):
        raise ValueError('invalid_report_gap_policy')
    history.group_turns([], policy)
    if ('gap_policy' in report or report.get('report_version', 0) >= 3) and (
            'gap_policy' not in report or report.get('gap_policy_hash') != digest(policy)):
        raise ValueError('stale_report_gap_policy')
    return policy


def _candidate_records(report, inboxd, model):
    policy = report_gap_policy(report)
    import continual
    from mlx_lm.utils import load_tokenizer
    tokenizer = load_tokenizer(model)
    session_rows, session_omitted = continual.collect(inboxd)
    session_records, _ = continual.prepare_candidates(session_rows)
    historical = []
    for platform in ('kakao', 'telegram', 'slack'):
        rows, _ = history.collect(inboxd, platform=platform)
        historical.extend(rows)
    history_records, _ = history.prepare_candidates(historical, session_rows=session_rows + session_omitted,
        tokenizer=tokenizer, max_seq_length=report.get('seq_length', 2048), gap_policy=policy)
    return {r['id']: r for r in session_records + history_records}


def _lookup_source(case, report, *, inboxd, model, reviews_path, candidate_records=None):
    report_gap_policy(report)
    if digest(_rubric_bundle()) != report.get('rubric_bundle_hash'):
        raise ValueError('stale_rubric_bundle')
    if case['source'] == 'rubric_fixture':
        fixture = _fixture(case['id'])
        if fixture is None:
            raise ValueError('stale_fixture_missing')
        return {'source_hash': digest({k: fixture[k] for k in ('id','messages','rubric')}),
                'prompt': fixture['messages'], 'rubric': fixture['rubric']}
    if case['source'] != 'heldout_reply':
        raise ValueError('invalid_case_source')
    import continual
    record = (candidate_records if candidate_records is not None else
              _candidate_records(report, inboxd, model)).get(case['id'])
    if record is None:
        raise ValueError('stale_source_missing')
    reviews = _read_private(reviews_path) if Path(reviews_path).exists() else {}
    approved = (continual.reviewed_records([record], reviews) if record['source'] == 'session'
                else history.reviewed_records([record], reviews))
    if not approved:
        raise ValueError('stale_source_review')
    return {'source_hash': record['review_hash'], 'prompt': record['messages'][:-1],
            'rubric': case['rubric']}


def verify_case(report, case_id, resolver):
    if not report.get('complete') or not isinstance(report.get('cases'), list):
        raise ValueError('incomplete_comparison')
    case = next((c for c in report['cases'] if c.get('id') == case_id), None)
    if case is None:
        raise ValueError('case_not_found')
    try:
        report_gap_policy(report)
        current = resolver(case)
    except (ValueError, KeyError, TypeError):
        return {'id': case_id, 'status': 'stale'}
    if (current['source_hash'] != case.get('source_hash')
            or digest(current['prompt']) != case.get('prompt_hash')
            or digest(current['rubric']) != case.get('rubric_hash')):
        return {'id': case_id, 'status': 'stale'}
    outputs = case.get('outputs')
    if not isinstance(outputs, list) or not outputs or len({o.get('label') for o in outputs}) != len(outputs):
        return {'id': case_id, 'status': 'stale'}
    if any(digest(o.get('text')) != o.get('output_hash') for o in outputs):
        return {'id': case_id, 'status': 'stale'}
    return {'id': case_id, 'status': 'ready', 'source': case['source'],
            'evaluation_group': case.get('evaluation_group'), 'input': current['prompt'],
            'rubric': current['rubric'],
            'outputs': [{'label': o['label'], 'text': o['text']} for o in outputs],
            'comparison_complete': case.get('comparison_complete', False),
            'source_hash': case['source_hash'], 'prompt_hash': case['prompt_hash'],
            'output_hashes': {o['label']: o['output_hash'] for o in outputs},
            'gap_policy_hash': report.get('gap_policy_hash')}


def validate_verdict(case_view, verdict):
    labels = set(case_view['output_hashes'])
    options = verdict.get('options')
    if not isinstance(options, dict) or set(options) != labels:
        raise ValueError('all_anonymous_options_required')
    normalized = {}
    for label, values in options.items():
        if not isinstance(values, dict) or set(values) != set(DIMENSIONS + SCORES):
            raise ValueError('invalid_option_judgment')
        if any(values[d] not in ('pass', 'fail', 'uncertain') for d in DIMENSIONS):
            raise ValueError('invalid_quality_judgment')
        if any(type(values[d]) is not int or values[d] not in range(1, 6) for d in SCORES):
            raise ValueError('invalid_quality_score')
        normalized[label] = {d: values[d] for d in DIMENSIONS + SCORES}
    preference = verdict.get('preference')
    if preference not in labels | {'tie', 'none'}:
        raise ValueError('invalid_preference')
    return {'options': normalized, 'preference': preference}


def save_verdict(report_path, case_view, verdict, *, reviewer='human', authorization=None):
    if case_view['status'] != 'ready':
        raise ValueError('stale_case')
    if reviewer not in ('human', 'agent_delegated'):
        raise ValueError('invalid_reviewer')
    if reviewer == 'agent_delegated' and (not isinstance(authorization, str)
            or not authorization.strip() or len(authorization) > 2048):
        raise ValueError('delegated_review_authorization_required')
    normalized = validate_verdict(case_view, verdict)
    path = Path(report_path).with_name(Path(report_path).stem + '-verdicts.json')
    lock = path.with_name(path.name + '.lock')
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        existing = _read_private(path) if path.exists() else {'cases': {}}
        existing['cases'][case_view['id']] = {
            'source_hash': case_view['source_hash'], 'prompt_hash': case_view['prompt_hash'],
            'output_hashes': case_view['output_hashes'],
            'gap_policy_hash': case_view.get('gap_policy_hash'), 'judgment': normalized,
            'reviewer': reviewer, 'reviewed_at': time.time()}
        if reviewer == 'agent_delegated':
            existing['cases'][case_view['id']]['authorization'] = authorization.strip()
        private_json(path, existing)
    finally:
        os.close(fd)
    return {'id': case_view['id'], 'status': 'reviewed', 'reviewer': reviewer}


def status(report, verdicts, current=None):
    report_gap_policy(report)
    cases = report.get('cases') or []
    accepted = 0
    stale = 0
    reviewer_counts = Counter({'human': 0, 'agent_delegated': 0, 'legacy_unknown': 0})
    for case in cases:
        decision = verdicts.get('cases', {}).get(case.get('id'), {})
        if (decision.get('gap_policy_hash') == report.get('gap_policy_hash')
                and decision.get('source_hash') == case.get('source_hash')
                and decision.get('prompt_hash') == case.get('prompt_hash')
                and decision.get('output_hashes') == {o['label']:o.get('output_hash') for o in case.get('outputs', [])}):
            reviewer = decision.get('reviewer', 'legacy_unknown')
            valid_provenance = (reviewer in ('human', 'legacy_unknown')
                or (reviewer == 'agent_delegated' and isinstance(decision.get('authorization'), str)
                    and bool(decision['authorization'].strip()) and len(decision['authorization']) <= 2048))
            if not valid_provenance or (current is not None and current(case)['status'] != 'ready'):
                stale += 1
            else:
                accepted += 1
                reviewer_counts[reviewer] += 1
    return {'case_count': len(cases), 'reviewed_count': accepted,
            'pending_count': len(cases) - accepted,
            'quality_review_complete': bool(cases) and accepted == len(cases),
            'human_review_complete': bool(cases) and reviewer_counts['human'] == len(cases),
            'reviewer_counts': dict(reviewer_counts), 'human_reviewed_count': reviewer_counts['human'],
            'agent_delegated_reviewed_count': reviewer_counts['agent_delegated'],
            'legacy_unknown_reviewed_count': reviewer_counts['legacy_unknown'],
            'stale_review_count': stale,
            'comparison_complete': report.get('comparison_complete', False),
            'omission_count': len(report.get('omissions') or [])}


def summary(report, verdicts, mapping):
    state = status(report, verdicts)
    if not state['quality_review_complete']:
        raise ValueError('quality_review_incomplete')
    counts = defaultdict(Counter)
    scores = defaultdict(lambda: defaultdict(list))
    preferences = Counter()
    for case in report['cases']:
        judgment = verdicts['cases'][case['id']]['judgment']
        methods = mapping.get(case['id']) or {}
        for label, values in judgment['options'].items():
            method = (methods.get(label) or {}).get('method')
            if not method:
                raise ValueError('unblind_mapping_incomplete')
            for dimension in DIMENSIONS:
                counts[method][dimension + '_' + values[dimension]] += 1
            for dimension in SCORES:
                scores[method][dimension].append(values[dimension])
            counts[method]['reviewed_outputs'] += 1
        preferred = judgment['preference']
        if preferred in ('tie', 'none'):
            preferences[preferred] += 1
        else:
            preferences[methods[preferred]['method']] += 1
    return {**state, 'methods': {method: {**dict(counts[method]),
             **{name + '_mean': sum(values)/len(values) for name, values in scores[method].items()}}
             for method in counts}, 'preferences': dict(preferences)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('status', 'show', 'review', 'summary'))
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--id')
    parser.add_argument('--verdict-file', type=Path)
    parser.add_argument('--reviewer', choices=('human', 'agent_delegated'), default='human')
    parser.add_argument('--authorization', help='explicit user delegation statement; required for agent review')
    parser.add_argument('--inboxd', type=Path, default=DEFAULT_INBOXD)
    parser.add_argument('--model', type=Path, default=DEFAULT_MODEL)
    parser.add_argument('--reviews', type=Path, default=history.DEFAULT_ROOT/'reviews.json')
    args = parser.parse_args(argv)
    report = _read_private(args.report)
    report_gap_policy(report)
    verdict_path = args.report.with_name(args.report.stem + '-verdicts.json')
    verdicts = _read_private(verdict_path) if verdict_path.exists() else {'cases': {}}
    cache = {}
    def resolve(case):
        if case.get('source') == 'heldout_reply' and 'candidates' not in cache:
            cache['candidates'] = _candidate_records(report, args.inboxd, args.model)
        return _lookup_source(case, report, inboxd=args.inboxd, model=args.model,
            reviews_path=args.reviews, candidate_records=cache.get('candidates'))
    if args.command == 'status':
        result = status(report, verdicts, lambda case: verify_case(report, case['id'], resolve))
    elif args.command == 'summary':
        if any(verify_case(report, case['id'], resolve)['status'] != 'ready' for case in report.get('cases', [])):
            raise ValueError('stale_comparison_source')
        mapping = _read_private(args.report.with_name(args.report.stem + '-unblind.json'))
        result = summary(report, verdicts, mapping)
    else:
        if not args.id:
            raise ValueError('case_id_required')
        view = verify_case(report, args.id, resolve)
        if args.command == 'show':
            result = view
        else:
            if view['status'] != 'ready':
                raise ValueError('stale_case')
            if not args.verdict_file:
                raise ValueError('verdict_file_required')
            verdict = json.loads(args.verdict_file.read_text())
            result = save_verdict(args.report, view, verdict, reviewer=args.reviewer, authorization=args.authorization)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'error', 'error_type': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
