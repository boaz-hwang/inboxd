from pathlib import Path
import json
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from context_intelligence import (  # noqa: E402
    DECISION_SCHEMA_VERSION, build_state, parse_baseline_output, validate_decision,
)
from policy import ExecutionBudget, execute_policy  # noqa: E402


def state_with(sources=None, evidence=None, execution_budget=None, context=None, incoming=None):
    return build_state({
        "state_id": "s1",
        "context": context or [{"message_id": "m", "author_role": "other", "author_id": "x",
                                "body": "지난번 조건대로 진행할까요?", "ts": 1}],
        "incoming_message_ids": incoming or ["m"],
        "source_registry": sources or [],
        "evidence": evidence or [],
        "execution_budget": execution_budget or {},
    })


def categorical(labels, winner):
    low = 0.1 / (len(labels) - 1)
    return {key: 0.9 if key == winner else low for key in labels}


def decision(state, *, response="respond", sufficiency="sufficient", escalation="direct",
             gaps=None, sources=None, risks=None, flags=None):
    raw = {
        "stateId": state["state_id"], "schemaVersion": DECISION_SCHEMA_VERSION,
        "modelVersion": "baseline-local", "calibrationVersion": None,
        "validHeads": ["response", "sufficiency", "gaps", "sources", "risks", "escalation"],
        "uncertaintyFlags": flags or [],
        "scores": {
            "response": categorical(("respond", "no_reply", "uncertain"), response),
            "sufficiency": categorical(("sufficient", "insufficient", "unknown"), sufficiency),
            "gaps": gaps or {"not_applicable": 0.9},
            "sources": sources or {},
            "risks": risks or {"not_applicable": 0.9},
            "escalation": categorical(("direct", "retrieve", "reason", "clarify", "defer"), escalation),
        },
    }
    return validate_decision(raw, state)


class PolicyContract(unittest.TestCase):
    def test_grounded_direct_response_can_reply(self):
        state = state_with()
        plan = execute_policy(state, decision(state))
        self.assertEqual(plan.action, "reply")
        self.assertEqual(plan.budget_cost["queryCalls"], 0)

    def test_indicator_choice_is_not_treated_as_model_confidence(self):
        state = state_with()
        raw = {
            "response": "respond", "sufficiency": "sufficient", "gaps": ["not_applicable"],
            "sources": [], "risks": ["not_applicable"], "escalation": "direct", "uncertain": False,
        }
        selected = parse_baseline_output(json.dumps(raw), state, "local-model")
        self.assertEqual(execute_policy(state, selected).action, "reply")
        self.assertEqual(selected.score_encoding, "categorical_indicator")

        raw["uncertain"] = True
        uncertain = parse_baseline_output(json.dumps(raw), state, "local-model")
        self.assertEqual(execute_policy(state, uncertain).action, "reason")

        raw.update(response="no_reply", sufficiency="unknown", escalation="defer")
        uncertain_no_reply = parse_baseline_output(json.dumps(raw), state, "local-model")
        self.assertEqual(execute_policy(state, uncertain_no_reply).action, "reason")

    def test_unsafe_sufficiency_does_not_authorize_commitment(self):
        state = state_with()
        plan = execute_policy(state, decision(state, risks={"unsupported_commitment": 0.95}))
        self.assertEqual(plan.action, "clarify")
        self.assertEqual(plan.reason_code, "unsupported_commitment")

    def test_user_decision_gap_is_clarification_not_retrieval_approval(self):
        source = {"id": "history", "kind": "chat", "context_scope": "thread", "scope": {"chat_id": "c"},
                  "permissions": ["query"], "availability": "available"}
        state = state_with(sources=[source])
        plan = execute_policy(state, decision(state, sufficiency="insufficient", escalation="retrieve",
                                              gaps={"previous_agreement": 0.9, "user_decision": 0.95},
                                              sources={"history": 0.99}))
        self.assertEqual(plan.action, "clarify")
        self.assertEqual(plan.queries, ())
        self.assertEqual(plan.reason_code, "user_decision_required")

    def test_source_registry_masks_unavailable_and_unpermitted_sources(self):
        sources = [
            {"id": "cloud", "kind": "email", "context_scope": "workspace", "scope": {},
             "permissions": ["query"], "availability": "unavailable"},
            {"id": "private", "kind": "file", "context_scope": "workspace", "scope": {},
             "permissions": [], "availability": "available"},
            {"id": "history", "kind": "chat", "context_scope": "thread", "scope": {"chat_id": "c"},
             "permissions": ["query"], "availability": "available"},
        ]
        state = state_with(sources=sources)
        plan = execute_policy(state, decision(state, sufficiency="insufficient", escalation="retrieve",
                                              gaps={"previous_agreement": 0.9},
                                              sources={"cloud": 1.0, "private": 0.99, "history": 0.8}))
        self.assertEqual(plan.action, "retrieve")
        self.assertEqual([query["sourceId"] for query in plan.queries], ["history"])
        self.assertEqual(plan.queries[0]["scope"], {"chat_id": "c"})
        self.assertEqual(plan.gaps[0]["sourceCandidates"], ["history"])

    def test_unknown_sufficiency_uses_bounded_reasoning_fallback(self):
        state = state_with()
        first = execute_policy(state, decision(state, sufficiency="unknown", escalation="direct"))
        self.assertEqual(first.action, "reason")
        second = execute_policy(
            state, decision(state, sufficiency="unknown", escalation="direct"),
            ExecutionBudget(reasoning_state_ids=(state["state_id"],)),
        )
        self.assertEqual(second.action, "defer")

    def test_unknown_and_conflicting_evidence_reason_once_then_clarify(self):
        key = {"msg_id": "old"}
        state = state_with(evidence=[
            {"id": "e1", "key": key, "excerpt": "A"},
            {"id": "e2", "key": key, "excerpt": "B"},
        ])
        first = execute_policy(state, decision(state, sufficiency="unknown", escalation="reason",
                                               gaps={"unknown": 0.9}))
        self.assertEqual(first.action, "reason")
        after = ExecutionBudget(reasoning_state_ids=(state["state_id"],))
        second = execute_policy(state, decision(state, sufficiency="unknown", escalation="reason",
                                                gaps={"unknown": 0.9}), after)
        self.assertEqual(second.action, "clarify")

    def test_truncated_incoming_cannot_take_fast_path(self):
        state = build_state({
            "state_id": "s1", "context": [{"message_id": "m", "author_role": "other", "body": "x" * 500}],
            "incoming_message_ids": ["m"], "source_registry": [], "evidence": [],
        }, max_context_chars=256)
        self.assertEqual(execute_policy(state, decision(state)).action, "reason")

    def test_retrieval_budget_and_seen_query_terminate(self):
        source = {"id": "history", "kind": "chat", "context_scope": "thread", "scope": {"chat_id": "c"},
                  "permissions": ["query"], "availability": "available",
                  "query_templates": {"previous_agreement": "find previous agreement"}}
        state = state_with(sources=[source])
        proposed = decision(state, sufficiency="insufficient", escalation="retrieve",
                            gaps={"previous_agreement": 0.9}, sources={"history": 0.9})
        exhausted = ExecutionBudget(retrieval_rounds_used=2, query_calls_used=2)
        self.assertEqual(execute_policy(state, proposed, exhausted).reason_code, "retrieval_budget_exhausted")

        seen = ExecutionBudget.from_mapping({"seen_queries": [{
            "sourceId": "history", "query": "find previous agreement", "scope": {"chat_id": "c"},
        }]})
        plan = execute_policy(state, proposed, seen)
        self.assertEqual(plan.action, "clarify")
        self.assertEqual(plan.reason_code, "no_permitted_unseen_source")

    def test_sufficient_retrieve_contradiction_is_not_executed(self):
        state = state_with()
        plan = execute_policy(state, decision(state, sufficiency="sufficient", escalation="retrieve"))
        self.assertEqual(plan.action, "reason")
        self.assertEqual(plan.reason_code, "contradictory_heads")

    def test_no_reply_does_not_consume_budget(self):
        state = state_with()
        plan = execute_policy(state, decision(state, response="no_reply", sufficiency="unknown", escalation="defer"))
        self.assertEqual(plan.action, "no_reply")
        self.assertEqual(plan.unresolved_gaps, ())
        self.assertEqual(plan.budget_cost, {"retrievalRounds": 0, "queryCalls": 0, "reasoningCalls": 0})

    def test_no_reply_with_critical_truncation_uses_reasoning(self):
        state = build_state({
            "state_id": "s1", "context": [{"message_id": "m", "author_role": "other", "body": "x" * 500}],
            "incoming_message_ids": ["m"], "source_registry": [], "evidence": [],
        }, max_context_chars=256)
        plan = execute_policy(state, decision(state, response="no_reply", sufficiency="unknown", escalation="defer"))
        self.assertEqual(plan.action, "reason")


if __name__ == "__main__":
    unittest.main()
