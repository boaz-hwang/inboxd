"""Small, dependency-free validation and evaluation helpers for CIM labels."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterable, Mapping, Sequence

from context_intelligence import (
    ESCALATION_LABELS, GAP_LABELS, RESPONSE_LABELS, RISK_LABELS, SUFFICIENCY_LABELS,
)


@dataclass(frozen=True)
class LabelledExample:
    example_id: str
    observed_at: str
    conversation_id: str
    labels: dict[str, Any]
    valid_heads: tuple[str, ...]
    evidence: tuple[str, ...]


def validate_labelled_dataset(records: Iterable[Mapping[str, Any]]) -> list[LabelledExample]:
    """Validate reviewed labels; unobserved heads must stay masked."""
    result: list[LabelledExample] = []
    seen: set[str] = set()
    categorical = {
        "response": set(RESPONSE_LABELS), "sufficiency": set(SUFFICIENCY_LABELS),
        "escalation": set(ESCALATION_LABELS),
    }
    multilabel = {"gaps": set(GAP_LABELS), "risks": set(RISK_LABELS)}
    for raw in records:
        if not isinstance(raw, Mapping):
            raise ValueError("invalid_label_record")
        example_id = raw.get("example_id")
        observed_at = raw.get("observed_at")
        conversation_id = raw.get("conversation_id")
        if not all(isinstance(value, str) and value for value in (example_id, observed_at, conversation_id)):
            raise ValueError("invalid_label_identity")
        if example_id in seen:
            raise ValueError("duplicate_label_example")
        seen.add(example_id)
        try:
            datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("invalid_label_time") from error
        labels = raw.get("labels")
        valid_heads = raw.get("valid_heads")
        if not isinstance(labels, Mapping) or not isinstance(valid_heads, list) or set(labels) != set(valid_heads):
            raise ValueError("label_validity_mismatch")
        clean: dict[str, Any] = {}
        for head, value in labels.items():
            if head in categorical:
                if value not in categorical[head]:
                    raise ValueError(f"invalid_{head}_label")
                clean[head] = value
            elif head in multilabel:
                if not isinstance(value, list) or not set(value).issubset(multilabel[head]):
                    raise ValueError(f"invalid_{head}_labels")
                clean[head] = list(dict.fromkeys(value))
            elif head == "sources":
                if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
                    raise ValueError("invalid_sources_labels")
                clean[head] = list(dict.fromkeys(value))
            else:
                raise ValueError("invalid_label_head")
        evidence = raw.get("evidence", [])
        if not isinstance(evidence, list) or not all(isinstance(item, str) for item in evidence):
            raise ValueError("invalid_label_evidence")
        result.append(LabelledExample(example_id, observed_at, conversation_id, clean,
                                      tuple(valid_heads), tuple(evidence)))
    return result


def temporal_split(
    examples: Sequence[LabelledExample], *, train_fraction: float = 0.7, validation_fraction: float = 0.15,
) -> tuple[list[LabelledExample], list[LabelledExample], list[LabelledExample]]:
    """Time split while keeping a conversation wholly in its earliest partition."""
    if not 0 < train_fraction < 1 or not 0 <= validation_fraction < 1 or train_fraction + validation_fraction >= 1:
        raise ValueError("invalid_split_fraction")
    ordered = sorted(examples, key=lambda item: (item.observed_at, item.example_id))
    train_cut = int(len(ordered) * train_fraction)
    validation_cut = int(len(ordered) * (train_fraction + validation_fraction))
    tentative = [ordered[:train_cut], ordered[train_cut:validation_cut], ordered[validation_cut:]]
    assigned: dict[str, int] = {}
    final: list[list[LabelledExample]] = [[], [], []]
    for partition, values in enumerate(tentative):
        for example in values:
            target = assigned.setdefault(example.conversation_id, partition)
            final[target].append(example)
    return final[0], final[1], final[2]


def brier_score(probabilities: Sequence[Mapping[str, float]], labels: Sequence[str]) -> float | None:
    if len(probabilities) != len(labels):
        raise ValueError("prediction_label_length_mismatch")
    if not labels:
        return None
    total = 0.0
    for scores, truth in zip(probabilities, labels):
        if truth not in scores:
            raise ValueError("missing_truth_score")
        total += sum((score - (1.0 if key == truth else 0.0)) ** 2 for key, score in scores.items())
    return total / len(labels)


def multilabel_metrics(predicted: Sequence[set[str]], truth: Sequence[set[str]]) -> dict[str, float | None]:
    if len(predicted) != len(truth):
        raise ValueError("prediction_label_length_mismatch")
    tp = sum(len(left & right) for left, right in zip(predicted, truth))
    fp = sum(len(left - right) for left, right in zip(predicted, truth))
    fn = sum(len(right - left) for left, right in zip(predicted, truth))
    return {
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
    }
