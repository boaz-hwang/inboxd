"""Local personal adapter lifecycle; no automatic training or activation.

Input records are explicitly reviewed examples, not inferred reply pairs.
Dataset staging is temporary and private; canonical observations stay in storage.
"""
import argparse
import copy
import math
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

VERSION = "personal-data-v1"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def local_model(path):
    path = Path(path)
    if not path.is_absolute() or not (path / "config.json").is_file():
        raise ValueError("absolute_local_model_required")
    return path.resolve()


def model_identity(path):
    path = local_model(path)
    # Include weights, not only config. Cached callers can reuse the result.
    files = sorted(path.glob("*.safetensors")) + [path / "config.json"]
    if len(files) < 2:
        raise ValueError("model_weights_missing")
    h = hashlib.sha256()
    for file in files:
        h.update(file.name.encode())
        with file.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
    return h.hexdigest()


def prepare_examples(records):
    """Strict eligibility, chronology, and duplicate-group split isolation.

    record: id, conversation_id, timestamp, reviewed, linkage, target_role,
    target_message_id, context_message_ids, context_timestamps, messages,
    provenance_refs. Optional duplicate_group groups paraphrased duplicates.
    """
    accepted, rejected, seen_ids = [], [], set()
    for source in records:
        r = copy.deepcopy(source)
        reason = None
        try:
            if not isinstance(r, dict):
                raise ValueError("invalid_record")
            if not r.get("reviewed") is True or r.get("target_role") != "self":
                raise ValueError("unreviewed_or_not_self")
            if r.get("linkage") not in ("explicit_reply", "reviewed_turn"):
                raise ValueError("unreliable_linkage")
            if not all(isinstance(r.get(k), str) and r[k] for k in ("id", "conversation_id", "target_message_id")):
                raise ValueError("missing_identity")
            if r["id"] in seen_ids:
                raise ValueError("duplicate_id")
            ts = r["timestamp"]
            times = r["context_timestamps"]
            ids = r["context_message_ids"]
            if type(ts) not in (int, float) or not math.isfinite(ts) or not times or len(times) != len(ids):
                raise ValueError("invalid_timestamps")
            if any(type(t) not in (int, float) or not math.isfinite(t) or not t < ts for t in times):
                raise ValueError("future_context")
            if r["target_message_id"] in ids or not r.get("provenance_refs"):
                raise ValueError("missing_or_leaking_provenance")
            messages = r["messages"]
            if not isinstance(messages, list) or len(messages) < 2:
                raise ValueError("invalid_messages")
            if any(m.get("role") not in ("system", "user", "assistant") or not isinstance(m.get("content"), str) or not m["content"].strip() for m in messages):
                raise ValueError("invalid_messages")
            if messages[-1]["role"] != "assistant" or messages[-2]["role"] != "user":
                raise ValueError("invalid_target")
            seen_ids.add(r["id"])
            accepted.append(r)
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            reason = str(exc) if isinstance(exc, ValueError) else "invalid_record"
        if reason:
            rejected.append({"id": r.get("id") if isinstance(r, dict) else None, "reason": reason})
    accepted.sort(key=lambda r: (r["timestamp"], r["id"]))
    # Time first. Drop groups straddling partitions, rather than leak a later
    # target into train or force future records into an earlier partition.
    n = len(accepted)
    cut1, cut2 = int(n * .7), int(n * .85)
    named = [(r, "train" if i < cut1 else "valid" if i < cut2 else "test") for i, r in enumerate(accepted)]
    groups = {}
    for r, split in named:
        keys = ("chat:" + r["conversation_id"], "text:" + digest(r["messages"]), "target:" + digest(r["messages"][-1]["content"].strip()))
        if r.get("duplicate_group"):
            keys += ("duplicate:" + str(r["duplicate_group"]),)
        rkeys = list(keys)
        for key in rkeys:
            groups.setdefault(key, set()).add(split)
        r["_split_keys"] = rkeys
    splits = {name: [] for name in ("train", "valid", "test")}
    for r, split in named:
        if any(len(groups[k]) > 1 for k in r.pop("_split_keys")):
            rejected.append({"id": r["id"], "reason": "cross_split_group"})
        else:
            splits[split].append(r)
    manifest = {"version": VERSION, "splits": {k: [{"id": r["id"], "example_hash": digest(r), "provenance_refs": r["provenance_refs"]} for r in v] for k, v in splits.items()}, "rejected": rejected}
    manifest["dataset_id"] = digest(manifest)
    return splits, manifest


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def run_local(records, model, output, *, iters=100, evaluate=False, adapter=None):
    model = local_model(model)
    splits, manifest = prepare_examples(records)
    if any(not splits[k] for k in ("train", "valid", "test")):
        raise ValueError("insufficient_disjoint_data")
    if not 1 <= iters <= 100000:
        raise ValueError("invalid_iterations")
    identity = model_identity(model)
    if adapter:
        adapter = Path(adapter)
        if not adapter.is_absolute():
            raise ValueError("absolute_local_adapter_required")
        metadata = json.loads((adapter / "manifest.json").read_text())
        if metadata.get("base_model_id") != identity or metadata.get("status") != "complete":
            raise ValueError("adapter_base_or_status_mismatch")
    output = Path(output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    manifest.update(base_model_id=identity, mode="evaluate" if evaluate else "train")
    private_json(output / "manifest.json", manifest)
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")}
    env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", DO_NOT_TRACK="1")
    with tempfile.TemporaryDirectory(prefix="inboxd-training-") as directory:
        os.chmod(directory, 0o700)
        for name, examples in splits.items():
            file = Path(directory) / f"{name}.jsonl"
            with file.open("w") as stream:
                os.chmod(file, 0o600)
                for record in examples:
                    stream.write(json.dumps({"messages": record["messages"]}, ensure_ascii=False) + "\n")
        config = dict(model=str(model), data=directory, train=not evaluate, test=evaluate,
                      adapter_path=str(Path(adapter).resolve()) if adapter else ("" if evaluate else str(output)),
                      fine_tune_type="lora", mask_prompt=True, batch_size=1, num_layers=4,
                      iters=iters, val_batches=-1, test_batches=-1, max_seq_length=2048,
                      steps_per_eval=min(25, iters), steps_per_report=10, save_every=iters,
                      grad_checkpoint=True, seed=0, report_to=None)
        private_json(Path(directory) / "config.json", config)
        with (output / "runtime.log").open("w") as log:
            os.chmod(output / "runtime.log", 0o600)
            result = subprocess.run([sys.executable, "-m", "mlx_lm.lora", "--config", str(Path(directory) / "config.json")], env=env, stdout=log, stderr=subprocess.STDOUT)
        manifest["status"] = "complete" if result.returncode == 0 else "failed"
        private_json(output / "manifest.json", manifest)
        if result.returncode:
            raise ValueError("local_training_or_evaluation_failed")
    return manifest


def activate(registry, adapter, base_model_id, *, reviewed=False):
    if not reviewed:
        raise ValueError("evaluation_review_required")
    adapter = Path(adapter).resolve()
    manifest = json.loads((adapter / "manifest.json").read_text())
    if manifest.get("status") != "complete" or manifest.get("mode") != "train" or manifest.get("base_model_id") != base_model_id:
        raise ValueError("adapter_base_or_status_mismatch")
    if not (adapter / "adapters.safetensors").is_file() or not (adapter / "adapter_config.json").is_file():
        raise ValueError("adapter_artifact_missing")
    registry = Path(registry)
    old = json.loads(registry.read_text()) if registry.exists() else {"active": None}
    active = {"path": str(adapter), "base_model_id": base_model_id, "dataset_id": manifest["dataset_id"],
              "adapter_version": hashlib.sha256((adapter / "adapters.safetensors").read_bytes()).hexdigest()}
    private_json(registry, {"active": active, "previous": old.get("active")})
    return active


def rollback(registry):
    registry = Path(registry)
    old = json.loads(registry.read_text())
    private_json(registry, {"active": old.get("previous"), "previous": old.get("active")})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("inspect", "train", "evaluate", "activate", "rollback"))
    parser.add_argument("--examples", type=Path)
    parser.add_argument("--model")
    parser.add_argument("--output")
    parser.add_argument("--adapter")
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--reviewed", action="store_true")
    parser.add_argument("--iters", type=int, default=100)
    args = parser.parse_args()
    if args.command == "rollback":
        rollback(args.registry)
    elif args.command == "activate":
        print(json.dumps(activate(args.registry, args.adapter, model_identity(args.model), reviewed=args.reviewed)))
    else:
        records = [json.loads(line) for line in args.examples.read_text().splitlines() if line.strip()]
        if args.command == "inspect":
            _, manifest = prepare_examples(records)
            print(json.dumps({"dataset_id": manifest["dataset_id"], "counts": {k: len(v) for k,v in manifest["splits"].items()}, "rejected_count": len(manifest["rejected"])}))
        else:
            run_local(records, args.model, args.output, iters=args.iters, evaluate=args.command == "evaluate", adapter=args.adapter)


if __name__ == "__main__":
    main()
