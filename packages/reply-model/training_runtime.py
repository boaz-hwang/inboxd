"""Process-local, exact-gradient memory bounds for Qwen3.5 LoRA training.

No installed library files, model weights, adapter scope, or examples are changed.
"""
from functools import partial
RUNTIME_VERSION = 'qwen35-training-runtime-v5'


def runtime_configuration(backend='legacy', compile_mode='default'):
    """Explicit opt-in; importing this metadata helper does not import MLX."""
    if backend not in ('legacy', 'parallel_chunk16'):
        raise ValueError('invalid_training_runtime_backend')
    if compile_mode not in ('default', 'disabled'):
        raise ValueError('invalid_training_compile_mode')
    if backend == 'parallel_chunk16' and compile_mode != 'disabled':
        raise ValueError('parallel_chunk16_requires_compile_disabled')
    return {
        'runtime_version': RUNTIME_VERSION,
        'effective_runtime_version': ('qwen35-parallel16-prefixoutside-gather-target-loss-v1'
                                      if backend == 'parallel_chunk16' else
                                      'qwen35-chunk32-gather-target-loss-v4'),
        'backend': backend, 'compile_mode': compile_mode,
        'recurrence_chunk_size': 16 if backend == 'parallel_chunk16' else 32,
        'head_loss_chunk_size': 32,
        'frozen_prefix_layers': 28 if backend == 'parallel_chunk16' else None,
        'trainable_suffix_layers': 4 if backend == 'parallel_chunk16' else None,
        'prefix_scope': 'training_only' if backend == 'parallel_chunk16' else 'none',
        'inference_path': 'original',
    }


def runtime_source_files(backend='legacy'):
    runtime_configuration(backend, 'disabled' if backend == 'parallel_chunk16' else 'default')
    return (('training_runtime.py', 'parallel_chunk.py', 'prefix_outside.py')
            if backend == 'parallel_chunk16' else ('training_runtime.py',))


class RuntimePatch:
    """Own only bindings installed in this dedicated runner process."""
    def __init__(self):
        self.bindings = []
        self.parallel = None
        self.restored = False

    def bind(self, module, name, replacement):
        original = getattr(module, name)
        setattr(module, name, replacement)
        self.bindings.append((module, name, original, replacement))

    def restore(self):
        if self.restored:
            return
        if self.parallel is not None:
            self.parallel.restore()
        for module, name, original, replacement in reversed(self.bindings):
            if getattr(module, name) is not replacement:
                raise RuntimeError('training_runtime_patch_ownership_changed')
            setattr(module, name, original)
        self.restored = True


def configure_compile_mode(mx, mode='default'):
    """An explicit process-local choice; preserve existing callers' defaults."""
    if mode not in ('default', 'disabled'):
        raise ValueError('invalid_training_compile_mode')
    if mode == 'disabled':
        if not callable(getattr(mx, 'disable_compile', None)):
            raise RuntimeError('training_compile_control_unavailable')
        mx.disable_compile()


def chunked_gated_delta_ops(q, k, v, g, beta, state=None, mask=None, *, chunk_size=32):
    import mlx.core as mx
    from mlx_lm.models.gated_delta import _gated_delta_step_ops
    if chunk_size < 1:
        raise ValueError('invalid_recurrence_chunk_size')
    batch, length, key_heads, key_dim = q.shape
    value_heads, value_dim = v.shape[-2:]
    if state is None:
        state = mx.zeros((batch, value_heads, value_dim, key_dim), dtype=mx.float32)
    if value_heads % key_heads:
        raise ValueError('invalid_recurrence_head_ratio')
    if value_heads != key_heads:
        q = mx.repeat(q, value_heads // key_heads, -2)
        k = mx.repeat(k, value_heads // key_heads, -2)

    def block(q, k, v, g, beta, state, mask):
        outputs = []
        for index in range(q.shape[1]):
            output, state = _gated_delta_step_ops(q[:, index], k[:, index],
                v[:, index], g[:, index], beta[:, index], state,
                None if mask is None else mask[:, index])
            outputs.append(output)
        return mx.stack(outputs, axis=1), state

    outputs = []
    checkpoint = mx.checkpoint(block)
    for start in range(0, length, chunk_size):
        end = min(start + chunk_size, length)
        output, state = checkpoint(q[:, start:end], k[:, start:end], v[:, start:end],
            g[:, start:end], beta[:, start:end], state,
            None if mask is None else mask[:, start:end])
        outputs.append(output)
    return mx.concatenate(outputs, axis=1), state


def checkpointed_loss(model, batch, lengths, *, chunk_size=32, target_token_bound=None):
    """Causal answer-only loss; exclude the first padding target at total length."""
    import mlx.core as mx
    import mlx.nn as nn
    if chunk_size < 1:
        raise ValueError('invalid_loss_chunk_size')
    if model.model_type not in ('qwen3_5', 'qwen3_5_text'):
        raise ValueError('unsupported_training_runtime_model')
    text = getattr(model, 'language_model', model)
    hidden = text.model(batch[:, :-1])
    bound = batch.shape[1] - 1 if target_token_bound is None else target_token_bound
    if type(bound) is not int or bound < 1:
        raise ValueError('invalid_target_token_bound')
    # Offset is the first answer token's original index; its prediction is offset-1.
    positions = mx.maximum(lengths[:, 0:1], 1) + mx.arange(bound)[None, :]
    mask = positions < lengths[:, 1:]
    hidden_indices = mx.stop_gradient(mx.clip(positions - 1, 0, hidden.shape[1] - 1))
    target_indices = mx.stop_gradient(mx.clip(positions, 0, batch.shape[1] - 1))
    hidden = mx.take_along_axis(hidden, hidden_indices[..., None], axis=1)
    targets = mx.take_along_axis(batch, target_indices, axis=1)
    ntoks = mask.sum()

    def head_loss(params, hidden, targets, mask):
        text.update(params)
        if text.args.tie_word_embeddings:
            logits = text.model.embed_tokens.as_linear(hidden)
        else:
            logits = text.lm_head(hidden)
        return (nn.losses.cross_entropy(logits, mx.stop_gradient(targets)) * mx.stop_gradient(mask)).astype(mx.float32).sum()

    checkpoint = mx.checkpoint(head_loss)
    total = mx.array(0.0, dtype=mx.float32)
    params = text.trainable_parameters()
    for start in range(0, targets.shape[1], chunk_size):
        end = min(start + chunk_size, targets.shape[1])
        total = total + checkpoint(params, hidden[:, start:end], targets[:, start:end], mask[:, start:end])
    return total / ntoks, ntoks


def validate_target_bound(dataset, bound):
    """Run before compilation; never silently truncate a target to the static bound."""
    if type(bound) is not int or bound < 1:
        raise ValueError('invalid_target_token_bound')
    if dataset is None:
        return
    for index in range(len(dataset)):
        tokens, offset = dataset[index]
        if type(offset) is not int or offset < 1 or len(tokens) <= offset:
            raise ValueError('invalid_training_target_offset')
        if len(tokens) - offset > bound:
            raise ValueError('training_target_exceeds_bound')


def install_runtime(target_token_bound, *, compile_mode='default', backend='legacy'):
    """Patch only this dedicated runner process, and fail on unsupported APIs."""
    runtime_configuration(backend, compile_mode)
    import mlx.core as mx
    configure_compile_mode(mx, compile_mode)
    import mlx_lm.lora as lora
    import mlx_lm.models.gated_delta as delta
    import mlx_lm.tuner.trainer as trainer
    if not callable(getattr(mx, 'checkpoint', None)) or not callable(getattr(delta, '_gated_delta_step_ops', None)):
        raise RuntimeError('training_runtime_api_unavailable')
    patch = RuntimePatch()
    # Defaults were bound when mlx_lm imported its trainer functions.
    loss = partial(checkpointed_loss, target_token_bound=target_token_bound)
    def bounded_train(*args, **kwargs):
        validate_target_bound(kwargs.get('train_dataset'), target_token_bound)
        validate_target_bound(kwargs.get('val_dataset'), target_token_bound)
        kwargs['loss'] = loss
        if backend == 'legacy':
            return original_train(*args, **kwargs)
        # lora.train_model has already loaded, frozen, and applied last4 LoRA.
        model = kwargs.get('model')
        if model is None or args:
            raise ValueError('expected_keyword_training_model')
        text = getattr(model, 'language_model', model)
        if (model.model_type not in ('qwen3_5', 'qwen3_5_text') or
                type(text.model).__module__ != 'mlx_lm.models.qwen3_5'):
            raise ValueError('parallel_chunk16_requires_qwen35_model')
        import mlx.nn as nn
        from prefix_outside import OutsideGradientPrefix
        hook = OutsideGradientPrefix(model, nn, prefix_count=28, suffix_count=4)
        try:
            return original_train(**kwargs)
        finally:
            hook.restore()
    def bounded_evaluate(*args, **kwargs):
        validate_target_bound(kwargs.get('dataset'), target_token_bound)
        kwargs['loss'] = loss
        return original_evaluate(*args, **kwargs)
    original_train, original_evaluate = lora.train, lora.evaluate
    try:
        patch.bind(delta, 'gated_delta_ops', chunked_gated_delta_ops)
        patch.bind(lora, 'train', bounded_train)
        patch.bind(lora, 'evaluate', bounded_evaluate)
        patch.bind(trainer, 'evaluate', bounded_evaluate)
        if backend == 'parallel_chunk16':
            from parallel_chunk import install_parallel_chunk
            patch.parallel = install_parallel_chunk(chunk_size=16, unsupported='error')
        return patch
    except BaseException:
        patch.restore()
        raise


def main():
    import argparse
    import json
    import sys
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('-c', '--config')
    args, _ = parser.parse_known_args()
    patch = None
    if args.config:
        with open(args.config) as stream:
            config = json.load(stream)
        bound = config.get('inboxd_target_token_bound')
        if type(bound) is not int or bound < 1:
            raise ValueError('invalid_target_token_bound')
        patch = install_runtime(bound, compile_mode=config.get('inboxd_compile_mode', 'default'),
                                backend=config.get('inboxd_runtime_backend', 'legacy'))
    elif '--help' not in sys.argv and '-h' not in sys.argv:
        raise ValueError('training_runtime_config_required')
    try:
        from mlx_lm.lora import main as lora_main
        lora_main()
    finally:
        if patch is not None:
            patch.restore()


if __name__ == '__main__':
    main()
