# 판단 모델의 정확도·속도 비교 계획

2026-09-23 기준 설계 문서. 이 계획은 모델을 설치하거나 실행한 결과가 아니다. 목표는 비자기회귀 판단 모델이 현재의 로컬 LLM 판단 호출을 대체하거나 일부 입력에서 먼저 처리할 때, 실제 추천의 정확도와 시간을 함께 개선하는지 검증하는 것이다. Laya의 공개 T4 속도를 M4 Pro의 예상 시간으로 쓰지 않는다.

## 먼저 고정할 비교 구성

| 구성 | 판단 | 초안 생성 | 초안 검사 | 검증 목적 |
| --- | --- | --- | --- | --- |
| A: 현행 | Qwen3.5-9B typed LLM | 현행 9B | 현행 9B | 같은 입력의 기준선 |
| B: 빠른 판단 | 한국어 검증을 거친 작은 비자기회귀 모델 | **A와 같은** 9B·같은 prompt | **A와 같은** 9B·같은 prompt | 판단 단계 절감과 route 오류 변화만 분리 |
| C: 빠른 판단·검사 | B와 동일 | **A와 같은** 9B·같은 prompt | 별도 학습·보정된 비자기회귀 검사 head | 검사 시간 절감과 오승인 위험을 별도 검증 |

첫 후보는 Laya의 다국어 encoder 계열로 검토하되 채택을 전제하지 않는다. [공식 저장소](https://github.com/NandhaKishorM/laya/blob/main/README.md)는 `laya-multilingual`을 mmBERT-base 322M, 기본 1,024-token 입력으로 설명한다. 공개 약 33ms 수치는 **T4**에서의 단일 질문 측정치이며 Mac, 한국어 긴 대화, 현재 파이프라인 수치가 아니다. 같은 저장소는 기본 checkpoint의 typed-decision zero-shot 성적이 낮고 domain fine-tuning이 필요하며, 다국어 checkpoint에는 배포 시점의 보정 온도가 없다고 명시한다. 따라서 한국어 검토 라벨·보정 자료가 없으면 confidence 수치만으로 fast path를 켜지 않는다. Laya 자체 구현·가중치·런타임은 필수 의존성으로 두지 않고 동일 typed 계약을 만족하는 다른 작은 encoder도 비교 가능하게 둔다.
공식 예시의 `Router(preload=True)`처럼 모든 checkpoint를 상주시킨다는 가정도 하지 않는다. 현재 Mac에서는 9B 생성 worker와 작은 encoder의 런타임·메모리 점유를 함께 재고, 한국어에 필요한 checkpoint만 올린 구성과 cold load를 비교한다.

## 코드의 정확한 교체 지점

1. [`context_intelligence.py`](../packages/reply-model/context_intelligence.py)의 `build_state()`가 대화, `incoming_message_ids`, 출처 registry, evidence, 절단·불명·충돌 표시와 `state_id`를 만든다. 판단용 입력 생성은 이 함수 **뒤**에 둔다. 작은 모델용 tokenization/절단을 추가할 때도 최신 incoming 본문과 화자·부정·조건·reply 연결, 누락 범위를 추적해야 한다. 현행 32,000자 상태를 Laya 기본 1,024 token에 그대로 넣을 수 없다. 입력이 길면 실행 **전**에 현행 LLM 판단 경로를 택하거나 명시적으로 실패시킨다. 요약을 도입한다면 정보 손실률과 소요 시간을 별도로 측정한다.
2. [`worker.py`](../packages/reply-model/worker.py)의 `ReplyWorker.decide()`는 현재 `build_baseline_prompt()` → `generate_text(max_tokens=900)` → `parse_baseline_output()` → `execute_policy()` 순서다. B의 adapter는 가운데 **proposal 생성**만 바꾸고, `state_id`가 일치하는 `ScoredDecision`을 `validate_decision()`으로 검증한 뒤 기존 `execute_policy()`에 전달한다. `scoreEncoding=model_scores`는 실제 분포·독립 점수에만 쓰며, 현행 LLM의 one-hot `categorical_indicator`를 보정 확률로 위장하지 않는다. `modelVersion`, `schemaVersion`, `calibrationVersion`, 유효 head, 불확실성 flag를 기록한다. 보정 전에는 shadow 평가만 하며 현행 정책의 0.55 점수·0.15 margin을 무검증 raw score에 적용하지 않는다. threshold 변경은 정책 버전으로 관리한다.
3. 필요한 head는 `response`(respond/no_reply/uncertain), `sufficiency`(sufficient/insufficient/unknown), `escalation`(direct/retrieve/reason/clarify/defer)의 각각 합계 1인 분포와, 독립 다중 라벨 `gaps`, `risks`, 현재 registry ID별 `sources` 점수다. 응답하지 않을 때의 하위 head는 validity mask로 제외한다. `unknown`, `not_applicable`, 미관측 head를 음성 라벨로 섞지 않는다. 동적 source 후보가 길어지면 option token budget과 후보 누락률을 검사한다. 특정 검색 문구·사용자 승인·전송 권한은 모델 출력이 아니다.
4. [`policy.py`](../packages/reply-model/policy.py)의 `execute_policy()`는 사용자 결정 gap, 충돌, 저신뢰, source 권한과 예산, 검색, direct/clarify를 결정한다. [`reply_pipeline.rs`](../crates/inboxd-daemon/src/reply_pipeline.rs)는 `op=decide`를 호출하고 현재 방 기록만 검색하며, reply/clarify일 때 `op=generate`를 호출한다. B는 이 Rust 그래프와 동일한 JSONL worker 계약을 유지한다. 낮은 신뢰가 동일 상태의 반복 판단·재생성·검사 재호출로 이어지지 않게 한다. 사용자 요청대로 초안은 한 번 생성하고 한 번 검사한다. 판단에서 `no_reply`/`defer`가 나와도 현재 Rust 그래프는 요청된 추천을 위해 맥락적 생성으로 이어가므로, `response=no_reply` 점수로 방이나 추천 작업을 숨기지 않는다.
5. C의 검사 head는 **초안 생성 뒤** 대화·evidence·reply mode·초안을 입력으로 받아 `supported`와 근거 유형(역할 반전, 근거 없는 사실·완료, 근거 없는 약속 등)을 판단한다. B의 route 점수와 검사 점수를 공유 정답처럼 취급하지 않는다. 기존 검사기 대체 전에는 정상 초안의 오거절과 위험 초안의 오승인을 각각 측정하고, 출력 누락·모순·범위 초과는 승인으로 세지 않는다. 불확실·장문 입력은 실행 전 기존 검사기 선택 또는 명시적 실패로 보낸다. 검사 실패 후 같은 초안 재검사나 자동 재생성은 하지 않는다.

## 데이터와 라벨 경계

- 기존 실행 기록의 LLM proposal은 teacher 제안이지 정답이 아니다. 검토자가 대화 원문·화자·수신자·근거 범위를 보고 response, sufficiency, gap, source, risk, escalation을 **각각** 라벨링한다. 초안 검사용 라벨은 별도 문장 쌍에서 만든다. `ready`, 사용자 수락, 편집, 읽음 여부만으로 옳고 그름을 자동 추론하지 않는다.
- 시간순 train/validation/test를 먼저 고정하고 대화 ID, 동일·의역 메시지, 동일 target, 관련 source 문서가 split을 넘지 않게 묶는다. 그룹을 넘나드는 표본은 제외하거나 가장 이른 split에만 두되 미래 답장을 과거 학습에 넣지 않는다. 한국어 존댓말, 짧은/긴 스레드, 그룹에서 타인 지목, 부정·조건, 일정·금액, 외부 URL, 최신 self 발언을 각 분할에 포함한다. label이 없는 head는 loss와 해당 지표에서 제외한다.
- 모델·입력 변환·라벨·split·보정·threshold 버전과 source hash를 고정한다. 온도 보정과 fast-path/fallback threshold는 **validation에서만** 선택한다. 고정 test와 새 대화 holdout은 마지막 한 번 평가하며, 실패 사례를 보고 prompt나 threshold를 바꾸면 새 holdout을 만든다. 작은 실사용 표본에서는 cluster bootstrap(대화 단위) 신뢰구간을 함께 제시한다.

## 파레토 실험과 합격 기준

같은 시점의 스냅샷·메시지 순서·source registry를 A/B/C에 공급한다. B 비교에서는 생성 모델·prompt·temperature·검사기를 고정하고, C 비교에서는 B의 판단·생성까지 고정한다. `state_id`와 route, retrieve 횟수, 초안 원문, 검사 결과, 최종 노출 상태를 함께 저장해 단계별 오류가 섞이지 않게 한다. 기존 고정 합성 사례와 별도로 사람이 검토한 새로운 한국어 holdout을 사용한다.

정확도는 총점 하나로 끝내지 않는다. route의 위험한 direct 승인, 필요한 clarification/retrieval 누락, 무관한 검색, 실제 응답 대상의 오분류를 구분한다. 검사기는 위험 초안 **오승인(FP unsafe)**, 정상 초안 **오거절(FN)**, 유효 verdict coverage, 이유 정확도를 따로 보고한다. head별 categorical Brier/ECE와 다중 라벨 precision/recall, confidence 구간별 실제 오류율을 기록한다. 충분한 표본과 대화 단위 신뢰구간 없이 1~2건 개선을 일반화하지 않는다. 안전 경계의 오승인 증가가 확인되면 속도 이득만으로 채택하지 않는다.

시간은 M4 Pro에서 **실측**한다. `state build → 판단 → policy → 선택적 retrieve/reason → 생성 → 검사 → 저장·UI ready`를 단조 시계로 나누고, 사용자 체감 `queued → ready` p50/p95와 처리량을 함께 본다. cold 모델 로드와 warm 연속 실행, 9B 생성 worker 1개/2개와 GPU 경합, 모든 방 backlog, 한국어 token 길이 구간과 절단 비율을 분리한다. 1,024-token 입력을 넘는 비율·fallback 시간까지 B/C 비용에 합산한다. 모든 방의 추천 작업을 유지하며 `no_reply` head로 coverage를 줄여 빠르게 보이게 하지 않는다. 끝까지 **정확도·coverage·지연·메모리**를 함께 놓고 지배되지 않는 후보만 다음 단계로 올린다. 현행 9B보다 몇 ms 빨라질지는 로컬 측정 전 약속하지 않는다.

단계 순서는 (1) local/offline shadow의 입력 적합성·검증 계약, (2) B의 고정 생성·검사 비교, (3) B가 통과한 뒤 C의 별도 검사 안전성, (4) 전체 방 실제 경로의 cold/warm·경합 성능, (5) 검증된 범위의 제한적 적용·rollback이다. 어느 단계에서도 메신저 전송이나 읽음 처리는 품질 실험의 수단이 아니다.
