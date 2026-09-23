"""Evaluation scoring must not reward malformed checker output."""
import importlib.util
from pathlib import Path
import unittest


WORKER_DIR = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "evaluation_accuracy", WORKER_DIR / "evaluation_accuracy.py")
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


class CheckerScoringTest(unittest.TestCase):
    def test_malformed_and_contradictory_outputs_never_count_as_correct_rejection(self):
        expected = {"supported": False, "reasonCode": "role_confusion"}
        invalid = [
            None, "false", {}, {"supported": "false", "reasonCode": "role_confusion"},
            {"supported": 0, "reasonCode": "role_confusion"},
            {"supported": False},
            {"supported": False, "reasonCode": "check_output_invalid"},
            {"supported": True, "reasonCode": "role_confusion"},
            {"supported": False, "reasonCode": "grounded"},
        ]
        for check in invalid:
            with self.subTest(check=check):
                score = evaluation.score_checker_verdict(check, expected)
                self.assertFalse(score["coherent_verdict"])
                self.assertFalse(score["verdict_correct"])
                self.assertFalse(score["strict_reason_correct"])

    def test_approved_and_rejected_verdicts_score_separately_from_reason(self):
        approved = {"supported": True, "reasonCode": "grounded"}
        rejected = {"supported": False, "reasonCode": "unsupported_fact"}
        self.assertTrue(evaluation.score_checker_verdict(approved, approved)["strict_reason_correct"])
        self.assertTrue(evaluation.score_checker_verdict(rejected, rejected)["strict_reason_correct"])
        wrong_reason = evaluation.score_checker_verdict(
            rejected, {"supported": False, "reasonCode": "role_confusion"})
        self.assertTrue(wrong_reason["verdict_correct"])
        self.assertFalse(wrong_reason["strict_reason_correct"])
        wrong_verdict = evaluation.score_checker_verdict(
            rejected, {"supported": True, "reasonCode": "grounded"})
        self.assertFalse(wrong_verdict["verdict_correct"])

    def test_no_reply_target_is_unscored_but_checker_failure_is_wrong(self):
        expected = {"supported": False, "reasonCode": "role_confusion"}
        skipped = evaluation.score_case_result(
            {"status": "abstained", "error": "no_reply_target"}, {}, expected)
        self.assertTrue(skipped["eligibility_skipped"])
        self.assertIsNone(skipped["verdict_correct"])
        self.assertIsNone(skipped["strict_reason_correct"])
        failed = evaluation.score_case_result(
            {"status": "failed", "error": "local_grounding_check_failed"}, {}, expected)
        self.assertFalse(failed["eligibility_skipped"])
        self.assertFalse(failed["verdict_correct"])


if __name__ == "__main__":
    unittest.main()
