"""Deterministic policy executor for validated Context Intelligence scores."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import re
from typing import Any, Mapping

from context_intelligence import GAP_LABELS, ScoredDecision


POLICY_VERSION = "context-policy-v1"
DEFAULT_SCORE_THRESHOLD = 0.55
LOW_MARGIN = 0.15


@dataclass(frozen=True)
class ExecutionBudget:
    max_retrieval_rounds: int = 2
    max_query_calls: int = 3
    retrieval_rounds_used: int = 0
    query_calls_used: int = 0
    reasoning_state_ids: tuple[str, ...] = ()
    seen_queries: tuple[str, ...] = ()

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any] | None) -> "ExecutionBudget":
        value = value or {}
        def integer(key: str, default: int, *, upper: int) -> int:
            raw = value.get(key, default)
            if isinstance(raw, bool) or not isinstance(raw, int) or not 0 <= raw <= upper:
                raise ValueError(f"invalid_budget_{key}")
            return raw
        reasoning = value.get("reasoning_state_ids", [])
        if not isinstance(reasoning, list) or not all(isinstance(item, str) for item in reasoning):
            raise ValueError("invalid_budget_reasoning_state_ids")
        seen = value.get("seen_queries", [])
        if not isinstance(seen, list):
            raise ValueError("invalid_budget_seen_queries")
        canonical_seen: list[str] = []
        for item in seen:
            if isinstance(item, str):
                canonical_seen.append(item)
            elif isinstance(item, Mapping):
                canonical_seen.append(_query_key(
                    item.get("source_id", item.get("sourceId")), item.get("query"), item.get("scope"),
                ))
            else:
                raise ValueError("invalid_budget_seen_queries")
        result = cls(
            max_retrieval_rounds=integer("max_retrieval_rounds", 2, upper=16),
            max_query_calls=integer("max_query_calls", 3, upper=64),
            retrieval_rounds_used=integer("retrieval_rounds_used", 0, upper=16),
            query_calls_used=integer("query_calls_used", 0, upper=64),
            reasoning_state_ids=tuple(dict.fromkeys(reasoning)),
            seen_queries=tuple(dict.fromkeys(canonical_seen)),
        )
        if result.retrieval_rounds_used > result.max_retrieval_rounds or result.query_calls_used > result.max_query_calls:
            raise ValueError("invalid_budget_usage")
        return result

    @classmethod
    def from_state(cls, state: Mapping[str, Any]) -> "ExecutionBudget":
        raw = state.get("execution_budget", {})
        return cls.from_mapping(raw if isinstance(raw, Mapping) else {})


@dataclass(frozen=True)
class ContextPlan:
    action: str
    thread_sufficiency: str
    gaps: tuple[dict[str, Any], ...]
    queries: tuple[dict[str, Any], ...]
    evidence_ids: tuple[str, ...]
    unresolved_gaps: tuple[str, ...]
    reason_code: str
    policy_version: str = POLICY_VERSION
    budget_cost: dict[str, int] | None = None

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["gaps"] = list(value["gaps"])
        value["queries"] = list(value["queries"])
        value["threadSufficiency"] = value.pop("thread_sufficiency")
        value["evidenceIds"] = list(value.pop("evidence_ids"))
        value["unresolvedGaps"] = list(value.pop("unresolved_gaps"))
        value["reasonCode"] = value.pop("reason_code")
        value["policyVersion"] = value.pop("policy_version")
        value["budgetCost"] = value.pop("budget_cost") or {
            "retrievalRounds": 0, "queryCalls": 0, "reasoningCalls": 0,
        }
        return value


def _winner(scores: Mapping[str, float]) -> tuple[str, float, float]:
    ordered = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    first = ordered[0]
    second = ordered[1][1] if len(ordered) > 1 else 0.0
    return first[0], first[1], first[1] - second


def _query_key(source_id: Any, query: Any, scope: Any) -> str:
    return json.dumps({"source_id": source_id, "query": query, "scope": scope}, sort_keys=True,
                      ensure_ascii=False, separators=(",", ":"), default=str)


def _incoming_query_text(state: Mapping[str, Any], gap: str) -> str:
    incoming = set(state.get("thread", {}).get("incoming_message_ids", []))
    bodies = [item.get("body", "") for item in state.get("thread", {}).get("messages", [])
              if item.get("message_id") in incoming]
    text = re.sub(r"\s+", " ", " ".join(bodies)).strip()[:512]
    return f"gap:{gap} {text}".strip()


def _plan(
    action: str, sufficiency: str, gap_records: list[dict[str, Any]], evidence_ids: list[str],
    reason: str, *, queries: list[dict[str, Any]] | None = None,
    unresolved: list[str] | None = None, retrieval: int = 0, reasoning: int = 0,
) -> ContextPlan:
    query_values = queries or []
    return ContextPlan(
        action=action,
        thread_sufficiency=sufficiency,
        gaps=tuple(gap_records),
        queries=tuple(query_values),
        evidence_ids=tuple(evidence_ids),
        unresolved_gaps=tuple(
            unresolved if unresolved is not None else [item["key"] for item in gap_records]
        ),
        reason_code=reason,
        budget_cost={"retrievalRounds": retrieval, "queryCalls": len(query_values), "reasoningCalls": reasoning},
    )


def execute_policy(
    state: Mapping[str, Any], decision: ScoredDecision, budget: ExecutionBudget | Mapping[str, Any] | None = None,
) -> ContextPlan:
    """Create an allowed next action from scores, registry permissions and budget."""
    if decision.state_id != state.get("state_id"):
        raise ValueError("state_id_mismatch")
    if budget is None:
        budget = ExecutionBudget.from_state(state)
    elif isinstance(budget, Mapping):
        budget = ExecutionBudget.from_mapping(budget)
    if not isinstance(budget, ExecutionBudget):
        raise TypeError("invalid_budget")

    registry = {item["id"]: item for item in state.get("source_registry", []) if isinstance(item, Mapping)}
    evidence_ids = [
        item["id"] for item in state.get("evidence", [])
        if isinstance(item, Mapping) and isinstance(item.get("id"), str)
        and item.get("source_id") in registry
        and ("query" in registry[item["source_id"]].get("permissions", [])
             or "read" in registry[item["source_id"]].get("permissions", []))
    ]
    response, response_score, response_margin = _winner(decision.scores["response"])
    sufficiency_scores = decision.scores.get("sufficiency")
    sufficiency = _winner(sufficiency_scores)[0] if sufficiency_scores else "unknown"
    escalation_scores = decision.scores.get("escalation")
    escalation = _winner(escalation_scores)[0] if escalation_scores else "defer"
    gaps = [key for key, score in decision.scores.get("gaps", {}).items()
            if score >= DEFAULT_SCORE_THRESHOLD and key not in ("not_applicable",)]
    source_scores = decision.scores.get("sources", {})
    scored_source_candidates = [
        source_id for source_id, score in sorted(source_scores.items(), key=lambda item: (-item[1], item[0]))
        if score >= DEFAULT_SCORE_THRESHOLD
    ]
    # Do not even expose a source as actionable when the daemon registry has
    # not explicitly granted query permission for the exact current scope.
    source_candidates = [
        source_id for source_id in scored_source_candidates
        if registry.get(source_id, {}).get("availability") == "available"
        and "query" in registry.get(source_id, {}).get("permissions", [])
    ]
    gap_records = [{
        "key": gap,
        "question": {
            "previous_agreement": "이전 합의 내용을 확인해야 합니다.",
            "availability": "내 일정상 이 시간이 가능한지 확인해야 합니다.",
            "project_state": "현재 프로젝트 상태를 확인해야 합니다.",
            "user_decision": "내가 이 요청을 수락하거나 확정할지 결정해야 합니다.",
            "other": "답변에 필요한 추가 정보를 확인해야 합니다.",
            "unknown": "답변 전에 필요한 정보를 확인해야 합니다.",
        }.get(gap, "추가 확인이 필요합니다."),
        "sourceCandidates": [source_id for source_id in source_candidates
                             if gap in registry.get(source_id, {}).get("supported_gaps", GAP_LABELS)],
    } for gap in gaps]

    state_uncertainty = set(state.get("uncertainty_flags", []))
    uncertainty = state_uncertainty | set(decision.uncertainty_flags)
    conflicts = bool(state.get("contradiction_sets")) or decision.scores.get("risks", {}).get("conflicting_evidence", 0) >= DEFAULT_SCORE_THRESHOLD
    if decision.score_encoding == "categorical_indicator":
        # Indicators encode a closed choice, not calibrated confidence. Safety
        # comes from explicit unknown/uncertain selections and state guards.
        low_confidence = response == "uncertain" or "baseline_uncertain" in uncertainty
        response_decisive = not low_confidence
    else:
        low_confidence = response == "uncertain" or response_score < DEFAULT_SCORE_THRESHOLD or response_margin < LOW_MARGIN
        response_decisive = response_score >= DEFAULT_SCORE_THRESHOLD and response_margin >= LOW_MARGIN
    critical_uncertainty = conflicts or bool(uncertainty & {
        "out_of_domain", "truncated_thread", "truncated_incoming", "conflicting_evidence", "contradictory_heads",
    })

    if response == "no_reply" and response_decisive and not critical_uncertainty:
        return _plan("no_reply", sufficiency, gap_records, evidence_ids, "response_no_reply", unresolved=[])

    # Missing user intent is an authority boundary. Information lookup cannot
    # turn an old fact or an empty calendar slot into the user's new decision.
    if "user_decision" in gaps:
        return _plan("clarify", sufficiency, gap_records, evidence_ids, "user_decision_required")

    needs_reason = low_confidence or sufficiency == "unknown" or escalation == "reason" or critical_uncertainty
    already_reasoned = state.get("state_id") in budget.reasoning_state_ids
    if needs_reason:
        if not already_reasoned:
            return _plan("reason", sufficiency, gap_records, evidence_ids,
                         "uncertainty_requires_local_reasoning", reasoning=1)
        terminal = "clarify" if gaps or conflicts else "defer"
        return _plan(terminal, sufficiency, gap_records, evidence_ids,
                     "uncertainty_unresolved_after_reasoning")

    contradictory = sufficiency == "sufficient" and escalation == "retrieve"
    if contradictory:
        if not already_reasoned:
            return _plan("reason", sufficiency, gap_records, evidence_ids, "contradictory_heads", reasoning=1)
        return _plan("clarify", sufficiency, gap_records, evidence_ids, "contradiction_unresolved")

    should_retrieve = sufficiency == "insufficient" or escalation == "retrieve"
    if should_retrieve:
        if budget.retrieval_rounds_used >= budget.max_retrieval_rounds or budget.query_calls_used >= budget.max_query_calls:
            terminal = "clarify" if gaps else "defer"
            return _plan(terminal, sufficiency, gap_records, evidence_ids, "retrieval_budget_exhausted")
        remaining_calls = budget.max_query_calls - budget.query_calls_used
        queries: list[dict[str, Any]] = []
        for gap in gaps or ["unknown"]:
            for source_id in source_candidates:
                source = registry.get(source_id)
                if not source or source.get("availability") != "available" or "query" not in source.get("permissions", []):
                    continue
                if gap not in source.get("supported_gaps", GAP_LABELS):
                    continue
                template = source.get("query_templates", {}).get(gap)
                query = template if isinstance(template, str) and template.strip() else _incoming_query_text(state, gap)
                item = {"sourceId": source_id, "query": query, "scope": dict(source.get("scope", {}))}
                key = _query_key(source_id, query, item["scope"])
                if key in budget.seen_queries:
                    continue
                queries.append(item)
                if len(queries) >= remaining_calls:
                    break
            if len(queries) >= remaining_calls:
                break
        if queries:
            return _plan("retrieve", sufficiency, gap_records, evidence_ids, "permitted_retrieval",
                         queries=queries, retrieval=1)
        return _plan("clarify" if gaps else "defer", sufficiency, gap_records, evidence_ids,
                     "no_permitted_unseen_source")

    if sufficiency == "sufficient" and escalation == "direct":
        unsupported = decision.scores.get("risks", {}).get("unsupported_commitment", 0)
        if unsupported >= DEFAULT_SCORE_THRESHOLD:
            return _plan("clarify", sufficiency, gap_records, evidence_ids, "unsupported_commitment")
        return _plan("reply", sufficiency, gap_records, evidence_ids, "sufficient_grounded_context", unresolved=[])
    if escalation == "clarify":
        return _plan("clarify", sufficiency, gap_records, evidence_ids, "model_requested_clarification")
    return _plan("defer", sufficiency, gap_records, evidence_ids, "no_safe_action")
