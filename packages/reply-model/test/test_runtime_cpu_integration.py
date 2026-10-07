"""CPU-only invented Qwen3.5 fixture through the real runtime train hook.

No model checkpoint, tokenizer, messenger, RPC, generation or GPU is used.
This one test supplements fake wiring: it invokes lora.train's installed
bounded_train, using a tiny observer harness as its captured original trainer.
The harness preserves installed trainer's grad_checkpoint / value_and_grad
(model, batch, lengths) / Adam sequence and inserts one bounded validation.
It does not exercise file-backed datasets, device limits or the complete CLI.

Tolerance source: independent scale-aware C16 protocol
206a45a0c716c1f2a27c19ea3d0ba80a0363a48e0d4d918f4b1c9a19f4bbf2ca.
All elementwise atol/rtol and RMS<=1 are unchanged, not bit-exact claims.
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1]
# Intended destination: packages/reply-model/test/test_runtime_cpu_integration.py.
TOLERANCES = {
    "original_loss_float32": (1e-5, 2e-4),
    "all62_parameter_gradients_float32": (2e-5, 5e-4),
    "parameters_after_Adam_float32": (2e-6, 2e-4),
    "persistent_Adam_state_float32": (2e-6, 5e-4),
}


class RuntimeCPUIntegrationTests(unittest.TestCase):
    def test_parallel16_bounded_train_matches_legacy_all62_adam_and_validation(self):
        sys.path.insert(0, str(SOURCE))
        try:
            import numpy as np
            import mlx.core as mx
            import mlx.nn as nn
            import mlx.optimizers as optim
            import mlx_lm.lora as lora
            import mlx_lm.tuner.trainer as trainer
            from mlx.utils import tree_flatten, tree_unflatten
            from mlx_lm.models import gated_delta as delta, qwen3_5
            from mlx_lm.models.qwen3_5 import TextModel, TextModelArgs, DecoderLayer
            from mlx_lm.tuner.utils import linear_to_lora_layers
        except ImportError:
            self.skipTest('NumPy/MLX/mlx-lm runtime unavailable')
        import training_runtime as runtime
        import prefix_outside

        previous_device = mx.default_device()
        mx.set_default_device(mx.cpu)
        mx.disable_compile()

        def make_model():
         mx.random.seed(73)
         args=TextModelArgs(model_type='qwen3_5_text',hidden_size=16,intermediate_size=32,num_hidden_layers=32,num_attention_heads=2,num_key_value_heads=1,vocab_size=23,linear_num_key_heads=1,linear_num_value_heads=2,linear_key_head_dim=4,linear_value_head_dim=4,full_attention_interval=4,rope_parameters={'type':'default','rope_theta':10000,'partial_rotary_factor':1.0})
         m=TextModel(args);m.freeze();linear_to_lora_layers(m,4,{'rank':2,'dropout':0.,'scale':2.})
         for key,a in tree_flatten(m.trainable_parameters()):
          if key.endswith('lora_b'):m.update(tree_unflatten([(key,mx.random.normal(a.shape)*.01)]))
         m.train();mx.eval(m.state);return m

        def snapshot(tree):
            mx.eval(tree)
            return {key: (np.array(value.astype(mx.float32), copy=True),
                          str(value.dtype), tuple(value.shape))
                    for key, value in tree_flatten(tree)}

        def compare(left, right, threshold):
            self.assertEqual(set(left), set(right))
            atol, rtol = TOLERANCES[threshold]
            for key in left:
                reference, dtype, shape = left[key]
                actual, actual_dtype, actual_shape = right[key]
                with self.subTest(threshold=threshold, tensor=key):
                    self.assertEqual(shape, actual_shape)
                    self.assertEqual(dtype, actual_dtype)
                    self.assertTrue(np.all(np.isfinite(reference)))
                    self.assertTrue(np.all(np.isfinite(actual)))
                    error = actual.astype(np.float64) - reference.astype(np.float64)
                    envelope = atol + rtol * np.abs(reference.astype(np.float64))
                    self.assertTrue(np.all(np.abs(error) <= envelope),
                                    f"elementwise tolerance: {threshold}/{key}")
                    rms = float(np.sqrt(np.mean(error * error)))
                    scale = atol + rtol * float(np.sqrt(np.mean(
                        reference.astype(np.float64) ** 2)))
                    self.assertLessEqual(rms / scale, 1.0,
                                         f"scale-aware RMS: {threshold}/{key}")

        bindings = {
            "train": lora.train, "evaluate": lora.evaluate,
            "trainer_evaluate": trainer.evaluate,
            "gradient_factory": nn.value_and_grad,
            "decoder_call": DecoderLayer.__call__,
            "delta": delta.gated_delta_ops,
            "update": qwen3_5.gated_delta_update,
        }
        original_prefix = prefix_outside.OutsideGradientPrefix
        batch = (mx.arange(70, dtype=mx.int32) % 23)[None, :]
        lengths = mx.array([[65, 68]])
        # Complete synthetic sample has three answer tokens; two pad tokens in
        # batch are excluded by lengths and the original checkpointed_loss.
        dataset = [([index % 23 for index in range(68)], 65)]

        def run(backend):
            model = make_model()
            self.assertEqual(type(model.model).__module__, "mlx_lm.models.qwen3_5")
            core_type = type(model.model)
            before_core_call = core_type.__call__
            before_factory = nn.value_and_grad
            before_decoder_call = DecoderLayer.__call__
            initial = snapshot(model.parameters())
            keys = {key for key, _ in tree_flatten(model.trainable_parameters())}
            self.assertEqual(len(keys), 62)
            self.assertFalse(tree_flatten(model.model.embed_tokens.trainable_parameters()))
            for layer in model.layers[:28]:
                self.assertFalse(tree_flatten(layer.trainable_parameters()))
            optimizer = optim.Adam(learning_rate=1e-5)
            hook_handles, observations = [], {"steps": [], "validation": []}
            owner = None

            def tracked_prefix(*args, **kwargs):
                handle = original_prefix(*args, **kwargs)
                hook_handles.append(handle)
                self.assertEqual(handle.metadata["trainable_parameter_arrays"], 62)
                self.assertEqual(handle.metadata["frozen_prefix_layers"], 28)
                self.assertEqual(handle.metadata["trainable_suffix_layers"], 4)
                return handle

            def tiny_evaluate(*, model, dataset, loss, **unused):
                self.assertIs(loss.func, runtime.checkpointed_loss)
                self.assertEqual(loss.keywords["target_token_bound"], 3)
                self.assertEqual(len(dataset), 1)
                model.eval()
                before = (owner.parallel.snapshot_stats() if owner.parallel else None)
                value, count = loss(model, batch, lengths)
                mx.eval(value, count)
                self.assertEqual(int(count.item()), 3)
                after = (owner.parallel.snapshot_stats() if owner.parallel else None)
                if after:
                    self.assertEqual(before["parallel_calls"], after["parallel_calls"])
                    self.assertGreater(after["reference_inference_calls"],
                                       before["reference_inference_calls"])
                observations["validation"].append(snapshot({"loss": value}))
                model.train()
                return value

            def tiny_train(*, model, optimizer, train_dataset, val_dataset, loss, **unused):
                # This function is only entered via installed bounded_train.
                self.assertIs(loss.func, runtime.checkpointed_loss)
                self.assertEqual(loss.keywords["target_token_bound"], 3)
                self.assertEqual(len(train_dataset), 1)
                self.assertEqual(len(val_dataset), 1)
                if backend == "parallel_chunk16":
                    self.assertIsNot(nn.value_and_grad, before_factory)
                    self.assertIsNot(core_type.__call__, before_core_call)
                    self.assertEqual(owner.parallel.snapshot_stats()["chunk_size"], 16)
                else:
                    self.assertIs(nn.value_and_grad, before_factory)
                    self.assertIs(core_type.__call__, before_core_call)
                trainer.grad_checkpoint(model.layers[0])
                gradient = nn.value_and_grad(model, loss)
                for step in range(2):
                    model.train()
                    (value, count), gradients = gradient(model, batch, lengths)
                    mx.eval(value, count, gradients)
                    self.assertEqual(int(count.item()), 3)
                    grad = snapshot(gradients)
                    self.assertEqual(set(grad), keys)
                    self.assertTrue(all(np.sum(np.abs(row[0])) > 0 for row in grad.values()))
                    optimizer.update(model, gradients)
                    mx.eval(model.state, optimizer.state)
                    parameters = snapshot(model.parameters())
                    for key in set(parameters) - keys:
                        self.assertTrue(np.array_equal(initial[key][0], parameters[key][0]),
                                        f"frozen parameter changed: {key}")
                    observations["steps"].append({
                        "loss": snapshot({"loss": value}), "gradients": grad,
                        "parameters": parameters, "optimizer": snapshot(optimizer.state),
                    })
                    if step == 0:
                        lora.evaluate(model=model, dataset=val_dataset)
                return "tiny_train_complete"

            try:
                with (patch.object(lora, "train", tiny_train),
                      patch.object(lora, "evaluate", tiny_evaluate),
                      patch.object(prefix_outside, "OutsideGradientPrefix", tracked_prefix)):
                    owner = runtime.install_runtime(3, backend=backend, compile_mode="disabled")
                    self.assertIsNot(lora.train, tiny_train)
                    try:
                        returned = lora.train(model=model, optimizer=optimizer,
                            train_dataset=dataset, val_dataset=dataset)
                        self.assertEqual(returned, "tiny_train_complete")
                        # bounded_train must restore its own prefix hook before
                        # the broader runtime owner is restored.
                        self.assertIs(nn.value_and_grad, before_factory)
                        self.assertIs(core_type.__call__, before_core_call)
                        if backend == "parallel_chunk16":
                            self.assertGreater(owner.parallel.snapshot_stats()["parallel_calls"], 0)
                            self.assertEqual(len(hook_handles), 1)
                            self.assertEqual(hook_handles[0].prefix_preparations, 2)
                            self.assertGreaterEqual(hook_handles[0].suffix_forwards, 2)
                            self.assertIsNone(hook_handles[0].active)
                        else:
                            self.assertFalse(hook_handles)
                    finally:
                        owner.restore()
                        self.assertIs(lora.train, tiny_train)
                        self.assertIs(lora.evaluate, tiny_evaluate)
                        owner.restore()  # Owner restore remains idempotent.
            finally:
                DecoderLayer.__call__ = before_decoder_call
                self.assertIs(nn.value_and_grad, before_factory)
                self.assertIs(core_type.__call__, before_core_call)
                self.assertIs(delta.gated_delta_ops, bindings["delta"])
                self.assertIs(qwen3_5.gated_delta_update, bindings["update"])
                self.assertIs(trainer.evaluate, bindings["trainer_evaluate"])
                self.assertIs(lora.train, bindings["train"])
                self.assertIs(lora.evaluate, bindings["evaluate"])
            return initial, observations

        try:
            baseline_initial, baseline = run("legacy")
            candidate_initial, candidate = run("parallel_chunk16")
            self.assertEqual(set(baseline_initial), set(candidate_initial))
            for key in baseline_initial:
                self.assertTrue(np.array_equal(baseline_initial[key][0], candidate_initial[key][0]))
            self.assertEqual(len(baseline["steps"]), 2)
            self.assertEqual(len(candidate["steps"]), 2)
            for left, right in zip(baseline["steps"], candidate["steps"]):
                compare(left["loss"], right["loss"], "original_loss_float32")
                compare(left["gradients"], right["gradients"], "all62_parameter_gradients_float32")
                compare(left["parameters"], right["parameters"], "parameters_after_Adam_float32")
                compare(left["optimizer"], right["optimizer"], "persistent_Adam_state_float32")
            self.assertEqual(len(baseline["validation"]), 1)
            self.assertEqual(len(candidate["validation"]), 1)
            compare(baseline["validation"][0], candidate["validation"][0], "original_loss_float32")
        finally:
            DecoderLayer.__call__ = bindings["decoder_call"]
            mx.set_default_device(previous_device)


if __name__ == "__main__":
    unittest.main()
