"""Private paired Granite evaluation: real contexts remain token arrays in RAM.

The complete one-epoch final adapter is compared to the unchanged base. Only
generated answers and metadata persist; historical targets never reach inference.
"""
import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import secrets
import socket
import subprocess
import sys
import time

from granite_training import digest, file_sha, private_json, resource_snapshot

ROOT = Path(__file__).resolve().parent
MODEL = Path.home() / ".inboxd/reply-model/models/Granite-4.2-3B-4bit"
HELPER = Path.home() / ".inboxd/reply-model/learning/expansion-20261003/actual4k-resource-pilot-bfs4-v1/restore_helper.py"
CONTRACT = Path.home() / ".inboxd/reply-model/learning/granite-training-20261006/paired-evaluation-contract.json"


def read_quality(grant):
    if grant.get("grant_hash") != digest({k: v for k, v in grant.items() if k != "grant_hash"}):
        raise ValueError("quality_grant_seal_changed")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(300)
        client.connect(grant["socket_path"])
        request = json.dumps({"operation": "granite_quality_data", "grant_hash": grant["grant_hash"]}).encode()
        client.sendall(len(request).to_bytes(8, "big") + request)
        def receive(count):
            value = bytearray()
            while len(value) < count:
                chunk = client.recv(min(1048576, count - len(value)))
                if not chunk:
                    raise ValueError("incomplete_quality_ram_transfer")
                value.extend(chunk)
            return value
        count = int.from_bytes(receive(8), "big")
        if count > 128 * 1024 ** 2:
            raise ValueError("oversized_quality_ram_transfer")
        data = json.loads(receive(count))
    if data.get("schema") != "granite-context-quality-evaluation-ram-v1" or data.get("historical_targets_absent") is not True:
        raise ValueError("context_only_quality_dataset_required")
    receipts = []
    for row in data["cases"]:
        if set(row) != {"id", "prompt_tokens", "input_hash", "rubric"}:
            raise ValueError("unexpected_quality_case_fields")
        prompt = row["prompt_tokens"]
        if not 0 < len(prompt) <= 3904 or any(type(t) is not int or not 0 <= t < 100352 for t in prompt):
            raise ValueError("bounded_original_quality_prompt_required")
        receipts.append({"id": row["id"], "prompt_token_sha256": digest(prompt), "prompt_tokens": len(prompt),
            "input_hash": row["input_hash"], "rubric_hash": digest(row["rubric"])})
    if len({r["id"] for r in receipts}) != len(receipts) or receipts != grant["receipts"] or digest(receipts) != grant["receipts_hash"] or data["rubrics_hash"] != grant["rubrics_hash"]:
        raise ValueError("quality_frozen_input_binding_changed")
    return data


def fixtures(data):
    from transformers import AutoTokenizer
    from evaluation_v2.fresh_cases import CASES
    from worker import compile_prompt, build_generation_input
    tokenizer = AutoTokenizer.from_pretrained(str(MODEL), local_files_only=True)
    result = [{"id": r["id"], "suite": "real_context_only", "prompt_tokens": r["prompt_tokens"],
        "preflight_status": "ready", "preflight_reason": "owner_frozen_production_prompt", "input_hash": r["input_hash"],
        "context_sufficiency": r["rubric"]["context_sufficiency"]} for r in data["cases"]]
    for case in CASES:
        compiled, omitted = compile_prompt(case["request"])
        if omitted:
            raise ValueError("synthetic_context_omitted")
        preflight = json.loads(compiled[-1]["content"])["preflight"]
        rendered = tokenizer.apply_chat_template(build_generation_input(compiled), tokenize=False,
            add_generation_prompt=True, enable_thinking=False)
        prompt = tokenizer.encode(rendered, add_special_tokens=False)
        if not 0 < len(prompt) <= 3904:
            raise ValueError("synthetic_prompt_budget_exceeded")
        result.append({"id": case["id"], "suite": "observed_synthetic_regression", "prompt_tokens": prompt,
            "preflight_status": preflight["status"], "preflight_reason": preflight["reason"],
            "input_hash": digest(case["request"]), "context_sufficiency": "synthetic_rubric"})
    return result


def run_child(out, label, rows):
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    import mlx.core as mx
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_sampler
    mapping = json.loads((out / "private_mapping.json").read_text())
    frozen = json.loads((out / "manifest.json").read_text())
    actual = [{k: v for k, v in r.items() if k != "prompt_tokens"} | {"prompt_tokens": len(r["prompt_tokens"]), "prompt_token_sha256": digest(r["prompt_tokens"])} for r in rows]
    if digest(actual) != frozen["input_receipts_hash"]:
        raise ValueError("paired_inputs_changed")
    cfg = mapping["runs"][label]
    adapter = cfg["adapter"]
    if file_sha(Path(__file__)) != frozen["script_sha256"] or file_sha(MODEL / "model.safetensors") != frozen["base_weight_sha256"]:
        raise ValueError("paired_runtime_or_base_changed")
    if any(file_sha(MODEL / name) != sha for name, sha in frozen["base_file_hashes"].items()) or any(importlib.metadata.version(name) != version for name, version in frozen["library_versions"].items()):
        raise ValueError("paired_model_or_library_binding_changed")
    if adapter and file_sha(Path(adapter) / "adapters.safetensors") != frozen["final_adapter_sha256"]:
        raise ValueError("paired_adapter_changed")
    mx.set_cache_limit(1024 ** 3)
    start = time.perf_counter()
    model, tokenizer = load(str(MODEL), adapter_path=adapter)
    model.eval()
    mx.eval(model.parameters())
    load_seconds = time.perf_counter() - start
    resident = mx.get_active_memory()
    baseline = resource_snapshot()
    def generate(row):
        if row["preflight_status"] != "ready":
            return {k: v for k, v in row.items() if k != "prompt_tokens"} | {"run": label, "model_generated": False, "text": "ABSTAIN"}
        mx.clear_cache()
        mx.reset_peak_memory()
        mx.random.seed(42)
        started = time.perf_counter()
        first = None
        parts = []
        last = None
        for piece in stream_generate(model, tokenizer, prompt=row["prompt_tokens"], max_tokens=192,
                sampler=make_sampler(temp=0.0, top_p=1.0)):
            if first is None:
                first = time.perf_counter() - started
            parts.append(piece.text)
            last = piece
        elapsed = time.perf_counter() - started
        snapshot = resource_snapshot()
        peak = mx.get_peak_memory()
        if snapshot["pressure_level"] != 1 or snapshot["swap_used_bytes"] - baseline["swap_used_bytes"] > 1024 ** 3 or peak > 24 * 1024 ** 3:
            raise RuntimeError("paired_inference_memory_bound_exceeded")
        return {k: v for k, v in row.items() if k != "prompt_tokens"} | {"run": label,
            "prompt_tokens": len(row["prompt_tokens"]), "prompt_token_sha256": digest(row["prompt_tokens"]),
            "model_generated": True, "text": "".join(parts).strip(), "seconds": elapsed,
            "ttft_seconds": first, "generation_tokens": last.generation_tokens, "finish_reason": last.finish_reason,
            "mlx_peak_bytes": peak, "mlx_resident_bytes": resident,
            "rss_high_water_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            "pressure_level": snapshot["pressure_level"], "swap_growth_bytes": snapshot["swap_used_bytes"] - baseline["swap_used_bytes"]}
    # An observed synthetic case warms each fresh process; measurements discard it.
    warmup = generate(next(r for r in rows if r["suite"] == "observed_synthetic_regression" and r["preflight_status"] == "ready"))
    path = out / (label + ".jsonl")
    with path.open("x") as handle:
        path.chmod(0o600)
        for index, row in enumerate(rows, 1):
            result = generate(row)
            handle.write(json.dumps(result, ensure_ascii=False) + "\n")
            handle.flush()
            print(json.dumps({"run": label, "case": index, "suite": row["suite"], "model_generated": result["model_generated"], "seconds": result.get("seconds")}), flush=True)
    private_json(out / (label + "_runtime.json"), {"load_seconds": load_seconds, "warmup_seconds": warmup.get("seconds"),
        "model_resident_bytes": resident, "initial_resources": baseline, "final_resources": resource_snapshot(),
        "rss_high_water_is_process_cumulative": True, "input_receipts_hash": frozen["input_receipts_hash"], "complete": True})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("run", "_child"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--quality-grant", type=Path)
    parser.add_argument("--training-output", type=Path)
    parser.add_argument("--label")
    args = parser.parse_args()
    if args.action == "_child":
        run_child(args.output, args.label, json.load(sys.stdin))
        return
    training = json.loads((args.training_output / "train/receipt.json").read_text())
    plan = json.loads((args.training_output / "training_plan.json").read_text())
    if plan.get("plan_hash") != digest({k: v for k, v in plan.items() if k != "plan_hash"}) or training.get("plan_hash") != plan["plan_hash"] or training.get("dataset_hash") != plan["dataset_hash"]:
        raise ValueError("frozen_training_dataset_binding_changed")
    covered = [json.loads(line)["id"] for line in (args.training_output / "train/coverage.jsonl").read_text().splitlines()]
    if covered != plan["ordered_train_ids"] or len(set(covered)) != plan["final_step"] or training.get("ordered_coverage_hash") != digest(covered):
        raise ValueError("exact_full_epoch_coverage_required")
    if training["status"] != "complete" or training["receipt_hash"] != digest({k: v for k, v in training.items() if k != "receipt_hash"}) or training["trained_examples"] != plan["final_step"] or training["selected_checkpoint"]["step"] != plan["final_step"] or training.get("selection_basis") != "final_full_epoch_all_admitted_train_ids_once":
        raise ValueError("complete_all_data_final_adapter_required")
    adapter = Path(training["selected_checkpoint"]["path"])
    if adapter.name != "final" or file_sha(adapter / "adapters.safetensors") != training["selected_checkpoint"]["adapter_sha256"]:
        raise ValueError("explicit_final_adapter_required")
    grant = json.loads(args.quality_grant.read_text())
    data = read_quality(grant)
    preflight_path = args.quality_grant.parent / "quality-preflight-proof.json"
    preflight = json.loads(preflight_path.read_text())
    if preflight.get("proof_hash") != digest({k: v for k, v in preflight.items() if k != "proof_hash"}) or preflight.get("rubrics_hash") != data["rubrics_hash"] or preflight.get("all_ready") is not True or preflight.get("pipeline_abstain_count") != 0:
        raise ValueError("original_production_preflight_proof_required")
    proof_by_id = {r["id"]: r for r in preflight["rows"]}
    if set(proof_by_id) != {r["id"] for r in data["cases"]} or any(proof_by_id[r["id"]]["input_hash"] != r["input_hash"] or proof_by_id[r["id"]]["prompt_tokens"] != len(r["prompt_tokens"]) or proof_by_id[r["id"]]["preflight_status"] != "ready" for r in data["cases"]):
        raise ValueError("preflight_case_binding_changed")
    sufficiency = [r["rubric"]["context_sufficiency"] for r in data["cases"]]
    if len(sufficiency) != 30 or sufficiency.count("judgeable") != 26 or sufficiency.count("ambiguous") != 4:
        raise ValueError("predeclared_quality_case_counts_changed")
    rows = fixtures(data)
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    labels = ["run_x", "run_y"]
    if secrets.randbits(1):
        labels.reverse()
    mapping = {"runs": {labels[0]: {"adapter": None, "identity": "base_granite"}, labels[1]: {"adapter": str(adapter), "identity": "final_full_epoch_adapter"}}, "withhold_until_all_ratings_frozen": True}
    private_json(args.output / "private_mapping.json", mapping)
    receipts = [{k: v for k, v in r.items() if k != "prompt_tokens"} | {"prompt_tokens": len(r["prompt_tokens"]), "prompt_token_sha256": digest(r["prompt_tokens"])} for r in rows]
    private_json(args.output / "manifest.json", {"schema": "granite-full-epoch-blinded-pair-v1", "settings": {"max_tokens": 192, "temperature": 0.0, "top_p": 1.0, "seed": 42, "enable_thinking": False, "add_special_tokens": False},
        "contract_sha256": file_sha(CONTRACT), "script_sha256": file_sha(Path(__file__)), "restore_helper_sha256": file_sha(HELPER),
        "base_weight_sha256": file_sha(MODEL / "model.safetensors"), "final_adapter_sha256": training["selected_checkpoint"]["adapter_sha256"],
        "base_file_hashes": {p.name: file_sha(p) for p in MODEL.iterdir() if p.is_file() and p.suffix in (".json", ".jinja", ".safetensors")},
        "library_versions": {name: importlib.metadata.version(name) for name in ("mlx", "mlx-lm", "transformers")},
        "worker_sha256": file_sha(ROOT / "worker.py"), "synthetic_cases_sha256": file_sha(ROOT / "evaluation_v2/fresh_cases.py"),
        "training_receipt_hash": training["receipt_hash"], "quality_grant_hash": grant["grant_hash"], "quality_rubrics_hash": data["rubrics_hash"],
        "quality_preflight_proof_hash": preflight["proof_hash"], "quality_preflight_proof_path": str(preflight_path),
        "input_receipts": receipts, "input_receipts_hash": digest(receipts), "historical_targets_absent": True,
        "real_case_count": len(data["cases"]), "observed_synthetic_count": 24, "frozen_at_unix": time.time()})
    sys.path.insert(0, str(HELPER.parent))
    import restore_helper
    import bounded_pilot as lifecycle
    lifecycle.restore_daemon = restore_helper.restore_daemon
    args.pause_daemon = True
    args.inboxd = (Path.home() / ".local/bin/inboxd").resolve()
    args.daemon_lock = Path.home() / ".inboxd/state/inboxd.lock"
    args.daemon_binary = (Path.home() / ".inboxd/product/release/inboxd-daemon").resolve()
    with lifecycle.daemon_pause(args):
        # Fixed visible label order avoids revealing the randomized identity mapping.
        for label in ("run_x", "run_y"):
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_child", "--output", str(args.output), "--label", label], stdin=subprocess.PIPE)
            try:
                child.communicate(json.dumps(rows, ensure_ascii=False).encode())
                if child.returncode:
                    raise RuntimeError("paired_inference_child_failed")
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
    print(json.dumps({"status": "complete", "output": str(args.output), "runs": ["run_x", "run_y"]}), flush=True)


if __name__ == "__main__":
    main()
