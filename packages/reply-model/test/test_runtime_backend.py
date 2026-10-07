"""Opt-in wiring and rollback; fake modules only, no MLX device/model execution.

The numerical C16/all62-gradient/Adam evidence is reused separately; these tests
exercise integration ownership, original inference dispatch and provenance.
"""
import contextlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
import training_runtime as runtime
import personalization


def source_module(name):
    spec = importlib.util.spec_from_file_location(name, SOURCE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@contextlib.contextmanager
def fake_dependencies():
    """Use real patch/helper code against structural placeholders, no arrays."""
    names = ('mlx', 'mlx.core', 'mlx.nn', 'mlx.utils', 'mlx_lm', 'mlx_lm.lora',
             'mlx_lm.models', 'mlx_lm.models.base', 'mlx_lm.models.gated_delta',
             'mlx_lm.models.qwen3_5', 'mlx_lm.tuner', 'mlx_lm.tuner.trainer',
             'mlx_lm.utils')
    modules = {name: ModuleType(name) for name in names}
    for name, module in modules.items():
        module.__path__ = []
        if '.' in name:
            parent, attribute = name.rsplit('.', 1)
            setattr(modules[parent], attribute, module)
    mx, nn = modules['mlx.core'], modules['mlx.nn']
    mx.disable_compile = Mock()
    mx.checkpoint = Mock()
    nn.value_and_grad = Mock(name='original_gradient_factory')
    modules['mlx.utils'].tree_flatten = lambda tree: list(tree.items())
    base = modules['mlx_lm.models.base']
    base.create_attention_mask = Mock()
    base.create_ssm_mask = Mock()
    lora, trainer = modules['mlx_lm.lora'], modules['mlx_lm.tuner.trainer']
    lora.train = Mock(return_value='trained')
    lora.evaluate = Mock(return_value='evaluated')
    lora.main = Mock()
    trainer.evaluate = Mock(return_value='trainer_evaluated')
    delta, qwen = modules['mlx_lm.models.gated_delta'], modules['mlx_lm.models.qwen3_5']
    delta._gated_delta_step_ops = Mock()
    delta.gated_delta_ops = Mock(name='original_delta_ops')
    qwen.gated_delta_update = Mock(return_value=('original_output', 'original_state'))

    class Layer:
        def __init__(self, parameters):
            self.parameters, self.training = parameters, True
        def trainable_parameters(self):
            return self.parameters
    layers = [Layer({}) for _ in range(28)] + [Layer({'parameter': object()}) for _ in range(4)]
    embedding = SimpleNamespace(parameters={})
    embedding.trainable_parameters = lambda: embedding.parameters
    class Core:
        __module__ = 'mlx_lm.models.qwen3_5'
        embed_tokens = embedding
        def __call__(self, *args, **kwargs):
            return 'original_core'
    parameters = {str(i): layer.parameters['parameter'] for i, layer in enumerate(layers[28:])}
    model = SimpleNamespace(model_type='qwen3_5', model=Core(), layers=layers,
                            trainable_parameters=lambda: parameters)
    originals = dict(train=lora.train, evaluate=lora.evaluate, trainer_evaluate=trainer.evaluate,
                     delta=delta.gated_delta_ops, inference=qwen.gated_delta_update,
                     factory=nn.value_and_grad, core=Core.__call__)
    with patch.dict(sys.modules, modules):
        parallel = source_module('parallel_chunk')
        prefix = source_module('prefix_outside')
        sys.modules['parallel_chunk'], sys.modules['prefix_outside'] = parallel, prefix
        yield SimpleNamespace(mx=mx, nn=nn, lora=lora, trainer=trainer, delta=delta,
            qwen=qwen, model=model, embedding=embedding, parameters=parameters,
            originals=originals, parallel=parallel, modules=modules)


class BackendWiringTests(unittest.TestCase):
    def assert_restored(self, fake):
        for actual, name in ((fake.lora.train, 'train'), (fake.lora.evaluate, 'evaluate'),
                            (fake.trainer.evaluate, 'trainer_evaluate'),
                            (fake.delta.gated_delta_ops, 'delta'),
                            (fake.qwen.gated_delta_update, 'inference'),
                            (fake.nn.value_and_grad, 'factory'),
                            (type(fake.model.model).__call__, 'core')):
            self.assertIs(actual, fake.originals[name])

    def test_default_backend_preserved_and_invalid_profile_rejected_before_mutation(self):
        self.assertEqual(runtime.runtime_configuration()['backend'], 'legacy')
        self.assertEqual(runtime.runtime_configuration()['recurrence_chunk_size'], 32)
        with fake_dependencies() as fake:
            for backend, compile_mode, reason in (
                ('unknown', 'disabled', 'invalid_training_runtime_backend'),
                ('parallel_chunk16', 'default', 'parallel_chunk16_requires_compile_disabled'),
                ('legacy', 'unknown', 'invalid_training_compile_mode'),
            ):
                with self.assertRaisesRegex(ValueError, reason):
                    runtime.install_runtime(2, backend=backend, compile_mode=compile_mode)
                self.assert_restored(fake)
            fake.mx.disable_compile.assert_not_called()
            owner = runtime.install_runtime(2)
            try:
                fake.lora.train(train_dataset=[([1, 2, 3], 2)])
                self.assertIs(fake.qwen.gated_delta_update, fake.originals['inference'])
            finally:
                owner.restore()
            self.assert_restored(fake)

    def test_parallel_uses_c16_original_inference_and_restores_real_hooks_success_exception(self):
        for failure in (None, RuntimeError('synthetic_train_failure'), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__), fake_dependencies() as fake:
                def train(**kwargs):
                    self.assertIsNot(fake.nn.value_and_grad, fake.originals['factory'])
                    self.assertIsNot(type(fake.model.model).__call__, fake.originals['core'])
                    self.assertIs(kwargs['loss'].func, runtime.checkpointed_loss)
                    if failure is not None:
                        raise failure
                    return 'trained'
                fake.originals['train'].side_effect = train
                owner = runtime.install_runtime(2, backend='parallel_chunk16', compile_mode='disabled')
                try:
                    self.assertEqual(owner.parallel.snapshot_stats()['chunk_size'], 16)
                    values = [object() for _ in range(7)]
                    self.assertEqual(fake.qwen.gated_delta_update(*values, use_kernel=True),
                                     ('original_output', 'original_state'))
                    fake.originals['inference'].assert_called_once_with(*values, None, None, use_kernel=True)
                    if failure is None:
                        self.assertEqual(fake.lora.train(model=fake.model, train_dataset=[([1, 2, 3], 2)]), 'trained')
                    else:
                        with self.assertRaises(type(failure)):
                            fake.lora.train(model=fake.model, train_dataset=[([1, 2, 3], 2)])
                    self.assertIs(fake.nn.value_and_grad, fake.originals['factory'])
                    self.assertIs(type(fake.model.model).__call__, fake.originals['core'])
                    self.assertEqual(fake.lora.evaluate(dataset=[([1, 2, 3], 2)]), 'evaluated')
                    self.assertIs(fake.nn.value_and_grad, fake.originals['factory'])
                finally:
                    owner.restore()
                self.assert_restored(fake)
                owner.restore()  # Idempotent, no second mutation.

    def test_invalid_model_layout_and_trainable_scope_fail_before_gradient_hook(self):
        mutations = (
            ('model_type', lambda f: setattr(f.model, 'model_type', 'other')),
            ('foreign_core', lambda f: setattr(type(f.model.model), '__module__', 'unsupported_core')),
            ('layout', lambda f: f.model.layers.pop()),
            ('prefix_trainable', lambda f: f.model.layers[0].parameters.update(bad=object())),
            ('embedding_trainable', lambda f: f.embedding.parameters.update(bad=object())),
            ('outside_suffix', lambda f: f.parameters.update(bad=object())),
        )
        for name, mutate in mutations:
            with self.subTest(scope=name), fake_dependencies() as fake:
                owner = runtime.install_runtime(2, backend='parallel_chunk16', compile_mode='disabled')
                try:
                    mutate(fake)
                    with self.assertRaises(ValueError):
                        fake.lora.train(model=fake.model, train_dataset=[([1, 2, 3], 2)])
                    fake.originals['train'].assert_not_called()
                    self.assertIs(fake.nn.value_and_grad, fake.originals['factory'])
                    self.assertIs(type(fake.model.model).__call__, fake.originals['core'])
                finally:
                    owner.restore()
                self.assert_restored(fake)

    def test_failed_recurrence_install_rolls_back_earlier_runtime_bindings(self):
        with fake_dependencies() as fake:
            with patch.object(fake.parallel, 'install_parallel_chunk', side_effect=RuntimeError('synthetic_install_failure')):
                with self.assertRaisesRegex(RuntimeError, 'synthetic_install_failure'):
                    runtime.install_runtime(2, backend='parallel_chunk16', compile_mode='disabled')
            self.assert_restored(fake)

    def test_main_restores_after_success_and_lora_main_exception(self):
        for failure in (None, RuntimeError('synthetic_main_failure')):
            with self.subTest(failure=failure), fake_dependencies() as fake, tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / 'config.json'
                config.write_text(json.dumps(dict(inboxd_target_token_bound=2,
                    inboxd_compile_mode='disabled', inboxd_runtime_backend='parallel_chunk16')))
                fake.lora.main.side_effect = failure
                with patch.object(sys, 'argv', ['training_runtime.py', '--config', str(config)]):
                    if failure is None:
                        runtime.main()
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'synthetic_main_failure'):
                            runtime.main()
                self.assert_restored(fake)


class ProvenanceWiringTests(unittest.TestCase):
    def test_run_local_passes_backend_config_and_records_exact_sources_dependency_fingerprint(self):
        with fake_dependencies() as fake, tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            directory = Path(directory)
            tokenizer = SimpleNamespace(apply_chat_template=lambda messages, **kwargs: [1, 2, 3] if len(messages) == 2 else [1, 2])
            fake.modules['mlx_lm.utils'].load_tokenizer = Mock(return_value=tokenizer)
            records = [{'id': 'train', 'messages': [{'role': 'user', 'content': 'synthetic'}, {'role': 'assistant', 'content': 'synthetic'}]},
                       {'id': 'valid', 'messages': [{'role': 'user', 'content': 'synthetic'}, {'role': 'assistant', 'content': 'synthetic'}]}]
            splits = {'train': records[:1], 'valid': records[1:], 'test': []}
            prepared = {'rejected': [], 'splits': {k: [{'id': r['id']} for r in v] for k, v in splits.items()}}
            captured = []
            @contextlib.contextmanager
            def staging(prefix):
                with tempfile.TemporaryDirectory(dir=directory) as location:
                    yield Path(location), None
            def fake_run(command, **kwargs):
                captured.append(json.loads(Path(command[-1]).read_text()))
                return SimpleNamespace(returncode=0)
            replacements = dict(cleanup_stale_training_dirs=Mock(), local_model=lambda model: directory / 'unloaded_model',
                prepare_examples=lambda *a, **k: (splits, json.loads(json.dumps(prepared))),
                prefilter_length=lambda records, *a: (records, []), model_identity=lambda *a: 'synthetic_identity',
                stage_training_model=lambda model, *a: model, private_staging=staging, guarded_training_run=fake_run)
            for key, value in replacements.items():
                stack.enter_context(patch.object(personalization, key, value))
            stack.enter_context(patch('importlib.metadata.version', side_effect=lambda name: 'synthetic-' + name))
            manifests = []
            for backend, compile_mode in (('legacy', 'default'), ('parallel_chunk16', 'disabled')):
                manifests.append(personalization.run_local(records, 'unloaded', directory / backend,
                    iters=1, require_test_split=False, runtime_backend=backend, compile_mode=compile_mode))
                self.assertEqual(captured[-1]['inboxd_runtime_backend'], backend)
                self.assertEqual(captured[-1]['inboxd_compile_mode'], compile_mode)
                metadata = manifests[-1]
                expected = dict(configuration=metadata['runtime_configuration'],
                    source_sha256=metadata['runtime_source_sha256'], dependency_versions=metadata['runtime_dependency_versions'])
                self.assertEqual(metadata['runtime_fingerprint'], personalization.digest(expected))
                self.assertEqual(metadata['runtime_configuration']['backend'], backend)
            self.assertNotEqual(manifests[0]['runtime_fingerprint'], manifests[1]['runtime_fingerprint'])
            self.assertEqual(set(manifests[1]['runtime_source_sha256']),
                {'personalization.py', 'training_runtime.py', 'parallel_chunk.py', 'prefix_outside.py'})
            self.assertNotIn('parallel_chunk.py', manifests[0]['runtime_source_sha256'])

    def test_cli_propagates_profile_to_training_and_saved_checkpoint_reevaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            records = Path(directory) / 'synthetic.jsonl'
            records.write_text('{}\n')
            argv = ['personalization.py', 'train', '--examples', str(records), '--model', 'unloaded',
                    '--output', str(Path(directory) / 'output'), '--runtime-backend', 'parallel_chunk16', '--compile-mode', 'disabled']
            with (patch.object(sys, 'argv', argv), patch.object(personalization, 'run_local') as train,
                  patch.object(personalization, 'select_validation_checkpoint') as reevaluate):
                personalization.main()
                for called in (train, reevaluate):
                    self.assertEqual(called.call_args.kwargs['runtime_backend'], 'parallel_chunk16')
                    self.assertEqual(called.call_args.kwargs['compile_mode'], 'disabled')

    def test_build_packages_both_runtime_helpers(self):
        product = Path(__file__).resolve().parents[3] / 'scripts' / 'build-product.ts'
        source = product.read_text()
        runtime_section = source[source.index('const replyRuntimeFiles'):source.index('interface ManifestFile')]
        for module in ('parallel_chunk.py', 'prefix_outside.py'):
            self.assertIn('"' + module + '"', runtime_section)


if __name__ == '__main__':
    unittest.main()
