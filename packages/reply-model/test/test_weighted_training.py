import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import personalization as p
import training_runtime as runtime
import weighted_training as w
import weighted_training_runtime as child


def seal(value, key):
    value[key] = p.digest({k: v for k, v in value.items() if k != key})
    return value


def small_map(rows):
    categories = ['required_state_preservation', 'real_acknowledgement_or_greeting',
                  'all_other_examples']
    mean = sum(child.RAW_WEIGHTS[c] for c in categories) / 3
    return seal({'schema': 'frozen-functional-loss-weights-v1',
        'normalization': 'arithmetic_mean_over_training_examples', 'normalizer': mean,
        'training_example_count': 3, 'entries': [
            {'id': str(i), 'category': categories[i], 'raw_weight': child.RAW_WEIGHTS[categories[i]],
             'normalized_weight': child.RAW_WEIGHTS[categories[i]] / mean,
             'example_hash': 'fixture', 'review_hash': 'fixture',
             'tokenized_example_hash': child.token_key(tokens, offset)}
            for i, (tokens, offset) in enumerate(rows)]}, 'weight_map_hash')


class MetadataTests(unittest.TestCase):
    def test_priority_order_prevents_abstain_promotion_and_ack_override(self):
        flags = dict.fromkeys(w.CRITERIA, True)
        self.assertEqual(w.classification_category({'criteria': flags}), 'required_state_preservation')
        flags['required_state_preservation'] = False
        self.assertEqual(w.classification_category({'criteria': flags}), 'mandatory_abstain_only')
        flags['mandatory_abstain_only'] = False
        self.assertEqual(w.classification_category({'criteria': flags}), 'useful_clarification_or_future_intent')
        flags['useful_clarification_or_future_intent'] = False
        self.assertEqual(w.classification_category({'criteria': flags}), 'real_acknowledgement_or_greeting')

    def test_global_mean_not_token_weight_or_batch_mean(self):
        rows = [([1, 2, 3], 1), ([4, 2, 3, 4, 5], 1), ([5, 2, 3, 4, 5, 6], 1)]
        value = small_map(rows)
        index = child.validate_map(value)
        self.assertAlmostEqual(sum(index.values()) / 3, 1)
        self.assertAlmostEqual(index[child.token_key(*rows[0])], 12 / 7)
        value['normalizer'] = 2
        seal(value, 'weight_map_hash')
        with self.assertRaisesRegex(ValueError, 'normalizer_changed'):
            child.validate_map(value)

    def test_conflicting_identical_tokens_fail_closed(self):
        value = small_map([([1, 2, 3], 1)] * 3)
        with self.assertRaisesRegex(ValueError, 'ambiguous_tokenized_example_weight'):
            child.validate_map(value)

    def test_boolean_or_nonfinite_weights_are_not_numeric_admission(self):
        original = small_map([([1, 2, 3], 1), ([4, 5, 6], 1), ([7, 8, 9], 1)])
        for field, replacement in [('raw_weight', True), ('normalized_weight', float('inf'))]:
            value = copy.deepcopy(original)
            value['entries'][0][field] = replacement
            seal(value, 'weight_map_hash')
            with self.assertRaisesRegex(ValueError, 'entry_changed'):
                child.validate_map(value)

    def test_weighted_completion_requires_child_audit_and_failure_restores_guard(self):
        weights = small_map([([1, 2, 3], 1), ([4, 5, 6], 1), ([7, 8, 9], 1)])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            root.chmod(0o700)
            weights_path = root / 'weights.json'
            p.private_json(weights_path, weights)
            prepared = SimpleNamespace(plan={'output': str(root / 'run'), 'plan_hash': 'ordinary'})
            experiment = {'experiment_hash': 'fixture'}
            for complete in [False, True]:
                def fake_execute(*args, **kwargs):
                    output = root / 'run'
                    output.mkdir(exist_ok=True)
                    train, valid = root / 'train.json', root / 'valid.json'
                    train.write_text(json.dumps({'train': True, 'inboxd_target_token_bound': 65}))
                    valid.write_text(json.dumps({'train': False, 'inboxd_target_token_bound': 65}))
                    for path in [train] + [valid] * 4:
                        p.guarded_training_run(['python', str(Path(runtime.__file__).resolve()),
                                               '--config', str(path)])
                    p.private_json(output / 'adapter' / 'weighted-loss-observation.json',
                        {'status': 'complete' if complete else 'failed', 'complete': complete,
                         'weight_map_hash': weights['weight_map_hash']})
                    return {'status': 'awaiting_independent_evaluation', 'plan_hash': 'ordinary'}
                original = lambda *args, **kwargs: None
                with patch.object(p, 'guarded_training_run', original), \
                     patch.object(w, 'experiment_plan', return_value=experiment), \
                     patch.object(w.e, 'owner_path', return_value=weights_path), \
                     patch.object(w.e, 'execute', side_effect=fake_execute):
                    if complete:
                        result = w.execute(prepared, weights, experiment, expected_experiment_hash='fixture',
                                           weight_path=weights_path, daemon_args=None)
                        self.assertEqual(result['plan_hash'], 'ordinary')
                    else:
                        with self.assertRaisesRegex(ValueError, 'observation_incomplete'):
                            w.execute(prepared, weights, experiment, expected_experiment_hash='fixture',
                                      weight_path=weights_path, daemon_args=None)
                    self.assertIs(p.guarded_training_run, original)
                receipt = json.loads((root / 'run' / 'weighted-completion.json').read_text())
                self.assertEqual(receipt['status'], 'awaiting_independent_evaluation' if complete else 'failed')
                self.assertEqual(receipt['base_training_plan_hash'], 'ordinary')
                self.assertEqual(receipt['receipt_hash'], p.digest({k: v for k, v in receipt.items() if k != 'receipt_hash'}))

    def test_only_training_dispatch_changes_and_guard_restores_on_failure(self):
        value = small_map([([1, 2, 3], 1), ([4, 5, 6], 1), ([7, 8, 9], 1)])
        calls = []
        def original(command, **kwargs):
            calls.append(command)
            if len(calls) == 3:
                raise RuntimeError('fixture_failure')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            train, valid = root / 'train.json', root / 'valid.json'
            train.write_text(json.dumps({'train': True, 'inboxd_target_token_bound': 65}))
            valid.write_text(json.dumps({'train': False, 'test': True, 'inboxd_target_token_bound': 65}))
            runtime_path = str(Path(runtime.__file__).resolve())
            commands = [['python', runtime_path, '--config', str(path)] for path in [train, valid, valid]]
            observations = []
            with patch.object(p, 'guarded_training_run', original):
                with self.assertRaisesRegex(RuntimeError, 'fixture_failure'):
                    with w.inject_training_child(root / 'weights.json', value, observations):
                        for command in commands:
                            p.guarded_training_run(command)
                self.assertIs(p.guarded_training_run, original)
            self.assertTrue(calls[0][1].endswith('weighted_training_runtime.py'))
            self.assertIs(calls[1], commands[1])
            self.assertIs(calls[2], commands[2])
            self.assertEqual([o['weighted'] for o in observations], [True, False, False])

    def test_freeze_requires_every_exact_training_identity_and_warning_review_hash(self):
        records = [{'id': str(i), 'review_hash': 'review-' + str(i), 'messages': [
            {'role': 'user', 'content': str(i)}, {'role': 'assistant', 'content': 'fixture target'}]}
            for i in range(152)]
        assignments = {r['id']: 'train' for r in records}
        prepared = SimpleNamespace(records=records, assignments=assignments,
            plan={'manifest_id': 'fixture', 'records_hash': p.digest(records),
                  'assignments_hash': p.digest(assignments)})
        entries = []
        for record in records:
            flags = dict.fromkeys(w.CRITERIA, False)
            flags['real_acknowledgement_or_greeting'] = True
            entries.append({'id': record['id'], 'example_hash': p.digest(record),
                'review_hash': record['review_hash'], 'criteria': flags,
                'category': 'real_acknowledgement_or_greeting', 'raw_weight': .5,
                'rationale_codes': ['fixture_semantic_review']})
        classification = seal({'proposal_hash': w.PROPOSAL_HASH, 'manifest_id': 'fixture',
            'review_provenance': 'agent_delegated_full_semantic', 'entries': entries}, 'classification_hash')
        class Tokenizer:
            def apply_chat_template(self, messages, **kwargs):
                return [10 + int(messages[0]['content'])] + ([1, 2] if len(messages) == 2 else [])
        result = w.freeze_weights(prepared, classification, Tokenizer())
        self.assertEqual(result['training_example_count'], 152)
        self.assertTrue(all(entry['normalized_weight'] == 1 for entry in result['entries']))
        classification['entries'][0]['review_hash'] = 'different'
        seal(classification, 'classification_hash')
        with self.assertRaisesRegex(ValueError, 'reviewed_weight_classification_changed'):
            w.freeze_weights(prepared, classification, Tokenizer())

    def test_expected_order_matches_installed_generator_with_interleaved_validation(self):
        import numpy as np
        import mlx.core as mx
        from mlx_lm.tuner.trainer import iterate_batches
        mx.set_default_device(mx.cpu)
        # Duplicate lengths deliberately exercise stable sorting; validation
        # consumes the same global RNG used by the next training epoch.
        dataset = [([i + 1] * (4 + i % 17), 2) for i in range(152)]
        validation = [([i + 1] * (4 + i % 9), 2) for i in range(46)]
        entries = [{'total_tokens': len(tokens),
                    'tokenized_example_hash': child.token_key(tokens, offset)}
                   for tokens, offset in dataset]
        prior = np.random.get_state()
        try:
            np.random.seed(0)
            batches = iterate_batches(dataset, 1, 4096, loop=True)
            actual = []
            for step in range(1, 305):
                batch, lengths = next(batches)
                if step == 1 or step % 76 == 0 or step == 304:
                    list(iterate_batches(validation, 1, 4096))
                offset, total = lengths.tolist()[0]
                actual.append(child.token_key(batch[0, :total].tolist(), offset))
            self.assertEqual(w.expected_order(entries, 46), p.digest(actual))
        finally:
            np.random.set_state(prior)

    def test_actual_call_audit_uses_frozen_multiplicity_and_rejects_changed_order(self):
        entries = [{'tokenized_example_hash': 'same', 'total_tokens': 9, 'offset': 6},
                   {'tokenized_example_hash': 'same', 'total_tokens': 9, 'offset': 6},
                   {'tokenized_example_hash': 'other', 'total_tokens': 8, 'offset': 6}]
        order = ['same', 'other', 'same', 'other', 'same', 'same']
        value = {'entries': entries, 'validation_example_count': 2,
                 'validation_target_token_count': 7, 'weight_map_hash': 'fixture',
                 'expected_training_order_hash': p.digest(order)}
        observed = {'ordered_training_keys': order, 'training_ntoks': 16,
                    'unweighted_eval_calls': 10, 'unweighted_eval_ntoks': 35}
        proof = child.audit_observations(value, observed)
        self.assertTrue(proof['complete'])
        self.assertEqual(proof['expected_seen_counts'], {'same': 4, 'other': 2})
        observed['ordered_training_keys'] = list(reversed(order))
        self.assertFalse(child.audit_observations(value, observed)['complete'])
        observed['ordered_training_keys'] = order
        observed['unweighted_eval_calls'] -= 1
        self.assertFalse(child.audit_observations(value, observed)['complete'])


try:
    import mlx.core as mx
    import mlx.nn as nn
    import mlx.optimizers as optim
    from mlx.utils import tree_flatten
except ImportError:
    mx = None


@unittest.skipIf(mx is None, 'MLX unavailable')
class GradientTests(unittest.TestCase):
    def setUp(self):
        mx.set_default_device(mx.cpu)
        mx.random.seed(17)
        self.rows = [([i % 10 + 1 for i in range(n)], n - 3) for n in [7, 11, 15]]
        self.value = small_map(self.rows)
        self.loss = child.weighted_loss(runtime.checkpointed_loss, self.value)
    def model(self):
        class Tiny(nn.Module):
            def __init__(self):
                super().__init__()
                self.model_type = 'qwen3_5_text'
                self.args = SimpleNamespace(tie_word_embeddings=False)
                self.model = nn.Sequential(nn.Embedding(11, 4), lambda x: mx.cumsum(x, axis=1))
                self.lm_head = nn.Linear(4, 11, bias=False)
                self.lm_head.freeze()
        return Tiny()
    def batch(self, i):
        tokens, offset = self.rows[i]
        return mx.array([tokens + [0, 0]]), mx.array([[offset, len(tokens)]])
    def close(self, a, b, tolerance=2e-5):
        mx.eval(a, b)
        self.assertLessEqual(float(mx.max(mx.abs(a - b)).item()), tolerance)
    def test_actual_checkpointed_loss_gradient_scaled_and_eval_exactly_unchanged(self):
        model = self.model()
        for i in range(3):
            batch, lengths = self.batch(i)
            base, g = nn.value_and_grad(model, lambda m: runtime.checkpointed_loss(
                m, batch, lengths, target_token_bound=3)[0])(model)
            alpha = self.value['entries'][i]['normalized_weight']
            actual, h = nn.value_and_grad(model, lambda m: self.loss(
                m, batch, lengths, target_token_bound=3)[0])(model)
            self.close(actual, alpha * base)
            for (key, a), (other, b) in zip(tree_flatten(g), tree_flatten(h)):
                self.assertEqual(key, other)
                self.close(b, alpha * a)
            self.assertEqual(self.loss(model, batch, lengths, target_token_bound=3)[1].item(), 3)
            model.eval()
            ordinary = runtime.checkpointed_loss(model, batch, lengths, target_token_bound=3)
            unchanged = self.loss(model, batch, lengths, target_token_bound=3)
            self.close(ordinary[0], unchanged[0], 0)
            self.assertEqual(ordinary[1].item(), unchanged[1].item())
            model.train()
    def test_adam_sequence_matches_manual_globally_weighted_gradients(self):
        def run(manual):
            mx.random.seed(17)
            model, optimizer = self.model(), optim.Adam(learning_rate=1e-5)
            for i in [0, 1, 2, 0, 1, 2]:
                batch, lengths = self.batch(i)
                alpha = self.value['entries'][i]['normalized_weight']
                fn = runtime.checkpointed_loss if manual else self.loss
                _, gradient = nn.value_and_grad(model, lambda m: fn(m, batch, lengths,
                    target_token_bound=3)[0])(model)
                if manual:
                    from mlx.utils import tree_map
                    gradient = tree_map(lambda x: alpha * x, gradient)
                optimizer.update(model, gradient)
                mx.eval(model.state, optimizer.state)
            return model.trainable_parameters(), optimizer.state
        left, right = run(False), run(True)
        for a, b in zip(tree_flatten(left), tree_flatten(right)):
            self.assertEqual(a[0], b[0])
            self.close(a[1], b[1])
    def test_unknown_training_batch_is_refused_but_eval_never_uses_weight_index(self):
        model = self.model()
        batch, lengths = self.batch(0)
        unknown = batch + mx.array([[1] + [0] * (batch.shape[1] - 1)])
        with self.assertRaisesRegex(ValueError, 'unfrozen_training_example'):
            self.loss(model, unknown, lengths, target_token_bound=3)
        model.eval()
        self.close(self.loss(model, unknown, lengths, target_token_bound=3)[0],
                   runtime.checkpointed_loss(model, unknown, lengths, target_token_bound=3)[0], 0)

    def test_observation_is_actual_gradient_call_not_forward_or_padding_count(self):
        model = self.model()
        observations = {'ordered_training_keys': [], 'training_ntoks': 0,
                        'unweighted_eval_calls': 0, 'unweighted_eval_ntoks': 0}
        loss = child.weighted_loss(runtime.checkpointed_loss, self.value, observations)
        for i in range(3):
            batch, lengths = self.batch(i)
            value, gradient = nn.value_and_grad(model, lambda m: loss(
                m, batch, lengths, target_token_bound=3)[0])(model)
            mx.eval(value, gradient)
        self.assertEqual(observations['ordered_training_keys'],
                         [e['tokenized_example_hash'] for e in self.value['entries']])
        self.assertEqual(observations['training_ntoks'], 9)
        model.eval()
        batch, lengths = self.batch(0)
        loss(model, batch, lengths, target_token_bound=3)
        self.assertEqual(observations['unweighted_eval_calls'], 1)
        self.assertEqual(observations['unweighted_eval_ntoks'], 3)
        self.assertEqual(len(observations['ordered_training_keys']), 3)


if __name__ == '__main__':
    unittest.main()
