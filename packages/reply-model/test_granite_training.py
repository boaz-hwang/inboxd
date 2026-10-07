"""Meaningful tiny CPU checks: causal masking, Granite scaling and gradients."""
import copy
import unittest

import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_flatten
from mlx_lm.models.granite import Model, ModelArgs
from mlx_lm.tuner.utils import linear_to_lora_layers
from granite_training import answer_loss, digest, validate_data, final_candidate

mx.set_default_device(mx.cpu)


def tiny_model():
    mx.random.seed(19)
    model = Model(ModelArgs(model_type="granite", hidden_size=32, num_hidden_layers=2,
        intermediate_size=48, num_attention_heads=2, rms_norm_eps=1e-5,
        vocab_size=64, logits_scaling=2.5, attention_multiplier=0.25,
        embedding_multiplier=1.0, residual_multiplier=1.0,
        max_position_embeddings=4096, num_key_value_heads=1,
        attention_bias=False, mlp_bias=False, rope_theta=10000,
        tie_word_embeddings=False))
    model.freeze()
    linear_to_lora_layers(model, 1, {"rank": 2, "scale": 4.0, "dropout": 0.0})
    return model


class LossTests(unittest.TestCase):
    def test_causal_answer_mask_and_exact_gradient(self):
        model = tiny_model()
        batch = mx.array([[5, 9, 12, 4, 6, 2, 1]])
        for offset in (1, 4, 6):
            def reference(m, b, p):
                ce = nn.losses.cross_entropy(m(b[:, :-1]), b[:, 1:])
                return ce[:, p - 1:].mean(), mx.array(b.shape[1] - p)
            (ref_loss, ref_count), ref_grad = nn.value_and_grad(model, reference)(model, batch, offset)
            for chunk in (1, 2, 32):
                def optimized(m, b, p):
                    return answer_loss(m, b, p, chunk_size=chunk)
                (value, count), grad = nn.value_and_grad(model, optimized)(model, batch, offset)
                mx.eval(value, ref_loss, grad, ref_grad)
                self.assertEqual(count.item(), ref_count.item())
                self.assertLess(abs(value.item() - ref_loss.item()), 1e-6)
                for (_, actual), (_, expected) in zip(tree_flatten(grad), tree_flatten(ref_grad)):
                    self.assertLess(mx.max(mx.abs(actual - expected)).item(), 2e-6)

    def test_wrong_offset_and_batch_are_rejected(self):
        model = tiny_model()
        for batch, offset in ((mx.array([[1, 2, 3]]), 0), (mx.array([[1, 2, 3]]), 3), (mx.array([[1, 2], [2, 3]]), 1)):
            with self.assertRaises(ValueError):
                answer_loss(model, batch, offset)

    def test_z_native_block_checkpoint_preserves_gradients(self):
        from mlx_lm.tuner.trainer import grad_checkpoint
        model = tiny_model()
        batch = mx.array([[5, 9, 12, 4, 6, 2, 1]])
        (before, _), before_grad = nn.value_and_grad(model, answer_loss)(model, batch, 4)
        mx.eval(before, before_grad)
        grad_checkpoint(model.layers[0])
        (after, _), after_grad = nn.value_and_grad(model, answer_loss)(model, batch, 4)
        mx.eval(after, after_grad)
        self.assertLess(abs(before.item() - after.item()), 1e-6)
        for (_, actual), (_, expected) in zip(tree_flatten(after_grad), tree_flatten(before_grad)):
            self.assertLess(mx.max(mx.abs(actual - expected)).item(), 2e-6)


def fixture():
    splits = {s: [] for s in ("train", "valid", "test")}
    for i, s in enumerate(splits):
        row = {"id": s, "prompt_tokens": [i + 1, 14], "answer_tokens": [15, 100257], "prefix_equal": True}
        row["token_sha256"] = digest({k: row[k] for k in ("prompt_tokens", "answer_tokens")})
        splits[s] = [row]
    hashes = {s: digest([{"id": r["id"], "token_sha256": r["token_sha256"],
        "prompt_tokens": len(r["prompt_tokens"]), "answer_tokens": len(r["answer_tokens"]),
        "total_tokens": len(r["prompt_tokens"]) + len(r["answer_tokens"])} for r in rows]) for s, rows in splits.items()}
    return {"schema": "granite-training-ram-v1", "splits": splits, "split_hashes": hashes, "dataset_hash": digest(hashes)}


class AdmissionTests(unittest.TestCase):
    def test_final_candidate_requires_complete_unique_coverage_even_if_mid_loss_is_lower(self):
        plan = {"ordered_train_ids": ["a", "b", "c"], "final_step": 3}
        checkpoints = [{"step": 2, "validation": {"loss": 0.1}}, {"step": 3, "validation": {"loss": 2.0}}]
        self.assertEqual(final_candidate(checkpoints, plan, ["a", "b", "c"]), checkpoints[1])
        for observed in (["a", "b"], ["a", "b", "b"], ["b", "a", "c"]):
            with self.assertRaises(ValueError):
                final_candidate(checkpoints, plan, observed)
        with self.assertRaises(ValueError):
            final_candidate(checkpoints[:1], plan, ["a", "b", "c"])

    def test_valid_receipts(self):
        self.assertEqual(validate_data(fixture()), fixture()["split_hashes"])

    def test_reject_cross_split_identity_and_token_leakage(self):
        for field in ("id", "tokens"):
            data = fixture()
            if field == "id":
                data["splits"]["valid"][0]["id"] = "train"
            else:
                data["splits"]["valid"][0] = copy.deepcopy(data["splits"]["train"][0])
                data["splits"]["valid"][0]["id"] = "valid"
            with self.assertRaises(ValueError):
                validate_data(data)

    def test_reject_tampered_spans_and_missing_eos(self):
        for mutate in (lambda r: r.update(prefix_equal=False),
                       lambda r: r["answer_tokens"].pop(),
                       lambda r: r["prompt_tokens"].extend([1] * 4096)):
            data = fixture()
            mutate(data["splits"]["train"][0])
            with self.assertRaises(ValueError):
                validate_data(data)


if __name__ == "__main__":
    unittest.main()
