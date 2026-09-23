from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from evaluation import brier_score, multilabel_metrics, temporal_split, validate_labelled_dataset  # noqa: E402


class EvaluationContract(unittest.TestCase):
    def test_masks_unobserved_heads_and_prevents_conversation_leakage(self):
        records = [
            {"example_id": "a", "observed_at": "2026-01-01T00:00:00Z", "conversation_id": "same",
             "labels": {"response": "respond"}, "valid_heads": ["response"], "evidence": []},
            {"example_id": "b", "observed_at": "2026-02-01T00:00:00Z", "conversation_id": "other",
             "labels": {"gaps": ["availability"]}, "valid_heads": ["gaps"], "evidence": ["e1"]},
            {"example_id": "c", "observed_at": "2026-03-01T00:00:00Z", "conversation_id": "same",
             "labels": {"response": "no_reply"}, "valid_heads": ["response"], "evidence": []},
        ]
        examples = validate_labelled_dataset(records)
        train, validation, test = temporal_split(examples, train_fraction=0.34, validation_fraction=0.33)
        partitions = [{item.conversation_id for item in values} for values in (train, validation, test)]
        self.assertFalse(partitions[0] & partitions[1])
        self.assertFalse(partitions[0] & partitions[2])
        self.assertFalse(partitions[1] & partitions[2])

    def test_rejects_labels_for_heads_not_observed(self):
        with self.assertRaisesRegex(ValueError, "label_validity_mismatch"):
            validate_labelled_dataset([{
                "example_id": "a", "observed_at": "2026-01-01T00:00:00Z", "conversation_id": "c",
                "labels": {"response": "respond"}, "valid_heads": [], "evidence": [],
            }])

    def test_metrics_are_explicit_about_empty_denominators(self):
        self.assertAlmostEqual(brier_score([{"yes": 0.8, "no": 0.2}], ["yes"]), 0.08)
        self.assertEqual(multilabel_metrics([set()], [set()]), {"precision": None, "recall": None})


if __name__ == "__main__":
    unittest.main()
