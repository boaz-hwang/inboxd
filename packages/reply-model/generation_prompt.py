"""Build the local model's drafting input from the compiled conversation.

The compiler owns truncation and source identity. This module only presents that
same snapshot to the generator; it never guesses an addressee or a missing fact.
"""

import json
import re


def build_generation_input(compiled, payload, action):
    """Return one role-aligned conversation followed by one drafting request."""
    conversation = payload["conversation"]
    by_id = {message["message_id"]: message for message in conversation}
    metadata = []
    for message in conversation:
        row = {key: message.get(key) for key in
               ("message_id", "author_role", "author_id", "reply_to", "unseen")}
        parent = by_id.get(str(message.get("reply_to")))
        if parent is not None:
            row["reply_to_author_role"] = parent["author_role"]
            row["reply_to_author_id"] = parent.get("author_id")
        metadata.append(row)

    # Keep the actual utterances as chat-template turns. Repeating their bodies
    # inside a final JSON request makes the latest synthetic user turn look like
    # another participant's message to a small model.
    turns = [{"role": "assistant" if message["author_role"] == "self" else "user",
              "content": message["body"]} for message in conversation]
    if payload["reply_mode"] == "continue_self":
        task = (
            "마지막 발언은 내가 이미 보낸 말이며 그 뒤 상대 답장은 없습니다. "
            "이미 확인하거나 확정한 내용을 다시 묻지 마세요. "
            "실제로 미해결된 내용이 있을 때만 상대에게 질문하고, 그렇지 않으면 "
            "내 관점에서 필요한 보충이나 자연스러운 마무리 한 문장을 쓰세요. "
            "내가 보낸 자료를 내가 받은 것처럼 말하지 마세요."
        )
    elif action == "clarify":
        task = (
            "상대의 마지막 실제 발언에 내가 보낼 답장 한 문장을 쓰세요. "
            "상대가 내 일정, 결정, 자료나 피드백을 요청했다면 요청받은 사람은 나입니다. "
            "내게 근거가 없는 사항은 확인이 필요하다고 말하되, 상대의 요청을 "
            "상대에게 그대로 되돌려 묻지 마세요. 근거 없는 확정이나 완료 주장을 하지 마세요."
        )
    else:
        task = (
            "상대의 마지막 실제 발언에 내가 보낼 자연스러운 답장 한 문장을 쓰세요. "
            "발언별로 누가 누구에게 무엇을 요청했는지 확인하세요. "
            "상대가 내게 자료나 피드백을 요청한 경우, 내가 상대에게 같은 자료나 "
            "피드백을 달라고 역할을 뒤집지 마세요. 이미 대화에 있는 내 답이나 "
            "결정은 그대로 사용하세요."
        )
    task += (
        " reply_to가 없는 그룹 메시지는 나를 수신자로 단정하지 마세요. "
        "메타데이터의 author_id와 reply_to는 실제 기록이고, 본문에서 추측한 "
        "수신자는 확정 사실이 아닙니다. 답장 문장만 출력하세요."
    )
    if any(re.search(r"https?://", message["body"], flags=re.I)
           for message in conversation):
        task += (
            " URL 문자열만으로 링크 목적지의 장소나 내용을 확인했다고 말하지 마세요. "
            "목적지 정보가 대화나 근거에 없으면 확인이 필요하다고 표현하세요."
        )
    request = {
        "reply_mode": payload["reply_mode"],
        "response_strategy": action,
        "evidence": payload.get("evidence", []),
        "turn_metadata": metadata,
    }
    return [compiled[0], *turns, {"role": "user", "content":
            "대화 기록의 발언 순서에 대응하는 메타데이터와 근거(JSON): "
            + json.dumps(request, ensure_ascii=False, separators=(",", ":"))
            + "\n작성 지시: " + task}]
