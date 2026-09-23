#!/usr/bin/env python3
"""Offline synthetic checker review against the installed local model.

This is an evaluation tool, not a product entry point. It never sends messages.
Each result is flushed immediately so an interrupted run remains inspectable.
Historic continue_self fixtures exercised the checker with an injected draft. After
latest-self became ineligible in production, those results are checker-only
diagnostics; a production eligibility skip must not be scored as a bad verdict.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

MODEL = Path.home() / ".inboxd/reply-model/models/Qwen3.5-9B-4bit"
VALID_REASONS = {"grounded", "unsupported_commitment", "role_confusion", "unsupported_fact"}


def score_checker_verdict(check, expected):
    """Score only a coherent, well-formed semantic verdict as an answer."""
    check = check if isinstance(check, dict) else {}
    supported = check.get("supported") if type(check.get("supported")) is bool else None
    reason = check.get("reasonCode")
    coherent = (supported is True and reason == "grounded") or (
        supported is False and reason in VALID_REASONS - {"grounded"})
    expected_supported = expected["supported"]
    verdict_correct = coherent and supported is expected_supported
    return {"actual_supported": supported, "actual_reason": reason,
            "valid_reason": reason in VALID_REASONS,
            "coherent_verdict": coherent,
            "verdict_correct": verdict_correct,
            "strict_reason_correct": verdict_correct and reason == expected["reasonCode"]}


def score_case_result(result, check, expected):
    score = score_checker_verdict(check, expected)
    skipped = result.get("status") == "abstained" and result.get("error") == "no_reply_target"
    if skipped:
        score["verdict_correct"] = None
        score["strict_reason_correct"] = None
    score["eligibility_skipped"] = skipped
    return score


def load_module(path, name):
    if str(Path(path).parent) not in sys.path:
        sys.path.insert(0, str(Path(path).parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def model_identity(path):
    index = path / "model.safetensors.index.json"
    weights = sorted(path.glob("*.safetensors"))
    return {"config_sha256": sha256(path / "config.json"),
            "index_sha256": sha256(index) if index.is_file() else None,
            "weights": [{"name": item.name, "bytes": item.stat().st_size} for item in weights]}


def load_cases(paths):
    cases = []
    for path in paths:
        payload = json.loads(Path(path).read_text())
        for case in payload["cases"]:
            cases.append((Path(path).name, case))
    return cases


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", required=True)
    parser.add_argument("--model", default=str(MODEL))
    parser.add_argument("--checker-candidate")
    parser.add_argument("--checker-thinking")
    parser.add_argument("--checker-frame")
    parser.add_argument("--checker-mode")
    parser.add_argument("--check-max-tokens", type=int)
    parser.add_argument("--checker-variant", choices=("new", "reason-first", "explicit-roles"), default="new")
    parser.add_argument("--result", required=True)
    parser.add_argument("--max-cases", type=int)
    parser.add_argument("--case-ids", help="Comma-separated IDs to select in fixture order")
    parser.add_argument("cases", nargs="+")
    args = parser.parse_args()
    worker_path = Path(args.worker).resolve()
    model_path = Path(args.model).resolve()
    sys.path.insert(0, str(worker_path.parent))
    worker_mod = load_module(worker_path, "inboxd_worker_accuracy")
    checker_path = Path(args.checker_candidate).resolve() if args.checker_candidate else None
    checker = load_module(checker_path, "inboxd_checker_accuracy") if checker_path else None
    thinking_path = Path(args.checker_thinking).resolve() if args.checker_thinking else None
    thinking = load_module(thinking_path, "inboxd_checker_thinking_accuracy") if thinking_path else None
    frame_path = Path(args.checker_frame).resolve() if args.checker_frame else None
    frame = load_module(frame_path, "inboxd_checker_frame_accuracy") if frame_path else None
    mode_path = Path(args.checker_mode).resolve() if args.checker_mode else None
    mode = load_module(mode_path, "inboxd_checker_mode_accuracy") if mode_path else None
    engine = worker_mod.ReplyWorker()
    engine.path = model_path
    generate = engine.generate_text
    cases = load_cases(args.cases)
    if args.case_ids:
        selected_ids = set(args.case_ids.split(","))
        cases = [(source, case) for source, case in cases if case["id"] in selected_ids]
    if args.max_cases is not None:
        cases = cases[:args.max_cases]
    result_path = Path(args.result)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    header = {"type": "metadata", "evaluation_scope": "synthetic_injected_draft_checker",
              "latest_self_note": "production no_reply_target skips are unscored; historical continue_self results are checker-only",
              "worker_sha256": sha256(worker_path),
              "candidate_sha256": sha256(checker_path) if checker_path else None,
              "thinking_sha256": sha256(thinking_path) if thinking_path else None,
              "frame_sha256": sha256(frame_path) if frame_path else None,
              "mode_sha256": sha256(mode_path) if mode_path else None,
              "check_max_tokens": args.check_max_tokens,
              "candidate_variant": args.checker_variant if checker_path else None,
              "model_identity": model_identity(model_path),
              "model_path": str(model_path), "case_sources": {str(p): sha256(p) for p in args.cases},
              "started_at_unix": time.time()}
    with result_path.open("w") as output:
        output.write(json.dumps(header, ensure_ascii=False) + "\n")
        output.flush()
        for source, case in cases:
            calls = []
            raw_check = None
            thinking_error = None

            def injected_generate(messages, **kwargs):
                nonlocal raw_check, thinking_error
                calls.append("generate" if len(calls) == 0 else "check")
                if len(calls) == 1:
                    return case["draft"]
                if checker:
                    if args.checker_variant == "reason-first":
                        messages = checker.reason_first_variant(messages)
                    elif args.checker_variant == "explicit-roles":
                        messages = checker.explicit_roles_variant(messages)
                    else:
                        messages = checker.build_checker_prompt(
                            case["conversation"], case.get("evidence", []),
                            case["reply_mode"], case["draft"])
                if frame:
                    messages = frame.frame_first_variant(messages)
                if mode:
                    messages = mode.mode_aware_variant(messages)
                if args.check_max_tokens and (not mode or case["reply_mode"] == "reply_other"):
                    kwargs["max_tokens"] = args.check_max_tokens
                try:
                    raw_check = (thinking.generate_checker_text(engine, messages) if thinking
                                 else generate(messages, **kwargs))
                except Exception as error:
                    thinking_error = ("check_reasoning_truncated" if isinstance(error, ValueError)
                                      and str(error) == "check_reasoning_truncated"
                                      else type(error).__name__)
                    raise
                return raw_check

            engine.generate_text = injected_generate
            request = {"id": case["id"], "model_path": str(model_path),
                       "context": case["conversation"], "incoming_message_ids": [],
                       "evidence": case.get("evidence", []), "plan": {"action": "reply"}}
            started = time.monotonic()
            result = engine.handle(request)
            check = next((step.get("decision") for step in reversed(result.get("steps", []))
                          if step.get("node_type") == "check"), None)
            check = check if isinstance(check, dict) else {}
            expected = case["expected"]
            score = score_case_result(result, check, expected)
            row = {"type": "case", "source": source, "id": case["id"],
                   "expected": expected, "actual_supported": score["actual_supported"],
                   "actual_reason": score["actual_reason"],
                   "actual_explanation": check.get("reason"),
                   "raw_check": None if thinking else raw_check,
                   "worker_status": result["status"], "worker_error": result.get("error"),
                   "thinking_error": thinking_error,
                   "verdict_correct": score["verdict_correct"],
                   "strict_reason_correct": score["strict_reason_correct"],
                   "eligibility_skipped": score["eligibility_skipped"],
                   "valid_reason": score["valid_reason"],
                   "coherent_verdict": score["coherent_verdict"],
                   "model_calls": max(len(calls) - 1, 0), "injected_draft_calls": min(len(calls), 1),
                   "duration_ms": round((time.monotonic() - started) * 1000)}
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
            output.flush()
            print(f"{case['id']}: verdict={score['actual_supported']} "
                  f"reason={score['actual_reason']} correct={row['verdict_correct']} "
                  f"ms={row['duration_ms']}", flush=True)


if __name__ == "__main__":
    main()
