"""Read-only, replayable reply-behavior diagnostics. No model weights or training.

Recovery uses the authenticated running daemon and the original frozen source
manifest. Bodies and token arrays remain in process memory. Output is metadata
only. Rules are *not* human or new agent semantic judgments.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import sys
import tempfile
import time
import unicodedata

TAXONOMY = {
    "question_or_request": "Broad question or request; missing-information clarification subtype is not established.",
    "direct_answer_information": "Answer a question or supply descriptive information.",
    "clarification_request": "Ask for missing information, explanation, confirmation or material.",
    "acceptance": "Accept a proposal, permission request or requested action.",
    "refusal": "Decline a proposal, request or action.",
    "boundary_preservation": "Preserve an existing decision, limit, scope or conditionality.",
    "coordination": "Arrange or report timing, location, contact, delivery or follow-up.",
    "opinion_help": "Offer advice, evaluation, encouragement, empathy or assistance.",
    "acknowledgement_thanks_greeting": "Receipt, thanks, greeting, agreement or social backchannel.",
    "other_uncertain": "Not resolved by the stated evidence and deterministic rules.",
}

# These are audit cues, not an exhaustive linguistic classifier. All matched
# cue names and original prior-review categories are retained on each row.
CUES = {
    "refusal": r"(안\s*(?:될|되겠|됩니다|할|하겠|하겠습니다)|못\s*(?:할|하겠|갑|가겠|참석)|불가능|어렵겠|어려울|거절|사양|하지\s*않|안\s*가요|안\s*해요|안\s*합니다)",
    "boundary_preservation": r"(까지만|만\s*가능|조건|기존(?:대로|에)|원래(?:대로|의)|그대로|변경\s*없이|확정.*(?:아니|안)|아직.*(?:미정|모르|안)|무리하지|강요|범위|동의.*(?:안|않))",
    "coordination": r"(일정|몇\s*시|언제|내일|오늘|다음\s*주|이번\s*주|월요일|화요일|수요일|목요일|금요일|토요일|일요일|오전|오후|미팅|회의|만나|만날|뵙|장소|어디서|도착|출발|연락|전화|통화|보내(?:드|겠)|전달|공유|예약|확인해|검토해|살펴보)",
    "clarification_request": r"([?？]|(?:인가|한가|될까|할까|있나|맞나|어떻|언제|어디|누가|무엇|뭔|몇|얼마|어떤|왜|어떻게)|(?:알려|설명|다시\s*보내|보여|확인)\s*(?:주|해주|부탁))",
    "acceptance": r"(좋(?:아요|습니다|네요|죠)|가능(?:해|합)|동의|찬성|괜찮(?:아|습)|(?:하겠|할게|하겠습니다|해볼게)|네[!~ .ㅋㅎ]*$|넵[!~ .ㅋㅎ]*$|예[!~ .]*$|오케이|알겠)",
    "opinion_help": r"(추천|제안|생각(?:해|합|이|하)|(?:같아요|같습니다)|(?:하면|하시면).*(?:좋|될|됩)|도움|응원|힘내|고생|수고|축하|기도|걱정|조심|행복|잘\s*되|잘\s*되시|화이팅|파이팅)",
    "acknowledgement_thanks_greeting": r"(감사|고마|안녕|반갑|잘\s*부탁|확인(?:했|하였|했습니다)|알겠|네[!~ .ㅋㅎ]*$|넵[!~ .ㅋㅎ]*$|예[!~ .]*$|ㅎㅎ|ㅋㅋ|하하|굿|좋(?:아요|습니다|네요)|수고|고생|축하)",
}
PATTERNS = {k: re.compile(v, re.I | re.S) for k, v in CUES.items()}
PRIOR_MAP = {
    "acknowledgement/greeting": "acknowledgement_thanks_greeting",
    "acknowledgement_greeting": "acknowledgement_thanks_greeting",
    "clarification/question": "clarification_request",
    "clarification_question": "clarification_request",
    "grounded_information": "direct_answer_information",
    "future_action_intent": "coordination",
    # An existing decision may be affirmative or negative. Keep the distinction
    # unresolved unless explicit target cues discriminate refusal.
    "existing_decision_or_refusal": "boundary_preservation",
}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def write_private(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        raise ValueError("new_artifact_must_not_overwrite")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def prior_label(category):
    if category in PRIOR_MAP:
        return PRIOR_MAP[category], "exact_prior_category_crosswalk"
    value = category.lower().replace("/", "_")
    if any(word in value for word in ("refus", "boundary", "scope_preservation", "assessment_preservation", "instruction_reconfirmation", "instruction_reiteration")):
        return "boundary_preservation", "prior_category_name_rule"
    if any(word in value for word in ("clarification", "question", "request", "follow_up")):
        return "clarification_request", "prior_category_name_rule"
    if any(word in value for word in ("answering", "information", "explanation", "instruction", "existing_contact_time")):
        return "direct_answer_information", "prior_category_name_rule"
    if any(word in value for word in ("schedule", "meeting", "followup", "follow_up", "arrival", "check_intent", "contact", "negotiation")):
        return "coordination", "prior_category_name_rule"
    if any(word in value for word in ("support", "empathy", "encourage", "guidance", "suggestion", "caution", "evaluation", "prayer", "faith", "concern")):
        return "opinion_help", "prior_category_name_rule"
    if any(word in value for word in ("approval", "permission", "agreement", "confirmation")):
        return "acceptance", "prior_category_name_rule"
    if any(word in value for word in ("acknowledg", "thank", "greeting", "reaction", "laughter", "farewell", "banter", "backchannel", "appreciation", "affection", "wordplay", "social", "goodwish", "reciprocity")):
        return "acknowledgement_thanks_greeting", "prior_category_name_rule"
    return "other_uncertain", "unresolved_prior_category"


def classify(record, metadata):
    target = "\n".join(t["body"] for t in record["targets"])
    recent_other = "\n".join(m.get("body", "") for m in record["context"][-10:]
                             if m.get("author_role") != "self")
    category = metadata["semantic_decision"].get("behavior_category", "unknown")
    baseline, method = prior_label(category)
    hits = [k for k, pattern in PATTERNS.items() if pattern.search(target)]
    labels = set(hits)
    if baseline != "other_uncertain":
        labels.add(baseline)
    # Priority resolves one primary label; it is explicitly a deterministic
    # convention, not a claim that every cue represents the dominant speech act.
    if "refusal" in labels:
        primary = "refusal"
    elif "boundary_preservation" in labels:
        primary = "boundary_preservation"
    elif baseline == "clarification_request" or "clarification_request" in labels:
        primary = "clarification_request"
    elif baseline == "direct_answer_information":
        primary = baseline
    elif "coordination" in hits or baseline == "coordination":
        primary = "coordination"
    elif baseline == "opinion_help" or "opinion_help" in labels:
        primary = "opinion_help"
    elif "acceptance" in labels and (baseline == "acceptance" or re.search(r"[?？]|(?:가능|괜찮|해\s*주|부탁|할까|할까요)", recent_other)):
        primary = "acceptance"
    elif baseline == "acknowledgement_thanks_greeting" or "acknowledgement_thanks_greeting" in labels:
        primary = "acknowledgement_thanks_greeting"
    else:
        primary = "other_uncertain"
    labels.add(primary)
    ambiguities = []
    if baseline == "boundary_preservation":
        ambiguities.append("prior_combines_existing_decision_and_refusal")
    if baseline == "coordination" and "coordination" not in hits:
        ambiguities.append("prior_future_intent_is_broader_than_coordination")
    if baseline == "other_uncertain":
        ambiguities.append("prior_category_does_not_resolve_behavior")
    if "refusal" in hits and "acceptance" in hits:
        ambiguities.append("positive_and_negative_cues_require_semantic_review")
    if baseline == "acknowledgement_thanks_greeting" and primary != baseline:
        ambiguities.append("rule_refines_prior_social_category")
    return {"primary": primary, "labels": sorted(labels), "matched_cue_names": hits,
            "prior_behavior_category": category, "prior_crosswalk_label": baseline,
            "prior_crosswalk_method": method, "ambiguity_codes": ambiguities,
            "classification_provenance": "deterministic_context_target_rules_and_prior_agent_category_recode",
            "new_semantic_judgment": False}


def normalized(text):
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def repeat_inventory(records):
    exact, norm, episodes = defaultdict(list), defaultdict(list), defaultdict(list)
    for identity, record in records.items():
        target = "\n".join(t["body"] for t in record["targets"])
        exact[digest(target)].append(identity)
        norm[digest(normalized(target))].append(identity)
        episodes[digest(record["messages"])].append(identity)
    def groups(mapping):
        rows = [{"sha256": k, "ids": v, "size": len(v)} for k, v in mapping.items() if len(v) > 1]
        return {"group_count": len(rows), "participating_examples": sum(r["size"] for r in rows),
                "redundant_examples_after_one_per_group": sum(r["size"] - 1 for r in rows),
                "pair_count": sum(r["size"] * (r["size"] - 1) // 2 for r in rows), "groups": rows}
    return {"exact_target_text": groups(exact), "normalized_target_text": groups(norm),
            "exact_compiled_episode": groups(episodes),
            "semantic_paraphrase_repetition": {"measured": False,
                "reason": "Lexical identity and shared speech-act labels do not establish semantic paraphrase equivalence."}}


def audit(records, metadata, output):
    rows = []
    for identity in sorted(records):
        m = metadata[identity]
        rows.append({"id": identity, "review_hash": records[identity]["review_hash"],
                     "input_hash": m["input_hash"], "target_hash": m["target_hash"],
                     "completion_tokens_with_eos": m["granite_answer_tokens"],
                     "prompt_tokens": m["granite_prompt_tokens"], **classify(records[identity], m)})
    counts = Counter(r["primary"] for r in rows)
    label_counts = Counter(label for r in rows for label in r["labels"])
    token_counts = Counter()
    for row in rows:
        token_counts[row["primary"]] += row["completion_tokens_with_eos"]
    packet = {"schema": "reply-behavior-inventory-v1", "taxonomy": TAXONOMY,
              "method": "Prior delegated agent reviews are evidence; this recoding is deterministic, rule-assisted, and not a new semantic or human review.",
              "rules": CUES, "prior_exact_crosswalk": PRIOR_MAP,
              "scope": "All approved train examples from the sealed Granite fullpool; originals unchanged.",
              "examples": rows, "primary_counts": {k: counts[k] for k in TAXONOMY},
              "multilabel_counts": {k: label_counts[k] for k in TAXONOMY},
              "primary_completion_token_counts": {k: token_counts[k] for k in TAXONOMY},
              "example_count": len(rows), "unique_id_count": len({r["id"] for r in rows}),
              "completion_tokens_with_eos": sum(r["completion_tokens_with_eos"] for r in rows),
              "prompt_tokens": sum(r["prompt_tokens"] for r in rows),
              "prior_category_counts": dict(Counter(r["prior_behavior_category"] for r in rows)),
              "ambiguity_counts": dict(Counter(code for r in rows for code in r["ambiguity_codes"])),
              "examples_with_ambiguity": sum(bool(r["ambiguity_codes"]) for r in rows),
              "exact_review_hash_bound": True, "bodies_persisted": 0, "token_arrays_persisted": 0,
              "quality_threshold_or_promotion_decision": None,
              "limitations": ["Cue matching can misread negation, questions and mixed speech acts.",
                  "Prior categories were chosen for admission, not this taxonomy; broad future intent and combined decision/refusal remain ambiguous.",
                  "No new per-example semantic review or human judgment was performed.",
                  "Counts describe historical approved targets; demand-side usefulness or independent model quality does not follow."]}
    if len(rows) != 1374 or packet["completion_tokens_with_eos"] != 33300 or packet["prompt_tokens"] != 3575030:
        raise ValueError("sealed_training_inventory_or_token_sum_changed")
    packet["inventory_hash"] = digest(packet)
    write_private(output / "behavior-inventory.json", packet)
    repeat = repeat_inventory(records)
    repeat["behavior_family_repetition"] = {"primary_counts": dict(counts),
        "semantic_equivalence_claimed": False,
        "interpretation": "Repeated behavior labels are speech-act concentration, not duplicate episodes or equivalent intent."}
    write_private(output / "repetition-audit.json", repeat)
    return {k: v for k, v in packet.items() if k not in ("examples", "rules", "prior_exact_crosswalk", "taxonomy")}


def recover(sealed, output, *, include_tokens=True):
    import history as h
    import history_snapshot as hs
    from kakao_local_import import OwnerRpc
    from transformers import AutoTokenizer
    coverage = read(sealed / "final-fullpool-coverage.json")
    if coverage["coverage_hash"] != digest({k: v for k, v in coverage.items() if k != "coverage_hash"}):
        raise ValueError("coverage_seal_changed")
    metadata = {r["id"]: r for r in coverage["entries"]}
    snapshot = read(sealed.parent / "expansion-20261003/dataset-snapshot.json")
    rooms = {r["chat"] for r in metadata.values()}
    expected = {r["id"]: r for r in snapshot["source"]["rows"] if room_key(r["id"]) in rooms}
    proofs, raw = [], {}
    with_rpc = OwnerRpc(timeout=90)
    try:
        for ordinal, scope in enumerate(sorted(rooms), 1):
            platform, account, chat_id, _ = json.loads(scope)
            rows, omitted = h.collect(hs.OwnerHistoryQuery(with_rpc), platform=platform, account=account, chat_id=chat_id)
            seen, changed, unknown, deferred = set(), [], [], 0
            for row in rows:
                if row["timestamp"] > snapshot["source"]["watermark_ts"]:
                    deferred += 1
                    continue
                if row["id"] not in expected:
                    unknown.append(row["id"])
                    continue
                seen.add(row["id"])
                if hs.source_manifest([row], [])["rows"][0] != expected[row["id"]]:
                    changed.append(row["id"])
                else:
                    raw[row["id"]] = row
            wanted = {i for i in expected if room_key(i) == scope}
            original_omitted = [m for m in snapshot["source"]["omitted"] if m.get("id", "").startswith("hist:") and room_key(m["id"]) == scope]
            proof = {"room": scope, "expected": len(wanted), "exact": len(wanted) - len(changed) - len(wanted - seen),
                     "missing_ids": sorted(wanted - seen), "changed_ids": changed,
                     "unexpected_pre_watermark_ids": unknown, "omitted_exact": hs.source_manifest([], omitted)["omitted"] == original_omitted,
                     "post_watermark_deferred": deferred}
            proofs.append(proof)
            if ordinal % 20 == 0 or ordinal == len(rooms):
                print(json.dumps({"phase": "recovering", "rooms_done": ordinal, "rooms_total": len(rooms), "exact_raw_records": len(raw)}), flush=True)
    finally:
        with_rpc.close()
    if any(p["missing_ids"] or p["changed_ids"] or p["unexpected_pre_watermark_ids"] or not p["omitted_exact"] for p in proofs):
        write_private(output / "recovery-failure.json", {"room_proofs": proofs, "bodies_persisted": 0})
        raise ValueError("frozen_source_recovery_inexact")
    grouped, _ = h.group_turns(list(raw.values()), snapshot["gap_policy_seconds"])
    raw.clear()
    train_ids = {i for i, m in metadata.items() if m["disposition"] == "approve" and m["split"] == "train"}
    quality_ids = {i for i, m in metadata.items() if m["split"] in ("test", "valid") and m.get("quality_context_eligible") and not m.get("sensitive_source_keys") and not m.get("boundary_reasons")}
    wanted_ids = train_ids | quality_ids
    tokenizer = AutoTokenizer.from_pretrained(str(Path.home() / ".inboxd/reply-model/models/Qwen3.5-9B-4bit"), local_files_only=True)
    granite = AutoTokenizer.from_pretrained(str(Path.home() / ".inboxd/reply-model/cleanup/experiment-models-20261006/records/Granite-4.2-3B-4bit"), local_files_only=True) if include_tokens else None
    recovered, tokens = {}, {}
    for row in grouped:
        identity = row["id"]
        if identity not in wanted_ids:
            continue
        record = h.candidate_record(row, tokenizer=tokenizer, max_seq_length=4096, generation_limit=192, gap_policy=snapshot["gap_policy_seconds"])
        m = metadata[identity]
        checks = {"review_hash": record["review_hash"] == m["old_review_hash"],
                  "source_keys_hash": digest(record["source_message_keys"]) == m["source_keys_hash"],
                  "raw_content_hash": digest({"context": record["context"], "targets": record["targets"]}) == m["raw_content_hash"],
                  "input_hash": digest(record["messages"][:-1]) == m["input_hash"],
                  "target_hash": digest(record["messages"][-1:]) == m["target_hash"]}
        if not all(checks.values()):
            raise ValueError("candidate_five_hash_binding_changed")
        if not include_tokens:
            recovered[identity] = record
            continue
        prefix = granite.encode(granite.apply_chat_template(record["messages"][:-1], tokenize=False,
                                add_generation_prompt=True, enable_thinking=False), add_special_tokens=False)
        actual = "\n".join(t["body"] for t in record["targets"])
        full = granite.encode(granite.apply_chat_template(record["messages"][:-1], tokenize=False,
                              add_generation_prompt=True, enable_thinking=False) + actual + granite.eos_token, add_special_tokens=False)
        answer = full[len(prefix):]
        if len(prefix) != m["granite_prompt_tokens"] or len(answer) != m["granite_answer_tokens"] or digest({"prompt_tokens": prefix, "answer_tokens": answer}) != m["granite_token_sha256"]:
            raise ValueError("granite_recovered_tokens_changed")
        if full[:len(prefix)] != prefix or granite.decode(answer[:-1], skip_special_tokens=False, clean_up_tokenization_spaces=False) != actual or answer[-1] != granite.eos_token_id:
            raise ValueError("unmodified_target_boundary_changed")
        recovered[identity] = record
        tokens[identity] = {"prompt_tokens": prefix, "answer_tokens": answer}
    grouped.clear()
    if set(recovered) != wanted_ids:
        raise ValueError("authorized_candidate_ids_missing")
    proof = {"schema": "behavior-read-only-recovery-v1", "room_proofs": proofs,
             "expected_raw_records": len(expected), "exact_raw_records": sum(p["exact"] for p in proofs),
             "authorized_train_records": len(train_ids), "authorized_quality_context_records": len(quality_ids),
             "five_hash_checks_each": True, "recovered_granite_tokens_exact_each": include_tokens,
             "tokenizer_uses_preserved_assets_only": True, "daemon_stopped": False,
             "coverage_raw_sha256": hashlib.sha256((sealed / "final-fullpool-coverage.json").read_bytes()).hexdigest(),
             "source_code_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
             "bodies_persisted": 0, "token_arrays_persisted": 0}
    write_private(output / "recovery-receipt.json", proof)
    return recovered, tokens, metadata, train_ids, quality_ids


def room_key(identity):
    return json.dumps(json.loads(identity[5:])[:3] + [""], ensure_ascii=False, separators=(",", ":"))


def client(grant, request):
    if digest({k: v for k, v in grant.items() if k != "grant_hash"}) != grant["grant_hash"]:
        raise ValueError("analysis_grant_seal_changed")
    path = Path(grant["socket_path"])
    if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077 or path.parent.stat().st_mode & 0o077:
        raise ValueError("owner_only_analysis_socket_required")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(90)
        sock.connect(str(path))
        sock.sendall(json.dumps({"grant_hash": grant["grant_hash"], **request}).encode() + b"\n")
        data = bytearray()
        while not data.endswith(b"\n"):
            chunk = sock.recv(65536)
            if not chunk:
                raise ValueError("incomplete_analysis_response")
            data.extend(chunk)
            if len(data) > 32 * 1024**2:
                raise ValueError("analysis_response_over_budget")
    result = json.loads(data)
    if "error" in result:
        raise ValueError("analysis_request_rejected")
    return result


def serve(records, tokens, metadata, train_ids, quality_ids, output):
    stopping = False
    def stop(*_):
        nonlocal stopping
        stopping = True
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    with tempfile.TemporaryDirectory(prefix="inboxd-behavior-audit-") as temp:
        directory = Path(temp)
        directory.chmod(0o700)
        path = directory / "audit.sock"
        grant = {"schema": "reply-behavior-read-only-grant-v1", "socket_path": str(path),
                 "owner_pid": os.getpid(), "train_ids": sorted(train_ids), "quality_context_ids": sorted(quality_ids),
                 "operations": ["metadata", "records"], "max_record_batch": 20,
                 "purpose": "authorized diagnostics and evaluation, no training", "source_bodies_disk_files": 0}
        grant["grant_hash"] = digest(grant)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(path))
            path.chmod(0o600)
            server.listen(4)
            server.settimeout(.5)
            write_private(output / "owner-grant.json", grant)
            print(json.dumps({"phase": "serving", "socket_path": str(path), "pid": os.getpid(), "train_count": len(train_ids), "quality_count": len(quality_ids)}), flush=True)
            while not stopping:
                try:
                    sock, _ = server.accept()
                except socket.timeout:
                    continue
                with sock:
                    sock.settimeout(90)
                    try:
                        data = bytearray()
                        while not data.endswith(b"\n"):
                            chunk = sock.recv(65536)
                            if not chunk or len(data) + len(chunk) > 65536:
                                raise ValueError("invalid_request_size")
                            data.extend(chunk)
                        request = json.loads(data)
                        if request.get("grant_hash") != grant["grant_hash"]:
                            raise ValueError("read_only_grant_required")
                        if request.get("op") == "metadata" and set(request) == {"op", "grant_hash"}:
                            result = {"entries": [metadata[i] for i in sorted(records)], "train_ids": sorted(train_ids), "quality_context_ids": sorted(quality_ids)}
                        elif request.get("op") == "records" and set(request) <= {"op", "ids", "grant_hash", "include_targets", "include_tokens"}:
                            ids = request["ids"]
                            if not isinstance(ids, list) or not 1 <= len(ids) <= 20 or len(set(ids)) != len(ids) or set(ids) - set(records):
                                raise ValueError("bounded_authorized_record_ids_required")
                            cases = []
                            for i in ids:
                                record = dict(records[i])
                                if i in quality_ids or not request.get("include_targets", False):
                                    record["targets"] = []
                                    record["messages"] = record["messages"][:-1]
                                item = {"record": record, "metadata": metadata[i]}
                                if request.get("include_tokens", False):
                                    item["tokens"] = {"prompt_tokens": tokens[i]["prompt_tokens"]}
                                    if i in train_ids and request.get("include_targets", False):
                                        item["tokens"]["answer_tokens"] = tokens[i]["answer_tokens"]
                                cases.append(item)
                            result = {"cases": cases, "originals_unchanged": True, "target_free_quality_cases": True}
                        else:
                            raise ValueError("operation_not_authorized")
                        response = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
                    except Exception:
                        response = b'{"error":"analysis_request_rejected"}\n'
                    try:
                        sock.sendall(response)
                    except OSError:
                        pass
    records.clear()
    tokens.clear()
    write_private(output / "shutdown-receipt.json", {"owner_pid": os.getpid(), "socket_removed": True, "bodies_persisted": 0, "token_arrays_persisted": 0})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sealed", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.output.stat().st_mode & 0o077:
        raise ValueError("private_output_directory_required")
    original_files = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in args.sealed.rglob("*") if p.is_file()}
    records, tokens, metadata, train_ids, quality_ids = recover(args.sealed, args.output)
    summary = audit({i: records[i] for i in train_ids}, metadata, args.output)
    unchanged = all(Path(p).exists() and hashlib.sha256(Path(p).read_bytes()).hexdigest() == sha for p, sha in original_files.items())
    write_private(args.output / "sealed-artifacts-preserved.json", {"sealed_file_hashes": original_files, "all_preserved": unchanged})
    if not unchanged:
        raise ValueError("sealed_artifact_changed_during_analysis")
    print(json.dumps({"phase": "audit_complete", "count": summary["example_count"], "completion_tokens": summary["completion_tokens_with_eos"], "primary_counts": summary["primary_counts"]}), flush=True)
    serve(records, tokens, metadata, train_ids, quality_ids, args.output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Library exceptions can contain message bodies. Fixed type only.
        print(json.dumps({"phase": "failed", "error_type": type(error).__name__, "body_values_logged": False}), flush=True)
        raise SystemExit(1)
