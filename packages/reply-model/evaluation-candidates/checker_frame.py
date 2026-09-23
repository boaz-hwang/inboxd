"""Isolated checker experiment: extract speaker/action direction before verdict.

The baseline policy, input and non-thinking model settings remain unchanged.
Only the requested JSON output structure is replaced. This is not imported by
the production worker until independently evaluated.
"""


def frame_first_variant(baseline_messages):
    old = (
        '오직 JSON {"supported":true|false,"reasonCode":"grounded|unsupported_commitment|'
        'role_confusion|unsupported_fact","reason":"초안의 구체적인 표현과 실제 발화자를 근거로 한 한 문장 설명"}를 출력하세요.'
    )
    new = (
        "원문의 관련 발언과 초안에서 화자 및 행동 주체를 먼저 추출하세요. "
        "source_actor는 관련 원문 발언자, requested_actor는 원문에서 행동을 요청받은 사람, "
        "draft_actor는 초안에서 행동을 요청받거나 하겠다고 말한 사람입니다. "
        "각 값은 self, other, unknown 중 하나이며, 근거가 없거나 그룹 대화에서 수신자가 "
        "불명확하면 unknown을 사용하세요. 다만 unknown 자체가 거절 사유는 아닙니다. "
        "관련 원문 message_id와 짧은 원문 인용을 남긴 뒤 기존 검토 규칙대로 판단하세요. "
        '오직 JSON {"source_message_id":"문자열 또는 빈 문자열",'
        '"source_quote":"짧은 원문 인용",'
        '"source_actor":"self|other|unknown",'
        '"requested_actor":"self|other|unknown",'
        '"draft_actor":"self|other|unknown",'
        '"reason":"초안의 구체적인 표현과 실제 발화자를 근거로 한 한 문장 설명",'
        '"reasonCode":"grounded|unsupported_commitment|role_confusion|unsupported_fact",'
        '"supported":true|false}를 출력하세요.'
    )
    changed = [dict(message) for message in baseline_messages]
    if old not in changed[0]["content"]:
        raise ValueError("unexpected_baseline_checker_prompt")
    changed[0]["content"] = changed[0]["content"].replace(old, new)
    return changed
