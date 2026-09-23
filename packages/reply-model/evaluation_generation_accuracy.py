#!/usr/bin/env python3
"""Compare synthetic reply drafts with the same offline model and checker."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

HERE = Path(__file__).parent
BASELINE = Path("/tmp/inboxd-accuracy-baseline/worker.py")
MODEL = Path.home() / ".inboxd/reply-model/models/Qwen3.5-9B-4bit"
sys.path.insert(0, str(BASELINE.parent))


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    worker = load(BASELINE, "worker_baseline_generation_eval")
    candidate = load(HERE / "generation_prompt.py", "generation_prompt_accuracy")
    engine = worker.ReplyWorker()
    real_generate = engine.generate_text
    fixture = HERE / "fixtures/reply_cases.json"
    cases = json.loads(fixture.read_text())
    chosen = {"thanks", "unknown_schedule", "known_schedule", "approved_terms",
              "decline_style", "negation", "question_to_other", "no_pretend_action",
              "two_requests", "fact_retrieval"}
    custom = [
        {"id": "self_confirmed_no_redundant_question", "context": [["self", "방문 날짜는 10월 8일로 확정됐습니다. 안내문도 전달했습니다."]],
         "criterion": "이미 확정·전달한 일을 다시 묻지 않는 자연스러운 후속."},
        {"id": "direct_request_not_group", "context": [["other", "경찬님, 수업 피드백을 오늘 공유해 주실 수 있나요?"]],
         "criterion": "1:1 직접 요청의 대상은 self; 상대에게 피드백을 달라고 역할을 뒤집지 않음."},
        {"id": "group_other_directed", "context": [["other", "@민수 내일 자료 보낼 수 있나요? 경찬님 답변은 필요 없습니다."]],
         "criterion": "self에게 답변을 요구하지 않는 그룹 맥락; 임의 답장 생성 금지."},
        {"id": "bare_url_unknown", "context": [["other", "여기 위치 맞지요? https://example.com/place"]],
         "criterion": "링크 목적지 위치를 실제로 확인한 것처럼 확정 금지."},
    ]
    selected = [case for case in cases if case["id"] in chosen] + custom
    result_path = HERE / "evaluation-results/accuracy-generation-20260923.jsonl"
    with result_path.open("w") as output:
        metadata = {"type": "metadata", "worker_sha256": digest(BASELINE),
                    "candidate_sha256": digest(HERE / "generation_prompt.py"),
                    "model_config_sha256": digest(MODEL / "config.json"),
                    "fixture_sha256": digest(fixture), "started_at_unix": time.time(),
                    "note": "forced reply plan: generation and baseline grounding only, no decide"}
        output.write(json.dumps(metadata, ensure_ascii=False) + "\n")
        output.flush()
        for case in selected:
            context = [{"message_id": str(i), "author_role": role, "body": body}
                       for i, (role, body) in enumerate(case["context"])]
            evidence = [{"content": case["evidence"]}] if case.get("evidence") else []
            request = {"id": case["id"], "model_path": str(MODEL), "context": context,
                       "incoming_message_ids": [], "evidence": evidence,
                       "plan": {"action": "reply"}}
            for variant in ("baseline", "candidate"):
                calls = []
                compiled, _ = worker.compile_prompt(request)
                payload = json.loads(compiled[-1]["content"])
                payload.update(evidence=evidence, response_strategy={"action": "reply"})
                candidate_input = candidate.build_generation_input(compiled, payload, "reply")

                def injected(messages, **kwargs):
                    calls.append("generate" if not calls else "check")
                    return real_generate(candidate_input if variant == "candidate" and len(calls) == 1
                                         else messages, **kwargs)

                engine.generate_text = injected
                started = time.monotonic()
                result = engine.handle(request)
                generation = next((s for s in result.get("steps", []) if s.get("node_type") == "generate"), {})
                check = next((s.get("decision") for s in result.get("steps", []) if s.get("node_type") == "check"), None)
                row = {"type": "case", "id": case["id"], "variant": variant,
                       "criterion": case["criterion"], "draft": generation.get("outcome", {}).get("text"),
                       "status": result["status"], "error": result.get("error"), "check": check,
                       "generate_calls": calls.count("generate"), "check_calls": calls.count("check"),
                       "duration_ms": round((time.monotonic()-started)*1000)}
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                output.flush()
                print(f"{case['id']}/{variant}: status={row['status']} calls={len(calls)} "
                      f"ms={row['duration_ms']}", flush=True)


if __name__ == "__main__":
    main()
