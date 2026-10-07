"""Local personal adapter lifecycle; no automatic training or activation.

Input records are explicitly reviewed examples, not inferred reply pairs.
Dataset staging is temporary and private; canonical observations stay in storage.
"""
import argparse
import copy
import contextlib
import fcntl
import math
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import re
import shutil
import stat
import time
import signal
from learning_split import partition, source_keys

VERSION = "personal-data-v1"
_STAGING_LOCK_FDS = set()


class TrainingRuntimeError(ValueError):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def _validate_resource_budget(max_runtime_seconds, max_rss_bytes):
    if (type(max_runtime_seconds) not in (int, float) or not math.isfinite(max_runtime_seconds)
            or max_runtime_seconds <= 0 or type(max_rss_bytes) is not int or max_rss_bytes <= 0):
        raise ValueError('invalid_training_resource_budget')


def _process_tree_accounting(group):
    """Read numeric process accounting only; never collect command lines."""
    try:
        result = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,rss='], capture_output=True,
                                text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        raise TrainingRuntimeError('training_resource_monitor_failed') from None

    if result.returncode:
        raise TrainingRuntimeError('training_resource_monitor_failed')
    try:
        rows = [tuple(map(int, line.split())) for line in result.stdout.splitlines() if line.strip()]
        if any(len(row) != 4 for row in rows):
            raise ValueError('invalid_process_accounting')
        members = {pid for pid, ppid, pgid, rss in rows if pgid == group}
        while True:
            descendants = {pid for pid, ppid, pgid, rss in rows if ppid in members}
            if descendants <= members:
                break
            members.update(descendants)
        return [row for row in rows if row[0] in members]
    except (ValueError, TypeError):
        raise TrainingRuntimeError('training_resource_monitor_failed') from None


def _process_group_rss(group):
    return sum(row[3] * 1024 for row in _process_tree_accounting(group))


def parse_swap_usage(text):
    match = re.search(r'\bused\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT])\b', text)
    if not match:
        raise TrainingRuntimeError('training_resource_monitor_failed')
    return int(float(match[1]) * 1024 ** ('KMGT'.index(match[2]) + 1))


def _system_swap_used():
    if sys.platform != 'darwin':
        return None
    try:
        result = subprocess.run(['sysctl', '-n', 'vm.swapusage'], capture_output=True,
                                text=True, timeout=5)
        if result.returncode:
            raise TrainingRuntimeError('training_resource_monitor_failed')
        return parse_swap_usage(result.stdout)
    except (OSError, subprocess.TimeoutExpired):
        raise TrainingRuntimeError('training_resource_monitor_failed') from None


def _terminate_training_group(process, *, grace_seconds=5):
    # Snapshot owned descendant sessions before the leader exits and reparents them.
    try:
        groups = {row[2] for row in _process_tree_accounting(process.pid)} | {process.pid}
    except TrainingRuntimeError:
        groups = {process.pid}
    groups.discard(os.getpgrp())
    def exists(group):
        try:
            os.killpg(group, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            # macOS can reject signal 0 for an exited, unreaped group leader.
            return _process_group_rss(group) > 0
    for group in groups:
        try:
            os.killpg(group, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        process.poll()  # Reap exited group leader before checking for descendants.
        if not any(exists(group) for group in groups):
            break
        time.sleep(min(.05, max(0, deadline - time.monotonic())))
    for group in groups:
        if exists(group):
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
    process.wait()


def guarded_training_run(command, *, env, stdout, pass_fds,
                         max_runtime_seconds=7200, max_rss_bytes=20 * 1024**3,
                         max_swap_bytes=4 * 1024**3, resource_report_path=None):
    """Bound a dedicated child group; MLX allocator limits alone are soft."""
    _validate_resource_budget(max_runtime_seconds, max_rss_bytes)
    if type(max_swap_bytes) is not int or max_swap_bytes <= 0:
        raise ValueError('invalid_training_resource_budget')
    baseline_swap = _system_swap_used()
    started = time.monotonic()
    resources = {'version': 1, 'baseline_swap_bytes': baseline_swap,
                 'peak_rss_bytes': 0, 'peak_swap_growth_bytes': 0, 'samples': []}
    failure_reason = None
    previous = {}
    process = None
    def cancelled(_number, _frame):
        raise TrainingRuntimeError('training_cancelled')
    try:
        for number in (signal.SIGINT, signal.SIGTERM):
            try:
                previous[number] = signal.signal(number, cancelled)
            except ValueError:  # Non-main threads still get exception-driven cleanup.
                break
        process = subprocess.Popen(command, env=env, stdout=stdout,
            stderr=subprocess.STDOUT, pass_fds=pass_fds, start_new_session=True,
            umask=0o077)
        deadline = time.monotonic() + max_runtime_seconds
        while process.poll() is None:
            if time.monotonic() >= deadline:
                raise TrainingRuntimeError('training_timeout')
            rss = _process_group_rss(process.pid)
            resources['peak_rss_bytes'] = max(resources['peak_rss_bytes'], rss)
            if rss > max_rss_bytes:
                raise TrainingRuntimeError('training_rss_limit')
            swap = _system_swap_used()
            growth = max(0, swap - baseline_swap) if baseline_swap is not None and swap is not None else None
            if growth is not None:
                resources['peak_swap_growth_bytes'] = max(resources['peak_swap_growth_bytes'], growth)
            elapsed = time.monotonic() - started
            if not resources['samples'] or elapsed - resources['samples'][-1]['elapsed_seconds'] >= 5:
                resources['samples'].append({'elapsed_seconds': round(elapsed, 3),
                    'rss_bytes': rss, 'swap_growth_bytes': growth})
            if baseline_swap is not None and swap - baseline_swap >= max_swap_bytes:
                raise TrainingRuntimeError('training_swap_limit')
            try:
                process.wait(timeout=min(.5, max(.001, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
        if process.returncode:
            raise TrainingRuntimeError('local_training_or_evaluation_failed')
        return process
    except BaseException as error:
        failure_reason = getattr(error, 'reason', 'training_cancelled'
            if isinstance(error, KeyboardInterrupt) else 'training_runtime_failed')
        for number in previous:
            signal.signal(number, signal.SIG_IGN)
        if process is not None:
            _terminate_training_group(process)
        raise
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        if resource_report_path is not None:
            resources.update(elapsed_seconds=round(time.monotonic() - started, 3),
                             status='failed' if failure_reason else 'complete',
                             failure_reason=failure_reason)
            private_json(Path(resource_report_path), resources)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def local_model(path):
    path = Path(path)
    if not path.is_absolute() or not (path / "config.json").is_file():
        raise ValueError("absolute_local_model_required")
    return path.resolve()


def model_identity(path):
    path = local_model(path)
    # Include weights, not only config. Cached callers can reuse the result.
    files = sorted(path.glob("*.safetensors")) + [path / "config.json"]
    if len(files) < 2:
        raise ValueError("model_weights_missing")
    h = hashlib.sha256()
    for file in files:
        h.update(file.name.encode())
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
    return h.hexdigest()


def prepare_examples(records, *, assignments=None, frozen=None):
    """Strict eligibility, chronology, and duplicate-group split isolation.

    record: id, conversation_id, timestamp, reviewed, linkage, target_role,
    target_message_id, context_message_ids, context_timestamps, messages,
    provenance_refs. Optional duplicate_group groups paraphrased duplicates.
    """
    accepted, rejected, seen_ids = [], [], set()
    for source in records:
        r = copy.deepcopy(source)
        reason = None
        try:
            if not isinstance(r, dict):
                raise ValueError("invalid_record")
            if not r.get("reviewed") is True or r.get("target_role") != "self":
                raise ValueError("unreviewed_or_not_self")
            if r.get("linkage") not in ("explicit_reply", "reviewed_turn", "historical_reply", "temporal_reply"):
                raise ValueError("unreliable_linkage")
            if not all(isinstance(r.get(k), str) and r[k] for k in ("id", "conversation_id", "target_message_id")):
                raise ValueError("missing_identity")
            if r["id"] in seen_ids:
                raise ValueError("duplicate_id")
            ts = r["timestamp"]
            times = r["context_timestamps"]
            ids = r["context_message_ids"]
            if type(ts) not in (int, float) or not math.isfinite(ts) or not times or len(times) != len(ids):
                raise ValueError("invalid_timestamps")
            if any(type(t) not in (int, float) or not math.isfinite(t) or not t < ts for t in times):
                raise ValueError("future_context")
            if r["target_message_id"] in ids or not r.get("provenance_refs"):
                raise ValueError("missing_or_leaking_provenance")
            source_keys(r)
            messages = r["messages"]
            if not isinstance(messages, list) or len(messages) < 2:
                raise ValueError("invalid_messages")
            if any(m.get("role") not in ("system", "user", "assistant") or not isinstance(m.get("content"), str) or not m["content"].strip() for m in messages):
                raise ValueError("invalid_messages")
            if messages[-1]["role"] != "assistant" or messages[-2]["role"] != "user":
                raise ValueError("invalid_target")
            seen_ids.add(r["id"])
            accepted.append(r)
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            reason = str(exc) if isinstance(exc, ValueError) else "invalid_record"
        if reason:
            rejected.append({"id": r.get("id") if isinstance(r, dict) else None, "reason": reason})
    accepted.sort(key=lambda r: (r["timestamp"], r["id"]))
    splits, boundary_rejected = partition(accepted, assignments=assignments, frozen=frozen)
    rejected.extend(boundary_rejected)
    manifest = {"version": VERSION, "splits": {k: [{"id": r["id"], "example_hash": digest(r), "provenance_refs": r["provenance_refs"]} for r in v] for k, v in splits.items()}, "rejected": rejected}
    manifest["dataset_id"] = digest(manifest)
    return splits, manifest


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _pid_alive(pid):
    if type(pid) is not int or pid < 1:
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _legacy_process_uses(path):
    """Fail closed if an unmarked directory might belong to an older trainer."""
    try:
        result = subprocess.run(['ps', '-A', '-ww', '-o', 'command='],
                                capture_output=True, text=True, timeout=5)
        return result.returncode != 0 or str(path) in result.stdout
    except (OSError, subprocess.TimeoutExpired):
        return True


@contextlib.contextmanager
def private_staging(prefix):
    """Keep an owner-only lock alive in both the orchestrator and MLX child."""
    if prefix not in ('inboxd-training-', 'inboxd-checkpoints-'):
        raise ValueError('invalid_staging_prefix')
    directory = Path(tempfile.mkdtemp(prefix=prefix))
    os.chmod(directory, 0o700)
    lock_path = directory / '.active.lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        payload = json.dumps({'version': 1, 'pid': os.getpid(), 'created_at': time.time()})
        os.write(fd, payload.encode())
        os.fsync(fd)
        _STAGING_LOCK_FDS.add(fd)
        yield directory, fd
    finally:
        _STAGING_LOCK_FDS.discard(fd)
        try:
            shutil.rmtree(directory)
        finally:
            os.close(fd)


def cleanup_stale_training_dirs(*, legacy_grace_seconds=60):
    """Remove abandoned private staging, never a live locked training child."""
    root = Path(tempfile.gettempdir())
    removed = 0
    for prefix in ('inboxd-training-', 'inboxd-checkpoints-'):
        for path in root.glob(prefix + '*'):
            try:
                info = path.lstat()
                if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_mode & 0o077):
                    continue
                lock = path / '.active.lock'
                if lock.is_symlink():
                    continue
                if lock.exists():
                    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
                    try:
                        lock_info = os.fstat(fd)
                        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.getuid():
                            continue
                        try:
                            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except BlockingIOError:
                            continue
                        metadata = json.loads(os.read(fd, 4096))
                        if not isinstance(metadata, dict) or metadata.get('version') != 1 or _pid_alive(metadata.get('pid')):
                            continue
                        shutil.rmtree(path)
                        removed += 1
                    finally:
                        os.close(fd)
                    continue
                elif (time.time() - info.st_mtime < legacy_grace_seconds
                      or _legacy_process_uses(path)):
                    continue
                shutil.rmtree(path)
                removed += 1
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue
    return removed


def prefilter_length(records, tokenizer, seq_length):
    kept, rejected = [], []
    for record in records:
        tokens = tokenizer.apply_chat_template(record['messages'], return_dict=False,
                                               enable_thinking=False)
        prefix = tokenizer.apply_chat_template(record['messages'][:-1],
            add_generation_prompt=True, return_dict=False, enable_thinking=False)
        offset = len(prefix)
        if offset >= len(tokens) or tokens[:offset] != prefix:
            raise ValueError('training_prefix_or_target_mismatch')
        if len(tokens) > seq_length:
            rejected.append({'id': record['id'], 'reason': 'over_token_budget'})
        else:
            kept.append(record)
    return kept, rejected


def stage_training_model(model, directory, records, production_tokenizer):
    """Make MLX's default ChatDataset template match production non-thinking mode."""
    from mlx_lm.utils import load_tokenizer
    stage = Path(directory) / 'model'
    stage.mkdir(mode=0o700)
    template = model / 'chat_template.jinja'
    for item in model.iterdir():
        if item.name != 'chat_template.jinja':
            (stage / item.name).symlink_to(item, target_is_directory=item.is_dir())
    if template.exists():
        (stage / 'chat_template.jinja').write_text(
            '{%- set enable_thinking = false %}\n' + template.read_text())
        os.chmod(stage / 'chat_template.jinja', 0o600)
    staged = load_tokenizer(stage)
    for r in records:
        messages = r['messages']
        expected = production_tokenizer.apply_chat_template(messages, return_dict=False,
                                                              enable_thinking=False)
        expected_prefix = production_tokenizer.apply_chat_template(messages[:-1],
            add_generation_prompt=True, return_dict=False, enable_thinking=False)
        actual = staged.apply_chat_template(messages, return_dict=False)
        actual_prefix = staged.apply_chat_template(messages[:-1], add_generation_prompt=True,
                                                    return_dict=False)
        if (actual != expected or actual_prefix != expected_prefix
                or actual[:len(actual_prefix)] != actual_prefix):
            raise ValueError('staged_training_template_mismatch')
    return stage


def iterations_for(train_count, batch_size, epochs, override=None):
    if batch_size < 1 or epochs <= 0 or not math.isfinite(epochs):
        raise ValueError('invalid_training_schedule')
    value = override if override is not None else math.ceil(train_count * epochs / batch_size)
    if not isinstance(value, int) or not 1 <= value <= 100000:
        raise ValueError('invalid_iterations')
    return value


def loss_from_log(path):
    match = re.findall(r'Test loss\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)', Path(path).read_text(), re.I)
    return float(match[-1]) if match else None


def select_validation_checkpoint(records, model, adapter, *, assignments, seq_length=2048, batch_size=1,
                                 max_runtime_seconds=7200, max_rss_bytes=20 * 1024**3, max_swap_bytes=4 * 1024**3,
                                 deduplicate=False, compile_mode='default', runtime_backend='legacy'):
    """Evaluate saved adapter weights on validation only, then install winner."""
    cleanup_stale_training_dirs()
    adapter = Path(adapter)
    checkpoints = sorted(adapter.glob('[0-9]' * 7 + '_adapters.safetensors'))
    checkpoints.append(adapter / 'adapters.safetensors')
    if not all(path.is_file() for path in checkpoints):
        raise ValueError('adapter_checkpoint_missing')
    if deduplicate:
        unique, seen = [], set()
        for path in checkpoints:
            fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
            if fingerprint not in seen:
                seen.add(fingerprint)
                unique.append(path)
        checkpoints = unique
    scores = []
    receipt_directory = adapter / 'checkpoint-validation'
    receipt_directory.mkdir(mode=0o700, exist_ok=True)
    receipts = []
    training_metadata = json.loads((adapter / 'manifest.json').read_text())
    validation_records_hash = digest(records)
    validation_assignments_hash = digest(assignments)
    def persist_receipts(status):
        ledger = {'version': 'checkpoint-validation-receipts-v1', 'status': status,
                  'criterion': 'full_validation_loss', 'validation_records_hash': validation_records_hash,
                  'validation_assignments_hash': validation_assignments_hash,
                  'final_test_records_supplied': 0, 'evaluations': receipts}
        ledger['ledger_hash'] = digest(ledger)
        private_json(adapter / 'checkpoint-validation.json', ledger)
    with private_staging('inboxd-checkpoints-') as (tmp, _lock_fd):
        for index, path in enumerate(checkpoints):
            candidate = Path(tmp) / f'candidate-{index}'
            candidate.mkdir(mode=0o700)
            shutil.copyfile(path, candidate / 'adapters.safetensors')
            artifact_hash = hashlib.sha256((candidate / 'adapters.safetensors').read_bytes()).hexdigest()
            shutil.copyfile(adapter / 'adapter_config.json', candidate / 'adapter_config.json')
            private_json(candidate / 'manifest.json', json.loads((adapter / 'manifest.json').read_text()))
            report = Path(tmp) / f'validation-{index}'
            run_local(records, model, report, evaluate=True, adapter=candidate,
                      assignments=assignments, seq_length=seq_length,
                      batch_size=batch_size, split_name='valid',
                      max_runtime_seconds=max_runtime_seconds, max_rss_bytes=max_rss_bytes, max_swap_bytes=max_swap_bytes,
                      compile_mode=compile_mode, runtime_backend=runtime_backend)
            loss = loss_from_log(report / 'runtime.log')
            if loss is None or not math.isfinite(loss):
                raise ValueError('validation_loss_missing')
            evaluated = json.loads((report / 'manifest.json').read_text())
            resources = json.loads((report / 'resources.json').read_text())
            if evaluated.get('status') != 'complete' or resources.get('status') != 'complete':
                raise ValueError('checkpoint_validation_receipt_incomplete')
            iteration = int(path.name[:7]) if path.name[0].isdigit() else training_metadata['iters']
            if (hashlib.sha256(path.read_bytes()).hexdigest() != artifact_hash or
                    hashlib.sha256((candidate / 'adapters.safetensors').read_bytes()).hexdigest() != artifact_hash):
                raise ValueError('evaluated_checkpoint_changed')
            resource_file = receipt_directory / f'{index + 1}-{artifact_hash[:12]}-resources.json'
            private_json(resource_file, resources)
            receipt = {'checkpoint_iteration': iteration, 'artifact_path': str(path.resolve()),
                'artifact_sha256': artifact_hash, 'validation_loss': loss,
                'loss_precision': 'mlx_lm_three_decimal_log',
                'validation_records_hash': validation_records_hash,
                'validation_assignments_hash': validation_assignments_hash,
                'validation_example_count': len(records), 'seq_length': seq_length, 'batch_size': batch_size,
                'base_model_id': evaluated.get('base_model_id'), 'dataset_id': evaluated.get('dataset_id'),
                'runtime_log_sha256': hashlib.sha256((report / 'runtime.log').read_bytes()).hexdigest(),
                'resource_report_path': str(resource_file.resolve()),
                'resource_report_sha256': hashlib.sha256(resource_file.read_bytes()).hexdigest(),
                'compile_mode': compile_mode,
                'runtime_backend': runtime_backend,
                'runtime_configuration': evaluated['runtime_configuration'],
                'runtime_source_sha256': evaluated['runtime_source_sha256'],
                'runtime_dependency_versions': evaluated['runtime_dependency_versions'],
                'runtime_fingerprint': evaluated['runtime_fingerprint'],
                'final_test_records_supplied': 0}
            receipt['loss_evaluation_hash'] = digest(receipt)
            receipts.append(receipt)
            # Preserve each completed result even if a later evaluation fails.
            persist_receipts('running')
            scores.append((loss, index, path))
    persist_receipts('complete')
    winner = min(scores)
    if winner[2] != adapter / 'adapters.safetensors':
        shutil.copyfile(winner[2], adapter / 'adapters.safetensors')
    metadata = json.loads((adapter / 'manifest.json').read_text())
    metadata['selection'] = {'criterion': 'validation_loss', 'loss': winner[0],
                             'checkpoint_iteration': int(winner[2].name[:7]) if winner[2].name[0].isdigit() else metadata['iters'],
                             'evaluated_checkpoints': len(scores),
                             'checkpoint_validation_ledger': str((adapter / 'checkpoint-validation.json').resolve()),
                             'checkpoint_validation_ledger_sha256': hashlib.sha256((adapter / 'checkpoint-validation.json').read_bytes()).hexdigest()}
    metadata['selection_required'] = False
    private_json(adapter / 'manifest.json', metadata)
    return metadata['selection']


def run_local(records, model, output, *, iters=None, evaluate=False, adapter=None, assignments=None,
              seq_length=2048, batch_size=1, epochs=2, save_every=None, split_name='test',
              max_runtime_seconds=7200, max_rss_bytes=20 * 1024**3, max_swap_bytes=4 * 1024**3,
              require_test_split=True, compile_mode='default', runtime_backend='legacy'):
    if compile_mode not in ('default', 'disabled'):
        raise ValueError('invalid_training_compile_mode')
    from training_runtime import runtime_configuration, runtime_source_files
    effective_runtime = runtime_configuration(runtime_backend, compile_mode)
    runtime_hashes = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                      for name in ('personalization.py',) + runtime_source_files(runtime_backend)}
    from importlib.metadata import version as package_version
    runtime_dependencies = {name: package_version(name) for name in ('mlx', 'mlx-lm')}
    runtime_fingerprint = digest({'configuration': effective_runtime,
                                  'source_sha256': runtime_hashes,
                                  'dependency_versions': runtime_dependencies})
    _validate_resource_budget(max_runtime_seconds, max_rss_bytes)
    cleanup_stale_training_dirs()
    model = local_model(model)
    splits, manifest = prepare_examples(records, assignments=assignments)
    if not require_test_split and splits['test']:
        raise ValueError('sealed_test_records_in_training')
    required = (('train', 'valid', 'test') if require_test_split else ('train', 'valid')) if not evaluate else (split_name,)
    if any(not splits[k] for k in required):
        raise ValueError("insufficient_disjoint_data")
    if not 64 <= seq_length <= 32768:
        raise ValueError('invalid_seq_length')
    # Refuse silent trainer truncation that could remove the actual reply target.
    from mlx_lm.utils import load_tokenizer
    tokenizer = load_tokenizer(model)
    for name, examples in splits.items():
        kept, rejected = prefilter_length(examples, tokenizer, seq_length)
        manifest['rejected'].extend(rejected)
        splits[name] = kept
    if any(not splits[k] for k in required):
        raise ValueError("insufficient_disjoint_data")
    if any(len(splits[k]) < batch_size for k in required):
        raise ValueError('split_smaller_than_batch_size')
    target_token_bound = max(len(tokenizer.apply_chat_template(r['messages'], return_dict=False,
        enable_thinking=False)) - len(tokenizer.apply_chat_template(r['messages'][:-1],
        add_generation_prompt=True, return_dict=False, enable_thinking=False))
        for examples in splits.values() for r in examples)
    if target_token_bound < 1:
        raise ValueError('invalid_target_token_bound')
    manifest['splits'] = {name: [item for item in manifest['splits'][name]
                                  if item['id'] in {r['id'] for r in splits[name]}] for name in splits}
    manifest['dataset_id'] = digest({k: v for k, v in manifest.items() if k != 'dataset_id'})
    iters = 1 if evaluate and iters is None else iterations_for(len(splits['train']), batch_size, epochs, iters)
    if save_every is not None and (not isinstance(save_every, int) or save_every < 1 or save_every > iters):
        raise ValueError('invalid_checkpoint_interval')
    identity = model_identity(model)
    if adapter:
        adapter = Path(adapter)
        if not adapter.is_absolute():
            raise ValueError("absolute_local_adapter_required")
        metadata = json.loads((adapter / "manifest.json").read_text())
        if metadata.get("base_model_id") != identity or metadata.get("status") != "complete":
            raise ValueError("adapter_base_or_status_mismatch")
    output = Path(output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    manifest.update(base_model_id=identity, mode="evaluate" if evaluate else "train",
                    selection_required=not evaluate,
                    target_token_bound=target_token_bound, compile_mode=compile_mode,
                    runtime_backend=runtime_backend, runtime_configuration=effective_runtime,
                    runtime_source_sha256=runtime_hashes,
                    runtime_dependency_versions=runtime_dependencies,
                    runtime_fingerprint=runtime_fingerprint,
                    resource_budget={'max_runtime_seconds': max_runtime_seconds, 'max_rss_bytes': max_rss_bytes, 'max_swap_bytes': max_swap_bytes})
    private_json(output / "manifest.json", manifest)
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")}
    env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1")
    with private_staging('inboxd-training-') as (directory, lock_fd):
        staged_model = stage_training_model(model, directory,
            [r for examples in splits.values() for r in examples], tokenizer)
        for name, examples in splits.items():
            # mlx_lm indexes data[0] for every existing split file, even unused
            # splits. Missing files are its supported empty-split representation.
            if not examples:
                continue
            file = Path(directory) / f"{name}.jsonl"
            with file.open("w") as stream:
                os.chmod(file, 0o600)
                for record in examples:
                    stream.write(json.dumps({"messages": record["messages"]}, ensure_ascii=False) + "\n")
        if evaluate and split_name == 'valid':
            shutil.copyfile(Path(directory) / 'valid.jsonl', Path(directory) / 'test.jsonl')
        save_every = save_every or max(1, min(25, iters))
        config = dict(model=str(staged_model), data=str(directory), train=not evaluate, test=evaluate,
                      adapter_path=str(Path(adapter).resolve()) if adapter else ("" if evaluate else str(output)),
                      fine_tune_type="lora", mask_prompt=True, batch_size=batch_size, num_layers=4,
                      iters=iters, val_batches=-1, test_batches=-1, max_seq_length=seq_length,
                      steps_per_eval=save_every, steps_per_report=10, save_every=save_every,
                      grad_checkpoint=True, seed=0, report_to=None,
                      inboxd_target_token_bound=target_token_bound,
                      inboxd_compile_mode=compile_mode,
                      inboxd_runtime_backend=runtime_backend)
        private_json(Path(directory) / "config.json", config)
        with (output / "runtime.log").open("w") as log:
            os.chmod(output / "runtime.log", 0o600)
            try:
                result = guarded_training_run([sys.executable, str(Path(__file__).resolve().with_name("training_runtime.py")), "--config", str(Path(directory) / "config.json")],
                    env=env, stdout=log, pass_fds=tuple(sorted(_STAGING_LOCK_FDS)),
                    max_runtime_seconds=max_runtime_seconds, max_rss_bytes=max_rss_bytes, max_swap_bytes=max_swap_bytes,
                    resource_report_path=output / 'resources.json')
            except BaseException as error:
                reason = getattr(error, 'reason', 'training_cancelled'
                    if isinstance(error, KeyboardInterrupt) else 'training_runtime_failed')
                if reason == 'local_training_or_evaluation_failed':
                    log.flush()
                    # Classify known allocator failures locally, never expose log content.
                    text = (output / 'runtime.log').read_text(errors='replace')
                    if ('[METAL]' in text and ('Insufficient Memory' in text or 'OutOfMemory' in text)
                            or 'kIOGPUCommandBufferCallbackErrorOutOfMemory' in text
                            or 'std::bad_alloc' in text):
                        reason = 'training_memory_error'
                        error = TrainingRuntimeError(reason)
                manifest.update(status='failed', failure_reason=reason)
                private_json(output / 'manifest.json', manifest)
                raise error
        adapter_config = output / 'adapter_config.json'
        if not evaluate and adapter_config.is_file():
            config_data = json.loads(adapter_config.read_text())
            config_data['model'] = str(model)
            config_data.pop('data', None)
            private_json(adapter_config, config_data)
        manifest["status"] = "complete" if result.returncode == 0 else "failed"
        manifest['seq_length'] = seq_length
        manifest['batch_size'] = batch_size
        manifest['iters'] = iters
        manifest['epochs'] = epochs
        private_json(output / "manifest.json", manifest)
        if result.returncode:
            raise ValueError("local_training_or_evaluation_failed")
    return manifest


def activate(registry, adapter, base_model_id, *, reviewed=False):
    if not reviewed:
        raise ValueError("evaluation_review_required")
    adapter = Path(adapter).resolve()
    manifest = json.loads((adapter / "manifest.json").read_text())
    if manifest.get("status") != "complete" or manifest.get("mode") != "train" or manifest.get("base_model_id") != base_model_id:
        raise ValueError("adapter_base_or_status_mismatch")
    if manifest.get('selection_required'):
        raise ValueError('validation_selection_required')
    if not (adapter / "adapters.safetensors").is_file() or not (adapter / "adapter_config.json").is_file():
        raise ValueError("adapter_artifact_missing")
    registry = Path(registry)
    old = json.loads(registry.read_text()) if registry.exists() else {"active": None}
    active = {"path": str(adapter), "base_model_id": base_model_id, "dataset_id": manifest["dataset_id"],
              "adapter_version": hashlib.sha256((adapter / "adapters.safetensors").read_bytes()).hexdigest()}
    private_json(registry, {"active": active, "previous": old.get("active")})
    return active


def rollback(registry):
    registry = Path(registry)
    old = json.loads(registry.read_text())
    private_json(registry, {"active": old.get("previous"), "previous": old.get("active")})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inspect", "train", "evaluate", "activate", "rollback"))
    parser.add_argument("--examples", type=Path)
    parser.add_argument("--model")
    parser.add_argument("--output")
    parser.add_argument("--adapter")
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--reviewed", action="store_true")
    parser.add_argument("--iters", type=int)
    parser.add_argument("--epochs", type=float, default=2)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--seq-length", type=int, default=2048)
    parser.add_argument("--save-every", type=int)
    parser.add_argument('--max-runtime-seconds', type=float, default=7200)
    parser.add_argument('--max-rss-gib', type=float, default=20)
    parser.add_argument('--max-swap-gib', type=float, default=4)
    parser.add_argument('--compile-mode', choices=('default', 'disabled'), default='default')
    parser.add_argument('--runtime-backend', choices=('legacy', 'parallel_chunk16'), default='legacy')
    args = parser.parse_args()
    if not math.isfinite(args.max_swap_gib) or args.max_swap_gib <= 0:
        parser.error('max-swap-gib must be positive and finite')
    if not math.isfinite(args.max_rss_gib) or args.max_rss_gib <= 0:
        parser.error('max-rss-gib must be positive and finite')
    try:
        _validate_resource_budget(args.max_runtime_seconds, int(args.max_rss_gib * 1024**3))
    except ValueError:
        parser.error('training resource budgets must be positive and finite')
    if args.command == "rollback":
        rollback(args.registry)
    elif args.command == "activate":
        print(json.dumps(activate(args.registry, args.adapter, model_identity(args.model), reviewed=args.reviewed)))
    else:
        records = [json.loads(line) for line in args.examples.read_text().splitlines() if line.strip()]
        if args.command == "inspect":
            _, manifest = prepare_examples(records)
            print(json.dumps({"dataset_id": manifest["dataset_id"], "counts": {k: len(v) for k,v in manifest["splits"].items()}, "rejected_count": len(manifest["rejected"])}))
        else:
            options = {'iters': args.iters, 'epochs': args.epochs, 'batch_size': args.batch_size,
                       'seq_length': args.seq_length, 'save_every': args.save_every,
                       'max_runtime_seconds': args.max_runtime_seconds,
                       'max_rss_bytes': int(args.max_rss_gib * 1024**3),
                       'max_swap_bytes': int(args.max_swap_gib * 1024**3),
                       'compile_mode': args.compile_mode, 'runtime_backend': args.runtime_backend}
            run_local(records, args.model, args.output, evaluate=args.command == "evaluate",
                      adapter=args.adapter, **options)
            if args.command == 'train':
                select_validation_checkpoint(records, args.model, args.output,
                    assignments=None, seq_length=args.seq_length, batch_size=args.batch_size,
                    max_runtime_seconds=args.max_runtime_seconds, max_rss_bytes=int(args.max_rss_gib * 1024**3),
                    max_swap_bytes=int(args.max_swap_gib * 1024**3),
                    compile_mode=args.compile_mode, runtime_backend=args.runtime_backend)


if __name__ == "__main__":
    main()
