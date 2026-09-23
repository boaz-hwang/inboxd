import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from generation_prompt import build_generation_input


def compiled():
    return [{"role": "system", "content": "시스템 지시"},
            {"role": "user", "content": "컴파일된 기록"}]


class GenerationPromptContract(unittest.TestCase):
    def test_keeps_participant_and_reply_target_without_extra_user_turn(self):
        payload = {"reply_mode": "reply_other", "evidence": [], "conversation": [
            {"message_id": "s1", "author_role": "self", "author_id": "me",
             "reply_to": None, "unseen": False, "body": "자료는 PDF로 부탁드립니다."},
            {"message_id": "o1", "author_role": "other", "author_id": "teacher",
             "reply_to": "s1", "unseen": True, "body": "최종 자료는 어떤 형식으로 드릴까요?"},
        ]}
        result = build_generation_input(compiled(), payload, "reply")
        self.assertEqual([row["role"] for row in result],
                         ["system", "assistant", "user", "user"])
        self.assertEqual(result[1]["content"], payload["conversation"][0]["body"])
        self.assertIn('"author_id":"teacher"', result[-1]["content"])
        self.assertIn('"reply_to_author_role":"self"', result[-1]["content"])
        self.assertIn("내가 상대에게 같은 자료나 피드백을 달라고", result[-1]["content"])
        self.assertEqual(result[-1]["content"].count("작성 지시:"), 1)

    def test_self_continuation_does_not_require_a_question(self):
        payload = {"reply_mode": "continue_self", "conversation": [
            {"message_id": "s1", "author_role": "self", "author_id": "me",
             "reply_to": None, "unseen": False, "body": "내용 확인했습니다."},
        ]}
        result = build_generation_input(compiled(), payload, "reply")
        self.assertIn("이미 확인하거나 확정한 내용을 다시 묻지 마세요", result[-1]["content"])
        self.assertIn("실제로 미해결된 내용이 있을 때만", result[-1]["content"])
        self.assertNotIn("후속 질문 한 문장만", result[-1]["content"])

    def test_clarify_keeps_request_actor_and_unverified_url_boundary(self):
        payload = {"reply_mode": "reply_other", "conversation": [
            {"message_id": "o1", "author_role": "other", "author_id": "them",
             "reply_to": None, "unseen": True,
             "body": "이 링크에 수업 피드백 공유해 주실 수 있나요? https://example.com"},
        ]}
        result = build_generation_input(compiled(), payload, "clarify")
        self.assertIn("요청받은 사람은 나입니다", result[-1]["content"])
        self.assertIn("목적지 정보가 대화나 근거에 없으면", result[-1]["content"])
        self.assertIn("그룹 메시지는 나를 수신자로 단정하지 마세요", result[-1]["content"])


if __name__ == "__main__":
    unittest.main()
