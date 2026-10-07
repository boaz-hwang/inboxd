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
    def test_unseen_state_distinguishes_unknown_from_known_empty(self):
        context = [{"message_id": "m", "author_role": "other", "author_id": "them", "ts": 1, "body": "안녕"}]
        unknown, _ = worker.compile_prompt({"context": context, "incoming_message_ids": None})
        known, _ = worker.compile_prompt({"context": context, "incoming_message_ids": []})
        u = json.loads(unknown[-1]["content"])
        k = json.loads(known[-1]["content"])
        self.assertIsNone(u["conversation"][0]["unseen"])
        self.assertFalse(k["conversation"][0]["unseen"])
        self.assertEqual(u["preflight"]["unseen_state"], "unknown")
        self.assertEqual(k["preflight"]["unseen_state"], "known")

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
            self.assertEqual(payload["preflight"]["reply_target_id"], 1)
            self.assertEqual(payload["preflight"]["missing_reply_ids"], [])
            self.assertEqual(payload["turn_metadata"][0][2], "me")
            self.assertEqual(payload["turn_metadata"][1][4], 0)
            self.assertIn("calendar", payload["preflight"]["unavailable_information"])
            self.assertNotIn("check_input", result)

    def test_compact_metadata_is_decodable_without_changing_source_or_roles(self):
        context = [
            {'message_id': 'one', 'author_id': 'same-author', 'author_role': 'other', 'ts': 1700000001.5, 'body': 'first', 'reply_to': 'external-a'},
            {'message_id': 'two', 'author_id': 'owner', 'author_role': 'self', 'ts': 1700000002, 'body': 'self'},
            {'message_id': 'three', 'author_id': 'same-author', 'author_role': 'unknown', 'ts': None, 'body': 'unknown', 'reply_to': 'external-b'},
            {'message_id': 'four', 'author_id': 'same-author', 'author_role': 'other', 'ts': 1700000004, 'body': 'target', 'reply_to': 'one'},
        ]
        for incoming in (None, [], ['four']):
            compiled, _ = worker.compile_prompt({'context': context, 'incoming_message_ids': incoming})
            before = json.dumps(compiled, ensure_ascii=False)
            raw = json.loads(compiled[-1]['content'])
            generation = worker.build_generation_input(compiled)
            compact = json.loads(generation[0]['content'].split('메타데이터: ', 1)[1])
            self.assertEqual(json.dumps(compiled, ensure_ascii=False), before)
            self.assertEqual(compact['turn_fields'], ['message_id', 'author_role', 'author_id', 'ts', 'reply_to', 'unseen'])
            # Independent inverse mapping from the unchanged authoritative source.
            inverse = {i: message['message_id'] for i, message in enumerate(raw['conversation'])}
            absent = []
            for message in raw['conversation']:
                parent = message['reply_to']
                if parent is not None and parent not in inverse.values() and parent not in absent:
                    absent.append(parent)
            inverse.update({len(raw['conversation']) + i: parent for i, parent in enumerate(absent)})
            decoded = []
            for values in compact['turn_metadata']:
                message = dict(zip(compact['turn_fields'], values))
                message['message_id'] = inverse[message['message_id']]
                if message['reply_to'] is not None:
                    message['reply_to'] = inverse[message['reply_to']]
                decoded.append(message)
            self.assertEqual(decoded, [{k: v for k, v in m.items() if k != 'body'} for m in raw['conversation']])
            preflight = dict(compact['preflight'])
            preflight['reply_target_id'] = inverse[preflight['reply_target_id']]
            preflight['missing_reply_ids'] = [inverse[i] for i in preflight['missing_reply_ids']]
            self.assertEqual(preflight, raw['preflight'])
            self.assertEqual(generation[1:-1], [{'role': 'assistant' if m['author_role'] == 'self' else 'user', 'content': m['body']} for m in raw['conversation']])
            self.assertEqual(compact['turn_metadata'][0][2], compact['turn_metadata'][3][2])
            self.assertEqual(compact['preflight']['reply_target_id'], compact['turn_metadata'][-1][0])
            self.assertEqual(generation[-2]['role'], 'user')
            self.assertIsNone(compact['turn_metadata'][1][4])
            if incoming is None:
                self.assertTrue(all(m[5] is None for m in compact['turn_metadata']))
            else:
                self.assertFalse(compact['turn_metadata'][1][5])
                self.assertEqual(compact['turn_metadata'][-1][5], bool(incoming))

    def test_prompt_version_rejects_old_cached_input_and_matches_rust(self):
        rust = PATH.parents[2] / 'crates/inboxd-storage/src/responses.rs'
        self.assertIn('const PROMPT_VERSION: &str = "reply-v4";', rust.read_text())
        self.assertEqual(worker.PROMPT_VERSION, 'reply-v4')
        with tempfile.TemporaryDirectory() as directory:
            engine = worker.ReplyWorker()
            with patch.object(engine, 'generate_text', return_value='synthetic reply') as generate:
                old = engine.handle(self.request(directory, prompt_version='reply-v3'))
                self.assertEqual(old['error'], 'unsupported_prompt_version')
                generate.assert_not_called()
                current = engine.handle(self.request(directory, prompt_version='reply-v4'))
                self.assertEqual(current['status'], 'ready')
                self.assertEqual(current['prompt_version'], 'reply-v4')
                generate.assert_called_once()

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
