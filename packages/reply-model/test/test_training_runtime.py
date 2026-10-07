import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import training_runtime as runtime
try:
    import mlx.core as mx
    import mlx.nn as nn
    from mlx.utils import tree_flatten
    from mlx_lm.models.gated_delta import gated_delta_ops
    from mlx_lm.tuner.trainer import default_loss, iterate_batches
    from mlx_lm.tuner.datasets import ChatDataset, CacheDataset
except ImportError:
    mx = None


class CompilePolicyTests(unittest.TestCase):
    def test_only_explicit_disabled_mode_changes_process_policy(self):
        calls = []
        fake = SimpleNamespace(disable_compile=lambda: calls.append('disabled'))
        runtime.configure_compile_mode(fake)
        self.assertEqual(calls, [])
        runtime.configure_compile_mode(fake, 'disabled')
        self.assertEqual(calls, ['disabled'])
        with self.assertRaisesRegex(ValueError, 'invalid_training_compile_mode'):
            runtime.configure_compile_mode(fake, 'automatic')
        with self.assertRaisesRegex(RuntimeError, 'training_compile_control_unavailable'):
            runtime.configure_compile_mode(SimpleNamespace(), 'disabled')


@unittest.skipIf(mx is None, 'MLX runtime unavailable')
class TrainingRuntimeTests(unittest.TestCase):
    def setUp(self):
        mx.set_default_device(mx.cpu)
        mx.random.seed(4)

    def assertClose(self, a, b, tolerance=2e-5):
        mx.eval(a, b)
        self.assertLess(float(mx.max(mx.abs(a - b)).item()), tolerance)

    def test_recurrence_values_and_all_input_gradients(self):
        shape = (1, 7, 2, 3)
        q, k = [mx.random.normal(shape) * .1 for _ in range(2)]
        v = mx.random.normal((1, 7, 4, 3)) * .1
        g = mx.ones((1, 7, 4)) * .9
        beta = mx.ones((1, 7, 4)) * .3
        state = mx.random.normal((1, 4, 3, 3)) * .1
        mask = mx.array([[True, True, False, True, True, False, True]])
        args = (q, k, v, g, beta, state)
        def objective(fn, *values):
            output, final = fn(*values, mask=mask)
            return mx.square(output).sum() + mx.square(final).sum()
        for chunk in (1, 3, 8):
            fn = lambda *a, **kw: runtime.chunked_gated_delta_ops(*a, **kw, chunk_size=chunk)
            reference = gated_delta_ops(*args, mask=mask)
            actual = fn(*args, mask=mask)
            for a, b in zip(actual, reference):
                self.assertClose(a, b)
            old = mx.grad(lambda *a: objective(gated_delta_ops, *a), argnums=tuple(range(6)))(*args)
            new = mx.grad(lambda *a: objective(fn, *a), argnums=tuple(range(6)))(*args)
            for a, b in zip(new, old):
                self.assertClose(a, b)

    def test_chat_dataset_batch_loss_counts_only_assistant_and_termination(self):
        class Tokenizer:
            def apply_chat_template(self, messages, **kwargs):
                prefix = [1] * 905
                return prefix + [2] * 15 + [3] if messages[-1]['role'] == 'assistant' else prefix
        class Tiny(nn.Module):
            def __init__(self):
                super().__init__()
                self.model_type = 'qwen3_5_text'
                self.args = SimpleNamespace(tie_word_embeddings=False)
                self.model = nn.Sequential(nn.Embedding(11, 4), lambda x: mx.cumsum(x, axis=1))
                self.lm_head = nn.Linear(4, 11, bias=False)
            def __call__(self, inputs):
                return self.lm_head(self.model(inputs))
        data = ChatDataset([{'messages': [{'role': 'user', 'content': 'synthetic prompt'},
            {'role': 'assistant', 'content': 'synthetic answer'}]}], Tokenizer(), mask_prompt=True)
        cached = CacheDataset(data)
        batch, lengths = next(iterate_batches(cached, batch_size=1, max_seq_length=1024))
        self.assertEqual(lengths.tolist(), [[905, 921]])
        self.assertGreater(batch.shape[1], 921)
        runtime.validate_target_bound(cached, 16)
        with self.assertRaisesRegex(ValueError, 'training_target_exceeds_bound'):
            runtime.validate_target_bound(cached, 15)
        model = Tiny()
        loss, tokens = runtime.checkpointed_loss(model, batch, lengths, target_token_bound=16)
        self.assertEqual(tokens.item(), 16)
        reference, upstream_tokens = default_loss(model, batch, lengths - mx.array([0, 1]))
        self.assertEqual(upstream_tokens.item(), 16)
        self.assertClose(loss, reference)
        # Independently select exactly original token positions 905..920.
        logits = model(batch[:, :-1])[:, 904:920]
        answer_and_termination = batch[:, 905:921]
        self.assertEqual(answer_and_termination.tolist(), [[2] * 15 + [3]])
        self.assertClose(loss, nn.losses.cross_entropy(logits, answer_and_termination).mean())

    def test_loss_and_trainable_gradients_match_masked_reference(self):
        class Tiny(nn.Module):
            def __init__(self):
                super().__init__()
                self.model_type = 'qwen3_5_text'
                self.args = SimpleNamespace(tie_word_embeddings=False)
                self.model = nn.Sequential(nn.Embedding(11, 4), lambda x: mx.cumsum(x, axis=1))
                self.lm_head = nn.Linear(4, 11, bias=False)
            def __call__(self, inputs):
                return self.lm_head(self.model(inputs))
        model = Tiny()
        # Match frozen production head and a trainable upstream adapter proxy.
        model.lm_head.freeze()
        batch = mx.array([[1, 2, 3, 4, 5, 6, 0], [2, 3, 1, 5, 0, 0, 0]])
        lengths = mx.array([[3, 6], [2, 4]])
        # Upstream includes a first padding target; reference corrects its inclusive bound.
        reference, reference_grad = nn.value_and_grad(model, lambda m: default_loss(m, batch, lengths - mx.array([0, 1]))[0])(model)
        for chunk in (1, 3, 8):
            actual, actual_grad = nn.value_and_grad(model, lambda m: runtime.checkpointed_loss(m, batch, lengths, chunk_size=chunk, target_token_bound=3)[0])(model)
            self.assertClose(actual, reference)
            for (key, a), (other, b) in zip(tree_flatten(actual_grad), tree_flatten(reference_grad)):
                self.assertEqual(key, other)
                self.assertClose(a, b)
        value_and_grad = nn.value_and_grad(model,
            lambda m, b, lengths: runtime.checkpointed_loss(m, b, lengths, chunk_size=3, target_token_bound=3)[0])
        compiled = mx.compile(lambda b, lengths: value_and_grad(model, b, lengths))
        value, gradients = compiled(batch, lengths)
        self.assertClose(value, reference)
        for (_, a), (_, b) in zip(tree_flatten(gradients), tree_flatten(reference_grad)):
            self.assertClose(a, b)

    def test_compile_off_preserves_loss_gradients_and_adam_updates_across_shapes(self):
        import mlx.optimizers as optim
        class Tiny(nn.Module):
            def __init__(self):
                super().__init__()
                self.model_type = 'qwen3_5_text'
                self.args = SimpleNamespace(tie_word_embeddings=False)
                self.model = nn.Sequential(nn.Embedding(11, 4), lambda x: mx.cumsum(x, axis=1))
                self.lm_head = nn.Linear(4, 11, bias=False)
                self.lm_head.freeze()
        def run(disabled):
            mx.random.seed(17)
            model, optimizer = Tiny(), optim.Adam(learning_rate=1e-5)
            state = [model.state, optimizer.state, mx.random.state]
            objective = nn.value_and_grad(model, lambda m, b, lengths:
                runtime.checkpointed_loss(m, b, lengths, chunk_size=3, target_token_bound=3)[0])
            traces, observations = [], []
            def step(batch, lengths):
                traces.append(batch.shape[1])
                value, gradients = objective(model, batch, lengths)
                optimizer.update(model, gradients)
                return value, gradients
            step = mx.compile(step, inputs=state, outputs=state)
            runtime.configure_compile_mode(mx, 'disabled' if disabled else 'default')
            for length in (7, 11, 15, 7, 11, 15):
                batch = (mx.arange(length, dtype=mx.int32) % 10)[None, :]
                value, gradients = step(batch, mx.array([[length - 3, length]]))
                mx.eval(state, value, gradients)
                observations.append((value.item(), {k: v.tolist() for k, v in tree_flatten(gradients)}))
            return observations, dict(tree_flatten(model.parameters())), len(traces)
        try:
            mx.enable_compile()
            compiled, compiled_parameters, compiled_traces = run(False)
            eager, eager_parameters, eager_calls = run(True)
            # First Adam step initializes captured optimizer state; repeating
            # the three subsequent shapes reuses their compiled traces.
            self.assertEqual(compiled_traces, 4)
            self.assertEqual(eager_calls, 6)
            for (a, gradients_a), (b, gradients_b) in zip(compiled, eager):
                self.assertAlmostEqual(a, b, places=5)
                self.assertEqual(gradients_a.keys(), gradients_b.keys())
                for key in gradients_a:
                    self.assertClose(mx.array(gradients_a[key]), mx.array(gradients_b[key]))
            for key in compiled_parameters:
                self.assertClose(compiled_parameters[key], eager_parameters[key])
        finally:
            mx.enable_compile()


if __name__ == '__main__':
    unittest.main()
