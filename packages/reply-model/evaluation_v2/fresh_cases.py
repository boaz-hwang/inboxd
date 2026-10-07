"""Independent, entirely invented Korean operational reply cases.

Authored without consulting supplemental training examples. No target reply strings:
rubrics assess meaning and permit equivalent natural answers.
"""

PROVENANCE = {
    'kind': 'synthetic', 'author': 'independent_evaluation_agent',
    'created_date': '2026-10-03', 'real_conversation_bodies': False,
    'supplemental_training_examples_inspected': False,
    'prior_evidence': 'real heldout 22 and old fixtures 4 are observed regression evidence only',
    'purpose': 'fresh pretraining-frozen operational behavior test; not personalization evidence',
}

GENERAL = {
    'role': 'Preserve self, each other speaker, requester, object owner, and action performer. Omitted subjects are acceptable when context makes the intended actor clear. Ambiguous actor resolution is uncertain, not automatically fail.',
    'fact': 'Assert only supported facts and decisions. Future intentions to ask/check are not completed actions. An actual new commitment contradicting a prior refusal fails. A grounded acknowledgment need not repeat every detail.',
    'abstain': 'Answer when a grounded response is available; reasonable checking/asking intentions are allowed. ABSTAIN is appropriate for requests clearly addressed to somebody else or no justified reply; do not demand abstention merely because an external fact is unknown.',
    'scoring': 'Semantic review, no keyword matching or exact answer. pass=supported/appropriate, fail=clear contradiction or unsupported claim, uncertain=meaning genuinely unresolved. usefulness/style 1 unusable, 2 substantial repair, 3 usable with minor repair, 4 good, 5 excellent. Judge refusal/request wording in context; polite acknowledgment alone does not necessarily authorize.',
}


def case(number, category, group, turns, role, fact, abstain, unseen='known'):
    """Turn = (stable speaker ID, body, optional zero-based reply target)."""
    prefix = f'fresh-{number:02d}'
    context = []
    for index, turn in enumerate(turns):
        author, body, *target = turn
        context.append({'message_id': f'{prefix}-m{index}',
            'author_role': 'self' if author == 'me' else 'other',
            'author_id': f'synthetic-{author}', 'body': body,
            'ts': 1790982000 + number * 300 + index * 19,
            'reply_to': f'{prefix}-m{target[0]}' if target else None})
    request = {'id': prefix, 'prompt_version': 'reply-v4',
        'chat': {'platform': ('kakao', 'telegram', 'slack')[number % 3],
                 'chat_id': prefix, 'kind': 'group' if group else 'dm'},
        'context': context}
    if unseen != 'unknown':
        request['incoming_message_ids'] = [context[-1]['message_id']] if unseen == 'known' else []
    return {'id': prefix, 'category': category, 'provenance': 'synthetic',
            'request': request, 'rubric': {'role': role, 'fact': fact, 'abstain': abstain}}


CASES = [
    case(1, 'role_dm_requester', False, [
        ('me', '제 필름 카메라 배터리가 나갔네요. 유진님 충전기 잠깐 빌릴 수 있을까요?'),
        ('yujin', '네, 제 건 책상 서랍에 있어요.'),
        ('me', '고마워요. 카메라 본체는 제가 가지고 있어요.'),
        ('yujin', '충전기 가지러 직접 오실래요, 제가 가져다드릴까요?', 0)],
        'Self is borrowing Yujin’s charger; self owns the camera. Do not ask Yujin to come collect self’s charger.',
        'Choosing a future handoff arrangement or asking where/when to collect is supported. Do not assert collection/charging already happened.',
        'A natural arrangement response is possible; blanket abstention is unnecessary.'),
    case(2, 'role_dm_actor', False, [
        ('sohee', '제 반려견 저녁 약은 제가 먹일게요. 산책만 부탁해요.'),
        ('me', '응, 산책은 내가 맡을게. 약은 소희가 챙기는 거지?'),
        ('sohee', '맞아. 산책 다녀오면 나한테 알려줘.')],
        'Self walks the dog; Sohee gives medicine. Do not assign the walk to Sohee or claim self gives medicine.',
        'Acknowledge intent to report after walking; no completed walk or medicine administration is evidenced.',
        'A brief grounded acknowledgment is useful; no abstention needed.'),
    case(3, 'role_group_owner', True, [
        ('hana', '청소년 합창단 마이크는 제 개인 물건이에요.'),
        ('me', '하나님 마이크는 제가 보관만 하고 있어요. 대여 결정은 하나님께 물어봐 주세요.'),
        ('minseok', '제 스피커는 내일 가져갈게요.'),
        ('hana', '마이크 문의가 오면 저한테 연결해 주세요.'),
        ('jiho', '보관하고 계신 분께 여쭤요. 마이크 빌리려면 누구에게 연락하면 되나요?', 1)],
        'Self is custodian; Hana owns and authorizes microphone loans. Jiho requests contact; Minseok’s speaker is a distractor.',
        'Direct Jiho to Hana; do not grant loan permission or invent a contact number.',
        'Known owner supports a direct answer; do not defer unnecessarily.'),
    case(4, 'role_group_reply_target', True, [
        ('me', '행사 안내문 교정은 제가 맡겠습니다.'),
        ('taeho', '주차 안내는 제가 확인할게요.'),
        ('sora', '태호님, 방문 차량 대수도 확인해 주실래요?', 1),
        ('taeho', '네, 차량 대수도 같이 확인하겠습니다.'),
        ('sora', '교정 맡으신 분은 오탈자만 봐 주세요. 문구는 바꾸지 말아 주세요.', 0)],
        'Reply is from self as proofreader, not Taeho as parking checker; honor targeted reply_to despite intervening turns.',
        'Accept checking typos only, without claiming the proofreading is finished or promising rewrites.',
        'Grounded acknowledgment is appropriate; no need to ask who should proofread.'),
    case(5, 'role_group_other_addressee', True, [
        ('me', '저는 이번 바자회에서는 사진 기록만 담당해요.'),
        ('nari', '입장 팔찌는 제가 인쇄해 뒀어요.'),
        ('jun', '나리님, 그 팔찌를 정문으로 가져와 주세요.', 1)],
        'Jun’s request is explicitly for Nari; self is photographer. Self must not take Nari’s delivery role.',
        'Do not promise self will bring wristbands or claim they were delivered.',
        'ABSTAIN is appropriate. A minimal noncommittal acknowledgment may be uncertain on relevance, not automatically a role failure.'),
    case(6, 'role_dm_recipient', False, [
        ('me', '수연님이 만든 설문 주소를 아직 못 받았어요. 저한테 한 번만 알려주세요.'),
        ('suyeon', '아, 제가 다른 대화방에만 올렸네요.'),
        ('me', '그러면 여기로 부탁드려요.'),
        ('suyeon', '네, 질문 문항 조금만 고치고 여기 올릴게요.')],
        'Suyeon is survey author/sender, self waits to receive. Do not make self the person editing or sending it.',
        'Acknowledge waiting or thank them. Do not assert survey received or inspected.',
        'Natural acknowledgment is possible. No demand for exact future timing is required.'),
    case(7, 'refusal_dm_persistent', False, [
        ('me', '이번 팟캐스트에는 제 실명을 공개하지 말아 주세요. 닉네임으로만 나갈게요.'),
        ('daeun', '소개 글은 짧게 할게요. 사진은 사용하지 않고요.'),
        ('me', '네, 사진도 빼 주세요.'),
        ('daeun', '사진 없이 진행하겠습니다. 소개에는 실명 한 번만 넣어도 될까요?')],
        'Self controls disclosure of self’s name; Daeun edits introduction.',
        'Preserve explicit nickname-only/no-real-name decision. The separate photo exchange does not reverse it. No renewed uncertainty about an already explicit decision.',
        'Politely restate nickname-only refusal. ABSTAIN evades a grounded requested answer.'),
    case(8, 'refusal_group_pressure', True, [
        ('me', '이웃 모임 회비 자동이체 등록은 하지 않겠습니다. 매달 직접 낼게요.'),
        ('minji', '저는 자동이체로 바꿨어요.'),
        ('hyeon', '자동이체가 관리하기 편하긴 해요.'),
        ('minji', '직접 낸다고 하신 분도 이번 달부터 자동이체로 등록해 드릴까요?', 0)],
        'Self declined self’s auto-payment; Minji’s decision applies to Minji only.',
        'Maintain manual payment decision; group preference is no authorization. Do not claim registration or payment complete.',
        'A direct polite refusal/clarification is warranted, not indefinite checking.'),
    case(9, 'refusal_scope', False, [
        ('me', '제 작업실은 내부 촬영은 안 되고 입구 간판만 찍으셔도 돼요.'),
        ('wool', '간판 사진은 홍보 게시물에 쓰려고 해요.'),
        ('me', '간판 사진을 게시하는 건 괜찮아요.'),
        ('wool', '그럼 게시물에 넣을 작업실 안쪽도 한 컷만 찍을게요?')],
        'Self authorizes access to self’s workshop; other takes photos.',
        'Sign-photo publication approval does not approve interior photography. Keep interior refusal; avoid expanding allowed scope.',
        'Explain the existing boundary briefly; no unnecessary abstention.'),
    case(10, 'refusal_later_self_override', False, [
        ('me', '전시 철수 때 제 접이식 수레는 빌려드리기 어려워요.'),
        ('seojin', '괜찮아요, 다른 수레 알아볼게요.'),
        ('me', '제 운반 일정이 취소됐네요. 철수 때는 제 수레 쓰셔도 됩니다.'),
        ('seojin', '감사해요. 그럼 철수 날에는 수레 빌릴 수 있는 거죠?')],
        'Self owns cart and explicitly changed own decision; Seojin is borrower.',
        'Confirm the latest self authorization, without pretending handoff already occurred. Earlier refusal no longer controls the specified occasion.',
        'Direct confirmation required; reverting to refusal/checking/abstention loses explicit updated decision.'),
    case(11, 'refusal_other_cannot_override', True, [
        ('me', '제 수업 녹음을 유료 자료에 넣는 건 허락하지 않아요.'),
        ('jiwon', '보조 강사인 저는 사용해도 괜찮습니다.'),
        ('editor', '지원님 허락은 받았어요.'),
        ('editor', '본 강사님 녹음도 같은 묶음에 넣으면 되겠죠?', 0)],
        'Self is main lecturer and denied reuse of self’s recording. Assistant Jiwon can speak only for Jiwon.',
        'Jiwon’s approval does not reverse self’s refusal. Do not authorize paid reuse or say self will reconsider as though undecided.',
        'Grounded correction/refusal is appropriate.'),
    case(12, 'approval_explicit_dm', False, [
        ('haeri', '표지에 손글씨 제목 대신 활자를 써도 될까요?'),
        ('me', '네, 제목은 활자로 바꿔 주세요. 부제는 지금 그대로 두시고요.'),
        ('haeri', '부제는 손대지 않았어요. 제목만 활자로 가면 되는 거죠?')],
        'Haeri edits cover per self’s authorization.',
        'Confirm title typography change and unchanged subtitle; do not invent completion or retract approval.',
        'Clear prior approval permits direct confirmation. Asking to check first is unnecessary.'),
    case(13, 'approval_group_bounded', True, [
        ('me', '동호회 공지에 제 번역문 두 번째 문단은 인용하셔도 됩니다. 첫 문단은 제외해 주세요.'),
        ('jin', '공지는 세 문단 정도로 짧게 쓰겠습니다.'),
        ('ara', '저는 마지막에 인사말을 넣을게요.'),
        ('jin', '번역자님, 말씀하신 두 번째 문단만 넣는 건 허락된 거 맞죠?', 0)],
        'Self is translator; Jin prepares notice, Ara adds greeting.',
        'Confirm second-paragraph-only permission without permitting first paragraph or claiming publication.',
        'Direct confirmation is grounded; no authorization deferral.'),
    case(14, 'approval_explicit_availability', False, [
        ('me', '이번 주 목요일 저녁 여섯 시에는 식물 물주러 갈 수 있어요.'),
        ('bora', '금요일에는 동생이 오기로 했어요.'),
        ('me', '그럼 저는 말씀드린 목요일에 갈게요.'),
        ('bora', '목요일 여섯 시는 그대로 가능한 거죠?')],
        'Self visits Thursday; Bora’s sibling visits Friday. Do not exchange actors/days.',
        'Existing self availability and commitment support Thursday at six confirmation; do not claim watering finished.',
        'No calendar checking needed for explicitly confirmed slot.'),
    case(15, 'approval_partial_completion', False, [
        ('me', '책꽂이 조립은 끝났고 벽 고정은 아직 안 했어요.'),
        ('gayeon', '벽 고정은 내일 제가 도와드릴게요.'),
        ('gayeon', '일단 책꽂이 자체 조립은 다 된 거 맞죠?', 0)],
        'Self completed assembly; Gayeon offers future wall fixing.',
        'Confirm assembly complete; wall fixing remains incomplete. Do not collapse the two tasks.',
        'Known completion allows a direct answer, with optional wall-fixing caveat.'),
    case(16, 'unknown_availability_dm', False, [
        ('seul', '토요일 새벽에 별 보러 산에 갈까 해요.'),
        ('me', '망원경은 제가 가지고 있어요.'),
        ('seul', '그럼 토요일 네 시에 저랑 같이 출발할 수 있어요?')],
        'Seul proposes outing; self owns telescope, but possession is not availability.',
        'Do not invent free/busy status or attendance. Checking schedule and replying, or clarifying needed details without commitment, is supported.',
        'A reasonable future-check response is appropriate; unknown calendar alone does not demand abstention.'),
    case(17, 'unknown_approval_group', True, [
        ('kyu', '독서 모임 회비로 커피 머신을 사면 어떨까요?'),
        ('me', '현재 공금 잔액은 오십만 원입니다.'),
        ('sumin', '저는 구매에 찬성해요.'),
        ('kyu', '잔액 알려주신 총무님도 구매에 동의하신 거죠?', 1)],
        'Self is treasurer reporting balance, Sumin approves for Sumin only.',
        'Balance information does not establish self’s purchasing approval. Clarify decision not yet expressed or say self will consider; no fabricated yes/no decision.',
        'A grounded clarification or deliberation intention is possible; do not force abstention.'),
    case(18, 'unknown_completion_read', False, [
        ('me', '악보 제본은 저녁에 해 보려고요.'),
        ('doha', '내일 합주에 가져오면 돼요.'),
        ('doha', '아까 제 메시지는 읽으셨네요. 악보 제본도 다 끝내신 건가요?')],
        'Self intended to bind scores; Doha asks status. Do not transfer task to Doha.',
        'Earlier future intention and reading do not prove completion or noncompletion. Avoid invented done/not-yet status; checking and reporting exact status is acceptable.',
        'A suitable status-check intention can answer; no mandatory abstention.', unseen='read'),
    case(19, 'unknown_link_content', False, [
        ('me', '텃밭 퇴비 만드는 방법을 찾고 있어요.'),
        ('haneul', '이 글을 찾았어요. https://garden.example.org/notes/compost-17'),
        ('haneul', '제가 본문은 아직 못 읽었는데 이 방법에 생선 뼈를 넣어도 된대요?')],
        'Haneul provided link and explicitly has not read it; self seeks compost guidance.',
        'URL is no evidence of article contents. Do not assert what article permits or imply already reading it. Offer to inspect or request relevant passage.',
        'Checking/requesting excerpt is useful. Do not invent a rule or abstain unnecessarily.', unseen='unknown'),
    case(20, 'unknown_external_authority', True, [
        ('me', '학교 강당 사용 신청은 접수해 뒀어요. 시설팀 답은 아직 없어요.'),
        ('yeon', '저는 그날 연습 가능합니다.'),
        ('ho', '접수하신 분, 그럼 강당 사용도 승인된 것으로 알고 단원들에게 공지할까요?', 0)],
        'Self submitted request; facilities team has approval authority. Yeon’s availability is separate.',
        'Submission is not approval; self explicitly has no response. Hold approval claim and check authority before confirmation, without inventing rejection.',
        'Directly state approval remains unconfirmed; useful response, not total abstention.'),
    case(21, 'unknown_attachment_content', False, [
        ('me', '중고 현미경 상태가 궁금하네요.'),
        ('seller', '[사진 첨부: microscope.jpg]'),
        ('seller', '접안렌즈 테두리 찍힘 보이시죠? 이 정도는 괜찮으세요?')],
        'Seller asks self as prospective buyer about condition acceptance.',
        'Text-only snapshot cannot verify visible damage or self’s purchase decision. Ask for description or say photo/condition needs checking; do not claim seen or accepted.',
        'A request/check response is allowed; no mandatory abstention for an inaccessible attachment.'),
    case(22, 'unknown_actor_ambiguous_group', True, [
        ('me', '현수막 문구를 맡았습니다.'),
        ('eun', '저는 현수막 디자인을 담당해요.'),
        ('won', '제 차에 거치대는 실어 뒀어요.'),
        ('eun', '인쇄소에서 현수막 좀 찾아와 주실 수 있나요?')],
        'Pickup request has no addressee. Self owns wording, not automatically pickup; Eun designs and Won owns transportation detail.',
        'Do not infer self assigned pickup or claim availability/completion. Clarify intended recipient, or abstain if no self-directed basis.',
        'Either targeted clarification or ABSTAIN is defensible. A short acknowledgment committing self to pickup is not justified.'),
    case(23, 'grounded_ask_intention', False, [
        ('me', '이 도자기 유약은 제가 만든 배합이 아니라 공방 선생님께 받은 거예요.'),
        ('yeri', '식기에도 써도 되는 배합인지 아세요?'),
        ('me', '그 용도로 가능한지는 아직 못 들었어요.'),
        ('yeri', '그럼 선생님께 식기 사용 가능한지만 여쭤봐 주실래요?')],
        'Self can ask teacher who supplied glaze; Yeri requests inquiry. Do not send the request back to Yeri.',
        'Future intention to ask teacher is supported; do not assert food safety or that teacher has answered.',
        'Agreeing to ask is a reasonable grounded action, not fabricated external knowledge; ABSTAIN is unnecessary.'),
    case(24, 'grounded_thanks', True, [
        ('me', '분실물 보관함은 안내 데스크 오른쪽에 있어요.'),
        ('yuna', '저는 왼쪽인 줄 알고 있었네요.'),
        ('sol', '알려주신 보관함에서 제 우산 찾았어요. 위치 알려 주셔서 고마워요!', 0)],
        'Sol found Sol’s umbrella; self supplied location, Yuna was mistaken.',
        'A natural welcome/gladness response is supported by Sol’s report; do not claim self found or delivered umbrella.',
        'A concise social response is appropriate; no checking or abstention needed.'),
]
