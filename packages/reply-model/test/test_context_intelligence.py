import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from context_intelligence import (  # noqa: E402
    DECISION_SCHEMA_VERSION,
    DecisionValidationError,
    StateValidationError,
    build_baseline_prompt,
    build_state,
    parse_baseline_output,
    validate_decision,
)


def request(**updates):
    value = {
        "state_id": "state-1",
        "context_version": "context-1",
        "chat": {"platform": "slack", "account": "a", "chat_id": "c"},
        "context": [
            {"message_id": "m1", "author_role": "self", "author_id": "me", "body": "전에 이야기했어요", "ts": 1},
            {"message_id": "m2", "author_role": "other", "author_id": "them", "body": "지난 조건대로 할까요?", "ts": 2, "reply_to": "m1"},
        ],
        "incoming_message_ids": ["m2"],
        "source_registry": [{
            "id": "current_chat_history", "kind": "chat", "context_scope": "thread",
            "scope": {"platform": "slack", "account": "a", "chat_id": "c"},
            "permissions": ["query"], "availability": "available", "freshness": "stored_snapshot",
        }],
        "evidence": [],
    }
    value.update(updates)
    return value


def raw_decision(state, **score_updates):
    scores = {
        "response": {"respond": 0.9, "no_reply": 0.05, "uncertain": 0.05},
        "sufficiency": {"sufficient": 0.9, "insufficient": 0.05, "unknown": 0.05},
        "gaps": {"not_applicable": 0.9},
        "sources": {item["id"]: 0.1 for item in state["source_registry"]},
        "risks": {"not_applicable": 0.9},
        "escalation": {"direct": 0.9, "retrieve": 0.025, "reason": 0.025, "clarify": 0.025, "defer": 0.025},
    }
    scores.update(score_updates)
    return {
        "stateId": state["state_id"], "schemaVersion": DECISION_SCHEMA_VERSION,
        "modelVersion": "local-test", "scores": scores, "validHeads": list(scores),
        "uncertaintyFlags": [], "calibrationVersion": None,
    }


def baseline_proposal(**updates):
    value = {
        "response": "respond", "sufficiency": "sufficient",
        "gaps": ["not_applicable"], "sources": [], "risks": ["not_applicable"],
        "escalation": "direct", "uncertain": False,
    }
    value.update(updates)
    return value


class StateBuilderContract(unittest.TestCase):
    def test_is_deterministic_and_preserves_provenance(self):
        first = build_state(request())
        second = build_state(request())
        self.assertEqual(first, second)
        self.assertEqual(first["thread"]["messages"][1]["reply_to"], "m1")
        self.assertEqual(first["source_registry"][0]["scope"]["chat_id"], "c")
        self.assertEqual(first["state_builder_version"], "state-builder-v1")

    def test_budget_progress_does_not_change_semantic_state_digest(self):
        first = build_state(request(state_id=None, execution_budget={"reasoning_state_ids": []}))
        second = build_state(request(state_id=None, execution_budget={"reasoning_state_ids": [first["state_id"]]}))
        self.assertEqual(first["state_id"], second["state_id"])
        self.assertEqual(first["state_digest"], second["state_digest"])
        self.assertNotEqual(first["execution_budget"], second["execution_budget"])

    def test_truncation_keeps_incoming_identity_and_marks_loss(self):
        state = build_state(request(context=[
            {"message_id": "old", "author_role": "self", "body": "x" * 500, "ts": 1},
            {"message_id": "new", "author_role": "other", "body": "y" * 500, "ts": 2},
        ], incoming_message_ids=["new"]), max_context_chars=256)
        self.assertEqual([m["message_id"] for m in state["thread"]["messages"]], ["new"])
        self.assertIn("truncated_incoming", state["uncertainty_flags"])
        self.assertEqual(state["truncation"]["omitted_message_ids"], ["old"])
        self.assertGreater(state["truncation"]["body_truncations"][0]["omitted_chars"], 0)

    def test_absent_and_invalid_values_remain_unknown(self):
        state = build_state(request(context=[{"message_id": "m2", "body": "hi", "author_role": "bot"}],
                                    incoming_message_ids=["m2", "missing"], source_registry=[{
                                        "id": "mail", "scope": {}, "permissions": [],
                                    }]))
        self.assertEqual(state["thread"]["messages"][0]["author_role"], "unknown")
        self.assertEqual(state["source_registry"][0]["availability"], "unknown")
        self.assertIn("incoming:missing:content", state["unknown_fields"])
        self.assertIn("unknown_fields", state["uncertainty_flags"])

    def test_evidence_conflict_is_preserved_not_resolved(self):
        key = {"chat_id": "c", "msg_id": "old"}
        state = build_state(request(evidence=[
            {"id": "e1", "source_id": "current_chat_history", "key": key,
             "version": "v1", "excerpt": "300만원", "ts": 1, "observed_at": 3},
            {"id": "e2", "source_id": "current_chat_history", "key": key,
             "version": "v2", "excerpt": "350만원", "ts": 2, "observed_at": 3},
        ]))
        self.assertEqual(state["contradiction_sets"], [["e1", "e2"]])
        self.assertIn("conflicting_evidence", state["uncertainty_flags"])

    def test_non_thread_metadata_cannot_bypass_state_bound(self):
        with self.assertRaisesRegex(StateValidationError, "state_too_large"):
            build_state(request(chat={"chat_id": "c", "untrusted": "x" * 300_000}))


class DecisionContract(unittest.TestCase):
    def test_categorical_scores_must_form_distribution(self):
        state = build_state(request())
        raw = raw_decision(state)
        raw["scores"]["response"] = {"respond": 0.9, "no_reply": 0.9, "uncertain": 0.9}
        with self.assertRaisesRegex(DecisionValidationError, "invalid_response_distribution"):
            validate_decision(raw, state)

    def test_multilabel_scores_are_not_forced_to_sum_to_one(self):
        state = build_state(request())
        raw = raw_decision(state, gaps={"previous_agreement": 0.9, "user_decision": 0.95})
        decision = validate_decision(raw, state)
        self.assertEqual(sum(decision.scores["gaps"].values()), 1.85)

    def test_source_scores_cannot_name_unregistered_source(self):
        state = build_state(request())
        raw = raw_decision(state, sources={"private_cloud": 1.0})
        with self.assertRaisesRegex(DecisionValidationError, "invalid_sources_labels"):
            validate_decision(raw, state)

    def test_validity_mask_must_match_score_heads(self):
        state = build_state(request())
        raw = raw_decision(state)
        raw["validHeads"].remove("risks")
        with self.assertRaisesRegex(DecisionValidationError, "scores_validity_mismatch"):
            validate_decision(raw, state)

    def test_local_baseline_prompt_and_strict_parser(self):
        state = build_state(request())
        prompt = build_baseline_prompt(state, "local-test")
        self.assertIn("로컬 Inboxd", prompt[0]["content"])
        self.assertIn("부정을 뒤집지 마세요", prompt[0]["content"])
        self.assertNotIn('"modelVersion"', prompt[1]["content"])
        payload = json.loads(prompt[1]["content"])
        self.assertEqual(
            [example["output"]["escalation"] for example in payload["examples"]],
            ["direct", "retrieve", "clarify", "clarify", "direct", "defer"],
        )
        self.assertIn("URL 내용을 열 수 있는", prompt[0]["content"])
        self.assertEqual(payload["examples"][1]["output"]["sources"], ["current_chat_history"])
        decision = parse_baseline_output(json.dumps(baseline_proposal()), state, "local-test")
        self.assertEqual(decision.model_version, "local-test")
        self.assertEqual(decision.score_encoding, "categorical_indicator")
        self.assertIsNone(decision.calibration_version)
        self.assertEqual(decision.scores["response"], {"respond": 1.0, "no_reply": 0.0, "uncertain": 0.0})
        with self.assertRaisesRegex(DecisionValidationError, "invalid_baseline_json"):
            parse_baseline_output("```json\n{}\n```", state)

    def test_baseline_proposal_gets_caller_owned_metadata(self):
        state = build_state(request())
        proposal = baseline_proposal(uncertain=True)
        decision = parse_baseline_output(json.dumps(proposal), state, "actual-local-model")
        self.assertEqual(decision.state_id, state["state_id"])
        self.assertEqual(decision.schema_version, DECISION_SCHEMA_VERSION)
        self.assertEqual(decision.model_version, "actual-local-model")
        self.assertEqual(decision.uncertainty_flags, ("baseline_uncertain",))
        self.assertEqual(decision.raw_proposal, proposal)
        self.assertEqual(decision.to_dict()["scoreEncoding"], "categorical_indicator")

    def test_baseline_examples_never_invent_an_unregistered_source(self):
        state = build_state(request(source_registry=[]))
        payload = json.loads(build_baseline_prompt(state)[1]["content"])
        retrieval_example = payload["examples"][1]["output"]
        self.assertEqual(retrieval_example["sources"], [])
        self.assertEqual(retrieval_example["escalation"], "clarify")

    def test_baseline_proposal_strictly_rejects_guessed_labels_sources_and_fields(self):
        state = build_state(request())
        bad_values = [
            baseline_proposal(response="maybe"),
            baseline_proposal(sources=["unregistered"]),
            baseline_proposal(gaps=["unknown", "unknown"]),
            baseline_proposal(uncertain=1),
            {**baseline_proposal(), "confidence": 0.9},
        ]
        for raw in bad_values:
            with self.subTest(raw=raw), self.assertRaises(DecisionValidationError):
                parse_baseline_output(json.dumps(raw), state, "local-model")

    def test_only_unambiguous_response_clarify_alias_is_canonicalised(self):
        state = build_state(request())
        proposal = baseline_proposal(
            response="clarify", sufficiency="insufficient", gaps=["availability"],
            risks=["unsupported_commitment"], escalation="clarify",
        )
        decision = parse_baseline_output(json.dumps(proposal), state, "local-model")
        self.assertEqual(decision.scores["response"]["respond"], 1.0)
        self.assertEqual(decision.scores["escalation"]["clarify"], 1.0)
        self.assertEqual(decision.raw_proposal["response"], "clarify")

        with self.assertRaisesRegex(DecisionValidationError, "invalid_baseline_response"):
            parse_baseline_output(
                json.dumps(baseline_proposal(response="clarify", escalation="direct")),
                state, "local-model",
            )

    def test_only_unambiguous_direct_sufficiency_alias_is_canonicalised(self):
        state = build_state(request())
        proposal = baseline_proposal(sufficiency="direct", escalation="direct", uncertain=False)
        decision = parse_baseline_output(json.dumps(proposal), state, "local-model")
        self.assertEqual(decision.scores["sufficiency"]["sufficient"], 1.0)
        self.assertEqual(decision.raw_proposal["sufficiency"], "direct")

        with self.assertRaisesRegex(DecisionValidationError, "invalid_baseline_sufficiency"):
            parse_baseline_output(
                json.dumps(baseline_proposal(sufficiency="direct", escalation="clarify")),
                state, "local-model",
            )

    def test_no_reply_masks_placeholder_lower_heads(self):
        state = build_state(request())
        proposal = baseline_proposal(response="no_reply", sufficiency="unknown", escalation="defer")
        decision = parse_baseline_output(json.dumps(proposal), state, "local-model")
        self.assertEqual(decision.valid_heads, ("response",))
        self.assertEqual(set(decision.scores), {"response"})
        self.assertEqual(decision.raw_proposal, proposal)


if __name__ == "__main__":
    unittest.main()
