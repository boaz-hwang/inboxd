#!/usr/bin/env python3
"""Offline synthetic model comparison through unchanged reply worker.

`generate` explicitly supplies a reply plan and exercises generate→check.
`full-route` first obtains the actual decide plan, then generates only when that
plan permits it. No provider, send, or read-marking API is called.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

HERE = Path(__file__).parent
FIXTURE = HERE / "fixtures/accuracy_model_comparison.json"


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def model_identity(path):
    index = path / "model.safetensors.index.json"
    weights = sorted(path.glob("*.safetensors"))
    return {"config_sha256": sha256(path / "config.json"),
            "index_sha256": sha256(index) if index.is_file() else None,
            "weights": [{"name": item.name, "bytes": item.stat().st_size} for item in weights]}


def load_worker(path):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("inboxd_worker_model_comparison", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request_for(case, model_path):
    context = []
    for i, message in enumerate(case["conversation"]):
        row = dict(message)
        row.setdefault("author_id", "owner" if row["author_role"] == "self" else "counterpart")
        row.setdefault("ts", 1_790_140_000_000 + i * 60_000)
        context.append(row)
    last = context[-1]
    incoming = [last["message_id"]] if last["author_role"] == "other" else []
    return {"id": case["id"], "model_path": str(model_path),
            "context": context, "incoming_message_ids": incoming,
            "chat": {"platform": "kakao"}, "evidence": []}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--mode", choices=("generate", "full-route"), required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--case-ids", help="Comma-separated case IDs; default is all six or full_route_ids")
    args = parser.parse_args()
    worker_path = Path(args.worker).resolve()
    model_path = Path(args.model).resolve()
    fixture = json.loads(FIXTURE.read_text())
    case_ids = (set(args.case_ids.split(",")) if args.case_ids else
                set(fixture["full_route_ids"]) if args.mode == "full-route" else None)
    cases = [case for case in fixture["cases"] if case_ids is None or case["id"] in case_ids]
    module = load_worker(worker_path)
    engine = module.ReplyWorker()
    original_generate = engine.generate_text
    output_path = Path(args.result)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w") as output:
        output.write(json.dumps({"type": "metadata", "mode": args.mode,
                                 "worker_sha256": sha256(worker_path),
                                 "model_identity": model_identity(model_path),
                                 "model_path": str(model_path),
                                 "fixture_sha256": sha256(FIXTURE),
                                 "started_at_unix": time.time()}, ensure_ascii=False) + "\n")
        output.flush()
        for case in cases:
            calls = []

            def counted_generate(messages, **kwargs):
                calls.append("model")
                return original_generate(messages, **kwargs)

            engine.generate_text = counted_generate
            request = request_for(case, model_path)
            started = time.monotonic()
            decision = None
            plan = {"action": "reply"}
            if args.mode == "full-route":
                decision = engine.handle({**request, "op": "decide"})
                plan = decision.get("plan")
            generated = None
            if isinstance(plan, dict) and plan.get("action") in ("reply", "clarify"):
                generated = engine.handle({**request, "op": "generate", "plan": plan})
            steps = generated.get("steps", []) if generated else []
            generation = next((step for step in steps if step.get("node_type") == "generate"), {})
            check = next((step.get("decision") for step in steps if step.get("node_type") == "check"), None)
            row = {"type": "case", "id": case["id"], "criterion": case["criterion"],
                   "decide_status": decision.get("status") if decision else None,
                   "decide_error": decision.get("error") if decision else None,
                   "route_action": plan.get("action") if isinstance(plan, dict) else None,
                   "generate_status": generated.get("status") if generated else None,
                   "generate_error": generated.get("error") if generated else None,
                   "draft": generation.get("outcome", {}).get("text"),
                   "check": check, "model_calls": len(calls),
                   "generate_step_count": sum(s.get("node_type") == "generate" for s in steps),
                   "check_step_count": sum(s.get("node_type") == "check" for s in steps),
                   "duration_ms": round((time.monotonic() - started) * 1000)}
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
            output.flush()
            print(f"{case['id']}: route={row['route_action']} "
                  f"status={row['generate_status']} calls={row['model_calls']} "
                  f"ms={row['duration_ms']}", flush=True)


if __name__ == "__main__":
    main()
