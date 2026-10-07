"""Private RAM-only Granite Q4 LoRA training, separate from production.

Only immutable metadata, losses, coverage receipts and adapters are persisted.
Token sequences and conversation bodies never enter a file or a log.
"""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import random
import re
import resource
import socket
import subprocess
import sys
import time

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
PROTOCOL = {"schema": "granite-q4-lora-full-epoch-v1", "epochs": 1,
    "num_layers": 8, "lora_parameters": {"rank": 8, "scale": 16.0, "dropout": 0.0},
    "batch_size": 1, "learning_rate": 2e-5, "seed": 42,
    "gradient_checkpointing": True, "max_seq_length": 4096,
    "max_answer_tokens": 192, "head_chunk_size": 32,
    "optimizer": "Adam", "optimizer_compile": False,
    "daemon_lifecycle": "existing bounded_pilot.daemon_pause; CPU parent; GPU child exits before readiness restoration",
    "allocator_cache_limit_bytes": 1024 ** 3, "mlx_peak_abort_bytes": 24 * 1024 ** 3,
    "swap_growth_abort_bytes": 1024 ** 3, "required_os_pressure_level": 1,
    "checkpoint_rule": "save mid for diagnostic/recovery and final; full valid token-weighted loss; final full-epoch checkpoint is primary candidate with every admitted train ID seen once",
    "pilot_rule": "three longest admitted train sequences plus synthetic resource-only 4096-total/192-answer shape probe; discarded adapters/optimizer; fresh base and optimizer for full epoch",
    "coverage_rule": "one seeded permutation; every admitted train ID exactly once; no truncation, no synthetic upweighting",
    "loss": "causal actual assistant answer plus EOS only; gathered hidden positions before chunked vocabulary projection",
    "base_model": str(Path.home() / ".inboxd/reply-model/models/Granite-4.2-3B-4bit")}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode()).hexdigest()


def file_sha(path):
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def private_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)


def final_candidate(checkpoints, plan, observed):
    if observed != plan["ordered_train_ids"] or len(set(observed)) != plan["final_step"]:
        raise ValueError("final_full_coverage_checkpoint_required")
    final_checkpoints = [c for c in checkpoints if c["step"] == plan["final_step"]]
    if len(final_checkpoints) != 1:
        raise ValueError("final_full_coverage_checkpoint_required")
    return final_checkpoints[0]


def read_ram(socket_path, grant_hash):
    """Length-prefixed JSON owner RPC; fail closed, never disk-cache response."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(300)
        client.connect(str(socket_path))
        request = json.dumps({"operation": "granite_training_data", "grant_hash": grant_hash}).encode()
        client.sendall(len(request).to_bytes(8, "big") + request)
        def receive(size):
            data = bytearray()
            while len(data) < size:
                chunk = client.recv(min(1024 * 1024, size - len(data)))
                if not chunk:
                    raise ValueError("incomplete_ram_transfer")
                data.extend(chunk)
            return data
        size = int.from_bytes(receive(8), "big")
        if size > 128 * 1024 ** 2:
            raise ValueError("oversized_ram_transfer")
        data = json.loads(receive(size))
    validate_data(data)
    return data


def validate_data(data):
    if data.get("schema") != "granite-training-ram-v1":
        raise ValueError("unsupported_ram_dataset_schema")
    all_ids = set()
    all_token_hashes = set()
    split_hashes = {}
    for name in ("train", "valid", "test"):
        rows = data["splits"][name]
        receipts = []
        for row in rows:
            identity = row["id"]
            prompt, answer = row["prompt_tokens"], row["answer_tokens"]
            if not isinstance(identity, str) or identity in all_ids:
                raise ValueError("duplicate_or_invalid_dataset_identity")
            all_ids.add(identity)
            if not prompt or not answer or len(prompt) + len(answer) > 4096 or len(answer) > 192:
                raise ValueError("invalid_nontruncating_answer_span")
            if any(type(t) is not int or t < 0 or t >= 100352 for t in prompt + answer):
                raise ValueError("invalid_granite_token")
            token_hash = digest({"prompt_tokens": prompt, "answer_tokens": answer})
            if row.get("token_sha256") != token_hash or row.get("prefix_equal") is not True:
                raise ValueError("token_hash_or_prefix_proof_mismatch")
            if answer[-1] != 100257 or token_hash in all_token_hashes:
                raise ValueError("missing_final_eos_or_duplicate_token_sequence")
            all_token_hashes.add(token_hash)
            receipts.append({"id": identity, "token_sha256": token_hash,
                "prompt_tokens": len(prompt), "answer_tokens": len(answer),
                "total_tokens": len(prompt) + len(answer)})
        split_hashes[name] = digest(receipts)
    if not data["splits"]["train"] or not data["splits"]["valid"]:
        raise ValueError("empty_required_training_split")
    if data.get("split_hashes") != split_hashes:
        raise ValueError("dataset_split_receipt_mismatch")
    if data.get("dataset_hash") != digest(split_hashes):
        raise ValueError("dataset_hash_mismatch")
    return split_hashes


def make_plan(data, out):
    validate_data(data)
    ids = [r["id"] for r in data["splits"]["train"]]
    random.Random(PROTOCOL["seed"]).shuffle(ids)
    counts = {s: len(rows) for s, rows in data["splits"].items()}
    plan = {"protocol": PROTOCOL, "dataset_hash": data["dataset_hash"],
        "split_hashes": data["split_hashes"], "split_counts": counts,
        "ordered_train_ids": ids, "mid_step": math.ceil(len(ids) / 2),
        "final_step": len(ids), "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "maximum_actual_train_tokens": max(len(r["prompt_tokens"]) + len(r["answer_tokens"]) for r in data["splits"]["train"]),
        "base_file_hashes": {p.name: file_sha(p) for p in Path(PROTOCOL["base_model"]).iterdir()
            if p.is_file() and p.suffix in (".json", ".jinja", ".safetensors")},
        "library_versions": {n: importlib.metadata.version(n) for n in ("mlx", "mlx-lm", "transformers")},
        "frozen_unix": time.time()}
    plan["plan_hash"] = digest(plan)
    private_json(out / "training_plan.json", plan)
    return plan


def answer_loss(model, batch, prompt_length, chunk_size=32):
    """Batch 1, unpadded. Token index P is predicted by hidden index P-1."""
    import mlx.core as mx
    import mlx.nn as nn
    if model.model_type != "granite" or batch.shape[0] != 1:
        raise ValueError("unsupported_granite_loss_shape")
    if not 0 < prompt_length < batch.shape[1]:
        raise ValueError("invalid_answer_offset")
    hidden = model.model(batch[:, :-1])[:, prompt_length - 1:]
    targets = batch[:, prompt_length:]
    def head(h, y):
        logits = (model.model.embed_tokens.as_linear(h) if model.args.tie_word_embeddings else model.lm_head(h)) / model.logits_scaling
        return nn.losses.cross_entropy(logits, mx.stop_gradient(y)).astype(mx.float32).sum()
    total = mx.array(0.0, dtype=mx.float32)
    for start in range(0, targets.shape[1], chunk_size):
        total = total + mx.checkpoint(head)(hidden[:, start:start + chunk_size], targets[:, start:start + chunk_size])
    return total / targets.size, mx.array(targets.size)


def resource_snapshot():
    raw = subprocess.check_output(["sysctl", "kern.memorystatus_vm_pressure_level", "vm.swapusage"], text=True)
    pressure = int(re.search(r"pressure_level:\s*(\d+)", raw).group(1))
    swap_mb = float(re.search(r"used = ([\d.]+)M", raw).group(1))
    return {"unix": time.time(), "pressure_level": pressure, "swap_used_bytes": int(swap_mb * 1024 ** 2),
            "rss_high_water_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}


def ensure_devices_off():
    android = subprocess.check_output([str(Path.home() / "Library/Android/sdk/platform-tools/adb"), "devices"], text=True)
    ios = subprocess.check_output(["xcrun", "simctl", "list", "devices", "booted"], text=True)
    if re.search(r"^emulator-\d+\s+device", android, re.M) or "(Booted)" in ios:
        raise ValueError("simulator_or_emulator_still_running")


def train(data, out, plan, pilot=False):
    import mlx.core as mx
    import mlx.nn as nn
    import mlx.optimizers as optim
    from mlx.utils import tree_flatten
    from mlx_lm import load
    from mlx_lm.tuner.trainer import grad_checkpoint
    from mlx_lm.tuner.utils import linear_to_lora_layers
    ensure_devices_off()
    validate_data(data)
    if data["dataset_hash"] != plan["dataset_hash"] or plan["protocol"] != PROTOCOL:
        raise ValueError("frozen_training_plan_changed")
    unsealed_plan = {k: v for k, v in plan.items() if k != "plan_hash"}
    expected_ids = {r["id"] for r in data["splits"]["train"]}
    if digest(unsealed_plan) != plan["plan_hash"] or set(plan["ordered_train_ids"]) != expected_ids or len(plan["ordered_train_ids"]) != len(expected_ids):
        raise ValueError("invalid_frozen_epoch_coverage")
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != plan["script_sha256"]:
        raise ValueError("frozen_runtime_source_changed")
    if any(file_sha(Path(PROTOCOL["base_model"]) / name) != expected for name, expected in plan["base_file_hashes"].items()):
        raise ValueError("frozen_base_model_changed")
    if any(importlib.metadata.version(name) != expected for name, expected in plan["library_versions"].items()):
        raise ValueError("frozen_training_library_changed")
    mx.set_cache_limit(PROTOCOL["allocator_cache_limit_bytes"])
    mx.random.seed(PROTOCOL["seed"])
    model, tokenizer = load(PROTOCOL["base_model"])
    if model.model_type != "granite" or len(model.layers) != 40:
        raise ValueError("unexpected_granite_architecture")
    model.freeze()
    linear_to_lora_layers(model, PROTOCOL["num_layers"], PROTOCOL["lora_parameters"])
    grad_checkpoint(model.layers[0])
    optimizer = optim.Adam(learning_rate=PROTOCOL["learning_rate"])
    value_grad = nn.value_and_grad(model, answer_loss)
    mx.eval(model.parameters())
    mx.reset_peak_memory()
    baseline_resources = resource_snapshot()
    if baseline_resources["pressure_level"] != 1:
        raise ValueError("training_requires_normal_memory_pressure")
    trainable = sum(x.size for _, x in tree_flatten(model.trainable_parameters()))
    if any(not name.endswith((".lora_a", ".lora_b")) for name, _ in tree_flatten(model.trainable_parameters())):
        raise ValueError("unexpected_non_adapter_trainable_weight")
    mode = "pilot" if pilot else "train"
    run_dir = out / mode
    run_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    receipt = {"mode": mode, "plan_hash": plan["plan_hash"], "trainable_parameters": trainable,
        "dataset_hash": plan["dataset_hash"], "protocol_hash": digest(plan["protocol"]),
        "script_sha256": plan["script_sha256"], "base_file_hashes": plan["base_file_hashes"],
        "library_versions": plan["library_versions"],
        "initial_resources": baseline_resources, "status": "running", "checkpoints": []}
    private_json(run_dir / "receipt.json", receipt)
    rows_by_id = {r["id"]: r for r in data["splits"]["train"]}
    ordered = ([r["id"] for r in sorted(rows_by_id.values(), key=lambda r: len(r["prompt_tokens"]) + len(r["answer_tokens"]), reverse=True)[:3]] if pilot else plan["ordered_train_ids"])
    if pilot:
        probe = {"id": "synthetic-resource-only-4096-answer192",
                 "prompt_tokens": [17] * 3904, "answer_tokens": [17] * 191 + [100257]}
        probe["token_sha256"] = digest({k: probe[k] for k in ("prompt_tokens", "answer_tokens")})
        rows_by_id[probe["id"]] = probe
        ordered = ordered + [probe["id"]]
    started = time.perf_counter()
    observed = []
    def resources():
        snapshot = resource_snapshot()
        snapshot["mlx_peak_bytes"] = mx.get_peak_memory()
        if snapshot["pressure_level"] != 1 or snapshot["swap_used_bytes"] - baseline_resources["swap_used_bytes"] > PROTOCOL["swap_growth_abort_bytes"] or snapshot["mlx_peak_bytes"] > PROTOCOL["mlx_peak_abort_bytes"]:
            raise RuntimeError("training_memory_bound_exceeded")
        return snapshot
    def validate():
        model.eval()
        loss_sum, token_count = 0.0, 0
        for row in data["splits"]["valid"]:
            batch = mx.array([row["prompt_tokens"] + row["answer_tokens"]])
            value, count = answer_loss(model, batch, len(row["prompt_tokens"]))
            mx.eval(value, count)
            loss_sum += value.item() * count.item()
            token_count += count.item()
            mx.clear_cache()
            resources()
        model.train()
        return {"loss": loss_sum / token_count, "answer_tokens": token_count,
                "examples": len(data["splits"]["valid"])}
    def save(step):
        path = run_dir / ("mid" if step == plan["mid_step"] else "final")
        path.mkdir(mode=0o700)
        private_json(path / "adapter_config.json", {"fine_tune_type": "lora", "num_layers": PROTOCOL["num_layers"], "lora_parameters": PROTOCOL["lora_parameters"]})
        mx.save_safetensors(str(path / "adapters.safetensors"), dict(tree_flatten(model.trainable_parameters())))
        val = validate()
        result = {"step": step, "path": str(path), "validation": val,
                  "adapter_sha256": hashlib.sha256((path / "adapters.safetensors").read_bytes()).hexdigest()}
        receipt["checkpoints"].append(result)
        private_json(run_dir / "receipt.json", receipt)
        print(json.dumps({"status": "checkpoint", "step": step, "valid_loss": val["loss"]}), flush=True)
    with (run_dir / "coverage.jsonl").open("x") as ledger:
        try:
            if not pilot:
                receipt["base_validation"] = validate()
                private_json(run_dir / "receipt.json", receipt)
            for step, identity in enumerate(ordered, 1):
                row = rows_by_id[identity]
                batch = mx.array([row["prompt_tokens"] + row["answer_tokens"]])
                tic = time.perf_counter()
                (loss, ntoks), gradients = value_grad(model, batch, len(row["prompt_tokens"]))
                optimizer.update(model, gradients)
                mx.eval(model.trainable_parameters(), optimizer.state, loss, ntoks)
                loss_value = loss.item()
                if not math.isfinite(loss_value):
                    raise RuntimeError("nonfinite_training_loss")
                observed.append(identity)
                snapshot = resources()
                record = {"step": step, "id": identity, "token_sha256": row["token_sha256"],
                    "synthetic_resource_only": identity == "synthetic-resource-only-4096-answer192",
                    "answer_tokens": ntoks.item(), "total_tokens": batch.shape[1], "loss": loss_value,
                    "seconds": time.perf_counter() - tic, "resources": snapshot}
                ledger.write(json.dumps(record) + "\n")
                ledger.flush()
                mx.clear_cache()
                if pilot or step % 10 == 0 or step == len(ordered):
                    print(json.dumps({"mode": mode, "step": step, "total": len(ordered), "loss": loss_value,
                        "seconds": record["seconds"], "mlx_peak_gb": snapshot["mlx_peak_bytes"] / 1e9,
                        "pressure_level": snapshot["pressure_level"], "swap_growth_bytes": snapshot["swap_used_bytes"] - baseline_resources["swap_used_bytes"]}), flush=True)
                if not pilot and step in (plan["mid_step"], plan["final_step"]):
                    save(step)
            if observed != ordered or len(set(observed)) != len(ordered):
                raise ValueError("training_coverage_mismatch")
            receipt.update(status="complete", trained_examples=len(observed), ordered_coverage_hash=digest(observed),
                seconds=time.perf_counter() - started, final_resources=resources())
            if pilot:
                receipt.update(actual_pilot_examples=len(observed) - 1, synthetic_resource_only_examples=1,
                    pilot_adapters_discarded=True,
                    passed_resource_shape_probe={"total_tokens": 4096, "answer_tokens": 192})
            if not pilot:
                receipt["selected_checkpoint"] = final_candidate(receipt["checkpoints"], plan, observed)
                receipt["selection_basis"] = "final_full_epoch_all_admitted_train_ids_once"
            receipt["receipt_hash"] = digest(receipt)
            private_json(run_dir / "receipt.json", receipt)
        except Exception as exc:
            receipt.update(status="failed", trained_examples=len(observed), error_type=type(exc).__name__,
                error_code=str(exc) if str(exc) in ("training_memory_bound_exceeded", "nonfinite_training_loss", "training_coverage_mismatch") else "training_exception")
            private_json(run_dir / "receipt.json", receipt)
            raise
    print(json.dumps({"status": "complete", "mode": mode, "examples": len(observed), "seconds": receipt["seconds"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("freeze", "pilot", "train", "_child"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--data-socket", type=Path)
    parser.add_argument("--grant-hash")
    parser.add_argument("--child-mode", choices=("pilot", "train"))
    parser.add_argument("--pilot-receipt", type=Path)
    parser.add_argument("--inboxd", type=Path, default=Path.home() / ".local/bin/inboxd")
    parser.add_argument("--daemon-lock", type=Path, default=Path.home() / ".inboxd/state/inboxd.lock")
    parser.add_argument("--daemon-binary", type=Path, default=Path.home() / ".inboxd/product/release/inboxd-daemon")
    args = parser.parse_args()
    if args.action == "_child":
        if args.child_mode is None:
            parser.error("_child requires --child-mode")
        data = json.load(sys.stdin)
        validate_data(data)
    else:
        if args.data_socket is None or args.grant_hash is None:
            parser.error("owner actions require --data-socket and --grant-hash")
        data = read_ram(args.data_socket, args.grant_hash)
    if args.action == "freeze":
        plan = make_plan(data, args.output)
        print(json.dumps({"status": "frozen", "plan_hash": plan["plan_hash"], "split_counts": plan["split_counts"], "max_train_tokens": plan["maximum_actual_train_tokens"]}), flush=True)
    else:
        plan = json.loads((args.output / "training_plan.json").read_text())
        mode = args.child_mode if args.action == "_child" else args.action
        if mode == "train":
            pilot_path = args.pilot_receipt or args.output / "pilot/receipt.json"
            pilot = json.loads(pilot_path.read_text())
            if pilot.get("receipt_hash") != digest({k: v for k, v in pilot.items() if k != "receipt_hash"}) or pilot["status"] != "complete" or pilot.get("mode") != "pilot":
                raise ValueError("completed_sealed_memory_pilot_required")
            if pilot.get("protocol_hash") != digest(plan["protocol"]) or any(pilot.get(k) != plan[k] for k in ("script_sha256", "base_file_hashes", "library_versions")):
                raise ValueError("memory_pilot_training_graph_or_model_changed")
            if pilot.get("passed_resource_shape_probe") != {"total_tokens": 4096, "answer_tokens": 192} or pilot.get("pilot_adapters_discarded") is not True:
                raise ValueError("memory_pilot_does_not_bound_full_training_shapes")
            if args.action != "_child":
                private_json(args.output / "memory-pilot-binding.json", {
                    "full_training_plan_hash": plan["plan_hash"], "full_dataset_hash": plan["dataset_hash"],
                    "pilot_plan_hash": pilot["plan_hash"], "pilot_dataset_hash": pilot["dataset_hash"],
                    "pilot_receipt_hash": pilot["receipt_hash"], "pilot_receipt_path": str(pilot_path),
                    "same_dataset": pilot["dataset_hash"] == plan["dataset_hash"],
                    "resource_only_shape_compatibility": True, "pilot_adapters_and_optimizer_reused": False})
        if args.action == "_child":
            train(data, args.output, plan, pilot=mode == "pilot")
        else:
            # Resolve all owner data before quiescing. The GPU child exits before
            # the verified original lifecycle restores daemon readiness.
            import bounded_pilot as lifecycle
            args.pause_daemon = True
            args.inboxd = args.inboxd.resolve()
            args.daemon_binary = args.daemon_binary.resolve()
            args.daemon_lock = args.daemon_lock.absolute()
            with lifecycle.daemon_pause(args):
                child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_child",
                    "--output", str(args.output), "--child-mode", mode]
                    + (["--pilot-receipt", str(pilot_path)] if mode == "train" else []), stdin=subprocess.PIPE)
                try:
                    child.communicate(json.dumps(data, ensure_ascii=False).encode())
                    if child.returncode:
                        raise RuntimeError("granite_training_child_failed")
                finally:
                    if child.poll() is None:
                        child.terminate()
                        try:
                            child.wait(timeout=20)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait()
