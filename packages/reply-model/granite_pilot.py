"""Offline cross-model pilot. Observed synthetic regressions, not a promotion gate.

Artifacts stay under the supplied private output directory. Production settings,
model registry, adapters, and messenger state are never changed.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import time

ROOT = Path(__file__).resolve().parent
REVISION = "0c6f39b1827afd5eb2c1c3b13751929857434953"
RUNS = {
    "run_a": {"model": "Granite-4.2-3B-4bit", "temperature": 0.0, "top_p": 1.0},
    "run_b": {"model": "Qwen3.5-9B-4bit", "temperature": 0.0, "top_p": 1.0},
    "run_c": {"model": "Granite-4.2-3B-4bit", "temperature": 1.0, "top_p": 0.95},
}


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def rendered_tokens(tokenizer, messages):
    text = tokenizer.apply_chat_template(messages, tokenize=False,
        add_generation_prompt=True, enable_thinking=False)
    return tokenizer.encode(text, add_special_tokens=False)


def freeze(out, models):
    from transformers import AutoTokenizer
    from evaluation_v2.fresh_cases import CASES, GENERAL
    from worker import compile_prompt, build_generation_input
    out.mkdir(parents=True, exist_ok=False)
    tokenizers = [AutoTokenizer.from_pretrained(str(models / name), local_files_only=True)
                  for name in ("Granite-4.2-3B-4bit", "Qwen3.5-9B-4bit")]
    fixtures = copy.deepcopy(CASES)
    for item in fixtures:
        compiled, omitted = compile_prompt(item["request"])
        assert not omitted
        item["messages"] = build_generation_input(compiled)
        item["preflight"] = json.loads(compiled[-1]["content"])["preflight"]
    # Same distant-refusal conversation for both models. Size is chosen using
    # only token counts before any output is generated. No silent truncation.
    stress = copy.deepcopy(CASES[6])
    stress.update(id="stress-near4k", category="stress_distant_refusal")
    original = stress["request"]["context"]
    accepted = None
    for count in range(1, 150):
        padding = [{"message_id": f"stress-neutral-{i}", "author_role": "other",
            "author_id": "synthetic-daeun", "body": "장비 목록의 정렬 순서는 확인 중이에요. 이 안내는 소개 글의 공개 범위와 관계없어요.",
            "ts": original[0]["ts"] + i + 1, "reply_to": None}
            for i in range(count)]
        req = copy.deepcopy(stress["request"])
        req["context"] = [copy.deepcopy(original[0])] + padding + copy.deepcopy(original[1:])
        for i, msg in enumerate(req["context"]):
            msg["ts"] = original[0]["ts"] + i
        compiled, omitted = compile_prompt(req)
        if omitted:
            break
        messages = build_generation_input(compiled)
        counts = [len(rendered_tokens(tok, messages)) for tok in tokenizers]
        if max(counts) > 3904:
            break
        accepted = (req, messages, counts, count)
    assert accepted is not None
    stress["request"], stress["messages"], counts, count = accepted
    compiled, _ = compile_prompt(stress["request"])
    stress["preflight"] = json.loads(compiled[-1]["content"])["preflight"]
    stress["stress_only"] = True
    stress["note"] = {"padding_turns": count, "prompt_tokens_granite_qwen": counts,
                      "total_budget": 4096, "output_budget": 192}
    fixtures.append(stress)
    for item in fixtures:
        assert all(len(rendered_tokens(tok, item["messages"])) + 192 <= 4096 for tok in tokenizers)
    write_json(out / "cases.json", {"evidence": "24 already observed synthetic regression cases; one stress case; no real messenger data", "general_rubric": GENERAL, "cases": fixtures})
    settings = {"runs": RUNS, "max_tokens": 192, "enable_thinking": False,
        "pretokenize_add_special_tokens": False, "seed_per_case": 42,
        "granite_repository": "ibm-granite/granite-4.2-3b-q4-mlx",
        "granite_revision": REVISION, "models_directory": str(models),
        "worker_sha256": hashlib.sha256((ROOT / "worker.py").read_bytes()).hexdigest(),
        "pilot_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "cases_sha256": hashlib.sha256((out / "cases.json").read_bytes()).hexdigest(),
        "frozen_at_unix": time.time(), "warmup": "first fixture, discarded from measurements",
        "memory": "MLX allocator peak bytes and process RSS high water bytes are separate overlapping measures; never add them"}
    write_json(out / "private_mapping_manifest.json", settings)
    print(json.dumps({"status": "frozen", "cases": len(fixtures), "stress_token_counts": counts, "path": str(out)}), flush=True)


def run(out, label):
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    import mlx.core as mx
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_sampler
    fixtures = json.loads((out / "cases.json").read_text())["cases"]
    settings = json.loads((out / "private_mapping_manifest.json").read_text())
    assert hashlib.sha256((out / "cases.json").read_bytes()).hexdigest() == settings["cases_sha256"]
    cfg = settings["runs"][label]
    start = time.perf_counter()
    model, tokenizer = load(str(Path(settings["models_directory"]) / cfg["model"]))
    mx.eval(model.parameters())
    load_seconds = time.perf_counter() - start
    resident = mx.get_active_memory()
    swap_before = subprocess.check_output(["sysctl", "vm.swapusage"], text=True).strip()
    model_dir = Path(settings["models_directory"]) / cfg["model"]
    weight_bytes = sum(p.stat().st_size for p in model_dir.glob("*.safetensors"))
    def generate(item, measured):
        prompt = rendered_tokens(tokenizer, item["messages"])
        rendered = tokenizer.apply_chat_template(item["messages"], tokenize=False,
            add_generation_prompt=True, enable_thinking=False)
        production_special_tokens = tokenizer.bos_token is None or not rendered.startswith(tokenizer.bos_token)
        production_prompt = tokenizer.encode(rendered, add_special_tokens=production_special_tokens)
        assert item["preflight"]["status"] == "ready", "preflight abstention must not invoke generation"
        assert len(prompt) + settings["max_tokens"] <= 4096
        mx.clear_cache()
        mx.reset_peak_memory()
        mx.random.seed(settings["seed_per_case"])
        sampler = make_sampler(temp=cfg["temperature"], top_p=cfg["top_p"])
        started = time.perf_counter()
        first_token = None
        first_text = None
        parts = []
        last = None
        for result in stream_generate(model, tokenizer, prompt=prompt,
            max_tokens=settings["max_tokens"], sampler=sampler):
            elapsed = time.perf_counter() - started
            if first_token is None:
                first_token = elapsed
            if result.text and first_text is None:
                first_text = elapsed
            parts.append(result.text)
            last = result
        elapsed = time.perf_counter() - started
        text = "".join(parts).strip()
        return {"run": label, "id": item["id"], "stress_only": item.get("stress_only", False),
            "preflight_status": item["preflight"]["status"], "preflight_reason": item["preflight"]["reason"],
            "model_generated": True, "production_string_tokenization_equal": production_prompt == prompt,
            "production_string_prompt_tokens": len(production_prompt),
            "text": text, "seconds": elapsed, "ttft_seconds": first_token,
            "first_text_seconds": first_text, "prompt_tokens": len(prompt),
            "generation_tokens": last.generation_tokens, "finish_reason": last.finish_reason,
            "prompt_tps": last.prompt_tps, "generation_tps": last.generation_tps,
            "mlx_peak_bytes": mx.get_peak_memory(), "mlx_resident_bytes": resident,
            "rss_high_water_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "thinking_leak": "<think>" in text or "</think>" in text}
    warmup = generate(fixtures[0], False)
    path = out / f"{label}.jsonl"
    with path.open("x") as stream:
        for item in fixtures:
            row = generate(item, True)
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
            stream.flush()
            print(json.dumps({"run": label, "id": row["id"], "seconds": round(row["seconds"], 3),
                              "mlx_peak_gb": round(row["mlx_peak_bytes"] / 1e9, 3)}), flush=True)
    write_json(out / f"{label}_runtime.json", {"load_seconds": load_seconds,
        "model_resident_bytes": resident, "warmup_seconds": warmup["seconds"],
        "mx_version": mx.__version__, "weight_file_bytes": weight_bytes,
        "swap_before": swap_before,
        "swap_after": subprocess.check_output(["sysctl", "vm.swapusage"], text=True).strip(),
        "rss_high_water_is_process_cumulative": True})
    print(json.dumps({"status": "complete", "run": label, "path": str(path)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("freeze", "run"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models", type=Path, default=Path.home() / ".inboxd/reply-model/models")
    parser.add_argument("--label", choices=tuple(RUNS))
    args = parser.parse_args()
    if args.action == "freeze":
        freeze(args.output, args.models)
    else:
        if args.label is None:
            parser.error("run requires --label")
        run(args.output, args.label)
