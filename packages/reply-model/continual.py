#!/usr/bin/env python3
"""Owner-local collection, reviewed replay training, and staged adapter evaluation.

No keystrokes, model approvals, or unsent drafts become ground truth. Candidate
bodies stay in SQLCipher and process memory; review records contain hashes only.
"""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.metadata
import math
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import time

from personalization import VERSION as TRAINING_POLICY_VERSION, model_identity, digest, prepare_examples, private_json, run_local, select_validation_checkpoint, loss_from_log, prefilter_length
from learning_split import key as source_key, freeze, source_keys, extend_temporal_assignments, reserve_refreshed_evaluation
from learning_evaluation import compare as compare_outputs
import history
try:
    from worker import ReplyWorker, build_generation_input, compile_prompt
except ModuleNotFoundError:
    import importlib.util
    spec = importlib.util.spec_from_file_location('reply_worker', Path(__file__).with_name('inboxd-reply-worker.py'))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    ReplyWorker = worker.ReplyWorker
    build_generation_input, compile_prompt = worker.build_generation_input, worker.compile_prompt

DEFAULT_ROOT = Path.home() / '.inboxd/reply-model/learning'
DEFAULT_MODEL = Path.home() / '.inboxd/reply-model/models/Qwen3.5-9B-4bit'


def collect(command):
    rows, skipped, cursor, visited = [], [], None, set()
    while True:
        query = {'training_candidates': True, 'limit': 10}
        if cursor:
            query['after_event_id'] = cursor
        result = subprocess.run([str(command), 'trajectory', 'list', json.dumps(query)],
                                capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise ValueError('candidate_export_failed')
        page = json.loads(result.stdout)
        if not isinstance(page.get('candidates'), list):
            raise ValueError('candidate_export_not_supported_by_daemon')
        rows.extend(page['candidates'])
        skipped.extend(page.get('omitted', []))
        cursor = page.get('next_after_event_id')
        if not cursor:
            return rows, skipped
        if cursor in visited:
            raise ValueError('candidate_export_cursor_repeated')
        visited.add(cursor)


def candidate_record(row):
    if row.get('outcome') != 'sent' or row.get('send_state') not in ('Sent', 'Verified'):
        raise ValueError('send_not_confirmed')
    if row.get('first_input') is not True:
        raise ValueError('no_observed_user_input')
    text = row.get('final_text')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('missing_final_text')
    if row.get('inserted') and text == row.get('suggested_text'):
        raise ValueError('unchanged_model_suggestion')
    incoming = row.get('incoming_message_ids', row.get('source_json'))
    if isinstance(incoming, str):
        incoming = json.loads(incoming)
    compiled, _ = compile_prompt({'context': row.get('context'), 'chat': row.get('chat', {}),
                                  'incoming_message_ids': incoming})
    payload = json.loads(compiled[-1]['content'])
    if payload['preflight']['status'] != 'ready':
        raise ValueError('ineligible_context')
    context = payload['conversation']
    timestamp = row['timestamp']
    if any(not isinstance(m['ts'], (int, float)) or m['ts'] >= timestamp for m in context):
        raise ValueError('future_or_missing_context_time')
    # The current prompt builder is shared with inference. Historical prompt
    # versions are not mixed into a new adapter's training input.
    messages = build_generation_input(compiled) + [{'role': 'assistant', 'content': text}]
    chat = row['chat']
    source = row.get('source_message_keys') or [source_key(chat['platform'], chat['account'], chat['chat_id'], m['message_id']) for m in context]
    target_keys = row.get('target_source_keys') or row.get('sent_message_keys') or []
    target_id = row.get('target_message_id')
    if target_id and not target_keys:
        target_keys = [source_key(chat['platform'], chat['account'], chat['chat_id'], target_id)]
    if not target_keys:
        raise ValueError('unlinked_send_identity')
    source = sorted(set(source) | set(target_keys))
    record = {'id': row['id'], 'source': 'session', 'chat': chat, 'conversation_id': digest(chat),
              'timestamp': timestamp, 'target_role': 'self', 'reviewed': False,
              'linkage': 'reviewed_turn', 'target_message_id': target_id or row['id'],
              'context_message_ids': [m['message_id'] for m in context],
              'context_timestamps': [m['ts'] for m in context],
              'provenance_refs': [row['id'], row['session_id']], 'messages': messages,
              'source_message_keys': source, 'target_source_keys': target_keys,
              'incoming_message_ids': incoming, 'unseen_state': 'known' if incoming is not None else 'unknown',
              'input_kind': 'edited_suggestion' if row.get('inserted') else 'manual',
              'suggestion_shown': bool(row.get('shown'))}
    # Bind reviews to data and prompt, so changed text or a deleted/rebuilt source
    # cannot silently inherit a prior review. The model draft is not a negative label.
    record['review_hash'] = digest(record)
    return record


def prepare_candidates(rows):
    records, rejected = [], []
    seen = set()
    for row in rows:
        if row.get('id') in seen:
            continue
        seen.add(row.get('id'))
        try:
            records.append(candidate_record(row))
        except (ValueError, TypeError, KeyError) as error:
            reason = str(error) if isinstance(error, ValueError) else 'invalid_candidate'
            rejected.append({'id': row.get('id'), 'reason': reason})
    return records, rejected


def reviewed_records(records, reviews):
    return [{**r, 'reviewed': True} for r in records
            if reviews.get(r['id'], {}).get('hash') == r['review_hash']
            and reviews[r['id']].get('decision') == 'approve']


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def loss_from_log(path):
    matches = re.findall(r'Test loss\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)', path.read_text(), re.I)
    return float(matches[-1]) if matches else None


@contextlib.contextmanager
def locked(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise ValueError('learning_directory_must_be_owner_only')
    fd = os.open(root / 'cycle.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('learning_cycle_already_running')
        yield
    finally:
        os.close(fd)


def compare_role_outputs(model, adapter, output):
    source = Path(__file__).with_name('learning_role_review.json')
    if not source.exists():
        source = Path(__file__).parent / 'fixtures/learning_role_review.json'
    cases = json.loads(source.read_text())
    engine = ReplyWorker()
    engine.path = Path(model)
    results = []
    for case in cases:
        context = [{'message_id':str(i), 'author_role':role, 'author_id':role,
                    'ts':i, 'body':body} for i, (role, body) in enumerate(case['turns'])]
        compiled, _ = compile_prompt({'context':context})
        prompt = build_generation_input(compiled)
        results.append({'id':case['id'], 'context':context, 'rubric':case['rubric'],
                        'base':engine.generate_text(prompt),
                        'candidate':engine.generate_text(prompt, adapter_path=str(adapter)),
                        'human_verdict':None})
        private_json(output, {'fixture_hash':hashlib.sha256(source.read_bytes()).hexdigest(),
                              'complete':False, 'cases':results})
    private_json(output, {'fixture_hash':hashlib.sha256(source.read_bytes()).hexdigest(),
                         'complete':True, 'cases':results})
    return str(output)


def recover_interrupted(root):
    path = root / 'status.json'
    state = read_json(path, {})
    if state.get('status') == 'training':
        state.update(status='training_interrupted', retry_required=True,
                     failure_reason='training_interrupted', interrupted_at=time.time())
        private_json(path, state)
    return state


def configured_gap_policy(args):
    policy = getattr(args, 'gap_policy_content', None)
    if policy is None:
        path = getattr(args, 'gap_policy', None)
        policy = json.loads(Path(path).read_text()) if path else {}
    if not isinstance(policy, dict):
        raise ValueError('invalid_gap_policy')
    history.group_turns([], policy)
    return policy


def training_identity(args, dataset_id):
    from training_runtime import RUNTIME_VERSION
    versions = {}
    for package in ('mlx', 'mlx-lm', 'transformers'):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = 'unavailable'
    try:
        base_id = model_identity(args.model)
    except ValueError:
        base_id = digest({'unavailable_model': str(args.model)})
    config = {'seq_length': getattr(args, 'seq_length', 2048),
              'batch_size': getattr(args, 'batch_size', 1),
              'epochs': float(getattr(args, 'epochs', 2)), 'iters': getattr(args, 'iters', None),
              'max_runtime_seconds': float(getattr(args, 'max_runtime_seconds', 7200)),
              'max_rss_bytes': int(getattr(args, 'max_rss_gib', 20) * 1024**3),
              'max_swap_bytes': int(getattr(args, 'max_swap_gib', 4) * 1024**3),
              'gap_policy': configured_gap_policy(args), 'training_policy_version': TRAINING_POLICY_VERSION}
    config['platforms'] = list(history.selected_platforms(getattr(args, 'platform', None)))
    environment = {'runtime_version': RUNTIME_VERSION, 'libraries': versions,
                   'python_version': sys.version.split()[0], 'base_id': base_id, 'config': config}
    return {'configuration_fingerprint': digest(environment),
            'failure_fingerprint': digest({**environment, 'dataset_id': dataset_id}),
            'runtime_version': RUNTIME_VERSION, 'base_id': base_id, 'training_config': config}


def cycle(args, records, reviews):
    state_path = args.root / 'status.json'
    previous = recover_interrupted(args.root)
    approved = reviewed_records(records, reviews)
    approved.extend(history.reviewed_records(getattr(args, 'history_records', []), reviews))
    from review_sensitive import sensitive_admission_report
    quarantine_path = args.root / 'sensitive-source-quarantine.json'
    quarantine_policy = read_json(args.root / 'sensitive-source-policy.json', {})
    if quarantine_policy.get('required') and not quarantine_path.is_file():
        raise ValueError('required_sensitive_quarantine_missing')
    empty_quarantine = {'version': 'empty-new-root', 'source_keys': [], 'values_retained': False}
    empty_quarantine['quarantine_hash'] = history.digest(empty_quarantine)
    quarantine = read_json(quarantine_path, empty_quarantine)
    if (quarantine_policy.get('required') and
            quarantine.get('quarantine_hash') != quarantine_policy.get('quarantine_hash')):
        raise ValueError('required_sensitive_quarantine_changed')
    approved, sensitive_rejected = sensitive_admission_report(approved, quarantine)
    length_rejected = []
    if getattr(args, 'model', None) and (Path(args.model) / 'config.json').is_file():
        from mlx_lm.utils import load_tokenizer
        approved, length_rejected = prefilter_length(approved, load_tokenizer(args.model),
            getattr(args, 'seq_length', 2048))
    partition_path = args.root / 'partitions.json'
    partitions = read_json(partition_path, None)
    if partitions is not None:
        partitions = reserve_refreshed_evaluation(partitions,
            list(records) + list(getattr(args, 'history_records', [])))
        private_json(partition_path, partitions)
    if partitions is None:
        initial_splits, _ = prepare_examples(approved)
        if (len(initial_splits['train']) >= args.min_train
                and len(initial_splits['valid']) >= args.min_eval
                and len(initial_splits['test']) >= args.min_eval):
            partitions = freeze({}, initial_splits)
            partitions['assignments'].update({r['id']: name for name, values in initial_splits.items() for r in values})
            private_json(partition_path, partitions)
    assignments = None
    if partitions is not None:
        assignments = dict(partitions['assignments'])
        for r in approved:
            assignments.setdefault(r['id'], 'train')
        assignments = extend_temporal_assignments(approved, assignments, partitions)
    splits, manifest = prepare_examples(approved, assignments=assignments, frozen=partitions)
    manifest['rejected'].extend(length_rejected)
    manifest['rejected'].extend(sensitive_rejected)
    manifest['dataset_id'] = digest({k: v for k, v in manifest.items() if k != 'dataset_id'})
    retained = [r for name in ('train', 'valid', 'test') for r in splits[name]]
    retained_assignments = {r['id']: name for name in splits for r in splits[name]}
    if partitions is not None:
        partitions = freeze(partitions, splits)
        partitions['assignments'].update({r['id']: name for name, values in splits.items() for r in values})
        private_json(partition_path, partitions)
    counts = {name: len(rows) for name, rows in splits.items()}
    training_ids = {row['id']: row['example_hash'] for row in manifest['splits']['train']}
    old_ids = previous.get('trained_examples', {})
    new_count = sum(old_ids.get(key) != value for key, value in training_ids.items())
    state = {**previous, 'checked_at': time.time(),
             'candidate_count': len(records) + len(getattr(args, 'history_records', [])),
             'candidate_counts_by_source': {'session': len(records),
                                           'history': len(getattr(args, 'history_records', []))},
             'approved_count': len(approved), 'split_counts': counts,
             'split_rejected_counts': {reason: sum(item['reason'] == reason for item in manifest['rejected'])
                                       for reason in sorted({item['reason'] for item in manifest['rejected']})},
             'distinct_chat_counts': {name: len({digest(r['chat']) for r in splits[name]}) for name in splits},
             'test_evidence_counts': {kind: sum(r.get('evaluation_group') == kind for r in splits['test'])
                                      for kind in ('temporal', 'heldout_chat', 'retrospective')},
             'new_train_examples': new_count, 'dataset_id': manifest['dataset_id'],
             'activation': 'manual', 'status': 'collecting'}
    # These describe only the current dataset check, unlike retained training
    # evidence and failed_attempts. Recompute them in the matching branch below.
    for field in ('insufficient_evidence', 'no_new_dataset'):
        state.pop(field, None)
    if previous.get('trained_dataset_id') == manifest['dataset_id']:
        state['status'] = ('awaiting_quality_review' if previous.get('status') == 'awaiting_quality_review'
                           else 'no_new_dataset')
        state['no_new_dataset'] = True
    elif (counts['train'] < args.min_train or counts['valid'] < args.min_eval
          or counts['test'] < args.min_eval or new_count < args.min_new
          or not state['test_evidence_counts']['temporal'] or not state['test_evidence_counts']['heldout_chat']):
        state['status'] = 'waiting_for_reviewed_data'
        state['insufficient_evidence'] = {name: {'available': counts[name],
              'required': args.min_train if name == 'train' else args.min_eval}
              for name in ('train', 'valid', 'test') if counts[name] < (args.min_train if name == 'train' else args.min_eval)}
        state['insufficient_evidence']['test_groups'] = {
            kind: state['test_evidence_counts'][kind] for kind in ('temporal', 'heldout_chat')
            if state['test_evidence_counts'][kind] == 0}
    else:
        attempt = training_identity(args, manifest['dataset_id'])
        failures = previous.get('failed_attempts', {})
        blocked = previous.get('failure_reason') == 'training_interrupted' or any(
            failure.get('failure_fingerprint') == attempt['failure_fingerprint']
            or (failure.get('resource_failure') and failure.get('configuration_fingerprint')
                == attempt['configuration_fingerprint']) for failure in failures.values())
        if blocked and not getattr(args, 'retry_failed', False):
            state.update(status='training_retry_blocked', retry_required=True)
            private_json(state_path, state)
            return state
        state.pop('retry_required', None)
        state.pop('failure_reason', None)
        state.update(attempt)
        runs = args.root / 'runs'
        runs.mkdir(mode=0o700, exist_ok=True)
        os.chmod(runs, 0o700)
        run = runs / f'{time.time_ns()}-{manifest["dataset_id"][:12]}'
        run.mkdir(mode=0o700)
        state.update(status='training', run=str(run))
        private_json(state_path, state)
        # Each cycle trains from the base with the current retained reviewed data,
        # not just the most recent correction. No activation occurs in this path.
        try:
            settings = {'assignments': retained_assignments, 'seq_length': getattr(args, 'seq_length', 2048),
                        'batch_size': getattr(args, 'batch_size', 1), 'epochs': getattr(args, 'epochs', 2),
                        'max_runtime_seconds': float(getattr(args, 'max_runtime_seconds', 7200)),
                        'max_rss_bytes': int(getattr(args, 'max_rss_gib', 20) * 1024**3),
                        'max_swap_bytes': int(getattr(args, 'max_swap_gib', 4) * 1024**3)}
            run_local(retained, args.model, run / 'adapter', iters=getattr(args, 'iters', None), **settings)
            selection = select_validation_checkpoint(retained, args.model, run / 'adapter',
                assignments=retained_assignments, seq_length=settings['seq_length'], batch_size=settings['batch_size'],
                max_runtime_seconds=settings['max_runtime_seconds'], max_rss_bytes=settings['max_rss_bytes'],
                max_swap_bytes=settings['max_swap_bytes'])
            run_local(retained, args.model, run / 'base-evaluation', evaluate=True, **settings)
            run_local(retained, args.model, run / 'adapter-evaluation', evaluate=True, adapter=run / 'adapter', **settings)
            base_loss = loss_from_log(run / 'base-evaluation/runtime.log')
            adapter_loss = loss_from_log(run / 'adapter-evaluation/runtime.log')
            engine = ReplyWorker(); engine.path = Path(args.model)
            from mlx_lm.utils import load_tokenizer
            tokenizer = load_tokenizer(args.model)
            active = read_json(args.root.parent / 'active-adapter.json', {}).get('active')
            rubric_path = Path(__file__).parent / 'fixtures/learning_evaluation_rubrics.json'
            if not rubric_path.exists():
                rubric_path = Path(__file__).parent / 'learning_evaluation_rubrics.json'
            rubrics = json.loads(rubric_path.read_text())
            comparison = compare_outputs(engine, tokenizer, splits['train'], splits['test'], run / 'adapter',
                                         run / 'blind-review.json', active_adapter=active.get('path') if active else None,
                                         heldout_rubric=rubrics['heldout'], rubric_cases=rubrics['fixtures'],
                                         seq_length=settings['seq_length'], gap_policy=configured_gap_policy(args))
            state.update(comparison_report=comparison, checkpoint_selection=selection,
                         status='awaiting_quality_review', trained_dataset_id=manifest['dataset_id'],
                         trained_examples=training_ids, base_test_loss=base_loss, adapter_test_loss=adapter_loss,
                         loss_improved=base_loss is not None and adapter_loss is not None and adapter_loss < base_loss,
                         quality_review_required=['speaker_role_reversal', 'unsupported_facts_and_commitments', 'reply_usefulness'])
        except Exception as error:
            reason = getattr(error, 'reason', None)
            allowed = {'training_timeout', 'training_rss_limit', 'training_cancelled',
                       'training_resource_monitor_failed', 'training_memory_error', 'training_swap_limit',
                       'local_training_or_evaluation_failed'}
            reason = reason if reason in allowed else 'training_failed'
            resource = reason in {'training_timeout', 'training_rss_limit', 'training_resource_monitor_failed',
                                  'training_memory_error', 'training_swap_limit'}
            failures[attempt['failure_fingerprint']] = {**attempt, 'resource_failure': resource,
                'reason': reason, 'at': time.time()}
            state.update(status='training_failed', error_type=type(error).__name__,
                         failure_reason=reason, failed_attempts=failures, retry_required=True)
            # Keep the run path for its private diagnostic logs, never raw errors.
    private_json(state_path, state)
    return state


def schedule(args):
    if sys.platform != 'darwin':
        raise ValueError('schedule_requires_macos')
    label = 'page.boaz.inboxd.learning'
    target = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    target.parent.mkdir(parents=True, exist_ok=True)
    plist = {'Label': label, 'ProgramArguments': [sys.executable, str(Path(__file__).resolve()),
             'cycle', '--root', str(args.root), '--inboxd', str(args.inboxd), '--model', str(args.model),
             '--seq-length', str(args.seq_length), '--batch-size', str(args.batch_size),
             '--epochs', str(args.epochs), '--max-runtime-seconds', str(args.max_runtime_seconds),
             '--max-rss-gib', str(args.max_rss_gib),
             '--max-swap-gib', str(getattr(args, 'max_swap_gib', 4))] +
             (['--gap-policy', str(args.gap_policy)] if getattr(args, 'gap_policy', None) else []) +
             [item for platform in history.selected_platforms(getattr(args, 'platform', None)) for item in ('--platform', platform)] +
             (['--iters', str(args.iters)] if args.iters else []),
             'StartCalendarInterval': {'Hour': 4, 'Minute': 0},
             'StandardOutPath': str(args.root / 'scheduler.log'),
             'StandardErrorPath': str(args.root / 'scheduler-error.log'),
             'ProcessType': 'Background', 'LowPriorityIO': True, 'Umask': 63}
    for log in ('scheduler.log', 'scheduler-error.log'):
        fd = os.open(args.root / log, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(fd)
    with target.open('wb') as stream:
        os.chmod(target, 0o600)
        plistlib.dump(plist, stream)
    subprocess.run(['launchctl', 'bootout', f'gui/{os.getuid()}/{label}'], capture_output=True)
    result = subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(target)], capture_output=True)
    if result.returncode:
        raise ValueError('schedule_install_failed')
    return {'scheduled': True, 'local_time': '04:00', 'activation': 'manual', 'plist': str(target)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('status', 'show', 'review', 'cycle', 'schedule'))
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--inboxd', type=Path, default=Path.home()/'.local/bin/inboxd')
    parser.add_argument('--model', type=Path, default=DEFAULT_MODEL)
    parser.add_argument('--id')
    parser.add_argument('--platform', action='append', choices=('kakao', 'telegram', 'slack', 'all'),
                        help='Repeat to select platforms; all explicitly includes Slack. Default: Kakao and Telegram')
    parser.add_argument('--decision', choices=('approve', 'reject'))
    parser.add_argument('--ack-reason', action='append', default=[])
    parser.add_argument('--min-train', type=int, default=100)
    parser.add_argument('--min-eval', type=int, default=20)
    parser.add_argument('--min-new', type=int, default=25)
    parser.add_argument('--iters', type=int)
    parser.add_argument('--epochs', type=float, default=2)
    parser.add_argument('--batch-size', type=int, default=1)
    parser.add_argument('--seq-length', type=int, default=2048)
    parser.add_argument('--max-runtime-seconds', type=float, default=7200)
    parser.add_argument('--max-rss-gib', type=float, default=20)
    parser.add_argument('--max-swap-gib', type=float, default=4)
    parser.add_argument('--gap-policy', type=Path, help='JSON platform turn-gap policy shared by review and cycle')
    parser.add_argument('--retry-failed', action='store_true', help='explicitly retry a failed or interrupted training run')
    args = parser.parse_args()
    args.root, args.inboxd, args.model = args.root.resolve(), args.inboxd.resolve(), args.model.resolve()
    if args.gap_policy:
        args.gap_policy = args.gap_policy.resolve()
    args.gap_policy_content = configured_gap_policy(args)
    if min(args.min_train, args.min_eval, args.min_new) < 1:
        parser.error('example thresholds must be positive')
    if not all(math.isfinite(value) and value > 0 for value in (args.max_runtime_seconds, args.max_rss_gib, args.max_swap_gib)):
        parser.error('training resource limits must be finite and positive')
    with locked(args.root):
        recover_interrupted(args.root)
        if args.command == 'schedule':
            result = schedule(args)
        else:
            rows, omitted = collect(args.inboxd)
            platforms = history.selected_platforms(args.platform)
            records, rejected = prepare_candidates([row for row in rows
                if (row.get('chat') or {}).get('platform') in platforms])
            history_rows, history_omitted = [], []
            for platform in platforms:
                found, skipped = history.collect(args.inboxd, platform=platform)
                history_rows.extend(found)
                history_omitted.extend(skipped)
            tokenizer = None
            if args.model.is_dir():
                from mlx_lm.utils import load_tokenizer
                tokenizer = load_tokenizer(args.model)
            history_records, history_rejected = history.prepare_candidates(
                history_rows, session_rows=list(rows) + list(omitted), tokenizer=tokenizer,
                max_seq_length=args.seq_length, gap_policy=args.gap_policy_content)
            args.history_records = history_records
            review_path = args.root / 'reviews.json'
            reviews = read_json(review_path, {})
            if args.command in ('review', 'show'):
                record = next((r for r in records + history_records if r['id'] == args.id), None)
                if record is None:
                    raise ValueError('eligible_candidate_not_found')
                if args.command == 'show':
                    result = record
                else:
                    if not args.decision:
                        raise ValueError('review_decision_required')
                    acknowledgements = set(args.ack_reason)
                    if record.get('source') == 'history':
                        expected = set(record['reasons']) & history.REVIEWABLE_REASONS
                        if args.decision == 'approve' and (not record['eligible_for_review'] or acknowledgements != expected):
                            raise ValueError('review_warnings_must_be_acknowledged_or_hard_hold')
                    reviews[args.id] = {'hash': record['review_hash'], 'decision': args.decision,
                                        'acknowledged_reasons': sorted(acknowledgements), 'at': time.time()}
                    private_json(review_path, reviews)
                    result = {'id': args.id, 'decision': args.decision}
            elif args.command == 'cycle':
                result = cycle(args, records, reviews)
            else:
                result = {'observations': len(rows) + len(history_rows),
                          'eligible_candidates': len(records) + sum(r['eligible_for_review'] for r in history_records),
                          'approved': len(reviewed_records(records, reviews)) + len(history.reviewed_records(history_records, reviews)),
                          'rejected': rejected + history_rejected, 'omitted': omitted + history_omitted,
                          'candidates': [{'id':r['id'], 'kind':r['input_kind'], 'timestamp':r['timestamp'],
                                          'status': r.get('status', 'candidate')} for r in records + history_records],
                          'last_cycle': read_json(args.root/'status.json', {})}
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Library errors may contain conversation/model contents. Keep scheduler
        # diagnostics bounded; detailed MLX logs live in owner-only run directories.
        print(json.dumps({'status':'error', 'error_type':type(error).__name__}), file=sys.stderr)
        sys.exit(1)
