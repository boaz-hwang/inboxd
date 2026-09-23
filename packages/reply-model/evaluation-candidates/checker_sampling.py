"""Isolated Qwen-recommended sampling test for the unchanged checker prompt.

No production worker imports this experiment. The seed is fixed for comparison;
reasoning text stays in memory and only the final answer is returned.
"""

import contextlib
import sys

from checker_thinking import extract_final_text


def generate_checker_text(engine, messages, *, max_tokens=2048, seed=42):
    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        from mlx_lm import generate, load
        from mlx_lm.sample_utils import make_presence_penalty, make_sampler

        key = (str(engine.path), None)
        if key not in engine.models:
            if len(engine.models) >= 2:
                engine.models.clear()
            engine.models[key] = load(str(engine.path))
        model, tokenizer = engine.models[key]
        prompt = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True,
            enable_thinking=True,
        )
        prompt_opens_thought = prompt.rstrip().endswith("<think>")
        mx.random.seed(seed)
        raw = generate(
            model, tokenizer, prompt=prompt, max_tokens=max_tokens,
            sampler=make_sampler(temp=1.0, top_p=0.95, top_k=20),
            # MLX passes the prompt plus generated tokens to this processor.
            # 4096 includes the full 2048-token generation and recent prompt.
            logits_processors=[make_presence_penalty(1.5, context_size=4096)],
            verbose=False,
        )
    return extract_final_text(raw, prompt_opens_thought=prompt_opens_thought)
