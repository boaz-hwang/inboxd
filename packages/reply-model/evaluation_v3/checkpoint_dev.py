"""CPU preparation and explicitly launched, bounded post-training Dev24 runner.

Only the frozen five-method DEVELOPMENT filename can be opened. No training
records, sealed final cases, registration, installation or activation is read.
The sole GPU owner must explicitly launch run AFTER training has completed.
"""
import argparse
import gc
import hashlib
import importlib.metadata
import json
import math
import mmap
import os
from pathlib import Path
import shutil
import struct
import sys

from independent import (read, check_seal, load_suite, digest, seal, now,
                         write_private, worker_module)
from multi_adapter import generate_multi

DEV_SUITE = 'dev-compiled-v4-checkpoint-selection-v2-frozen.json'
DEV_HASH = '24e3269850fefd229a4feafc33528ca63f80a7479e6cbc02be7a5b2b5749c355'
RULE_HASH = '25e8fc171aff971aa440bca4afcc6169468ce8b2b25145f2ef72022901e2ba93'
TRAINING_PLAN_MUST_BE_COMPLETE = True
SHARED_RUNTIME_FILES = ('expanded_training.py', 'bounded_pilot.py', 'personalization.py',
    'training_runtime.py', 'learning_split.py', 'review_sensitive.py', 'history.py',
    'kakao_local_import.py', 'expanded_training_bridge.py', 'history_snapshot.py')


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def check_producer_digest(value, key):
    """Validate personalization's explicitly spaced JSON hash protocol.

    Only producer-owned ledger/receipts/manifests use this contract. Independent
    evaluation seals continue to use their frozen compact JSON protocol.
    """
    payload = {k: v for k, v in value.items() if k != key}
    expected = hashlib.sha256(json.dumps(payload, sort_keys=True,
                                        ensure_ascii=False).encode()).hexdigest()
    if value.get(key) != expected:
        raise ValueError('producer_digest_protocol_mismatch_' + key)


def libraries():
    return {name: importlib.metadata.version(name)
            for name in ('mlx', 'mlx-lm', 'transformers')}


def dev_suite(path):
    if Path(path).name != DEV_SUITE:
        raise ValueError('development_only_filename_required_before_read')
    suite = load_suite(path)
    expected = {'production_base_v4', *[f'checkpoint_{i}_v4' for i in range(1, 5)]}
    if (suite['suite_hash'] != DEV_HASH or suite['split'] != 'development_diagnostic'
            or set(suite['compilers']) != expected):
        raise ValueError('exact_frozen_five_method_development_required')
    return suite


def helper_fingerprints():
    return {name: sha(Path(__file__).with_name(name)) for name in
            ('checkpoint_dev.py', 'independent.py', 'multi_adapter.py',
             'development_selection.py', 'development_review.py', 'selected_adapter.py')}


def shared_runtime_fingerprints():
    root = Path(__file__).resolve().parent.parent
    return {name: sha(root / name) for name in SHARED_RUNTIME_FILES}


def validate_artifact_metadata(metadata, methods):
    check_seal(metadata, 'artifacts_hash')
    if metadata.get('training_complete') is not True:
        raise ValueError('completed_training_required')
    if metadata.get('loss_measurement_kind') != 'reevaluated_saved_artifact':
        raise ValueError('saved_artifact_loss_required')
    if not metadata.get('validation_set_hash') or not metadata.get('training_plan_hash'):
        raise ValueError('validation_and_training_provenance_required')
    if set(metadata['checkpoint_methods']) != set(methods):
        raise ValueError('all_four_saved_artifacts_required')
    steps = [metadata['checkpoint_methods'][m]['step'] for m in methods]
    if any(type(s) is not int or s <= 0 for s in steps) or len(set(steps)) != len(steps):
        raise ValueError('positive_unique_saved_steps_required')
    for m in methods:
        c = metadata['checkpoint_methods'][m]
        if not c.get('adapter_artifact_hash') or not c.get('loss_evaluation_hash'):
            raise ValueError('exact_loss_receipt_required')
        if not isinstance(c.get('validation_loss'), (int, float)) or not math.isfinite(c['validation_loss']) or c['validation_loss'] < 0:
            raise ValueError('finite_saved_artifact_loss_required')


def finite_adapter(path):
    """CPU-only finite check, including BF16, without importing MLX or printing weights."""
    import numpy as np
    count = 0
    with Path(path).open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        if len(data) < 8:
            raise ValueError('invalid_adapter_container')
        header_len = struct.unpack('<Q', data[:8])[0]
        if header_len > 16 * 1024 * 1024 or 8 + header_len > len(data):
            raise ValueError('invalid_adapter_header')
        header = json.loads(data[8:8 + header_len])
        for name, spec in header.items():
            if name == '__metadata__':
                continue
            dtype = {'F16': '<f2', 'BF16': '<u2', 'F32': '<f4', 'F64': '<f8'}.get(spec['dtype'])
            if dtype is None:
                raise ValueError('unsupported_adapter_parameter_dtype')
            start, end = spec['data_offsets']
            width = np.dtype(dtype).itemsize
            expected = math.prod(spec['shape']) * width
            if start < 0 or end < start or end - start != expected or 8 + header_len + end > len(data):
                raise ValueError('invalid_adapter_tensor_span')
            for at in range(start, end, 1024 * 1024):
                chunk = data[8 + header_len + at:8 + header_len + min(end, at + 1024 * 1024)]
                values = np.frombuffer(chunk, dtype=dtype)
                finite = not np.any((values & 0x7f80) == 0x7f80) if spec['dtype'] == 'BF16' else np.all(np.isfinite(values))
                if not finite:
                    raise ValueError('nonfinite_adapter_parameters')
            count += 1
    if not count:
        raise ValueError('empty_adapter_parameters')
    return {'tensor_count': count, 'all_parameters_finite': True}


def metadata_from_ledger(ledger_path, completion_path, expected_plan_hash, model):
    """Read hashes and exact artifact loss receipts only; never training records."""
    ledger, completed = read(ledger_path), read(completion_path)
    check_producer_digest(ledger, 'ledger_hash')
    if (ledger.get('status') != 'complete' or ledger.get('final_test_records_supplied') != 0
            or completed.get('status') != 'awaiting_independent_evaluation'
            or completed.get('plan_hash') != expected_plan_hash
            or completed.get('final_test_records_supplied') != 0
            or completed.get('activation_performed') is not False):
        raise ValueError('completed_exact_plan_and_loss_ledger_required')
    completed_selection = completed.get('checkpoint_selection', {})
    if (completed_selection.get('checkpoint_validation_ledger_sha256') != sha(ledger_path)
            or Path(completed_selection.get('checkpoint_validation_ledger', '')).resolve() != Path(ledger_path).resolve()):
        raise ValueError('completion_exact_ledger_binding_required')
    receipts = sorted(ledger['evaluations'], key=lambda c: c['checkpoint_iteration'])
    if len(receipts) != 4:
        raise ValueError('exactly_four_saved_loss_receipts_required')
    model = Path(model).resolve()
    base_id = model_identity(model)
    parent = Path(ledger_path).parent.resolve()
    config = parent / 'adapter_config.json'
    checkpoints = {}
    for i, c in enumerate(receipts, 1):
        check_producer_digest(c, 'loss_evaluation_hash')
        if (c['base_model_id'] != base_id
                or c['validation_records_hash'] != ledger['validation_records_hash']
                or c['validation_assignments_hash'] != ledger['validation_assignments_hash']
                or c['final_test_records_supplied'] != 0
                or sha(c['resource_report_path']) != c['resource_report_sha256']):
            raise ValueError('loss_receipt_provenance_mismatch')
        if read(c['resource_report_path']).get('status') != 'complete':
            raise ValueError('loss_receipt_resources_incomplete')
        # The canonical alias can be overwritten by the loss winner. Require
        # the evaluated artifact SHA, falling back only to its numbered file.
        source = Path(c['artifact_path'])
        if not source.is_file() or sha(source) != c['artifact_sha256']:
            source = parent / f"{c['checkpoint_iteration']:07d}_adapters.safetensors"
        if not source.is_file() or sha(source) != c['artifact_sha256']:
            raise ValueError('immutable_saved_checkpoint_unavailable')
        checkpoints[f'checkpoint_{i}_v4'] = {'step': c['checkpoint_iteration'],
            'weights_path': str(source), 'adapter_config_path': str(config),
            'adapter_artifact_hash': c['artifact_sha256'], 'adapter_config_hash': sha(config),
            'validation_loss': c['validation_loss'], 'loss_evaluation_hash': c['loss_evaluation_hash'],
            'loss_precision': c['loss_precision'], 'resource_report_sha256': c['resource_report_sha256'],
            'validation_records_hash': c['validation_records_hash'],
            'validation_assignments_hash': c['validation_assignments_hash']}
    metadata = seal({'training_complete': True, 'loss_measurement_kind': 'reevaluated_saved_artifact',
        'validation_set_hash': digest({k: ledger[k] for k in ('validation_records_hash', 'validation_assignments_hash')}),
        'training_plan_hash': expected_plan_hash, 'model_path': str(model), 'base_model_identity': base_id,
        'checkpoint_methods': checkpoints, 'checkpoint_ledger_hash': ledger['ledger_hash'],
        'training_manifest_path': str(parent / 'manifest.json')}, 'artifacts_hash')
    validate_artifact_metadata(metadata, list(checkpoints))
    return metadata


def model_identity(path):
    path = Path(path)
    files = sorted(path.glob('*.safetensors')) + [path / 'config.json']
    if len(files) < 2:
        raise ValueError('base_weights_required')
    h = hashlib.sha256()
    for file in files:
        h.update(file.name.encode())
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
    return h.hexdigest()


def prepare(suite_path, artifact_metadata_path, output, worker_path):
    """Run after completion; verifies/copies adapter artifacts without loading weights."""
    suite = dev_suite(suite_path)
    metadata = read(artifact_metadata_path)
    methods = [f'checkpoint_{i}_v4' for i in range(1, 5)]
    validate_artifact_metadata(metadata, methods)
    worker_path = Path(worker_path).resolve()
    if sha(worker_path) != suite['compilers']['production_base_v4']['source_sha256']:
        raise ValueError('unchanged_production_worker_required')
    model = Path(metadata['model_path'])
    if not model.is_absolute() or model_identity(model) != metadata['base_model_identity']:
        raise ValueError('base_model_identity_mismatch')
    output = Path(output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    adapters, checkpoints, file_hashes = {'production_base_v4': None}, {}, {}
    for method in methods:
        c = metadata['checkpoint_methods'][method]
        source, config = Path(c['weights_path']), Path(c['adapter_config_path'])
        if (not source.is_absolute() or not config.is_absolute()
                or sha(source) != c['adapter_artifact_hash']
                or sha(config) != c['adapter_config_hash']):
            raise ValueError('saved_adapter_identity_mismatch')
        target = output / 'adapters' / method
        target.mkdir(mode=0o700, parents=True, exist_ok=False)
        for original, name in ((source, 'adapters.safetensors'), (config, 'adapter_config.json')):
            dest = target / name
            shutil.copyfile(original, dest)
            dest.chmod(0o600)
            file_hashes[str(dest)] = sha(dest)
        if file_hashes[str(target / 'adapters.safetensors')] != c['adapter_artifact_hash']:
            raise ValueError('staged_adapter_changed')
        finite_result = finite_adapter(target / 'adapters.safetensors')
        if metadata.get('training_manifest_path'):
            manifest = read(metadata['training_manifest_path'])
            manifest.update(saved_checkpoint_step=c['step'],
                selection={'criterion': 'evaluation_only_saved_checkpoint', 'checkpoint_iteration': c['step'],
                           'artifact_sha256': c['adapter_artifact_hash']}, selection_required=True)
            write_private(target / 'manifest.json', manifest)
            file_hashes[str(target / 'manifest.json')] = sha(target / 'manifest.json')
        adapters[method] = str(target)
        checkpoints[method] = {**c, 'adapter_path': str(target), 'finite_parameter_check': finite_result}
    tokenizer_names = ('tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json',
                       'chat_template.jinja', 'vocab.json', 'merges.txt', 'added_tokens.json')
    tokenizer_files = {str(model / n): sha(model / n) for n in tokenizer_names if (model / n).is_file()}
    binding = seal({'schema': 'frozen-development-adapter-bindings-v1', 'frozen_at_utc': now(),
        'suite_hash': suite['suite_hash'], 'selection_rule_hash': RULE_HASH,
        'generator_sha256': sha(Path(__file__).with_name('multi_adapter.py')),
        'generation_policy': suite['generation_policy'], 'method_adapters': adapters,
        'artifacts': {'metadata_hash': metadata['artifacts_hash'],
            'training_plan_hash': metadata['training_plan_hash'], 'model_path': str(model),
            'base_model_identity': metadata['base_model_identity'], 'worker_path': str(worker_path),
            'worker_sha256': sha(worker_path), 'adapter_file_hashes': file_hashes,
            'tokenizer_file_hashes': tokenizer_files, 'library_versions': libraries(),
            'helper_fingerprints': helper_fingerprints(),
            'shared_runtime_fingerprints': shared_runtime_fingerprints(),
            'checkpoint_receipts': checkpoints},
        'generation_order': 'method_major_all24_then_clear_models_gc_and_mlx_cache',
        'blind_labels': 'case_specific_random_labels_after_generation',
        'resource_budget': {'seconds': 900, 'rss_bytes': 12 * 1024**3,
                            'swap_growth_bytes': 1024**3}}, 'binding_hash')
    write_private(output / 'bindings.json', binding)
    selection_metadata = seal({'development_case_count': 24,
        'loss_measurement_kind': metadata['loss_measurement_kind'],
        'validation_set_hash': metadata['validation_set_hash'], 'checkpoints': checkpoints,
        'binding_hash': binding['binding_hash']}, 'checkpoint_metadata_hash')
    write_private(output / 'checkpoint-selection-metadata.json', selection_metadata)
    return {'binding_hash': binding['binding_hash'], 'method_count': 5, 'case_count': 24}


def verify_binding(binding):
    check_seal(binding, 'binding_hash')
    a = binding['artifacts']
    if a['library_versions'] != libraries() or a['helper_fingerprints'] != helper_fingerprints():
        raise ValueError('frozen_libraries_or_helpers_changed')
    if a['shared_runtime_fingerprints'] != shared_runtime_fingerprints():
        raise ValueError('frozen_shared_runtime_changed')
    if sha(a['worker_path']) != a['worker_sha256']:
        raise ValueError('frozen_worker_changed')
    for group in ('adapter_file_hashes', 'tokenizer_file_hashes'):
        if any(sha(path) != expected for path, expected in a[group].items()):
            raise ValueError('frozen_artifact_changed')
    if model_identity(a['model_path']) != a['base_model_identity']:
        raise ValueError('frozen_base_weights_changed')


def verify_suite_binding(suite, binding):
    if (binding['suite_hash'] != suite['suite_hash']
            or binding['generation_policy'] != suite['generation_policy']
            or binding['generator_sha256'] != sha(Path(__file__).with_name('multi_adapter.py'))
            or set(binding['method_adapters']) != set(suite['compilers'])
            or binding['method_adapters']['production_base_v4'] is not None):
        raise ValueError('frozen_method_or_policy_binding_mismatch')
    for method, receipt in binding['artifacts']['checkpoint_receipts'].items():
        path = binding['method_adapters'][method]
        if path != receipt['adapter_path'] or not Path(path).is_absolute():
            raise ValueError('exact_checkpoint_path_binding_required')
        if sha(Path(path) / 'adapters.safetensors') != receipt['adapter_artifact_hash']:
            raise ValueError('exact_checkpoint_weight_binding_required')


class FrozenOutputCache:
    """No inference here: publish exactly the method-major verified generation."""
    def __init__(self, outputs):
        self.outputs, self.used = outputs, set()

    def generate_text(self, messages, *, adapter_path, max_tokens, temperature):
        key = (digest(messages), adapter_path)
        if key in self.used or key not in self.outputs or max_tokens != 192 or temperature != 0:
            raise ValueError('cache_boundary_or_duplicate_call')
        self.used.add(key)
        return self.outputs[key]


def generate_method_major(engine, tokenizer, suite, method_adapters, clear_cache):
    for case in suite['cases']:
        for messages in case['inputs'].values():
            tokens = tokenizer.apply_chat_template(messages, add_generation_prompt=True,
                enable_thinking=False, return_dict=False)
            if len(tokens) > suite['generation_policy']['max_input_tokens']:
                raise ValueError('complete_suite_input_budget_exceeded')
    outputs = {}
    for method, adapter in method_adapters.items():
        engine.models.clear()
        gc.collect()
        clear_cache()
        for case in suite['cases']:
            messages = case['inputs'][method]
            key = (digest(messages), adapter)
            if key in outputs:
                raise ValueError('duplicate_generation_input_adapter_pair')
            text = engine.generate_text(messages, adapter_path=adapter,
                max_tokens=suite['generation_policy']['max_tokens'], temperature=0.0).strip()
            if not text:
                raise ValueError('empty_development_generation')
            outputs[key] = text
    engine.models.clear()
    gc.collect()
    clear_cache()
    return outputs


def preflight_report(report, bindings_path):
    report = Path(report).resolve()
    if report.parent != Path(bindings_path).resolve().parent:
        raise ValueError('report_inside_private_binding_directory_required')
    if report.exists() or report.with_name(report.stem + '-unblind.json').exists():
        raise ValueError('generation_report_exists_no_overwrite')


def child(suite_path, bindings_path, report, expected_binding_hash):
    suite, binding = dev_suite(suite_path), read(bindings_path)
    if binding['binding_hash'] != expected_binding_hash:
        raise ValueError('explicit_expected_binding_hash_required')
    verify_binding(binding)
    verify_suite_binding(suite, binding)
    preflight_report(report, bindings_path)
    from mlx_lm.utils import load_tokenizer
    import mlx.core as mx
    engine = worker_module(binding['artifacts']['worker_path']).ReplyWorker()
    engine.path = Path(binding['artifacts']['model_path'])
    tokenizer = load_tokenizer(str(engine.path))
    outputs = generate_method_major(engine, tokenizer, suite, binding['method_adapters'], mx.clear_cache)
    cache = FrozenOutputCache(outputs)
    result = generate_multi(cache, tokenizer, bindings_path, report, suite_path=suite_path,
                            artifacts={'method_major_clean_reset': True})
    if len(cache.used) != len(outputs):
        raise ValueError('unpublished_generated_output')
    return result


def run(args):
    suite = dev_suite(args.suite)
    binding = read(args.bindings)
    if binding['binding_hash'] != args.expected_binding_hash:
        raise ValueError('explicit_expected_binding_hash_required')
    verify_binding(binding)
    verify_suite_binding(suite, binding)
    preflight_report(args.report, args.bindings)
    if not args.pause_daemon:
        raise ValueError('verified_daemon_pause_required')
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import bounded_pilot as lifecycle
    import personalization as p
    args.output = Path(args.bindings).parent
    budget = binding['resource_budget']
    with lifecycle.daemon_pause(args):
        with (args.output / 'generation-runtime.log').open('x') as log:
            os.chmod(log.name, 0o600)
            p.guarded_training_run([sys.executable, str(Path(__file__).resolve()), '_child',
                '--suite', str(args.suite), '--bindings', str(args.bindings), '--report', str(args.report),
                '--expected-binding-hash', args.expected_binding_hash],
                env=os.environ, stdout=log, pass_fds=(),
                max_runtime_seconds=budget['seconds'], max_rss_bytes=budget['rss_bytes'],
                max_swap_bytes=budget['swap_growth_bytes'],
                resource_report_path=args.output / 'generation-resources.json')
    return {'status': 'dev_complete_daemon_restored', 'binding_hash': binding['binding_hash']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'prepare-ledger', 'run', '_child'])
    for name in ('suite', 'bindings', 'report', 'artifact-metadata', 'output', 'worker',
                 'inboxd', 'daemon-lock', 'daemon-binary'):
        parser.add_argument('--' + name, type=Path)
    parser.add_argument('--checkpoint-ledger', type=Path)
    parser.add_argument('--training-completion', type=Path)
    parser.add_argument('--model', type=Path)
    parser.add_argument('--expected-training-plan-hash')
    parser.add_argument('--expected-binding-hash')
    parser.add_argument('--pause-daemon', action='store_true')
    args = parser.parse_args()
    if args.command == 'prepare':
        result = prepare(args.suite, args.artifact_metadata, args.output, args.worker)
    elif args.command == 'prepare-ledger':
        dev_suite(args.suite)
        metadata = metadata_from_ledger(args.checkpoint_ledger, args.training_completion,
                                        args.expected_training_plan_hash, args.model)
        artifact_path = args.output.with_name(args.output.name + '-artifact-metadata.json')
        write_private(artifact_path, metadata)
        result = prepare(args.suite, artifact_path, args.output, args.worker)
    elif args.command == '_child':
        result = child(args.suite, args.bindings, args.report, args.expected_binding_hash)
    else:
        result = run(args)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
