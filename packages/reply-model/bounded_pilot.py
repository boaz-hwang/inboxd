"""Explicit owner-local pilot; plan is CPU-only and run requires the same plan hash.

No activation, message sending, collection, or automatic new-example admission.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import importlib.metadata
import contextlib
import signal
import stat
import time
import re

import continual as c
import history as h
import personalization as p
import training_curriculum as curriculum

GAP_POLICY = {'kakao': 64, 'telegram': 115}
FRESH_SHA = 'd130426feb506abfb320c2e706484d30b503ac68036d1348e5d661fdc09655e4'


def restore_daemon(args):
    result = subprocess.run([str(args.inboxd), 'daemon', 'start'],
        capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise ValueError('daemon_restore_failed')
    wait_daemon_ready()


def daemon_status_ready(status):
    encryption = status.get('encryption') if isinstance(status, dict) else None
    return (isinstance(encryption, dict) and status.get('ready') is True
            and encryption.get('ready') is True and encryption.get('schema_valid') is True)


def owner_daemon_status():
    from kakao_local_import import OwnerRpc
    rpc = OwnerRpc(timeout=3)
    try:
        return rpc.request('system.status', {})
    finally:
        rpc.close()


def wait_daemon_ready(*, timeout=45):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if daemon_status_ready(owner_daemon_status()):
                return
        except (OSError, ValueError, RuntimeError):
            pass
        time.sleep(min(.2, max(0, deadline - time.monotonic())))
    raise ValueError('daemon_not_ready_after_restore')


def resource_snapshot():
    text = subprocess.check_output(['vm_stat'], text=True, timeout=5)
    page_size = int(re.search(r'page size of (\d+) bytes', text).group(1))
    pages = {}
    for name in ('Pages free', 'Pages inactive', 'Pages speculative',
                 'Pages wired down', 'Pages occupied by compressor'):
        match = re.search(re.escape(name) + r':\s*(\d+)', text)
        if match:
            pages[name] = int(match.group(1)) * page_size
    return {'vm_bytes': pages, 'swap_used_bytes': p._system_swap_used()}


def stop_owner_daemon(args):
    lock = args.daemon_lock
    if lock.parent.is_symlink() or lock.is_symlink():
        raise ValueError('invalid_daemon_lock')
    info = lock.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise ValueError('invalid_daemon_lock')
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        if os.fstat(stream.fileno()).st_ino != info.st_ino:
            raise ValueError('daemon_lock_changed')
        pid = json.load(stream)['pid']
    if type(pid) is not int or pid < 1:
        raise ValueError('invalid_daemon_pid')
    probe = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'uid=,comm='], capture_output=True, text=True, timeout=5)
    fields = probe.stdout.strip().split(None, 1)
    if probe.returncode or len(fields) != 2 or int(fields[0]) != os.getuid() or fields[1] != str(args.daemon_binary):
        raise ValueError('daemon_executable_identity_mismatch')
    owned = p._process_tree_accounting(pid)
    child_pids = [row[0] for row in owned if row[0] != pid]
    before = resource_snapshot()
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        remaining = subprocess.run(['/bin/ps', '-p', ','.join(map(str, [pid] + child_pids)),
            '-o', 'pid=,stat='], capture_output=True, text=True, timeout=5)
        live = [line for line in remaining.stdout.splitlines() if not line.split()[-1].startswith('Z')]
        if not lock.exists() and not live:
            after = resource_snapshot()
            p.private_json(args.output / 'daemon-pause-resources.json', {'daemon_pid': pid,
                'daemon_executable_verified': True, 'worker_count_before': len(child_pids),
                'owned_live_processes_after': 0, 'before': before, 'after': after})
            return
        time.sleep(.05)
    raise ValueError('daemon_shutdown_incomplete')


@contextlib.contextmanager
def daemon_pause(args):
    if not args.pause_daemon:
        yield
        return
    previous = {}
    def cancelled(_number, _frame):
        raise p.TrainingRuntimeError('training_cancelled')
    try:
        # Cover staging and checkpoint work between guarded children too.
        # Installation must succeed before touching the owner daemon.
        for number in (signal.SIGINT, signal.SIGTERM):
            previous[number] = signal.signal(number, cancelled)
        try:
            stop_owner_daemon(args)
            yield
        finally:
            # A second interrupt must not cut short restoration/readiness.
            for number in previous:
                signal.signal(number, signal.SIG_IGN)
            restore_daemon(args)
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def prepare(args):
    from mlx_lm.utils import load_tokenizer
    tokenizer = load_tokenizer(args.model)
    sessions, omitted = c.collect(args.inboxd)
    session_records, _ = c.prepare_candidates(sessions)
    rows = []
    for platform in GAP_POLICY:
        found, _ = h.collect(args.inboxd, platform=platform)
        rows.extend(found)
    historical, _ = h.prepare_candidates(rows, session_rows=sessions + omitted,
        tokenizer=tokenizer, max_seq_length=4096, gap_policy=GAP_POLICY)
    reviews = c.read_json(args.root / 'reviews.json', {})
    frozen = c.read_json(args.root / 'partitions.json', None)
    if not frozen:
        raise ValueError('frozen_partitions_required')
    approved = c.reviewed_records(session_records, reviews) + h.reviewed_records(historical, reviews)
    approved = [r for r in approved if r['id'] in frozen['assignments']]
    approved, _ = p.prefilter_length(approved, tokenizer, 4096)
    real_splits, _ = p.prepare_examples(approved, assignments=frozen['assignments'], frozen=frozen)
    if {name: len(rs) for name, rs in real_splits.items()} != {'train': 28, 'valid': 12, 'test': 22}:
        raise ValueError('real_frozen_counts_changed')
    frozen_counts = {name: len(rs) for name, rs in real_splits.items()}
    real_splits, exclusions = filter_real_training(real_splits, tokenizer, args.train_max_tokens)
    expected_train = 22 if args.train_max_tokens == 2048 else 28
    if len(real_splits['train']) != expected_train:
        raise ValueError('filtered_real_training_count_changed')
    real = [r for rs in real_splits.values() for r in rs]
    assignments = {r['id']: name for name, rs in real_splits.items() for r in rs}
    synthetic_train = curriculum.build_records(tokenizer, seq_length=4096)
    synthetic_valid = curriculum.build_validation_records(tokenizer, seq_length=4096)
    merged, assignments = curriculum.merge_training_records(real, assignments, synthetic_train)
    merged, assignments = curriculum.merge_validation_records(merged, assignments, synthetic_valid)
    splits, manifest = p.prepare_examples(merged, assignments=assignments)
    if {name: len(rs) for name, rs in splits.items()} != {'train': expected_train + 32, 'valid': 20, 'test': 22}:
        raise ValueError('merged_counts_changed')
    lengths = {}
    for name, rs in splits.items():
        totals, targets = [], []
        for r in rs:
            full = tokenizer.apply_chat_template(r['messages'], return_dict=False, enable_thinking=False)
            prefix = tokenizer.apply_chat_template(r['messages'][:-1], add_generation_prompt=True,
                return_dict=False, enable_thinking=False)
            totals.append(len(full)); targets.append(len(full) - len(prefix))
        lengths[name] = {'count': len(rs), 'max_total_tokens': max(totals),
                        'max_target_tokens': max(targets),
                        'unique_batch_shapes': len({min(4096, 1 + 32 * ((n + 31) // 32)) for n in totals})}
    suite = Path(__file__).parent / 'evaluation_v2/fresh_frozen.json'
    if json.loads(suite.read_text()).get('suite_hash') != FRESH_SHA:
        raise ValueError('fresh_suite_changed')
    if args.train_max_tokens == 2048 and lengths['train']['max_total_tokens'] != 1985:
        raise ValueError('short_training_max_length_changed')
    train_count = len(splits['train'])
    plan = {'version': 1, 'gap_policy': GAP_POLICY, 'seq_length': 4096,
        'pause_daemon': args.pause_daemon,
        'train_max_tokens': args.train_max_tokens, 'training_exclusions': exclusions,
        'frozen_real_counts': frozen_counts,
        'epochs': 2, 'iters': train_count * 2, 'save_every': train_count, 'batch_size': 1,
        'real_counts': {name: len(rs) for name, rs in real_splits.items()},
        'synthetic_counts': {'train': len(synthetic_train), 'valid': len(synthetic_valid)},
        'lengths': lengths, 'dataset_hash': manifest['dataset_id'],
        'reviewed_source_fingerprint': p.digest(sorted((r['id'], r['review_hash']) for r in real)),
        'partitions_hash': p.digest(frozen), 'fresh_suite_hash': FRESH_SHA,
        'fresh_suite_file_sha256': hashlib.sha256(suite.read_bytes()).hexdigest(),
        'runtime_fingerprint': {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in ('bounded_pilot.py', 'personalization.py', 'training_runtime.py')},
        'libraries': {name: importlib.metadata.version(name) for name in ('mlx', 'mlx-lm', 'transformers')},
        'base_model_id': p.model_identity(args.model),
        'max_rss_bytes': 28 * 1024**3, 'max_swap_bytes': 4 * 1024**3, 'max_runtime_seconds': 7200}
    return real_splits, merged, assignments, plan


def filter_real_training(splits, tokenizer, max_tokens):
    result = {name: list(records) for name, records in splits.items()}
    retained, excluded = [], []
    for record in result['train']:
        total = len(tokenizer.apply_chat_template(record['messages'], return_dict=False, enable_thinking=False))
        if total > max_tokens:
            excluded.append({'id': record['id'], 'hash': record['review_hash'],
                'total_tokens': total, 'reason': 'pilot_train_over_token_budget'})
        else:
            retained.append(record)
    result['train'] = retained
    return result, sorted(excluded, key=lambda item: item['id'])


def execute(args):
    real_splits, records, assignments, plan = prepare(args)
    expected = c.read_json(args.output / 'plan.json', {})
    if p.digest(expected) != p.digest(plan):
        raise ValueError('pilot_plan_changed')
    with daemon_pause(args):
        execute_prepared(args, real_splits, records, assignments, plan)


def execute_prepared(args, real_splits, records, assignments, plan):
    settings = dict(assignments=assignments, seq_length=4096, batch_size=1, epochs=2,
        max_runtime_seconds=7200, max_rss_bytes=28 * 1024**3, max_swap_bytes=4 * 1024**3)
    adapter = args.output / 'adapter'
    p.run_local(records, args.model, adapter, iters=plan['iters'], save_every=plan['save_every'], **settings)
    selection = p.select_validation_checkpoint(records, args.model, adapter, deduplicate=True,
        **{k: v for k, v in settings.items() if k != 'epochs'})
    p.run_local(records, args.model, args.output / 'base-evaluation', evaluate=True, **settings)
    p.run_local(records, args.model, args.output / 'adapter-evaluation', evaluate=True, adapter=adapter, **settings)
    from mlx_lm.utils import load_tokenizer
    from learning_evaluation import compare
    engine = c.ReplyWorker(); engine.path = args.model
    rubric_path = Path(__file__).parent / 'fixtures/learning_evaluation_rubrics.json'
    if not rubric_path.exists():
        rubric_path = Path(__file__).parent / 'learning_evaluation_rubrics.json'
    rubrics = json.loads(rubric_path.read_text())
    compare(engine, load_tokenizer(args.model), real_splits['train'], real_splits['test'], adapter,
        args.output / 'blind-review.json', rubric_cases=rubrics['fixtures'], heldout_rubric=rubrics['heldout'],
        seq_length=4096, max_input_tokens=4096, gap_policy=GAP_POLICY)
    del engine
    import gc
    import mlx.core as mx
    gc.collect()
    mx.clear_cache()
    fresh = Path(__file__).parent / 'evaluation_v2/fresh_evaluate.py'
    with (args.output / 'fresh-runtime.log').open('w') as log:
        os.chmod(log.name, 0o600)
        p.guarded_training_run([sys.executable, str(fresh), 'generate', '--model', str(args.model),
            '--adapter', str(adapter), '--report', str(args.output / 'fresh-comparison.json')],
            env=os.environ, stdout=log, pass_fds=(), max_runtime_seconds=7200,
            max_rss_bytes=28 * 1024**3, max_swap_bytes=4 * 1024**3,
            resource_report_path=args.output / 'fresh-resources.json')
    p.private_json(args.output / 'completion.json', {'status': 'awaiting_quality_review',
        'plan_hash': p.digest(plan), 'checkpoint_selection': selection, 'activation_performed': False})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'run', '_child'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--inboxd', type=Path, default=Path.home() / '.local/bin/inboxd')
    parser.add_argument('--pause-daemon', action='store_true')
    parser.add_argument('--train-max-tokens', type=int, choices=[2048, 4096], default=4096)
    parser.add_argument('--daemon-lock', type=Path, default=Path.home() / '.inboxd/state/inboxd.lock')
    parser.add_argument('--daemon-binary', type=Path, default=Path.home() / '.inboxd/product/release/inboxd-daemon')
    args = parser.parse_args()
    for name in ('root', 'model', 'output', 'inboxd', 'daemon_binary'):
        setattr(args, name, getattr(args, name).resolve())
    args.daemon_lock = args.daemon_lock.absolute()
    if args.command == 'plan':
        _, _, _, plan = prepare(args)
        args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
        p.private_json(args.output / 'plan.json', plan)
        print(json.dumps(plan))
    elif args.command == '_child':
        execute(args)
    else:
        run_guarded(args)


def run_guarded(args):
    try:
        with (args.output / 'pilot-runtime.log').open('x') as log:
            os.chmod(log.name, 0o600)
            p.guarded_training_run([sys.executable, str(Path(__file__).resolve()), '_child',
                '--root', str(args.root), '--model', str(args.model), '--output', str(args.output),
                '--inboxd', str(args.inboxd), '--daemon-lock', str(args.daemon_lock),
                '--daemon-binary', str(args.daemon_binary), '--train-max-tokens', str(args.train_max_tokens)]
                + (['--pause-daemon'] if args.pause_daemon else []),
                env=os.environ, stdout=log, pass_fds=(),
                max_runtime_seconds=7200, max_rss_bytes=28 * 1024**3, max_swap_bytes=4 * 1024**3,
                resource_report_path=args.output / 'pilot-resources.json')
    finally:
        if args.pause_daemon:
            restore_daemon(args)


if __name__ == '__main__':
    main()
