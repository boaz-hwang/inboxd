import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1] / "evaluation-candidates" / "worker-legacy.py"
sys.path.insert(0, str(WORKER.parent.parent))
spec = importlib.util.spec_from_file_location("reply_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerContract(unittest.TestCase):
    def test_missing_model_abstains_without_import_or_network(self):
        result = worker.ReplyWorker().handle({"id": "missing"})
        self.assertEqual(result["status"], "abstained")
        self.assertIsNone(result["text"])

    def test_remote_model_id_is_not_downloaded(self):
        result = worker.ReplyWorker().handle({"id": "remote", "model_path": "mlx-community/Qwen3-4B-4bit"})
        self.assertEqual(result["error"], "local_model_directory_required")

    def test_snapshot_preserves_roles_unseen_and_reply(self):
        compiled, omitted = worker.compile_prompt({"context": [
            {"message_id": "a", "author_role": "unknown", "author_id": "a", "body": "old", "ts": 1},
            {"message_id": "b", "author_role": "other", "author_id": "b", "body": "new", "ts": 2, "reply_to": "a"},
        ], "incoming_message_ids": ["b"]})
        snapshot = json.loads(compiled[1]["content"])
        self.assertFalse(snapshot["conversation"][0]["unseen"])
        self.assertEqual(snapshot["conversation"][0]["author_role"], "unknown")
        self.assertTrue(snapshot["conversation"][1]["unseen"])
        self.assertEqual(snapshot["conversation"][1]["reply_to"], "a")
        self.assertEqual(omitted, [])

    def test_telegram_member_departure_is_not_a_reply_target(self):
        compiled, omitted = worker.compile_prompt({"chat": {"platform": "telegram"}, "context": [
            {"message_id": "1", "author_role": "other", "body": "자료 감사합니다"},
            {"message_id": "2", "author_role": "other", "body": "[ChatDeleteMember]"},
        ], "incoming_message_ids": ["2"]})
        self.assertEqual(omitted, ["2"])
        self.assertEqual(json.loads(compiled[-1]["content"])["incoming_message_ids"], [])
        self.assertEqual(json.loads(compiled[-1]["content"])["conversation"][-1]["body"], "자료 감사합니다")

    def test_last_self_message_remains_context_but_is_not_a_reply_target(self):
        compiled, _ = worker.compile_prompt({"context": [
            {"message_id": "self-1", "author_role": "self", "body": "설계 파일 공유드립니다"},
        ], "incoming_message_ids": ["self-1"]})
        payload = json.loads(compiled[-1]["content"])
        self.assertEqual(payload["reply_mode"], "reply_other")
        self.assertEqual(payload["incoming_message_ids"], [])
        self.assertFalse(payload["conversation"][0]["unseen"])
        self.assertEqual(payload["conversation"][0]["body"], "설계 파일 공유드립니다")
        self.assertNotIn("continue_self", compiled[0]["content"])

    def test_read_other_last_can_generate_without_unseen_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", side_effect=["네, 감사합니다.", '{"supported":true,"reasonCode":"grounded"}']):
                result = engine.handle(self.request(directory, incoming_message_ids=[], context=[
                    {"message_id": "self-1", "author_role": "self", "body": "설계 파일 공유드립니다"},
                    {"message_id": "other-1", "author_role": "other", "body": "자료 감사합니다"}]))
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["text"], "네, 감사합니다.")
            self.assertEqual(result["model_input"][1], {"role": "assistant", "content": "설계 파일 공유드립니다"})

    def test_latest_self_abstains_before_any_model_call_for_both_operations(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            for operation in ("decide", "generate"):
                with patch.object(engine, "generate_text") as generate:
                    result = engine.handle(self.request(directory, op=operation, incoming_message_ids=[], context=[
                        {"message_id": "other-1", "author_role": "other", "body": "파일 보내 주세요"},
                        {"message_id": "self-1", "author_role": "self", "body": "설계 파일 공유드립니다"}]))
                self.assertEqual(result["status"], "abstained")
                self.assertEqual(result["error"], "no_reply_target")
                self.assertIsNone(result["text"])
                generate.assert_not_called()

    def test_latest_self_is_non_actionable_even_without_model_installation(self):
        engine = worker.ReplyWorker()
        with patch.object(engine, "generate_text") as generate:
            result = engine.handle({"id": "self-only", "context": [
                {"message_id": "self-1", "author_role": "self", "body": "자료 보냈습니다"}]})
        self.assertEqual((result["status"], result["error"]), ("abstained", "no_reply_target"))
        generate.assert_not_called()

    def test_telegram_service_event_after_self_does_not_create_target(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text") as generate:
                result = engine.handle(self.request(directory, chat={"platform": "telegram"}, context=[
                    {"message_id": "self-1", "author_role": "self", "body": "자료 보냈습니다"},
                    {"message_id": "service-1", "author_role": "other", "body": "[ChatDeleteMember]"}]))
            self.assertEqual((result["status"], result["error"]), ("abstained", "no_reply_target"))
            generate.assert_not_called()

    def test_truncation_keeps_latest_and_discloses_omitted(self):
        compiled, omitted = worker.compile_prompt({"context": [
            {"message_id": str(i), "body": "가" * 8000} for i in range(5)
        ], "incoming_message_ids": ["4"]})
        snapshot = json.loads(compiled[1]["content"])
        self.assertEqual(snapshot["conversation"][-1]["message_id"], "4")
        self.assertTrue(omitted)
        self.assertEqual(snapshot["omitted_message_ids"], omitted)

    def test_invalid_frame_does_not_poison_following_request(self):
        result = subprocess.run([sys.executable, str(WORKER)], input='bad json\n{"id":"next"}\n',
                                text=True, capture_output=True, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(responses[0]["error"], "invalid_json")
        self.assertEqual(responses[1]["id"], "next")
        self.assertEqual(responses[1]["status"], "abstained")

    def request(self, directory, **overrides):
        Path(directory, "config.json").write_text("{}")
        return {"id": "synthetic", "model_path": directory,
                "context": [{"message_id": "a", "author_role": "other", "author_id": "friend",
                             "body": "사진 고마워!", "ts": 1}], "incoming_message_ids": ["a"], **overrides}

    def test_decision_correlates_caller_metadata_and_validates_proposal(self):
        proposal = {"response": "respond", "sufficiency": "sufficient", "gaps": ["not_applicable"],
                    "sources": [], "risks": ["not_applicable"], "escalation": "direct", "uncertain": False}
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", return_value=json.dumps(proposal)):
                result = engine.handle(self.request(directory, op="decide"))
            self.assertEqual(result["status"], "decided")
            self.assertEqual(result["plan"]["action"], "reply")
            self.assertEqual(result["decision"]["stateId"], result["state_id"])

    def test_grounding_check_withholds_unsupported_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", side_effect=["내일 3시 가능해요", '{"supported":false,"reasonCode":"unsupported_commitment"}']) as generate:
                result = engine.handle(self.request(directory, plan={"action": "clarify"}))
            self.assertEqual(result["status"], "failed")
            self.assertIsNone(result["text"])
            self.assertEqual([step["node_type"] for step in result["steps"]], ["generate", "check"])
            self.assertEqual(generate.call_count, 2)

    def test_model_abstention_fails_once_without_regeneration(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", return_value="<ABSTAIN>") as generate:
                result = engine.handle(self.request(directory))
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["error"], "model_abstained")
            self.assertIsNone(result["text"])
            self.assertEqual(generate.call_count, 1)
            self.assertEqual([step["node_type"] for step in result["steps"]], ["generate"])

    def test_explicit_grounding_approval_does_not_require_redundant_reason_code(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", side_effect=["혹시 파일 확인은 잘 되셨나요?", '{"supported":true,"reason":"발신자가 수신자에게 묻는 올바른 후속 질문"}']):
                result = engine.handle(self.request(directory, incoming_message_ids=[], context=[
                    {"message_id": "self-1", "author_role": "self", "body": "설계 파일 공유드립니다"},
                    {"message_id": "other-1", "author_role": "other", "body": "파일 확인은 잘 되셨나요?"}]))
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["steps"][-1]["decision"]["reasonCode"], "grounded")
            check_context = json.loads(result["check_input"][-1]["content"])["context"]
            self.assertEqual(set(check_context), {"conversation", "reply_mode", "evidence"})
            self.assertNotIn("response_strategy", check_context)
            self.assertNotIn("instruction", check_context)

    def test_contradictory_grounding_approval_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", side_effect=["내일 만나겠습니다", '{"supported":true,"reasonCode":"unsupported_commitment"}']) as generate:
                result = engine.handle(self.request(directory))
            self.assertEqual(result["status"], "failed")
            self.assertIsNone(result["text"])
            self.assertEqual(generate.call_count, 2)

    def test_unverified_url_adds_destination_boundary_to_first_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            unrelated_evidence = [{"id":"fact-1","excerpt":"담당자는 김대리"}]
            with patch.object(engine, "generate_text", side_effect=[
                "링크는 받았습니다. 정확한 위치는 확인해 보겠습니다.",
                '{"supported":true,"reasonCode":"grounded"}',
            ]):
                result = engine.handle(self.request(directory, context=[
                    {"message_id":"url-1","author_role":"other","body":"여기 맞지요? https://example.com"}
                ], incoming_message_ids=["url-1"], evidence=unrelated_evidence))
            self.assertEqual(result["status"], "ready")
            self.assertIn("URL 문자열 자체는 목적지 내용을 증명하지 않습니다", result["model_input"][-1]["content"])

    def test_checker_failure_retains_generation_step_and_withholds_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", side_effect=["고마워!", RuntimeError("private library detail")]):
                result = engine.handle(self.request(directory))
            self.assertEqual(result["status"], "failed")
            self.assertIsNone(result["text"])
            self.assertEqual([step["node_type"] for step in result["steps"]], ["generate", "check"])
            self.assertEqual(result["steps"][-1]["status"], "failed")
            self.assertNotIn("private library detail", json.dumps(result))

    def test_invalid_decision_does_not_become_a_fake_reply(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, "generate_text", return_value="형식을 따르지 않은 문장"):
                result = engine.handle(self.request(directory, op="decide"))
            self.assertEqual(result["status"], "failed")
            self.assertIsNone(result["text"])
            self.assertEqual(result["raw_proposal"], "형식을 따르지 않은 문장")
            self.assertTrue(result["state"])
            self.assertTrue(result["model_input"])

    def test_active_adapter_must_match_reviewed_artifact_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            adapter = root / "adapter"
            adapter.mkdir()
            weights = adapter / "adapters.safetensors"
            weights.write_bytes(b"reviewed synthetic artifact")
            version = hashlib.sha256(weights.read_bytes()).hexdigest()
            (adapter / "adapter_config.json").write_text("{}")
            (adapter / "manifest.json").write_text(json.dumps({"status": "complete", "mode": "train", "base_model_id": "base-id", "dataset_id": "data-id"}))
            registry = root / "active.json"
            registry.write_text(json.dumps({"active": {"path": str(adapter), "base_model_id": "base-id", "dataset_id": "data-id", "adapter_version": version}}))
            engine = worker.ReplyWorker()
            engine.path = root
            engine.base_identities[str(root)] = "base-id"
            self.assertEqual(engine.personal_adapter({"adapter_registry": str(registry)})[1], version)
            weights.write_bytes(b"unreviewed changed weights")
            self.assertEqual(engine.personal_adapter({"adapter_registry": str(registry)}), (None, "base", "adapter_digest_mismatch"))


if __name__ == "__main__":
    unittest.main()
