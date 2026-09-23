# Laya 결정 아키텍처 내부 분석: Inboxd에 차용할 범위

2026-09-23 기준 코드 조사. 공식 `NandhaKishorM/laya`의 [`010bacef`](https://github.com/NandhaKishorM/laya/tree/010bacef009c855ccba814b51f7c8e1d38ab5e3f)와 별도 개발자의 MLX 포트 `mizorewww/laya-mlx`의 [`0a859518`](https://github.com/mizorewww/laya-mlx/tree/0a859518634112655cb97c745dbf04f5191aaf13)을 고정해 읽었다. 공개 코드만 확인했고 가중치를 내려받거나 추론을 실행하지 않았다. 완제품 모델 후보와 공개 벤치마크의 별도 조사는 [25-laya-research.md](25-laya-research.md)에 있다. 여기서는 **구현 구조**를 분석하며, 공개 벤치마크를 Inboxd 정확도의 증거로 사용하지 않는다.

## 핵심 판정

Laya의 `system_one(state, questions)`는 여러 질문을 **한 번의 배치 호출**로 처리하지만 상태를 한 번 인코딩하여 모든 질문에 재사용하지는 않는다. 공식 [`agent.py:341-364`](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/agent.py#L341-L364)는 질문마다 `build_sequence`를 호출해 *질문·선택지·상태 전체*로 된 별도 행을 만들고, [`common.py:247-279`](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L247-L279)가 이를 패딩해 배치한다. [`DecisionModel.forward`](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L105-L136)의 양방향 encoder는 각 행을 처음부터 계산한다. 질문·선택지가 attention에 들어가므로 질문이 바뀌면 상태 토큰의 hidden state도 바뀐다. 따라서 “state 1회 인코딩 + N개 임의 질문의 가벼운 head”는 이 코드의 동작이 아니다.

배치가 줄이는 것은 질문별 **호출과 GPU 처리의 직렬성**이며, 행마다 상태 토큰과 attention 계산은 반복된다. 질문 수를 `Q`, 행 길이를 `L`로 보면 각 행의 attention 비용이 누적되므로 작은 질문 head만 `Q`개 더하는 구조와 비용이 다르다. 포트의 [`PrefixCache`](https://github.com/mizorewww/laya-mlx/blob/0a859518634112655cb97c745dbf04f5191aaf13/laya_mlx/prepared.py#L1-L59)는 상태 토큰화를 요청당 한 번 수행하고 반복 질문의 **토큰화된 prefix** 최대 128개를 보관한다. 파일 첫 줄이 명시하듯 encoder states와 predictions는 캐시하지 않는다. 이것은 CPU 준비 비용 절감이지 추론 본체 재사용이 아니다.

## 구현 단위별 판단

| 요소와 코드 근거 | 실제 동작 및 속도 효과 | 정확도·운영 위험 | Inboxd 차용 판단 |
|---|---|---|---|
| [공식 `build_sequence`](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L49-L86) | `[CLS] 유형+질문 [SEP] [MASK] 선택지… [SEP] 상태 [SEP]`를 만든다. 답 생성이 아닌 선택지 점수화이므로 autoregressive 토큰 디코딩이 없다. | 질문·선택지가 상태 토큰 예산을 잠식한다. 선택지별 최대 48토큰, head 예산 초과 때 더 짧게 자른다. 역할·부정·최신 메시지가 잘리면 결정이 왜곡된다. | `reply` 경로의 **판정**을 짧은 고정 선택지 분류로 바꿀 때 검토할 수 있다. 답장 생성 자체를 대체할 수 없다. |
| [공식 `DecisionModel`](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L89-L136) | encoder 출력에 3종 질문 유형 embedding을 더하고, 기본 2층 transformer head를 **전 토큰**에 적용한 뒤 각 `[MASK]` 위치를 gather해 MLP 점수를 낸다. marker 수 외 padding option은 `-1e4`로 제외한다. | head도 전 토큰 attention이어서 “작은 head 비용만”이라고 할 수 없다. 다중 선택지의 문장 의미를 잘못 읽으면 확신 있게 틀릴 수 있다. | 선택지 marker와 typed head는 route/grounding의 **학습형 분류기** 설계에 참고 가능. 코드만 이식하면 한국어·Inboxd 역할판단 능력이 생기지는 않는다. |
| [공식 `system_one`](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/agent.py#L319-L364), [collate](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L247-L279) | 질문별 행을 하나의 batch로 처리한다. 직렬 호출보다 GPU 활용과 Python overhead 측면에서 유리할 수 있다. 모든 행은 batch 최장 길이까지 패딩된다. | 질문 수가 늘면 메모리·총 연산 증가. 긴 행 하나가 전체 batch 패딩을 키운다. | 필요한 검증 질문을 **작고 고정된 집합**으로 유지하고, 길이 비슷한 것끼리 묶는 실험 가치는 있다. 속도 개선은 Inboxd M4에서 실측해야 한다. |
| [choice/score/noul 결과](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/agent.py#L391-L424), [option 렌더링](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L28-L46) | `choice`는 최고확률 label, `score`는 순서형 level의 기대값, `noul`은 `false/true` 중 index 1의 확률을 반환한다. 질문별 결과는 동일 batch에서 나온다. | `noul`은 설명 문구와 학습 분포에 의존하는 이진 분류다. 출력 0.9가 grounding 사실 90%를 자동으로 뜻하지 않는다. `score`도 근거 있는 답장 생성은 못 한다. | 판정 인터페이스를 명시적 label·근거·abstain으로 분해하는 **제품 설계**는 차용 가능. 공개 모델 점수를 안전 임계치로 바로 쓰는 것은 불가. |
| [temperature/confidence](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L210-L240), [적용 경로](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/agent.py#L391-L406) | 유형·선택지 수별 온도를 clamp한 뒤 softmax, entropy 기반 confidence를 계산한다. 계산은 싸다. | confidence는 분포 집중도이고 정답률 보증이 아니다. 코드에는 과도한 sharpening으로 부정확한 확신이 커지는 사례에 대한 방어가 있다. | Inboxd 오류 유형별 calibration 데이터가 쌓인 뒤 적용. 역할 반전·근거 없는 확정의 false-ready rate를 별도 측정해야 한다. |
| [action head](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L117-L136) | CLS 벡터와 top 확률, gap, entropy, 선택지 수를 작은 MLP에 넣어 action 확률을 낸다. | action 출력은 별도 학습·비용 함수·검증에 의존한다. 확률과 실제 Inboxd의 `ready/abstain` 의미가 자동 일치하지 않는다. | 위험한 초안은 보류한다는 인터페이스 개념만 참고. 실제 기준은 사전 독립 holdout과 비용 가중 평가로 결정. |
| [proper scoring reward](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L150-L176) | log score, spherical score 및 순서형 score의 ranked probability score를 결합한다. 추론 속도 기법이 아닌 학습 목적함수다. | 교정된 확률을 얻으려면 충분한 실제 라벨과 분포 대표성이 필요하다. | 장래 SFT/판정모델 학습 시 calibration 평가와 함께 참고 가능. 지금은 데이터 설계가 선행. |

## 토큰 예산과 대화형 입력의 함정

공식 [`build_sequence`](https://github.com/NandhaKishorM/laya/blob/010bacef009c855ccba814b51f7c8e1d38ab5e3f/laya/common.py#L49-L86)는 prefix를 먼저 넣고 남은 길이에 상태를 채운다. 기본 `truncate_left=False`이면 `st[:room]`이어서 **상태의 앞부분을 보존하고 끝을 삭제**한다. 최근 발언이 가장 중요한 Inboxd에서는 위험하다. `truncate_left=True` 선택지는 존재하지만 공개 `system_one`의 호출은 넘기지 않는다. 컨텍스트 크기는 체크포인트 config와 encoder 상한으로 제한된다([MLX 검사](https://github.com/mizorewww/laya-mlx/blob/0a859518634112655cb97c745dbf04f5191aaf13/laya_mlx/agent.py#L128-L133)). [별도 모델 조사](25-laya-research.md)의 multilingual 1024 / English base 512 / typed 1024 수치는 각 공개 체크포인트의 설정으로 취급해야 하며 모든 variant의 고정 능력으로 일반화하면 안 된다.

Inboxd에 적용할 때는 `author_id`, `reply_to`, self/other, 부정, 시간/장소, 최신 원문을 JSON 필드로 분리해 절단 전에 우선순위를 정해야 한다. 단순 문자열 절단은 역할반전 오류를 증폭할 수 있다. 이 설계 제안은 Laya 구현의 관찰에서 도출한 **추론**이며 Laya가 이 구조를 제공한다는 뜻이 아니다.

## MLX 포트가 주는 실제 교훈과 한계

별도 개발자의 포트는 ModernBERT의 embedding, RoPE, full/sliding attention 및 decision head를 MLX로 다시 구현했다([`model.py:13-234`](https://github.com/mizorewww/laya-mlx/blob/0a859518634112655cb97c745dbf04f5191aaf13/laya_mlx/model.py#L13-L234)). [`attention_masks`](https://github.com/mizorewww/laya-mlx/blob/0a859518634112655cb97c745dbf04f5191aaf13/laya_mlx/model.py#L135-L154)는 valid-token mask와 길이×길이의 local boolean mask를 만들고, [`EncoderAttention`](https://github.com/mizorewww/laya-mlx/blob/0a859518634112655cb97c745dbf04f5191aaf13/laya_mlx/model.py#L82-L100)은 `mx.fast.scaled_dot_product_attention`을 호출한다. sliding layer가 있어도 이 포트가 **무조건 선형 시간/메모리**라고 주장할 수 없다. full layer도 주기적으로 존재하고, mask 생성과 커널 선택의 실제 비용은 길이별 프로파일링 대상이다.

포트의 [`Agent.system_one`](https://github.com/mizorewww/laya-mlx/blob/0a859518634112655cb97c745dbf04f5191aaf13/laya_mlx/agent.py#L233-L270)은 기본 `batch_size=16`([초기값](https://github.com/mizorewww/laya-mlx/blob/0a859518634112655cb97c745dbf04f5191aaf13/laya_mlx/agent.py#L88-L112))으로 질문을 chunk 처리한다. 따라서 질문이 16개를 넘으면 **여러** forward call이다. `mx.eval`로 출력을 동기화한다([`forward`](https://github.com/mizorewww/laya-mlx/blob/0a859518634112655cb97c745dbf04f5191aaf13/laya_mlx/agent.py#L225-L231)). MLX 사용 자체만으로 빠른 것이 아니라 precision, batch 크기, 패딩, 컴파일 워밍업, Metal 자원 경합에 따라 달라진다. 공개 M3 Max 지연 수치를 Inboxd M4 측정값으로 대용할 수 없다.

## Inboxd 설계 선택지

1. **현재 9B 생성기와 독립 grounding checker 유지, 입력 및 판정 데이터 개선.** 구현 비용이 가장 낮고 기존 실패 사례의 역할/발신자·근거 레이블을 직접 반영할 수 있다. 다만 생성기의 다단계 호출 지연이 남는다.
2. **작은 encoder로 route/grounding의 고정 질문을 한 번에 배치.** Laya의 typed option-marker·배치 방식과 가장 가깝다. 생성은 계속 9B가 맡는다. 동일 대화 상태가 각 질문 행에 반복되므로 실제 질문 수·길이에서 정확도와 지연을 측정해야 한다. 공개 Laya 가중치를 쓰는 경우에도 한국어와 Inboxd 역할/부정/근거 기준으로 독립 평가가 선행되어야 한다.
3. **상태 1회 인코딩 + 여러 고정 head로 자체 학습.** 지연 목표에는 더 매력적일 수 있지만 **Laya 코드의 단순 포팅이 아니다**. 질문과 선택지가 encoder 내부에서 상태 토큰을 바꾸는 Laya 설계를 버리고, Inboxd의 고정 판정 head와 역할 보존형 입력을 새로 학습해야 한다. 그만큼 데이터·학습·검증 비용이 크다.

판단 기준은 같은 holdout에서 역할 반전, 다른 사람 요청에 대한 자기 약속 발명, 명시 부정 약화, 근거 없는 일정 확정의 **false-ready**, 정상 후속 답장의 **false-abstain**, p50/p95 wall-clock 지연, 메모리/전력이다. Laya 아키텍처와 Laya 완제품 모델은 각각 독립된 후보로 비교해야 한다. 사용자의 사적 대화를 외부 서비스로 보내지 않는 현재 로컬 경계도 유지한다.
