"""One predeclared instruction-only development ablation; no production edit."""
from copy import deepcopy

VARIANT = 'ordered_self_state_instruction_v1'
FINAL_INSTRUCTION = (
    '위 마지막 상대 발언에 내가 보낼 짧은 답장 한두 문장만 쓰세요. 다음 순서로 판단하세요. '
    '먼저 발화자와 답장 대상을 구분하고, 주제별로 대화에서 내가 마지막으로 명시한 결정을 확인하세요. '
    '내 최신 거절·취소·보류는 이전 승인이나 상대의 재요청보다 우선합니다. '
    '내 승인은 내가 명시한 대상·행동·조건에만 적용하고 다른 요청으로 확대하지 마세요. '
    '이미 정한 내용은 유지하고, 결정하지 않은 부분만 확인하거나 필요한 정보를 요청하세요. '
    '일정·가능 여부를 모르면 확인해서 알려주겠다고 답할 수 있지만, 요청된 시각이나 행동을 새로 약속하지 마세요. '
    '검토 요청에는 앞으로 검토하겠다는 의향을, 감사에는 자연스러운 인사를 답할 수 있습니다. '
    '완료·오프라인 합의·링크나 첨부 내용·표현하지 않은 내 의사를 만들지 마세요. '
    '추측 없이 유용한 확인·질문·인사를 할 수 있으면 답하고, 답장이 필요 없거나 그런 답도 불가능할 때만 <ABSTAIN>을 쓰세요. '
    '판단 과정이나 설명은 출력하지 말고 내 기존 말투를 따르세요.'
)


def compile_final_instruction(messages):
    """Replace exactly one final user instruction, preserving every prior byte."""
    if (not isinstance(messages, list) or len(messages) < 2
            or messages[-1].get('role') != 'user'
            or not isinstance(messages[-1].get('content'), str)
            or messages[0].get('role') != 'system'):
        raise ValueError('existing_system_and_final_user_instruction_required')
    result = deepcopy(messages)
    result[-1]['content'] = FINAL_INSTRUCTION
    if result[:-1] != messages[:-1] or result[-1]['role'] != messages[-1]['role']:
        raise ValueError('instruction_only_boundary')
    return result
