#!/usr/bin/env python3
"""Pair the isolated continue_self change on synthetic owner-authored contexts."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

BASE = Path("/tmp/inboxd-accuracy-baseline/worker.py")
Q = Path(__file__).parent / "evaluation-candidates/worker-q.py"
MODEL = Path.home() / ".inboxd/reply-model/models/Qwen3.5-9B-4bit"
sys.path.insert(0, str(Path(__file__).parent))


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    cases = [
        {"id": "self_confirmed_location", "context": [
            {"message_id": "s1", "author_role": "self", "body": "회의 장소는 서울시청 3층으로 확인했고 안내드렸습니다."}],
         "criterion": "확인·안내한 장소를 또 물어보지 않고, 근거 없는 새 일정·행동도 만들지 않는다."},
        {"id": "self_sent_file", "context": [
            {"message_id": "s1", "author_role": "self", "body": "설계 파일을 공유드립니다."}],
         "criterion": "파일 발신자 관점을 유지하며 수신 확인 요청 또는 자연스러운 후속을 쓴다."},
        {"id": "self_prohibition", "context": [
            {"message_id": "s1", "author_role": "self", "body": "이 파일은 아직 고객에게 보내면 안 됩니다."}],
         "criterion": "명시적 금지를 유지하며 고객에게 보내겠다는 약속을 하지 않는다."},
    ]
    result_path = Path(__file__).parent / "evaluation-results/accuracy-q-continue-self-20260923.jsonl"
    modules = {"baseline": load(BASE, "worker_accuracy_q_base"),
               "q": load(Q, "worker_accuracy_q_candidate")}
    # A single engine instance reuses the loaded local model across both prompt variants.
    engine = modules["baseline"].ReplyWorker()
    engine.path = MODEL
    with result_path.open("w") as output:
        output.write(json.dumps({"type": "metadata", "base_sha256": digest(BASE),
                                 "q_sha256": digest(Q),
                                 "model_config_sha256": digest(MODEL / "config.json"),
                                 "started_at_unix": time.time(),
                                 "note": "forced reply plan; generate+check only"}, ensure_ascii=False) + "\n")
        output.flush()
        for case in cases:
            for variant, module in modules.items():
                request = {"id": case["id"], "model_path": str(MODEL),
                           "context": case["context"], "incoming_message_ids": [],
                           "evidence": [], "plan": {"action": "reply"}}
                calls = []
                actual_generate = engine.generate_text

                def count_calls(messages, **kwargs):
                    calls.append("generate" if not calls else "check")
                    return actual_generate(messages, **kwargs)

                engine.generate_text = count_calls
                start = time.monotonic()
                # Use the candidate compiler and create_reply while preserving model cache.
                compiled, omitted = module.compile_prompt(request)
                result = module.ReplyWorker.create_reply(engine, request, compiled, omitted)
                engine.generate_text = actual_generate
                generation = next((s for s in result.get("steps", []) if s.get("node_type") == "generate"), {})
                check = next((s.get("decision") for s in result.get("steps", []) if s.get("node_type") == "check"), None)
                row = {"type": "case", "id": case["id"], "variant": variant,
                       "criterion": case["criterion"], "draft": generation.get("outcome", {}).get("text"),
                       "status": result.get("status"), "check": check,
                       "generate_calls": calls.count("generate"), "check_calls": calls.count("check"),
                       "duration_ms": round((time.monotonic()-start)*1000)}
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                output.flush()
                print(f"{case['id']}/{variant}: {row['status']} {row['duration_ms']}ms", flush=True)


if __name__ == "__main__":
    main()
