# 답장 워커 메모리 구조와 절감 후보

작성일: 2026-10-06

**추천 워커를 동시 1개로 고정하고 설치본에 반영했다.** 총 RAM에 따른 2개 선택과 `INBOXD_REPLY_WORKERS` 재정의를 제거했다. 데몬에는 단일 큐 소비자만 있으며, 실제 Python 프로세스는 첫 추천 요청 때 생성한다. 아래 추가 절감 조사는 별도의 모델 로드·추론·다운로드·학습 없이 진행했고, 양자화·문맥 길이·생성 설정은 변경하지 않았다. **추가 절감량과 답장 속도·품질은 아직 실측하지 않았다.**

## 1. 확인 범위와 메모리 수치의 의미

현재 워커 코드, 설치된 MLX/MLX-LM 소스, 로컬 모델 설정과 safetensors header를 확인하고 공식 최신 문서와 대조했다. 설치 버전은 `mlx 0.32.2`, `mlx-metal 0.32.2`, `mlx-lm 0.31.3`이다. 최신 공식 MLX 문서는 0.32.3 기준이므로 현재 동작 판단에는 설치 소스와 0.31.3 태그를 우선했다.

이전 `top` 관측의 두 워커 `MEM 5149M`, `5357M`은 압축 메모리를 포함하는 footprint 지표다. RSS와 동일한 값으로 취급하거나, 두 수를 실제 물리 RAM 절감량으로 합산하면 안 된다. 동일한 모델 로드·요청 조건에서 워커 수를 줄인 전후의 비교 측정은 아직 없다.

MLX의 `get_active_memory()`는 사용 중인 배열 버퍼를, `get_cache_memory()`는 재사용할 수 있는 allocator 버퍼를 구분한다. 프로세스의 시스템 메모리 지표에는 Python·토크나이저 등 다른 비용도 있으므로 이 값들이 RSS나 footprint와 같지는 않다. [공식 active memory 문서](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.get_active_memory.html)

## 2. 상주 가중치와 모델 보관 정책

| 로컬 Qwen3.5-9B-4bit 파일/header 확인 | bytes | 의미 |
|---|---:|---|
| 두 safetensors 파일 합계 | 5,950,221,072 | 파일 header와 비전 tensor도 포함한 디스크 크기 |
| 텍스트 tensor payload | 5,038,041,600 | 약 **4.69GiB**. 텍스트 가중치 크기의 근거이며 프로세스 메모리 실측값은 아님 |
| 비전 tensor payload | 912,020,960 | 현재 텍스트 로더가 제외하는 부분 |

설정은 4bit affine, group size 64다. MLX-LM의 `qwen3_5.Model`은 텍스트 모델만 구성하고 `sanitize()`에서 비전 tensor를 제외한다. 따라서 전체 파일 5.95GB를 모두 active weights로 계산하거나, 비전 제거로 0.91GB를 추가 절감할 수 있다고 제안하면 부정확하다. 로드 중 일시적 할당·allocator 잔류 비용은 별도 측정 대상이다. [공식 Qwen3.5 로더](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/models/qwen3_5.py#L367-L398)

[worker.py](../packages/reply-model/worker.py)의 `generate_text()`는 `(model_path, adapter_path)`별로 모델을 로드하고 최대 2개 객체를 보존한다. 세 번째 키가 들어오면 전체 보관함을 비운다. 단일 워커라도 혼합 요청에서는 두 모델을 보존할 수 있으나, **현재 두 벌 상주의 증거는 아니다.** 정상 daemon 경로는 모델·adapter·worker 코드의 runtime fingerprint가 바뀌면 기존 워커 프로세스를 교체한다. 활성 adapter 변경으로 모델이 계속 누적되는 일반 경로는 억제돼 있다. [runtime 확인·워커 교체 코드](../crates/inboxd-daemon/src/reply.rs)

보관함을 1개로 제한하는 것은 혼합 요청에 대한 방어 개선 후보다. 현재 base 모델 하나만 쓰는 운영 상태에서 큰 절감량을 보장하지 않으며, 모델 전환이 잦으면 재로딩 비용이 늘어난다.

## 3. Qwen3.5의 KV와 prefill

현재 Python 생성 API의 기본값은 `prefill_step_size=2048`, `kv_bits=None`, `kv_group_size=64`, `quantized_kv_start=0`, `max_kv_size=None`이다. 워커는 이 값을 별도로 지정하지 않는다. `quantized_kv_start=0`은 **Python API** 기준이며 CLI의 기본값과 구분해야 한다. [설치 버전 생성 소스](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/generate.py#L307-L319)

이 모델은 32층 중 linear attention 24층과 full attention 8층으로 구성된다. 전자는 고정 크기의 상태를, 후자는 길이에 따라 커지는 KV를 보존한다. full attention의 KV head 4개·head dim 256을 적용하면 BF16 기준 4096토큰의 K/V 원시 크기는 `8층 × K/V 2개 × 4 heads × 256 × 4096 × 2 bytes` = **128MiB**다. 이는 계산 예시로, linear state·할당 단위·활성화·생성 토큰 증가를 제외한 값이며 현재 요청의 실측 사용량이 아니다.

Qwen3.5에는 전용 `make_cache()`가 있고 cache 생성 함수가 이를 우선한다. **현재 버전에 `max_kv_size` 인자만 전달해도 rotating KV 제한이 적용된다고 볼 수 없다.** 일반 모델의 메모리 조절법을 그대로 적용하지 않아야 한다. [모델별 cache](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/models/qwen3_5.py#L304-L305), [cache 생성 우선순위](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/models/cache.py#L15-L40)

## 4. 검토 우선순위와 절충

| 우선순위 | 후보 | 기대 효과와 제한 |
|---|---|---|
| 1. allocator cache | 요청 완료 후 free cache 정리, 또는 재사용 cache 상한 | 가중치·문맥·양자화 유지. 이미 해제 가능한 버퍼를 반환하며 active weights는 줄이지 않음. 재할당 비용이 생길 수 있음 |
| 2. prefill 512 | 기본 2048에서 512로 청크 축소 | 전체 문맥을 유지하면서 입력 처리의 일시적 피크를 낮추는 후보. 처리 속도·수치 차이는 검증 필요 |
| 3. idle unload | 일정 시간 유휴 시 모델 참조 해제·GC·cache 정리, 또는 워커 종료 | 유휴 상주 가중치까지 줄일 수 있으나 다음 요청에 재로딩 지연. 현재 blocking stdin 루프에는 유휴 타이머가 없음 |

생성 함수는 이미 prefill 청크마다, decode 256토큰 주기로 `clear_cache()`를 호출한다. 요청 종료 뒤의 추가 정리가 실제로 얼마나 남은 버퍼를 반환하는지는 측정해야 한다. 모델 보관함을 비우는 것과 allocator cache를 비우는 것도 서로 다른 작업이다. [현재 생성 소스](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/mlx_lm/generate.py#L426-L468)

`set_cache_limit(0)`은 free cache를 비활성화하며 active weights의 상한이 아니다. 기본 free cache 상한은 memory limit을 따른다. `set_memory_limit()`도 메모리 사용의 가이드이며 모델을 더 작게 만드는 기능은 아니다. 일률적으로 작은 상한을 주기보다 실제 active/cache/peak를 먼저 구분해야 한다. [cache limit](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.set_cache_limit.html), [clear cache](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.clear_cache.html), [memory limit](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.set_memory_limit.html)

KV 양자화는 full-attention KV 일부를 줄이며 약 4.69GiB의 가중치를 줄이지 않는다. 양자화 오차와 연산 경로에 따른 속도·피크 변화가 있어 품질 검증이 필요하다. 더 낮은 weight 양자화·더 작은 모델·문맥 절단은 품질에 직접 영향을 주는 별도 후보다. 이번에는 어느 설정도 적용하지 않았다. [공식 생성·메모리 옵션 소스](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/generate.py), [rotating cache의 품질 절충 설명](https://github.com/ml-explore/mlx-lm/blob/v0.31.3/README.md#long-prompts-and-generations)

## 5. 다음 측정 제안

워커 1개 배포 확인 후 같은 모델·동일 입력·출력 상한을 유지해 cold start, warm 요청, 요청 직후, 유휴 구간을 비교한다. 각 단계의 PID·RSS·footprint와 워커 내부 `active/cache/peak` bytes를 함께 기록하고, 요청별 peak는 시작 전에 초기화한다. 본문이나 토큰 배열은 기록하지 않는다.

먼저 cache 정리 전후를 비교하고, 다음에 prefill 2048/512의 최대 메모리·첫 토큰 지연·전체 응답 시간·출력 차이를 비교한다. 유휴 unload는 재로딩 지연까지 포함한다. 이 측정과 답장 품질 확인 전에는 절감률·품질 유지·속도 개선을 완료 결과로 보고하지 않는다.

## 6. 단일 워커 적용 검증

- Rust 답장 큐·파이프라인 검사 12개, launcher 검사 4개 통과. 단일 소비자의 연속 작업 처리와 외부 `INBOXD_REPLY_WORKERS=2` 전달 차단을 확인했다.
- release 빌드 후 설치 product의 daemon·launcher를 교체했다. 다른 runtime 파일 내용은 보존했다. 기존 `personalization.py`와 `training_runtime.py`의 설치 manifest 불일치는 실제 보존 파일의 hash·size로 정정했다.
- 기존 daemon PID 76692와 추천 워커 PID 49191·49192 종료, 새 daemon PID 36174의 `system.ping` 및 `system.status.ready=true`를 주관 에이전트가 독립 확인했다.
- 2026-10-06 22:48 KST 관측에서는 새 추천 워커가 아직 생성되지 않은 cold 상태였다. `top MEM`은 daemon 약 17MiB, 연결 워커 3개 합계 약 208MiB였다. 이는 모델이 로드된 상태의 메모리가 아니므로 이전 추천 워커 두 개의 footprint와 비교한 절감률을 제시하지 않는다.
- 별도 cmux workspace 6의 inboxd 화면도 새 launcher로 재실행했으며, 주관 에이전트가 탐색 UI 표시를 확인했다. 설치 manifest 28개 항목의 실제 size·SHA-256도 모두 일치했다.
- 실제 배포 기록: `~/.inboxd/product/single-worker-deployment-20261006/`. 빌드는 현재 작업 트리의 Rust 변경을 포함하며, 기존 미커밋 작업을 되돌리지 않았다.

워커 수 제한은 적용 완료이며, allocator cache·prefill·idle unload는 조사와 측정 제안 단계다.
