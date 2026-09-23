"""Production contract: preflight first, at most one inference, no post-check."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / "worker.py"
spec = importlib.util.spec_from_file_location("single_reply_worker", PATH)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SingleReplyTest(unittest.TestCase):
    def request(self, directory, **kwargs):
        Path(directory, "config.json").write_text("{}")
        return {"id": "test", "model_path": directory, "context": [
            {"message_id": "1", "author_id": "me", "author_role": "self", "ts": 1, "body": "자료 보내드립니다."},
            {"message_id": "2", "author_id": "them", "author_role": "other", "ts": 2,
             "body": "감사합니다!", "reply_to": "1"}], **kwargs}

    def test_one_call_sees_validated_roles_references_style_and_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", return_value="네, 감사합니다.") as generate:
                result = engine.handle(self.request(directory))
            generate.assert_called_once()
            self.assertEqual(result["status"], "ready")
            self.assertEqual([s["node_type"] for s in result["steps"]], ["generate"])
            payload = json.loads(generate.call_args.args[0][0]["content"].split("메타데이터: ", 1)[1])
            self.assertEqual(payload["preflight"]["reply_target_id"], "2")
            self.assertEqual(payload["preflight"]["missing_reply_ids"], [])
            self.assertEqual(payload["turn_metadata"][0]["author_id"], "me")
            self.assertEqual(payload["turn_metadata"][1]["reply_to"], "1")
            self.assertIn("calendar", payload["preflight"]["unavailable_information"])
            self.assertNotIn("check_input", result)

    def test_preflight_abstains_without_model_for_self_unknown_missing_parent(self):
        for message, reason in [
            ({"author_role": "self"}, "no_reply_target"),
            ({"author_role": "unknown"}, "unknown_reply_author"),
            ({"author_role": "other", "reply_to": "absent"}, "missing_reply_context"),
        ]:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text") as generate:
                result = engine.handle({"id": "test", "context": [{"message_id": "m", "body": "hello", **message}]})
            self.assertEqual((result["status"], result["error"]), ("abstained", reason))
            generate.assert_not_called()

    def test_empty_and_abstain_are_no_suggestion_not_runtime_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            for text in ("", "<ABSTAIN>"):
                engine = worker.ReplyWorker()
                with patch.object(engine, "generate_text", return_value=text) as generate:
                    result = engine.handle(self.request(directory))
                generate.assert_called_once()
                self.assertEqual(result["status"], "abstained")
                self.assertIsNone(result["text"])

    def test_future_intent_is_not_sent_to_second_model_for_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", side_effect=["확인해 보겠습니다.", AssertionError("second call")]) as generate:
                result = engine.handle(self.request(directory))
            self.assertEqual(result["text"], "확인해 보겠습니다.")
            generate.assert_called_once()

    def test_runtime_and_malformed_outputs_are_errors_without_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            for output in (RuntimeError("private detail"), "<think>unfinished", "```json\n{}", "a"*4001):
                engine = worker.ReplyWorker()
                with patch.object(engine, "generate_text", side_effect=[output]) as generate:
                    result = engine.handle(self.request(directory))
                generate.assert_called_once()
                self.assertEqual(result["status"], "failed")
                self.assertIsNone(result["text"])
                self.assertNotIn("private detail", json.dumps(result))

    def test_truncation_cannot_silently_drop_explicit_reply_parent(self):
        context = [{"message_id": str(i), "author_role": "other", "body": "가"*8000} for i in range(5)]
        context[-1]["reply_to"] = "0"
        compiled, omitted = worker.compile_prompt({"context": context})
        payload = json.loads(compiled[-1]["content"])
        self.assertIn("0", omitted)
        self.assertEqual(payload["preflight"]["reason"], "missing_reply_context")

    def test_ambiguous_identity_and_order_fail_before_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            for context in ([{"message_id": "m", "body": "a"}]*2,
                            [{"message_id": "a", "body": "a", "ts": 2}, {"message_id": "b", "body": "b", "ts": 1}]):
                engine = worker.ReplyWorker()
                with patch.object(engine, "generate_text") as generate:
                    result = engine.handle(self.request(directory, context=context))
                self.assertEqual(result["status"], "failed")
                generate.assert_not_called()

    def test_no_model_is_runtime_failure_and_remote_id_never_downloads(self):
        engine = worker.ReplyWorker()
        base = {"id": "test", "context": [{"message_id": "m", "body": "hello", "author_role": "other"}]}
        with patch.dict(worker.os.environ, {}, clear=True):
            self.assertEqual(engine.handle(base)["error"], "model_not_installed")
        self.assertEqual(engine.handle({**base, "model_path": "remote/model"})["error"], "local_model_directory_required")
