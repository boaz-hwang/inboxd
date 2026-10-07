"""Frozen, owner-local training API. Final-test bodies never enter this module.

The coordinator passes approved train/validation records in memory. Plans and
completion reports contain hashes/counts only; training uses private temporary
staging. This module does not collect, review, evaluate final tests or activate.
"""
import copy
import contextlib
import hashlib
import importlib.metadata
import math
import os
import signal
from dataclasses import dataclass, field
from pathlib import Path

import bounded_pilot as lifecycle
import personalization as p
import review_sensitive


RUNTIME_FILES = ('expanded_training.py', 'bounded_pilot.py', 'personalization.py',
                 'training_runtime.py', 'learning_split.py', 'review_sensitive.py', 'history.py',
                 'kakao_local_import.py', 'expanded_training_bridge.py', 'history_snapshot.py')


def runtime_fingerprint():
    return {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in RUNTIME_FILES}


def tokenizer_fingerprint(model):
    names = ('tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
             'chat_template.jinja', 'vocab.json', 'merges.txt', 'added_tokens.json')
    return {name: hashlib.sha256((model / name).read_bytes()).hexdigest()
            for name in names if (model / name).is_file()}


def library_fingerprint():
    versions = {}
    for name in ('mlx', 'mlx-lm', 'transformers'):
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return versions


def owner_path(path, *, exists=False):
    path = Path(path)
    if not path.is_absolute() or any(parent.is_symlink() for parent in (path, *path.parents)):
        raise ValueError('absolute_owner_path_required')
    current = path
    while not current.exists():
        current = current.parent
    if current.stat().st_uid != os.getuid() or (exists and not path.exists()):
        raise ValueError('owner_path_unavailable')
    return path


@contextlib.contextmanager
def total_runtime_guard(seconds):
    """One deadline across staging/children, disarmed before daemon cleanup."""
    p._validate_resource_budget(seconds, 28 * 1024**3)
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise ValueError('existing_process_deadline')
    def timed_out(_number, _frame):
        raise p.TrainingRuntimeError('training_total_timeout')
    previous = signal.signal(signal.SIGALRM, timed_out)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


@dataclass
class PreparedRun:
    # Bodies are retained in process memory only. Never serialize this object.
    records: list = field(repr=False)
    assignments: dict
    plan: dict


def prepare(records, manifest, tokenizer, *, model, output, epochs,
            max_runtime_seconds, train_max_tokens=2048, evaluation_max_tokens=4096,
            batch_size=1, save_every=None, selection_max_runtime_seconds=None,
            max_total_runtime_seconds=None, compile_mode='default'):
    """CPU-only, exact-manifest admission and frozen source-boundary validation.

    Manifest fields: version=1, records [{id, example_hash, review_hash, split}],
    assignments, reservations, source (snapshot/policy metadata), manifest_id.
    Its digest covers every field except manifest_id. Test entries are metadata
    only; callers must provide exactly the train/valid entries as record objects.
    """
    if compile_mode not in ('default', 'disabled'):
        raise ValueError('invalid_training_compile_mode')
    if manifest.get('version') != 1 or manifest.get('manifest_id') != p.digest(
            {k: v for k, v in manifest.items() if k != 'manifest_id'}):
        raise ValueError('frozen_manifest_changed')
    if not isinstance(manifest.get('reservations'), dict) or not manifest.get('source'):
        raise ValueError('frozen_source_reservations_required')
    quarantine = manifest['source'].get('sensitive_source_quarantine')
    if not isinstance(quarantine, dict):
        raise ValueError('sensitive_source_quarantine_required')
    review_sensitive.assert_no_sensitive_sources(records, quarantine)
    # Authored supervision stores its exact target in messages rather than the
    # archive's targets array. Screen every supplied generation message too.
    if any(review_sensitive.credential_rules(message.get('content'))
           for record in records for message in record.get('messages', [])):
        raise ValueError('sensitive_source_in_admitted_record')
    entries = manifest.get('records', [])
    if any(e.get('split') not in ('train', 'valid', 'test') for e in entries):
        raise ValueError('invalid_manifest_split')
    if len({e['id'] for e in entries}) != len(entries):
        raise ValueError('duplicate_manifest_identity')
    admitted = {e['id']: e for e in entries if e['split'] != 'test'}
    if len({r['id'] for r in records}) != len(records) or set(admitted) != {r['id'] for r in records}:
        raise ValueError('training_records_differ_from_frozen_manifest')
    for r in records:
        e = admitted[r['id']]
        if (not r.get('review_hash') or r['review_hash'] != e.get('review_hash')
                or p.digest(r) != e.get('example_hash')
                or manifest['assignments'].get(r['id']) != e['split']):
            raise ValueError('reviewed_example_changed')
    splits, dataset = p.prepare_examples(records, assignments=manifest['assignments'],
                                          frozen=manifest['reservations'])
    if dataset['rejected'] or splits['test']:
        raise ValueError('frozen_boundary_or_eligibility_rejected')
    if not (64 <= train_max_tokens <= evaluation_max_tokens <= 32768):
        raise ValueError('invalid_sequence_policy')
    p._validate_resource_budget(max_runtime_seconds, 28 * 1024**3)
    lengths, exclusions = {}, []
    for name in ('train', 'valid'):
        limit = train_max_tokens if name == 'train' else evaluation_max_tokens
        kept, rejected = p.prefilter_length(splits[name], tokenizer, limit)
        if name == 'valid' and rejected:
            raise ValueError('frozen_validation_over_token_budget')
        exclusions.extend({**r, 'split': name} for r in rejected)
        splits[name] = kept
        if not kept or len(kept) < batch_size:
            raise ValueError('insufficient_disjoint_data')
        sizes = [len(tokenizer.apply_chat_template(r['messages'], return_dict=False,
                                                   enable_thinking=False)) for r in kept]
        lengths[name] = {'count': len(kept), 'max_total_tokens': max(sizes)}
    used = splits['train'] + splits['valid']
    assignments = {r['id']: admitted[r['id']]['split'] for r in used}
    model, output = owner_path(model, exists=True), owner_path(output)
    iters = p.iterations_for(len(splits['train']), batch_size, epochs)
    save_every = save_every or math.ceil(len(splits['train']) / batch_size)
    if type(save_every) is not int or not 1 <= save_every <= iters:
        raise ValueError('invalid_checkpoint_interval')
    selection_max_runtime_seconds = (max_runtime_seconds if selection_max_runtime_seconds is None
                                     else selection_max_runtime_seconds)
    max_total_runtime_seconds = (max_runtime_seconds + math.ceil(iters / save_every) * selection_max_runtime_seconds
                                if max_total_runtime_seconds is None else max_total_runtime_seconds)
    for budget in (selection_max_runtime_seconds, max_total_runtime_seconds):
        p._validate_resource_budget(budget, 28 * 1024**3)
    plan = {'version': 1, 'manifest_id': manifest['manifest_id'],
            'source_hash': p.digest(manifest['source']),
            'sensitive_source_quarantine_hash': quarantine['quarantine_hash'],
            'reservations_hash': p.digest(manifest['reservations']),
            'model': str(model), 'output': str(output), 'base_model_id': p.model_identity(model),
            'tokenizer_fingerprint': tokenizer_fingerprint(model),
            'libraries': library_fingerprint(), 'admitted_dataset_id': dataset['dataset_id'],
            'training_dataset_id': p.prepare_examples(used, assignments=assignments)[1]['dataset_id'],
            'runtime_fingerprint': runtime_fingerprint(), 'lengths': lengths,
            'exclusions': exclusions, 'epochs': epochs, 'iters': iters,
            'save_every': save_every, 'batch_size': batch_size,
            'train_max_tokens': train_max_tokens, 'seq_length': evaluation_max_tokens,
            'records_hash': p.digest(used), 'assignments_hash': p.digest(assignments),
            'final_test_records_supplied': 0,
            'max_runtime_seconds': max_runtime_seconds,
            'selection_max_runtime_seconds': selection_max_runtime_seconds,
            'max_total_runtime_seconds': max_total_runtime_seconds,
            'max_rss_bytes': 28 * 1024**3, 'max_swap_bytes': 4 * 1024**3,
            'compile_mode': compile_mode}
    plan['plan_hash'] = p.digest(plan)
    return PreparedRun(copy.deepcopy(used), assignments, plan)


def execute(prepared, *, expected_plan_hash, daemon_args):
    """Train and select on validation only, with guaranteed daemon restoration.

    daemon_args uses the existing verified owner lifecycle helper. It must enable
    pause_daemon, identify the planned model/output, and name the exact installed
    daemon binary/lock. No installation or adapter activation occurs here.
    """
    plan = prepared.plan
    if (expected_plan_hash != plan.get('plan_hash') or plan['plan_hash'] != p.digest(
            {k: v for k, v in plan.items() if k != 'plan_hash'})
            or p.digest(prepared.records) != plan['records_hash']
            or p.digest(prepared.assignments) != plan['assignments_hash']
            or runtime_fingerprint() != plan['runtime_fingerprint']):
        raise ValueError('training_plan_changed')
    model = owner_path(plan['model'], exists=True)
    output = owner_path(plan['output'])
    if (p.model_identity(model) != plan['base_model_id']
            or tokenizer_fingerprint(model) != plan['tokenizer_fingerprint']
            or library_fingerprint() != plan['libraries']):
        raise ValueError('training_model_changed')
    if (not daemon_args.pause_daemon or Path(daemon_args.model) != model
            or Path(daemon_args.output) != output):
        raise ValueError('verified_daemon_pause_required')
    for path in (daemon_args.daemon_binary, daemon_args.daemon_lock, daemon_args.inboxd):
        owner_path(path, exists=True)
    if output.exists():
        raise ValueError('training_output_exists')
    output.mkdir(mode=0o700, parents=True)
    p.private_json(output / 'plan.json', plan)
    settings = {k: plan[k] for k in ('seq_length', 'batch_size', 'max_runtime_seconds',
                                     'max_rss_bytes', 'max_swap_bytes', 'compile_mode')}
    try:
        with lifecycle.daemon_pause(daemon_args):
            with total_runtime_guard(plan['max_total_runtime_seconds']):
                adapter = output / 'adapter'
                p.run_local(prepared.records, model, adapter, assignments=prepared.assignments,
                            epochs=plan['epochs'], iters=plan['iters'], save_every=plan['save_every'],
                            require_test_split=False, **settings)
                validation = [r for r in prepared.records if prepared.assignments[r['id']] == 'valid']
                selection_settings = {**settings, 'max_runtime_seconds': plan['selection_max_runtime_seconds']}
                selection = p.select_validation_checkpoint(validation, model, adapter,
                    assignments={r['id']: 'valid' for r in validation}, deduplicate=True, **selection_settings)
        report = {'status': 'awaiting_independent_evaluation', 'plan_hash': plan['plan_hash'],
                  'checkpoint_selection': selection, 'final_test_records_supplied': 0,
                  'activation_performed': False}
        p.private_json(output / 'completion.json', report)
        return report
    except BaseException:
        p.private_json(output / 'completion.json', {'status': 'failed',
                       'plan_hash': plan['plan_hash'], 'activation_performed': False})
        raise
