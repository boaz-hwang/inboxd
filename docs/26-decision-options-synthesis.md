# 정확도와 속도를 함께 개선할 판단 모델 선택지

2026-09-23 연구 설계. 현재 승자는 없다. 이 문서는 공개 구현의 구조와 inboxd 코드의 교체 지점을 연결한 **검증 가설**이다. 모델 설치·학습·프로덕션 전환을 수행한 결과가 아니다. [세부 판단 경로와 측정 계약](25-decision-pareto-plan.md), [Laya 입력·런타임 분석](26-decision-architecture-internals.md), [Laya/Kev 학습·보정 분석](26-decision-training-internals.md)을 함께 본다.

## 무엇을 개선해야 하는가

현재 `ReplyWorker.decide()`는 `build_state()`의 대화·출처 상태를 9B 자유형 출력으로 판단하고, `parse_baseline_output()`의 one-hot 제안을 `execute_policy()`에 넘긴다. 이후 같은 9B가 초안을 생성하고 별도 checker 호출로 검사한다. 기존 실험에서 가장 위험했던 것은 checker의 **위험 초안 오승인**과 정상 초안 오거절이다. 따라서 route만 빨라져도 정확도 문제가 해결되었다고 말할 수 없다. `ready` 역시 초안의 역할·근거가 옳다는 라벨이 아니다. 기존 고정 합성 26건의 9B checker 판정은 19/26, 엄격한 이유까지 맞은 것은 18/26이었다. 작은 표본의 개발 지표이며 실제 방 정확도의 추정치는 아니다. 이 오래된 checker-only 시험에는 최신 self 메시지 뒤에도 초안을 강제로 넣은 사례가 포함된다. 현재의 `no_reply_target` 적격성 규칙 적용 뒤에는 그 사례를 프로덕션 전체 경로의 오답으로 세거나 26건 분모를 그대로 비교하지 않는다.

실험은 판단(`decide`), 생성(`generate`), 검사(`check`)를 분리한다. `decide`의 `response`, `sufficiency`, `escalation`, `gaps`, `risks`, 동적 `sources`와 검사의 `supported`·오류 유형은 서로 다른 정답과 실패 비용을 가진다. 생성 개인화 LoRA가 검사기의 오승인을 고친다고 가정하지 않는다. 모든 방의 추천 작업은 유지한다. 현재 Rust 경로는 판단 결과가 `no_reply`/`defer`라도 맥락적 추천 생성을 이어 가므로, `response` 확률로 방을 숨기는 것은 기능 변경이다. 실패 후 재생성·동일 checker 재호출을 허용하지 않는 한 번 생성·한 번 검사 계약을 유지한다.

## 비교할 네 구성

| 구성 | 구조와 속도 이득의 원천 | 정확도 개선이 성립할 조건 | 반례·탈락 조건 |
| --- | --- | --- | --- |
| **C0: 현재 9B + LoRA** | 기존 판단·검사와 9B 생성에 검토된 개인화 adapter를 적용한다. 추가 모델 상주가 없고 운영 기준선이다. | 대화별 작성 스타일과 초안의 근거 준수 모두 독립 라벨에서 개선돼야 한다. 검사기를 개선하려면 **별도** 검사 학습 또는 교체가 필요하다. | 생성만 미세조정해도 기존 checker의 역할 반전 오승인은 남는다. LoRA 장착만으로 경로 단계 수나 지연이 준다고 가정할 수 없다. |
| **C1: 작은 한국어 가능 encoder 판단 head + 기존 9B 생성** | 자유형 `decide` 디코딩을 작은 분류 모델의 option/head 점수로 바꾼다. route와 checker는 각각 독립 교체 가능하다. | 한국어 화자·수신자·부정·증거 누락을 긴 대화에서도 학습하고, 별도 검사용 head가 초안+원문에서 위험을 가려야 한다. 현재 9B checker를 고정한 route-only 구성은 속도 효과를 분리하는 대조군이다. | 작은 encoder의 절단·모델 로드·GPU 경합이 시간 이득을 상쇄하거나 checker를 그대로 둬서 안전성 개선이 없을 수 있다. Laya 기본 checkpoint의 zero-shot 성능을 근거로 즉시 채택하지 않는다. |
| **C2: 현행 Qwen 백본 hidden state + 학습된 판단 head** | 9B의 단어 생성 없이 causal hidden state에서 typed 결정을 읽는다. 백본 메모리를 공유할 가능성이 있다. | 한국어 긴 문맥의 역할·근거 판단에 필요한 정보가 선택한 hidden state에 남고, 학습 head가 보정된 출력으로 이를 회수해야 한다. 실제 같은 백본·KV/cache 재사용과 요청 간 스케줄링 이득도 구현·측정돼야 한다. | 디코딩을 없애도 긴 문맥 prefill은 남는다. 현행 worker는 `decide`→`generate`→`check` 사이 hidden state/KV를 재사용하지 않는다. checker는 새 초안이 생긴 뒤 다시 원문+초안을 읽어야 한다. 공유 캐시가 구현되지 않으면 9B 연산 비용은 계속 크다. |
| **C3: 더 작은 생성 모델 + 구조 차용** | 9B 생성기를 4B 이하 후보로 바꾸고, C1 또는 C2에서 검증된 독립 판단·검사 head를 조합한다. 생성 자체의 연산량을 낮출 가능성이 가장 크다. | 작은 모델을 검토된 한국어 작업·개인화 자료로 학습한 뒤 역할, 사실, 약속, 부정의 임계 오류를 9B 기준 이하로 낮춰야 한다. 검사 head도 생성 오류에 대해 별도 검증되어야 한다. | 예전 작은 개발 표본에서 4B는 20건 중 임계 오류 7건, 9B는 1건이었다. 표본은 확정 성능이 아니지만 무학습 교체를 지지하지 않는다. 작은 모델의 낮은 품질이 거절·수정 시간을 늘리면 빠른 토큰 생성은 이득이 아니다. |

27B는 더 큰 모델의 진단용 상한 비교에만 둔다. 기본 배포 후보가 아니다. 4B 이하 후보는 기존 로컬 비교의 Qwen3.5-4B·Gemma4 E2B와 공식 가중치만 확인한 Qwen3.5-2B 등으로 **실측 전 후보**를 구분한다. 9B를 최대 기준으로 삼되 크기가 작다는 사실만으로 한국어 정확도·지연의 우위를 선언하지 않는다. 최종 조합은 예를 들어 **C0의 개인화 생성 + C1의 별도 검증 head**일 수도 있다. route 교체가 먼저여야 한다는 순서는 고정하지 않는다.

## Laya에서 가져올 구조와 가져오면 안 되는 가정

[고정된 Laya 구현](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L49-L136)은 `[CLS] 질문 유형·지시 [SEP] [MASK] 선택지 … [SEP] 상태`를 encoder에 넣고 선택지 marker 위치를 점수화한다. 자유형 JSON 생성 대신 option 점수를 읽는 원리는 빌릴 만하다. 그러나 [agent가 질문마다 입력을 새로 만드는 코드](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/agent.py#L341-L364)는 같은 상태를 질문별 sequence에 반복 삽입한다. 한 **batch forward**가 가능해도 상태 hidden state를 한 번 계산해 여러 head에 재사용하는 구조는 아니다. 질문 수 × 문맥 길이에 따른 token·메모리 비용을 잰다. 기본 1,024-token 다국어 입력에서 선택지 설명이 상태 예산을 차지하고, 기본 오래된 prefix 보존 절단이 최근 메시지를 잃게 할 수 있다. Laya의 공개 T4 지연이나 비공식 MLX 포트의 M3 Max 지연을 사용자의 M4 Pro end-to-end 시간으로 대입하지 않는다.

학습은 우선 간단한 **head별 masked 교차 엔트로피**, 필요한 경우 진짜 주석자 불일치의 soft target, 별도 보정으로 시작한다. [Laya의 공개 notebook](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb#L322-L338)은 soft CE에 noisy-logit 보상 항을 더하며 PPO나 Brier 학습이 아니다. 공개 `act_head`는 [학습 loss에 0배로 들어가](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb#L334-L338) 독립 act/defer 신호로 복사할 수 없다. `Kev`의 causal backbone+option pointer head와 선택적 CE/Brier 손실도 [구현 선택지](https://github.com/jaredpalmer/kev/blob/557598fced1dada75dfbf36ed144dce309ac6ceb/kev/train.py#L37-L57)이지 이 작업의 보정 증거는 아니다. 텍스트 `unknown`, 관측 불가, 해당 없음, 복수 오류는 명시한 head 라벨·validity mask로 분리한다.

## inboxd에 붙일 정확한 경계

`context_intelligence.build_state()`의 상태·출처 registry·`state_id`를 고정하고 `ReplyWorker.decide()`의 **proposal 생성 부분만** C1/C2 adapter로 교체한다. 출력은 `validate_decision()`을 통과한 `ScoredDecision`이어야 하며 기존 `ExecutionBudget`·`execute_policy()`와 Rust JSONL 작업 흐름은 유지한다. `response`(respond/no_reply/uncertain), `sufficiency`(sufficient/insufficient/unknown), `escalation`(direct/retrieve/reason/clarify/defer)은 각 합계 1인 분포; `gaps`·`risks`·현재 등록된 `sources`는 독립 점수다. 출처 ID는 고정 클래스 목록이 아니라 현재 state의 registry에서 나온다. `modelVersion`, `calibrationVersion`, `scoreEncoding`을 기록하고 one-hot `categorical_indicator`를 보정 확률로 속이지 않는다. 현재 정책의 점수·margin 임계값은 새 모델 출력에 그대로 적용하기 전 validation에서 다시 검증한다.

검사 head는 `create_reply()`의 초안 **뒤**에 원문·증거·`reply_mode`·초안을 입력받는다. `supported`와 역할 반전, 근거 없는 사실, 근거 없는 약속, 명시적 부정 위반, 외부 URL 미확인 등을 분리해 예측한다. 원문에서 **누가 누구에게** 요청했고 누가 행동하기로 했는지 별도 주석이 있어야 역할 반전 정답을 만들 수 있다. 단어 일치나 현재 checker 승인 기록은 human truth가 아니다. 경로 전용 대조군은 기존 9B 생성·검사를 고정하고, 검사 전용 대조군은 경로·실제 초안 원문을 고정한다. 입력 제한 초과는 실행 전에 기존 경로 선택 또는 명시적 실패로 정하며, checker 실패 뒤 재시도하지 않는다. 문맥 앞에 큰 LLM 요약기를 추가한다면 그 정확도 손실·시간·GPU 점유를 후보 비용에 포함한다.

## 실험 순서와 판정

1. **라벨과 split 고정.** 대화 원문·화자·수신자·메시지 연결·근거 출처를 사람이 확인해 route, 초안 품질, checker 판정을 독립 주석한다. `ready`, 편집, 사용자 수락, 기존 LLM proposal은 정답이 아니다. 동일 대화·사례·근거 문서·의역은 train/validation/calibration/test 경계를 넘지 않게 그룹화한다. threshold와 온도는 validation/calibration에서만 정하고 untouched 한국어 holdout에 한 번 적용한다. Laya 공개 notebook의 보정 분할은 case가 아닌 파생 question item 기준이므로 그대로 모방하지 않는다.
2. **checker-first shadow와 route-only shadow를 병렬 비교.** 현재 9B가 생성한 **동일 초안**에 작은 고정 multihead 검사기를 적용해 오승인·오거절을 본다. 동시에 C1/C2 route를 동일 state에 적용하되 생성·검사는 현행으로 고정해 route 기여를 분리한다. C2의 hidden state가 한국어 사실·수신자 판단을 실제로 담는지 probing/학습 후 새 대화에서 검증한다. checker가 임계 안전 오류를 늘리면 속도와 무관하게 탈락시킨다.
3. **생성 후보를 고정 경로에서 비교.** C0의 검토된 LoRA와 C3 작은 생성기를 동일 route·checker 조건, 동일 prompt·evidence에서 비교한다. 검사 결과뿐 아니라 초안 원문의 역할·사실·약속·말투를 사람이 본다. 생성 모델이 바뀌면 검사기 오승인 분포도 다시 측정한다. 결합 구성은 각 단계를 통과한 후보만 전체 경로에서 다시 평가한다.
4. **동일 전체 작업 pool의 Pareto frontier.** 모든 방을 같은 queue와 snapshot으로 처리한다. 분모를 전체 요청에 고정해 `correct-ready coverage`, `unsafe-ready / 전체 요청`, 유효한 판정 coverage, 정상 초안 오거절, route 위험 direct, 실패·abstain·timeout·누락을 각각 보고한다. 빨리 실패해서 p50이 내려간 후보를 우수하게 세지 않는다. `queued → correct ready`의 시간은 미완료·실패를 검열하거나 별도 누적 비율로 함께 제시하고, 성공만의 p50/p95와 실패의 종료 시간도 구분한다. 단계별 prefill·decode·encoder·검색·생성·검사·저장 시간과 cold/warm, GPU 경합, 메모리, 한국어 길이 구간, 절단·fallback 비율을 잰다. 위험 오승인율, 정상 coverage, time-to-ready, 메모리에서 지배되지 않는 후보만 남긴다.

속도 해석은 실제 병목을 따른다. C1의 최대 절감은 기존 `decide`가 차지한 시간에서 새 encoder·토큰화·상주 비용을 뺀 만큼이다. C2는 결정의 디코딩 토큰을 줄여도 prefill과 초안 뒤 검사의 읽기 비용을 없애지 못한다. C3는 생성 단계를 빠르게 할 수 있지만 품질 하락으로 correct-ready coverage가 떨어질 수 있다. 현재 공개 benchmark는 장치·입력·동시 부하가 달라 이 차이를 ms로 약속할 근거가 아니다. 신뢰구간은 문장 단위가 아니라 대화/방 단위로 계산하고, 판정 임계값은 test 결과를 보고 다시 고르지 않는다.
