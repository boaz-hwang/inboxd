"""Isolated experiment: run the unchanged checker prompt with model reasoning.

This module is not imported by the production worker unless the experiment has
passed the frozen grounding review. Never write raw thinking or message text to
stdout or a shared log.
"""

import contextlib
import sys


def extract_final_text(raw, *, prompt_opens_thought):
    """Discard reasoning and reject incomplete/malformed thought boundaries."""
    raw = raw.strip()
    if prompt_opens_thought or raw.startswith("<think>"):
        if "</think>" not in raw:
            raise ValueError("check_reasoning_truncated")
        return raw.split("</think>", 1)[1].strip()
    if "<think>" in raw or "</think>" in raw:
        raise ValueError("check_reasoning_invalid")
    return raw


def generate_checker_text(engine, messages, *, max_tokens=2048):
    """Return only the final checker answer, or fail closed on unfinished thought."""
    with contextlib.redirect_stdout(sys.stderr):
        from mlx_lm import generate, load
        from mlx_lm.sample_utils import make_sampler

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
        # Some Qwen chat templates place the opening <think> in the prompt,
        # leaving only the closing tag in generated text.
        prompt_opens_thought = prompt.rstrip().endswith("<think>")
        raw = generate(
            model, tokenizer, prompt=prompt, max_tokens=max_tokens,
            sampler=make_sampler(temp=0.0), verbose=False,
        ).strip()
    return extract_final_text(raw, prompt_opens_thought=prompt_opens_thought)
