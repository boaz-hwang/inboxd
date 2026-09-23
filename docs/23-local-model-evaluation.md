# 23 — 로컬 추천 모델 비교

평가일: 2026-09-21–22 (KST). 선택 상태: **Qwen3.5-9B 4-bit를 이번 Mac의 기본 로컬 모델로 선정**. 모델 선택과 추천 파이프라인의 품질 승인은 별개이며 통합 품질은 아래 제한을 따른다. Qwen3.5-4B는 fast 모델의 후속 개선 후보이며 아직 기본 모델로 승인하지 않는다.

## 비교 조건

- Apple M4 Pro, RAM 48 GiB, macOS 26.6.2.
- Python 3.12, MLX 0.32.2, MLX-LM 0.31.3.
- 네트워크를 차단한 별도 프로세스에서 각 모델 실행.
- 한국어 합성 대화 20개, 같은 system prompt, temperature 0, thinking 비활성, 출력 최대 192 tokens.
- 사실·승낙 근거 없음, 명시된 조건, 부정·수정, 역할, 가족·업무 말투, 자료 충돌 등을 포함한다.
- 아래 지연은 **생성만** 측정한 값이다. router·retrieval·검증을 포함한 제품 응답 시간이 아니다. 모델 load는 별도이며, 첫 생성 warm-up이 포함된 소규모 표본이다.
- peak memory는 MLX allocator의 process peak이며 전체 시스템 RAM이나 에너지 소비를 뜻하지 않는다.

실행 스크립트: [benchmark_reply.py](../packages/reply-model/benchmark_reply.py), 입력: [reply_cases.json](../packages/reply-model/fixtures/reply_cases.json).

## 단독 생성 결과

JSON context 입력의 동일 20개 사례를 기준으로, 별도 Sol 에이전트가 사례별 사전 criterion으로 검토했다. pass/partial/fail은 명시 조건을 충족하는지의 수동 판정이며 대규모 정확도 추정이 아니다. 중대 오류에는 근거 없는 사실·확정·의사결정과 명시 조건 위반을 포함한다.

| 모델 | Pass / Partial / Fail | 중대 오류 사례 | 생성 p50 / p95 | MLX peak |
| --- | --- | --- | --- | --- |
| Qwen3.5-9B 4-bit | 12 / 6 / 2 | 1 / 20 | 1.11 / 1.37초 | 5.72 GB |
| Gemma 4 E2B 4-bit | 10 / 3 / 7 | 6 / 20 | 0.33 / 0.42초 | 2.96 GB |
| Qwen3.5-4B 4-bit | 8 / 3 / 9 | 7 / 20 | 0.70 / 0.91초 | 3.12 GB |
| 기존 Qwen3-8B 4-bit | 3 / 7 / 10 | 5 / 20 | 1.09 / 1.69초 | 5.10 GB |

Qwen3.5-4B의 초기 MLX 변환본과 canonical 변환본은 같은 문장을 출력했다. 표에는 canonical 변환본을 사용했다. JSON 대신 표준 user/assistant 역할을 사용한 추가 비교도 수행했으나, 일정·계약 승낙이나 역할 혼동 문제가 일관되게 해결되지는 않았다. 그 결과도 저장했다.

[원시 결과 디렉터리](../packages/reply-model/evaluation-results)는 합성 입력에 대한 결과만 포함한다. 실제 가족방 메시지를 benchmark 또는 공개 결과에 넣지 않았다.

## 판단

4B가 더 작다는 장점만으로 기본 모델로 정하지 않는다. 이 기기에서 9B의 생성 중앙값 증가는 약 0.4초였고, 잘못된 확정 답변 감소가 더 중요했다. Gemma는 빠르지만 현재 오류 유형상 기본 추천 생성기로 채택하지 않는다. 기존 Qwen3-8B는 Qwen3.5-9B로 교체하는 편이 이 평가에서 유리하다.

다만 9B도 감사 발화의 역할을 바꾸거나 본인에게 향하지 않은 질문에 답하는 사례가 있다. **직접 생성만으로 제품 준비 완료를 선언하지 않는다.** Context Intelligence 정책, evidence, 개인화, 출력 검증이 필요하며 통합 결과를 별도로 평가한다. 검증 모델이 같은 계열이면 오류도 상관될 수 있어 self-check 통과를 사실 정확도의 보장으로 취급하지 않는다.

4B+9B 두 tier를 처음부터 항상 메모리에 올리지 않는다. 우선 9B 단일 로컬 baseline으로 실행 계약을 안정화하고, 검토된 데이터로 CIM fast path와 4B 개인화의 품질·전체 지연 이득을 검증한 뒤 분리한다. 전용 CIM 학습과 개인 LoRA 실험은 계획대로 병행한다.

## 재현할 가중치

| 용도 | Hugging Face repository | Revision |
| --- | --- | --- |
| 기본 모델 | `mlx-community/Qwen3.5-9B-4bit` | `8b2b98c00a6b4d291155e4890773ca8f769aee53` |
| fast 후보 | `mlx-community/Qwen3.5-4B-4bit` | `0e7ffd5c629ef7719d4cbc04069232580bfa9d9c` |
| edge 비교 | `mlx-community/gemma-4-e2b-it-4bit` | `238767527555cb75a05732a84dff5d6ba0dd6809` |

Qwen3.5는 post-trained checkpoint를 사용했다. Qwen3-4B의 32K 사양을 Qwen3.5의 사양으로 옮겨 적지 않는다. 공식 [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B)와 [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B)는 Apache 2.0으로 공개되어 있다. [Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B)도 Apache 2.0이며 E2B는 유효 파라미터 규모를 뜻한다. 실제 배포 메모리는 위처럼 측정한다.

## LoRA와 남은 검증

Qwen3.5-4B와 Qwen3.5-9B 4-bit 각각에서 합성 데이터 20개로 offline LoRA 1 iteration, base/adapter held-out loss 평가, 격리된 registry 적용·rollback을 실제 실행했다. 네트워크는 차단했고 산출물은 실험 종료 후 삭제했다. 이는 실행 호환성 검증이며 개인화 품질 향상 결과가 아니다.

실사용 acceptance/edit distance, 장기 열·배터리 영향, 긴 context, 여러 방의 준비 완료율은 아직 측정하지 않았다. 개인 학습 데이터의 at-rest 암호화·삭제 연동도 production 자동 학습의 남은 조건이다. 기본 후보 결정과 전체 제품 품질 검증을 구분한다.

## 현재 파이프라인 통합 결과

선정된 9B에 실제 typed policy → 생성 → 근거 검증을 연결한 6개 합성 사례의 마지막 실행에서는 판단 파싱 6/6, 추천 준비 3/6, 보류 3/6이었다. 전체 경로 중앙값은 **8.70초**, 평균 8.86초였다. 사전 생성이 필요한 이유이며 앞의 단독 생성 약 1.1초와 구분한다.

- 감사 답변, 이전 계약 조건 확인 질문, 본인이 이미 승인한 동일 조건 재확인은 적절한 추천을 준비했다.
- 일정 질문의 화자 혼동, 명시적 금지의 의미 약화, 확보한 사실 근거를 사용하지 않은 초안은 검증 단계에서 보류했다.
- 준비됨 3개를 사람이 criterion과 대조했다. `ready`만으로 정확하다고 집계하지 않았다.

[통합 결과](../packages/reply-model/evaluation-results/pipeline-qwen35-9b.json)는 실패를 포함한다. 이 6개는 prompt 보완에 사용한 개발 사례여서 일반화 평가용 holdout이 아니다. 작은 사례에 맞춘 반복 튜닝은 여기서 멈추고, 더 넓은 미사용 사례와 실제 사용자 평가를 축적한다. 현재는 실험 가능한 로컬 추천 기반이며 즉시·고품질 추천이 완성된 상태는 아니다.
