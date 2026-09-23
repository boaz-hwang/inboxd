# 22 — Context Intelligence + Personal LoRA 기반 로컬 추천 에이전트

작성일: 2026-09-21 · 구현 검증 갱신: 2026-09-22
상태: TUI·unread·응답 세션·로컬 decision graph·trajectory의 첫 구현을 설치했다. 실계정에서 가족방의 사용자 지정 이름과 입력 포커스를 확인했고, 데몬 재시작 후 schema 6와 ready 상태를 검증했다. 실제 메시지는 전송하지 않았다. CIM은 로컬 LLM baseline이며 전용 학습 모델은 아직 없다. 개인 LoRA는 수동 학습·평가 도구까지 구현했고 자동 학습·암호화 adapter 수명 관리는 미연결이다. 모델 선택과 통합 품질은 [검증 기록](23-local-model-evaluation.md)을 따른다.

## 1. 목표와 핵심 흐름

**안 읽은 메시지가 도착하면 로컬에서 답변을 미리 만든다. 사용자가 방에 들어오면 메시지와 추천이 준비되어 있다. Tab으로 추천을 수락하고 Enter로 전송한다. 전송 후 Tab을 누르면 다음 안 읽은 방으로 이동한다. 이 흐름을 반복한다.**

```text
상대 메시지 수신
  → 목록을 최신순으로 갱신하고 안 읽은 개수 표시
  → 해당 방의 다음 답변을 로컬에서 미리 생성·보관

사용자가 안 읽은 방에 진입
  → 안 읽은 메시지 확인 + 빈 입력창의 흐린 추천
  → Tab: 추천을 실제 입력으로 채움
  → Enter: 전송
  → Tab: 다음 최신 안 읽은 방으로 이동, 입력창 포커스
  → Tab: 그 방의 추천 수락
  → Enter: 전송
  → 반복
```

직접 입력을 시작하면 추천은 화면에서 사라진다. 직접 작성한 답변도 Enter로 보내고, 전송 후 Tab으로 다음 방에 간다. 사용자가 수락하지 않은 추천은 전송하지 않는다.

사용자 경험은 위의 단순한 흐름을 유지한다. 내부에서는 두 질문을 분리한다.

1. **이 답변을 만들려면 무엇을 어디까지 확인해야 하는가?** → Inboxd Context Intelligence Model과 선택적 retrieval.
2. **확인한 사실을 바탕으로 이 사용자는 무엇을 하고 어떻게 말하는가?** → 개인화된 생성 모델과 Personal LoRA.

retrieval과 LoRA는 대체재가 아니다. retrieval은 사건·사실의 근거를 제공하고 LoRA는 표현·선호·행동 패턴을 학습한다. **Context Intelligence와 Personal LoRA를 MVP부터 병행하는 closed learning pipeline**을 구축한다. 스타일 메모나 retrieval이 실패해야 LoRA를 시작하는 순서로 두지 않는다.

장기적으로 next action을 예측하되, 현재 실행 가능한 행동은 허용된 출처 조회와 답변 추천이다. 사용자가 확인·전송하는 Tab·Enter UX를 유지한다. 자료를 찾았거나 수락률이 높다는 이유로 자동 발신 권한이 생기지는 않는다.

## 2. 이번에 고정하는 범위

| 항목 | 결정 |
| --- | --- |
| 채팅방 목록 | 최신 메시지 시각 내림차순, 실시간 갱신, 안 읽은 개수 배지 |
| 추천 생성 시점 | 안 읽은 수신 메시지를 로컬에 저장한 직후, 방 진입 전 생성 |
| 추천 표시 | 현재 방의 빈 입력창에 흐린 자동완성 텍스트 |
| 추천 수락 | Tab으로 draft에 삽입. Enter로 사용자가 전송 |
| 직접 작성 | 첫 문자·붙여넣기에서 추천을 숨기고 사용자 입력 시작 |
| 다음 방 이동 | 전송 완료 후 빈 입력창에서 Tab. 다음 최신 안 읽은 방으로 이동 |
| 포커스 | 방에 들어오면 입력창. 다음 방에서도 동일 |
| 로컬 처리 | 내장 생성·판단·평가·학습은 로컬 전용, 클라우드 fallback 없음 |
| 첫 환경 | Apple Silicon Mac, 기존 TUI·daemon·암호화 DB 활용 |
| Context | 현재 thread부터 시작하고, information gap에 필요한 허용된 출처만 선택적으로 조회 |
| 데이터 | 초기 trajectory를 기록하고 실사용에 따라 필요한 관측을 구체화 |
| 개선 방식 | 공통 Context Intelligence Model + 개인 Reply LoRA. 초기 router 개인화는 threshold calibration으로 시작하고 단계별 평가·갱신 |
| 외부 연동 | MCP는 별도 선택 기능. 내장 추천과 분리 |

자동 전송, 전 채팅방 history 일괄 수집, 입력 중 토큰 단위 자동완성은 이번 구현 범위가 아니다. 추천 사전 생성은 연결된 계정과 사용자가 허용한 자료 범위 안에서 동작한다. 동일인 연결은 사용자 확인이 있는 범위에서 context source를 확장하는 기능으로 설계한다. 메일·문서·agent 대화·일정은 source adapter 인터페이스를 처음부터 두되, 아직 연결되지 않은 자료를 사용할 수 있다고 가정하지 않는다.

첫 통합에서 실제 동작시킬 escalation은 **현재 thread → 같은 방의 이전 로컬 대화 검색**이다. 동일인 다른 방과 다른 자료는 source adapter가 준비된 것부터 연결한다. 학습은 이미 수집된 적격 history로 시작할 수 있지만 부족한 history를 채우려고 자동으로 전 계정 수집을 시작하지 않는다.

## 3. 채팅방 목록: 최신순 정렬과 안 읽은 배지

### 표시 형태

```text
채팅방                         최근 시각
김대리                     14:32    [3]
자료 확인 부탁드립니다.

프로젝트 A                 14:30    [1]
내일 일정 다시 공유드립니다.

민수                       14:25
나: 내일 보자!
```

기존 sidebar의 방 이름·미리보기·시각을 유지하고 우측에 안 읽은 배지를 추가한다. 안 읽은 방은 이름과 배지를 강조한다. 추천 준비 여부는 작은 보조 표시로만 나타내고, 개수 배지를 대신하지 않는다.

### 정렬 규칙

1. 마지막 실제 메시지 시각 내림차순으로 정렬한다. 수신과 발신 모두 활동에 포함한다.
2. 같은 시각이면 구조적 chat key로 안정적으로 정렬한다.
3. 동일 메시지의 재조회·추천 완료·읽음 처리만으로 방을 위로 올리지 않는다.
4. 마지막 메시지가 삭제되면 확인 가능한 남은 최신 메시지를 기준으로 갱신한다. 불명확한 값으로 새 활동을 만들지 않는다.
5. 실시간 재정렬 후에도 선택한 방은 chat key로 유지한다. 행 번호가 바뀌었다고 다른 방을 선택하거나 입력 목적지가 바뀌면 안 된다.

목록은 계속 최신순이지만 현재 열어 둔 방은 자동으로 바뀌지 않는다. 다음 방은 사용자가 Tab을 누르는 시점에 최신 상태에서 고른다.

### 안 읽은 개수의 근거

각 방은 단순 숫자 외에 `count / source / status / observed_at`을 갖는다. 제공자의 확정 개수가 있으면 활용하고, Inboxd가 실제 관측한 미확인 메시지와 로컬 확인 경계를 함께 관리한다.

- 확정된 개수는 `[3]`처럼 표시한다.
- 전체 개수는 모르고 최소 3개를 확인했다면 `[3+]`처럼 표시한다.
- 안 읽음은 확인됐지만 개수가 불명확하면 점 배지 등으로 표현한다.
- 제공자 값이 없다는 이유로 0이라고 처리하지 않는다.
- 본인 발신은 새로운 안 읽은 수신 메시지로 세지 않는다. 중복 수신·수정 이벤트도 개수를 늘리지 않는다.

**Inboxd에서 확인한 범위를 먼저 로컬에 낙관적으로 저장하고, 제공자 읽음 상태는 비동기로 동기화한다.** 추천 사전 생성이나 history 조회는 읽음으로 처리하지 않는다. 실제로 화면에 표시한 메시지만 로컬 확인 대상으로 삼는다. 카카오처럼 누적 watermark를 쓰는 제공자에는 확인한 메시지까지의 cursor를 전달하며, 이후 도착한 메시지는 포함하지 않는다. 제공자의 누적 읽음과 Inboxd의 개별 메시지 확인 기록은 구분한다.

위임 경계는 다음처럼 나눈다.

- **로컬 저장소:** 확인 대상의 방·세션을 검증하고 local seen, 동기화 작업, 복구 정보를 한 트랜잭션으로 저장한다. 응답은 서버를 기다리지 않고 반환한다.
- **비동기 연결 함수:** 카카오 읽음 API를 한 번 호출하고 완료·실패를 저장한다. 작업 ID와 버전을 사용해 오래된 실패가 새 읽음 상태를 되돌리지 않게 한다. 별도 작업 큐·자동 재시도는 두지 않는다. 종료 때문에 미완료로 남은 낙관적 변경은 다음 시작 때 복구하고, 방 재진입 시 다시 동기화한다.
- **플랫폼 adapter:** 지정된 계정·방·cursor의 읽음 요청만 실행하고 결과를 반환한다. TUI 상태나 로컬 rollback을 직접 변경하지 않는다.
- **TUI:** 낙관적 안 읽음 개수를 즉시 표시한다. 실패 이벤트를 받으면 복구된 개수와 안내를 반영하되 작성 중인 초안은 유지한다. 완료 이벤트보다 늦게 도착한 낙관적 응답으로 화면을 덮어쓰지 않는다.

서버 읽음 요청이 실패하면 그 작업이 새로 변경한 로컬 확인 상태만 복구한다. 이미 확인됐거나 더 최신 작업에서 확정된 읽음 기록을 지우지 않는다. 지원하지 않는 플랫폼은 동기화 성공으로 표시하지 않는다. 카카오 동기화를 우선 구현·검증하고 나머지 adapter는 지원 계약을 확인해 확장한다.

과거 unread 중 메시지별 범위를 아직 확보하지 못한 경우, 방에 들어왔다는 이유만으로 전체 개수를 0으로 지우지 않는다. 확인 가능한 범위만 줄이고 나머지 개수의 불확실성을 유지한다.

## 4. 읽음 상태와 응답 순회 상태

**읽었는가와 답장을 끝냈는가는 다른 상태다.** 방에 들어가 메시지를 읽으면 unread는 줄어들 수 있지만, 현재 작성 세션은 전송할 때까지 유지한다.

각 응답 세션은 시작할 때 다음을 고정한다.

```text
response_session_id
chat_key
확인할 수신 메시지 범위 / incoming_version
추천 ID와 context version
현재 draft와 추천 수락 여부
전송 request ID와 결과
```

방 진입 시 첫 안 읽은 메시지 경계와 최신 메시지를 확인할 수 있게 표시한다. 긴 미확인 내역을 한 번에 다 읽은 것으로 처리하지 않는다. 입력창에 포커스가 있어도 PageUp/PageDown 등으로 대화를 확인할 수 있다.

현재 세션에 대한 전송이 완료되면 그 세션의 응답을 끝낸다. 이후 새로 들어온 미확인 메시지는 별도 작업으로 남는다. 방 전체를 무조건 완료 처리하지 않는다.

### 다음 방 선택

- 기본 범위는 현재 선택한 메신저 필터 안의 방이다. ‘전체’ 필터면 연결된 모든 메신저를 대상으로 한다.
- 조건은 **미확인 수신 메시지가 남아 있고 현재 접근 가능한 방**이다.
- 최신 메시지순으로 고른다. 마지막 답장 때문에 목록 최상단이 된 현재 방은 건너뛴다.
- 기존 응답 세션의 같은 수신 범위는 다시 선택하지 않는다. 새 미확인 메시지가 생기면 다시 대상이 된다.
- 현재 방에 새 미확인 메시지가 있고 다른 대상이 없으면 같은 방의 새 세션으로 이어간다.
- 다음 방이 없으면 현재 입력창을 비워 둔 채 ‘안 읽은 대화를 모두 확인했습니다’를 표시한다. 실패·확인 불가 방이 남았다면 완료라고 하지 않고 별도로 알린다.

읽기 전용 방도 확인 대상이다. 읽을 수 있는 내용을 확인한 뒤 Tab으로 다음 방에 갈 수 있지만, 추천·전송은 활성화하지 않는다. 현재 방에 표시되지 않은 미확인 메시지가 남으면 다음 방으로 넘기기 전에 남은 메시지를 보여준다. 이동만으로 그 메시지를 읽음 처리하지 않는다.

## 5. Tab·Enter 상태 전이

Tab은 **현재 입력 상태에 따라 한 가지 동작만** 한다. 한 번 누른 Tab이 방 이동과 추천 수락을 동시에 수행해서는 안 된다. 일반 Tab은 영역 포커스를 이동하지 않는다. 영역 이동은 Shift+Tab만 담당하며 채팅방 → 필터 → 메시지 → 채팅방 순으로 순환한다. 영역을 이동해도 작성 중인 초안과 커서 위치는 보존한다.

| 현재 상태 | Tab | Enter | 일반 입력·붙여넣기 |
| --- | --- | --- | --- |
| 새 방, 추천 준비됨, draft 비어 있음 | 추천을 draft에 삽입 | 추천을 수락·전송하지 않음 | 추천 숨김 → 직접 작성 |
| 새 방, 추천 생성 중 | 방 이동 없이 생성 중 안내 | 전송 없음 | 직접 작성, 늦은 추천 숨김 |
| 추천을 수락해 draft 있음 | 내용 유지, 다음 방 이동 안 함 | draft 전송 | draft 수정 |
| 직접 작성한 draft 있음 | 내용 유지, 다음 방 이동 안 함 | draft 전송 | 계속 작성 |
| 전송 중 | 대기, 이동 안 함 | 중복 전송 안 함 | 전송 중 상태 유지 |
| Sent/Verified, draft 비어 있음 | 다음 안 읽은 방으로 이동 | 전송 없음 | 현재 방에 새 메시지 작성 |
| Failed/Uncertain | 완료로 넘기지 않고 상태 안내 | 자동 재전송 없음 | 전송 결과 확인·명시적 새 작성 경로 사용 |
| 보류/추천 없음/읽기 전용, draft 비어 있음 | 남은 미확인 내용을 확인한 뒤 다음 방 | 전송 없음 | 가능하면 직접 작성 |
| 직접 입력을 지워 빈 상태 | 추천 자동 복원 없음, 확인 후 다음 방 | 전송 없음 | 새 직접 작성 |
| 다음 방 없음 | 완료 또는 남은 확인 불가 상태 안내 | 전송 없음 | 현재 방 직접 작성 |

이 동작은 채팅 화면의 입력창 포커스에서만 적용한다. 검색·파일 선택·설정·사이드바 포커스의 기존 키 동작은 유지한다. Esc로 입력창 흐름을 벗어나 메시지/목록을 조작할 수 있게 한다. 생성 중인 방을 건너뛰어야 할 경우도 Esc로 목록에 돌아가 수동 이동할 수 있다.

### 사용 예

```text
A방: 추천 표시
Tab → 추천 수락
Enter → A방 전송 완료
Tab → B방 이동, 입력창 포커스, B방 추천 표시
Tab → 추천 수락
Enter → B방 전송 완료
Tab → C방 이동
직접 입력 → C방 추천 사라짐
Enter → 직접 작성한 답변 전송
Tab → 다음 방 또는 완료 안내
```

전송 직후 현재 방의 오래된 추천을 다시 띄우지 않는다. 다음 Tab의 의미는 ‘다음 대화’로 분명하게 표시한다. 전송 실패나 Uncertain은 성공 세션으로 소비하지 않는다. 별도 명시적 보류 후 수동 이동은 가능하지만 자동 재시도하지 않는다.

## 6. 미리 추천하기: 수신부터 준비까지

사전 생성의 주체는 TUI가 아니라 daemon이다. TUI에서 열지 않은 방도 기존 실시간 수집 경로를 통해 추천을 준비할 수 있어야 한다.

```text
provider 변경 신호
  → 실제 메시지 조회
  → 로컬 DB 저장 완료
  → 신규 수신 / unread / context 변경 판단
  → 방별 생성 작업 갱신
  → 현재 thread snapshot
  → State Builder → Context Intelligence Model의 typed decision
  → policy executor: 점수·근거·권한·예산에 따라 다음 행동 결정
  → 필요할 때만 source 조회 → 최소 evidence bundle
  → base model + active Personal LoRA로 생성
  → 버전이 여전히 맞으면 ready cache에 저장
  → 목록 상태 갱신
```

원문을 아직 가져오지 않은 push 신호나 unread 숫자 변화만으로 답변을 만들지 않는다. 실제 수신 내용을 로컬에서 확보한 뒤 생성한다. 본인 발신은 unread 생성 trigger가 아니다. 서버 조회 실패 시 이전 자료를 새로 확인한 자료처럼 사용하지 않는다.

### 작업 큐

- 방별로 최신 context 하나에 대한 작업만 유지한다. 메시지가 연속 도착하면 이전 대기 작업을 합친다.
- 짧은 연속 수신을 묶는 debounce 초기값은 500ms로 두고 실사용으로 조정한다. 계속 수신되는 방의 작업이 무한 연기되지 않게 최대 대기도 둔다.
- 우선순위는 현재 열린 방 → 사용자가 다음에 갈 수 있는 최신 unread 방 → 나머지 unread 방이다.
- 첫 버전의 생성 worker는 동시 실행 하나로 시작한다. 모델을 로드한 채 재사용한다. thread-only 작업은 바로 생성하고, retrieval이 필요한 작업은 별도 제한된 조회 큐로 넘겨 다른 방의 빠른 추천을 막지 않는다.
- 현재 방 요청은 이전 background 결과보다 우선한다. 취소가 즉시 계산을 멈추지 못해도 오래된 결과를 표시하지 않는다.
- pending queue와 ready cache는 크기를 제한한다. 밀려난 작업도 unread 자체를 지우지 않으며, 진입 시 다시 우선 요청한다.
- 같은 본문의 폴링·같은 provider 이벤트 재수신은 다시 생성하지 않는다.
- 삭제·내용 편집·새 수신은 관련 cache를 무효화한다. 이미 작성한 사용자 draft는 변경하지 않는다.

시작 시 기존 unread 방도 최근 context가 준비된 범위에서 큐에 넣는다. 과거 전체 수집을 시작하지 않는다. 재시작 후 생성 중이던 작업은 다시 판단하고, persisted ready cache는 모델·context·읽음 상태가 현재와 일치할 때만 재사용한다.

### 방별 cache

```text
cache key = chat_key + incoming/thread_version
            + route_policy_version + source_scope_version
            + evidence_versions + generator_version + personal_adapter_version
            + prompt_version + decision_version + state_builder_version
            + decision_schema_version + calibration_version + threshold_policy_version
value     = suggestion_id + text + generated_at + status
status    = queued | generating | ready | abstained | failed | stale
```

근거 자료의 수정·삭제·접근 범위 변경이나 adapter 교체도 해당 추천 cache의 유효성에 영향을 준다. 일정 등 변하는 자료는 freshness 기준을 source별로 적용한다. 단순히 thread가 같다고 과거 근거를 계속 재사용하지 않는다.

cache는 아직 누구에게도 표시하지 않은 답변일 수 있다. 생성 완료를 추천 노출로 기록하지 않는다. 임시 cache와 trajectory는 같은 suggestion ID로 연결한다. TTL·개수 제한으로 cache를 비워도 별도 보관 정책에 따른 관측 기록과 혼동하지 않는다.

### 방 진입 시

유효한 ready cache가 있으면 즉시 흐린 추천으로 표시한다. 아직 준비 중이면 해당 방을 우선 처리하고 ‘대화 확인 중 / 필요한 자료 확인 중 / 답변 작성 중’ 정도의 상태만 보여준다. 자료가 없거나 조회 예산을 소진했으면 무한 검색하지 않고 확인 질문·보류로 끝낸다. 내부 route나 confidence를 기본 작성 UI에 노출하지 않는다. 사용자가 먼저 입력하면 늦은 결과를 띄우지 않는다.

‘항상 진입 즉시 준비’를 하드웨어와 수신량에 상관없이 보장하지 않는다. 목표는 준비된 비율을 높이는 것이며, 실제로 **방 진입 시 cache 적중률·준비 완료율**을 측정한다. 준비되지 않았다고 입력이나 방의 메시지 조회를 막지 않는다.

## 7. 구성 요소와 API

```text
기존 provider worker
       ↓
Rust daemon
  ├─ 메시지 관측·암호화 저장
  ├─ unread / local seen 관리
  ├─ response session / 다음 방 선택
  ├─ reply scheduler / 방별 cache
  ├─ State Builder / decision policy executor
  ├─ source registry / selective retrieval
  ├─ minimal context compiler / evidence bundle
  └─ trajectory recorder
       ↕ 로컬 stdio
로컬 모델 worker
  ├─ base reply model + active Personal LoRA
  ├─ Context Intelligence Model (공통 encoder + typed heads 지향)
  └─ 불확실한 판단을 처리하는 로컬 reasoning 경로
       ↕
TUI: 최신순 목록 + unread 배지 + 흐린 추천 + Tab/Enter
```

생성 실행기는 MLX-LM으로 시작한다. 기준 Mac의 합성 한국어 사례 비교에서는 Qwen3.5-9B 4-bit post-trained를 기본 로컬 모델로 선정했다. Qwen3.5-4B는 더 빠르지만 근거 없는 확정 오류가 많아 현재 기본값으로 채택하지 않는다. 실제 가중치 revision·지연·품질 판정·한계는 [모델 비교 기록](23-local-model-evaluation.md)을 따른다. 초기에는 9B 단일 baseline을 사용하고, 전용 CIM과 개인화된 fast 모델은 검증된 범위에서 분리한다. 모델 설치와 runtime을 분리하고, 설치 후 내장 추론은 네트워크 없이 동작해야 한다. daemon은 모델 입력과 작업을 관리하며 모델에 메신저 자격 증명이나 전송 권한을 주지 않는다.

### 제안 API

| API | 역할 |
| --- | --- |
| 기존 `account.list` 확장 | 최신 activity, 구조화된 unread, 방별 추천 준비 상태 반환 |
| `response.open` | 현재 방·확인할 수신 범위의 세션을 열고 유효한 cache 결과 반환, cache miss면 우선 요청 |
| `response.get` | 현재 세션의 추천 준비 상태·본문 조회 |
| `response.seen` | 실제 화면에 표시된 메시지의 확인 경계 기록 |
| `response.feedback` | 추천 표시·삽입·첫 입력·종료 이벤트 기록 |
| `response.next` | 현재 세션과 필터 기준 다음 미확인 방 식별. 호출 자체는 읽음 처리하지 않음 |
| 기존 `message.send` 확장 | 선택적 response session 연결과 최종 본문·전송 결과 기록 |

이름은 구현 시 확정한다. 각 요청은 모델 완료를 기다리지 않고 짧게 반환한다. 첫 버전은 현재 세션에 대해서만 250ms 초기 간격으로 생성 상태를 조회한다. 모든 방을 TUI에서 polling하지 않는다. unread와 목록은 기존 daemon 변경 알림 경로를 확장해 갱신한다.

내부 reply pipeline은 `route → retrieve(선택) → compile → generate → evaluate` 단계로 나눈다. response API의 결과에는 UI용 준비 상태와 추천문을 반환하고, route/evidence의 상세 기록은 별도 로컬 trajectory로 보관한다. TUI는 생성기나 학습 방식이 달라져도 같은 계약을 사용한다.

세션 응답은 connection generation·session ID·chat key가 일치할 때만 반영한다. 같은 ID의 재요청·feedback은 중복 저장하지 않는다. background cache가 외부 MCP에 자동 공개되지 않도록 기존 접근 경계와 분리한다.

## 8. 상태와 저장 계약

### 서로 분리할 상태

| 상태 | 수명·의미 |
| --- | --- |
| provider unread evidence | provider가 관측 시점에 보고한 값. 없거나 오래됐을 수 있음 |
| local seen boundary | Inboxd가 실제 표시한 범위. 재시작 후에도 유지 |
| pending response session | 지금 확인·작성·전송하는 수신 범위 |
| reply cache | 해당 context의 미리 만든 추천. 모델·context 변경 시 무효화 |
| draft | 사용자 입력. 다른 방의 추천이나 실시간 정렬로 변경하지 않음 |
| send record | 기존 request ID·전송 결과. 중복 전송 방지의 기준 |

기존 SQLCipher DB에 필요한 상태와 trajectory를 추가한다. provider evidence와 local seen을 하나의 덮어쓰기 숫자로 합치지 않는다. provider의 뒤늦은 unread 값 때문에 이미 확인한 동일 메시지를 다시 순회 대상으로 만들지 않는다. 반대로 수신 내용을 아직 확보하지 못한 count-only evidence를 확인 완료로 소거하지 않는다.

### 세 가지 memory와 Context Escalation

| Memory | 보관하는 것 | 사용 원칙 |
| --- | --- | --- |
| Working memory | 현재 thread의 최근 흐름과 unread 수신 | 가장 먼저 확인, 필요한 범위만 모델 입력으로 구성 |
| Episodic memory | 이전 대화·메일·문서·agent 기록·일정의 사건과 사실 | information gap이 있을 때 근거를 검색 |
| Parametric personal memory | Personal LoRA의 말투·선호·확인/거절/응답 패턴 | 사실 저장소 대신 개인 행동의 prior로 사용 |

Personal LoRA가 계약금액을 출력했다고 사실 근거로 인정하지 않는다. 정확한 값은 당시 유효한 대화·문서 등의 evidence로 확인한다. 학습 과정에서 사실을 전혀 암기하지 않는다고 보장할 수도 없으므로 출력과 근거의 연결을 유지한다.

### 먼저 정의할 decision graph

설계 순서는 **agent policy / decision graph → trajectory schema → evaluation → learning**이다. LoRA의 구체적 구조나 수집 필드부터 고정하지 않는다. 아래 그래프를 실행 가능한 첫 정책으로 정의하고, trajectory는 그 실행을 관측한다. Personal LoRA는 초기 개발에서 병행하되 이 순서를 따른다.

```text
수신 이벤트 + thread snapshot
  → 응답 필요성·intent 판단
      ├─ no_reply → 추천 없음 (unread나 사용자 순회는 유지)
      └─ 응답 후보 → context 충분성 판단
          ├─ 충분 → 답변 가능성·authority 판단
          └─ 부족 → information gap 정의 → 허용 source 선택
                    → 검색·근거 확인 → 충분성 재판단
                      (예산 소진/미해결 → clarify 또는 defer)
  → 근거와 사용자 결정의 범위 안에서 응답 전략 선택
  → 개인화 생성 → 근거 없는 확정·약속 점검
  → 추천 표시 또는 보류
  → 사용자 선택·전송 결과 관측
```

| 노드 | 입력 state | 결정·실행 | 다음 단계 / 종료 |
| --- | --- | --- | --- |
| Respond / intent | 수신 범위, 최근 흐름, 본인 identity | 응답 후보 / 무응답 / 불확실, intent | 무응답은 추천 보류, 나머지는 충분성 판단 |
| Sufficiency | thread, intent, 확보한 evidence | 필요한 사실·사용자 의사와 gap 식별 | 충분하면 authority, 부족하면 source 선택 |
| Source selection | gap, source registry, 남은 예산 | 허용 source·검색어·scope 선택 | 검색 가능하면 retrieve, 없으면 clarify/defer |
| Retrieve / validate | query, snapshot 범위 | 실제 조회, 관련성·시점·충돌 확인 | 새 evidence로 충분성 재판단, 반복 gap·동일 query는 예산 내에서도 중단 |
| Authority / strategy | evidence, 미해결 gap, 사용자 결정 | 사실 전달 / 확인 질문 / 보류 / 근거 있는 제안 | 허용된 응답 전략을 생성기에 전달 |
| Generate / check | 최소 context, 전략, personal adapter | 생성 후 사실·확정 표현을 근거와 대조 | 유효하면 준비 완료, 실패하면 한 번 수정 또는 보류 |
| Present / observe | 유효한 추천 버전, 현재 UI session | 표시·수락·직접 작성·전송 결과 기록 | 실제 관측만 기록, 모델 호출 없이 UI 동작 유지 |

새 수신으로 context가 바뀌면 기존 실행을 `superseded`로 끝내고 새 snapshot으로 시작한다. 사용자가 이미 작성 중인 draft는 덮어쓰지 않는다. 검색과 생성은 취소 가능해야 하며, 오류로 노드가 재실행돼도 step/action ID로 중복 결과를 구분한다. 외부 조회의 재시도도 같은 예산에 포함한다.

각 노드는 입력 state, 허용 decision, 실행 action, 종료 조건을 갖는다. 단순 코드로 결정할 수 있는 상태는 모델에 묻지 않는다. 충분성·intent 등의 판단은 같은 로컬 호출에서 묶을 수 있으나 결과는 각각 식별 가능해야 한다. 검색 후의 재판단과 생성 후의 확인도 별도 실행 단계로 남긴다.

authority 판단은 ‘지금 자동으로 보내도 되는가’가 아니라 **추천문에 어떤 확정·약속을 담을 근거와 사용자 의사가 있는가**를 뜻한다. 현재 제품의 전송 주체는 항상 사용자다. 조회된 계약 조건만으로 새 계약 승낙 의사를 만들어내지 않는다.

### Router의 네 가지 판단

1. 답변이 필요한가? 바로 말할지, 확인 질문을 할지, 답하지 않을지 판단한다.
2. 현재 thread로 필요한 사실과 사용자 의도를 알 수 있는가?
3. 부족하다면 무엇이 없고 어떤 출처가 그 정보를 제공할 수 있는가?
4. 근거를 찾더라도 무엇까지 제안할 수 있는가? 사실 확인과 사용자의 결정·권한을 구분한다.

예: ‘지난번 조건대로 진행할까요?’에는 ‘지난번 조건’과 ‘이번 진행 의사’라는 서로 다른 gap이 있다. 과거 계약을 찾으면 전자는 채울 수 있지만, 후자의 새로운 의사결정은 사용자의 입력이 필요할 수 있다. 정보 조회만으로 승인했다고 답하지 않는다.

판단 모델의 raw score를 검증한 **policy executor의 실행 계획**이다. 모델의 출력 계약은 §10에 별도로 정의한다:

```typescript
type ContextPlan = {
  action: "reply" | "retrieve" | "reason" | "clarify" | "defer" | "no_reply";
  threadSufficiency: "sufficient" | "insufficient" | "unknown";
  gaps: Array<{
    key: string; // 예: previous_price, project_status, availability
    question: string;
    sourceCandidates: string[];
  }>;
  queries: Array<{ sourceId: string; query: string; scope: object }>;
  evidenceIds: string[];
  unresolvedGaps: string[];
  reasonCode: string;
  policyVersion: string;
};
```

이는 행동 계획이지 chain-of-thought 전문이 아니다. 필요한 판단·간단한 이유 코드·출처·결과만 기록한다. 판단 모델의 confidence만으로 충분성이나 권한을 확정하지 않는다.

### 선택적 검색과 종료 조건

source registry는 조회 가능 범위, source 종류, freshness, 검색 비용, 제공할 수 있는 필드를 노출한다. Router는 출처를 무조건 순서대로 전부 순회하지 않고 gap에 맞는 것을 고른다.

- 같은 방의 과거 약속 → 현재 방의 이전 대화.
- 다른 메신저에서 나눈 이야기 → 확인된 동일인의 허용된 다른 conversation.
- 계약 조건 → 연결된 메일·문서 중 해당 계약.
- 일정 가능 여부 → 연결된 일정과 관련 맥락. 비어 있는 시간만으로 의사를 확정하지 않음.
- 사용자가 예전에 agent와 내린 결정 → 선택한 agent 대화 기록.

첫 실행 예산은 retrieval 최대 2 round, source/query 호출 총 3회, 근거 입력에 별도 token budget을 둔다. 수치들은 조정 가능한 초기값이다. 조회가 실패하거나 source가 없으면 `unavailable`로 남기고 없는 사실로 해석하지 않는다. 근거가 충돌하면 출처·시점을 비교하고 해결되지 않으면 확인 질문이나 보류로 전환한다.

source adapter는 읽기 전용이다. 메일·문서 수집은 source 설정 범위에서 수행하고 내장 모델에는 로컬로 확보한 자료만 전달한다. 필요에 따른 provider 조회와 외부 모델 전송을 구분한다. 로컬 추론 원칙은 유지한다.

### 최소 context와 근거 묶음

```text
thread snapshot
+ 갭을 채우는 evidence (원본 key/version, 발췌, 시점, 범위)
+ 해결되지 않은 gap
+ 관계/상황 정보
→ 개인화된 생성 입력
```

모든 자료를 합치지 않는다. 실제 사용한 입력과 생략된 범위를 기록한다. unread 범위를 모델 한도 때문에 일부만 넣었다면 전체에 답했다고 기록하지 않는다. 본인 identity와 사용자 확인된 관계만 사용한다. 외부 자료의 instruction은 자료이며 실행 권한이 아니다.

## 9. 관측 데이터와 closed learning pipeline

목표는 고정된 파인튜닝 dataset을 먼저 완성하는 것이 아니다. 실사용에서 **어떤 추천이 언제 준비되고, 사용자는 무엇을 보고 어떻게 보냈는가**를 연결해 개선할 수 있게 한다.

### Trajectory는 policy의 실행 이력

핵심 단위는 message pair가 아니라 `state → decision → action → outcome`의 연속이다. 한 실행에 여러 검색·재판단이 생길 수 있으므로 평면 로그 하나로 압축하지 않는다.

```text
trajectory (policy_version, trigger, room, input_snapshot)
  ├─ step: state_ref → decision → action → observation / outcome
  ├─ step: 이전 step + 새 evidence → decision → action → outcome
  ├─ output: generated / withheld / superseded
  ├─ exposure: 실제 표시 여부·시점·사용자가 본 버전
  ├─ human_response: accept / edit / manual / dismiss / unobserved
  └─ outcome: 전송 결과 + 관측 가능한 후속 대화 참조
```

step에는 `step_id`, `parent_step_id`, `node_type`, `input_refs`, 구조화된 결정과 reason code, action 인자·결과 참조, 상태·소요 시간·모델/정책 버전을 둔다. 실행하지 않은 검색이나 관측하지 않은 인간 행동은 기록으로 만들어내지 않는다. 실패·취소·예산 소진도 결과다. 원문 근거는 로컬 snapshot/reference로 연결하고 내부 사고 과정 전문을 저장하는 의미로 해석하지 않는다.

후속 메시지는 발생하면 별도 이벤트로 연결한다. 답변 직후 결과를 알 수 없는 경우 `unknown`으로 남기며, 상대방의 후속 반응을 곧바로 성공/실패의 정답으로 간주하지 않는다. `ignore`도 명시적 dismiss와 단순 미관측을 구분한다.

### Decision graph에서 도출한 첫 관측 초안

```text
suggestion_id / response_session_id / chat_key
source_message_keys / incoming_version / thread_snapshot / compiled_context
route_plan / gap_keys / queried_sources / query_results / evidence_versions
unresolved_gaps / route_status / route_timing / retrieval_cost
model_version / personal_adapter_version / router_version / prompt_version / observation_version
state_builder_version / decision_schema_version / calibration_version / threshold_policy_version
head_scores / validity_masks / uncertainty_flags / selected_action / escalation_reason
queued_at / generation_started_at / generated_at
room_opened_at / shown_at / first_input_at / inserted_at
suggested_text / final_submitted_text / send_request_id / send_outcome
closed_reason / hidden_reason / context_changed
```

- 준비했으나 방을 열지 않은 추천, 늦어 표시하지 않은 추천, 보고 직접 작성한 추천을 구분한다.
- 직접 입력은 추천을 화면에서 없애지만 이미 노출된 추천과 최종 본문의 연결을 지우지 않는다.
- 모든 키 입력이나 취소한 draft 전문은 기본 수집하지 않는다. 첫 입력 시점, 수락 여부와 전송 직전 최종 본문부터 시작한다.
- 생성·표시·삽입·전송을 각각 기록한다. 미노출은 거절이 아니고, 무반응은 답변 불필요의 정답이 아니다.
- 전송 실패·Uncertain을 실제 전송 완료와 구분한다. request ID로 중복을 제거한다.
- 추천을 본 뒤 보낸 문장도 추천의 영향을 받을 수 있다. 독립적인 정답으로 단정하지 않는다.
- 외부 클라이언트 전송을 이 TUI에서 관측한 인간의 선택과 섞지 않는다.

관측 형식은 버전을 두고 실제 질문에 맞춰 바꾼다. 먼저 필요한 것은 사례를 로컬에서 재구성하는 기능이다. 사용자가 공유할 결과를 선택할 수는 있지만 자동 telemetry는 없다.

### 개선 루프

```text
현재 버전으로 사용
 → 실패·불편 사례 확인
 → 부족한 관측 보완
 → prompt/context/판단/생성 모델 중 필요한 부분 개선
 → 보류한 사례와 실사용 비교
 → 새 버전 적용 또는 이전 버전 유지/복구
```

### 서로 다른 학습 신호

| 신호 | 배울 것 | 정답 근거 |
| --- | --- | --- |
| Routing supervision | 언제 어느 정보를 확인할지 | 관측된 조회·선택한 evidence·명시적 context 교정 |
| Retrieval supervision | gap에 맞는 출처·검색어·근거를 선택할지 | 실제 검색 결과와 근거 적합성 검토. 조회 성공과 유용성을 구분 |
| Reasoning / authority supervision | 근거가 허용하는 확정 수준과 사용자 의사를 구분할지 | 근거·제안된 약속·명시적 사용자 교정 |
| Generation supervision | 근거를 바탕으로 사용자답게 답할지 | 당시 context와 사용자가 실제 보낸 메시지 |
| Preference supervision | 어떤 표현/행동을 더 선호하는지 | 비교 가능한 후보·노출·수정·사용자 평가 |
| Delegation supervision | 향후 어떤 범위를 위임 후보로 볼지 | 표본 수·내용 정확성·사용자 결정·후속 결과. 자동 권한 부여에는 사용하지 않음 |

사용자가 답변을 고쳤다는 사실만으로 router가 틀렸다고 단정하지 않는다. 다른 문서를 실제로 확인했다는 관측이나 사용자가 지정한 근거가 없으면 ‘context 부족 추정’과 ‘확인됨’을 구분한다. 답변 차이만으로 사용자의 숨은 의도를 정답 라벨로 만들지 않는다.

문체만 고친 예시와 새로운 사실을 추가한 예시도 자동으로 완벽히 나눌 수 있다고 가정하지 않는다. 초기에는 로컬 사례 검토로 분류하고 관측을 보완한다. 관측 기록은 먼저 넓게 연결하되 학습 dataset은 신호별 적격 조건으로 만든다.

### 오류 분해와 평가

동일한 문장 수정도 routing(필요한 자료를 찾지 않음), retrieval(찾았지만 잘못된 근거), reasoning/authority(근거는 맞지만 승낙을 과도하게 단정), personalization(내용·의도는 맞지만 표현 불일치)으로 나눠 검토한다. 여러 원인이 함께 있거나 판별 불가일 수 있다.

Tab 수락만으로 검색이 필요했다는 정답을 만들지 않는다. 불필요한 검색 뒤 수락할 수도 있다. 검색 기여는 근거 검토와 검색 유무 비교 평가로 확인한다. 최종 문장만 있는 과거 history에서 router decision 정답을 역으로 지어내지 않는다.

먼저 이 그래프의 대표 사례와 종료 조건을 평가 fixture로 정의하고, 단계별 품질·근거 적합성·확정 수준·전체 지연을 평가한다. 그 뒤 적격 관측에서 routing, retrieval, personal LoRA, preference, 향후 delegation dataset을 각각 추출한다. 하나의 trajectory가 여러 dataset에 기여할 수 있지만 모든 기록이 모든 학습의 정답은 아니다.

### Personal LoRA를 초기부터 병행

- 이미 수집된 본인 history에서 context–reply 쌍을 만들고 첫 local offline LoRA를 실험한다. explicit reply 또는 신뢰할 수 있는 turn 연결만 사용한다.
- 다른 사람의 발언, context가 없거나 순서가 불명확한 메시지, 원본 수정 시점을 복원할 수 없는 사례는 무리하게 정답으로 넣지 않는다. 초기 history dataset과 실시간 trajectory dataset의 근거 수준을 구분한다.
- 관계·상황과 확인/거절/짧은 응답 같은 행동을 입력에 포함한다. 첫 adapter는 생성에 적용하고, router의 개인화에도 적용할 수 있는 구조로 둔다.
- 초기 판단 모델은 공통 모델로 두고 사용자별 threshold/calibration만 별도로 version 관리한다. 개인 Reply LoRA와 섞지 않는다. router 개인 adapter는 충분한 적격 데이터와 별도 검증이 생긴 이후의 선택지다.
- LoRA가 바꿀 수 있는 것은 허용 범위 안의 표현과 확인 전략이다. source 접근 권한이나 전송 권한은 학습 모델 밖의 정책이 결정한다.
- 매 interaction 직후 학습하지 않는다. 초기에는 수동 batch 실행으로 시작하고, 주간 또는 적격 신규 예시 500건 같은 트리거는 평가 후 설정 가능한 후보로 둔다. 숫자 자체가 품질 보장은 아니다.
- 모델 교체 전에 시간순 holdout과 실제 사용 비교를 수행한다. 개인 LoRA가 반드시 baseline보다 좋다고 가정하지 않는다.

적용한 개선이 UI·수신·전송 구조를 바꾸지 않도록 생성 모델·개인 adapter·context 정책·판단 모델의 버전을 분리한다.

학습을 한다면 원본 예시와 dataset·adapter·checkpoint의 계보를 남기고 base와 개인 adapter를 분리한다. 사례 삭제가 즉시 가중치에서 정보 제거를 뜻하지 않음을 명시하고, 폐기·제외 후 재학습·rollback을 지원한다.

## 10. Inboxd Context Intelligence Model

### 역할과 경계

Laya를 통째로 도입하는 계획이 아니다. 사용자 제안의 **작은 모델·typed decision·fast routing** 방향을 Inboxd의 context 판단에 맞춰 설계한다. 내부 가칭은 ‘Inboxd Laya’일 수 있지만 문서와 계약에서는 **Inboxd Context Intelligence Model(CIM)**을 사용한다. 기존 Laya와의 호환성이나 동일한 구현을 뜻하지 않는다.

핵심 질문은 ‘이 state에서 사용자의 다음 행동을 제안하려면 무엇을 더 알아야 하는가?’다. CIM은 답변을 생성하거나 도구를 직접 실행하지 않는다. 제한된 선택지와 점수를 내고, daemon의 policy executor가 근거·권한·예산을 적용해 행동을 결정한다. Jev/Laya의 구체적인 가중치·API·런타임은 필수 의존성으로 두지 않는다.

```text
State Builder
  → CIM: response / sufficiency / gap / source / risk / escalation
  → policy executor
      ├─ thread 충분 → 개인화 생성
      ├─ 정보 부족 → 선택적 검색 → 갱신된 state 재평가
      ├─ 판단 불확실·근거 충돌 → 로컬 reasoning
      └─ 사용자 의사 필요·해결 불가 → 확인 질문 / 보류
  → 추천·사용자 행동 → trajectory → 평가·학습
```

### State Builder: 판단 전에 몰래 판단하지 않기

작고 재현 가능한 입력을 구성한다. 최근 메시지 개수는 token budget 안에서 조절하며 최신 수신 범위·화자·시간·명시적 reply 연결을 보존한다. 단순 요약만 남겨 부정·조건·인용 맥락을 지우지 않는다.

- 현재 수신 원문과 최근 thread, 본인 identity, group/direct 등 확인 가능한 메타데이터.
- 사용자 확인된 관계와 관측된 행동 요약. 표본 수·대상 기간·출처를 함께 둔다.
- 조회 가능한 source registry와 로컬 index의 존재 정보, 이미 확보한 evidence.
- 잘린 범위, freshness, 없는 값과 모르는 값, evidence provenance.

`previous_contract_exists=true`는 실제 index/evidence가 있을 때만 넣는다. ‘현재 thread에 계약 조건 없음’은 단순 전처리 사실이 아니라 의미 판단이므로, 근거 없이 State Builder가 써 주지 않는다. 압축에 모델을 썼다면 버전·원본 참조·누락 범위를 남겨 별도 평가한다. 요약된 state가 틀리면 CIM 학습 문제와 구분한다.

`context_scope`는 thread / same-person / workspace 같은 **자료 범위**다. `source`는 chat / email / file / calendar / agent-history 같은 **자료 종류**다. ‘external’이라는 값으로 다른 방의 로컬 자료와 외부 모델 호출을 혼동하지 않는다. 내장 판단·reasoning·생성은 모두 로컬이다.

### 논리적 계층, 공유 encoder와 여러 head

decision graph는 계층적이지만 각 판단마다 모델을 다시 로드하지 않는다. 작은 pretrained encoder를 기반으로 공유 representation과 여러 head를 학습하는 구조를 첫 후보로 둔다. 처음부터 base model을 새로 pretrain하지 않는다. 한국어·긴 thread·Mac 성능을 평가해 backbone과 크기를 결정한다.

| Head | 출력 의미 | 정책 적용 |
| --- | --- | --- |
| response | respond / no_reply / uncertain | no_reply여도 unread·순회는 유지 |
| sufficiency | sufficient / insufficient / unknown | thread와 현재 evidence가 해당 응답 전략에 충분한지 |
| gap | previous_agreement, availability, project_state, user_decision, other 등 | 여러 gap 동시 선택 가능 |
| source | 허용된 source별 관련성 점수 | 여러 출처 가능, 접근 권한은 registry로 제한 |
| risk | unsupported_commitment, sensitive_context 등 위험 유형 | 오류 비용·검토 정책을 선택, 전송 권한 부여 아님 |
| escalation | direct / retrieve / reason / clarify / defer | 현 state에서 다음 한 행동, 조회 후 다시 평가 |

서로 배타적인 head는 분포로, gap/source/risk는 multi-label 점수로 취급한다. 예를 들어 메일과 파일이 모두 필요할 수 있으므로 두 점수의 합을 1로 강제하지 않는다. `other`, `unknown`, `not_applicable`을 구분한다. gap ontology와 출력 schema는 version 관리한다.

응답 보류 등으로 하위 판단이 불필요하면 validity mask를 적용한다. 실행하지 않은 하위 head를 음성 정답으로 학습하지 않는다. ‘충분하지만 retrieve’, ‘사용자 결정 gap인데 검색으로 승인 추론’ 같은 모순은 policy validator에서 검출한다. 필요하면 로컬 reasoning에 넘기고 해결되지 않으면 clarify/defer로 종료한다.

### 모델 출력과 실행 계획을 분리

```typescript
type ScoredDecision = {
  stateId: string;
  schemaVersion: string;
  modelVersion: string;
  scores: {
    response: Record<string, number>;
    sufficiency: Record<string, number>;
    gaps: Record<string, number>;       // multi-label
    sources: Record<string, number>;    // multi-label
    risks: Record<string, number>;      // multi-label
    escalation: Record<string, number>;
  };
  validHeads: string[];
  uncertaintyFlags: string[];          // truncated / out_of_domain 等
  calibrationVersion: string | null;
};
// 실제 구현에서는 version별 enum key, 유한한 [0,1] 점수,
// 배타 head의 합, 필수 head와 registry source ID를 runtime 검증한다.
// policy executor가 이 출력으로 §8 ContextPlan을 만든다.
```

CIM은 gap 종류와 출처 후보를 분류한다. 구체적인 ‘어느 계약의 어떤 조건인가’와 검색어는 원문 span·확인된 entity·query template으로 구성하고, 모호하면 로컬 reasoning으로 보완한다. 작은 classifier가 자유형 검색 계획까지 모두 생성한다고 가정하지 않는다.

### Confidence와 escalation

점수는 반드시 보존하되 모델이 출력한 `0.91`을 91% 정확도로 간주하지 않는다. head별 held-out label로 calibration을 평가하고 `calibrationVersion`을 붙인다. 보정 근거가 없으면 raw score로 표시·기록한다. 하나의 overall confidence로 충분성·출처·risk를 뭉치지 않는다.

개인별로 조정하는 첫 대상은 허용된 정책 안의 retrieval/reasoning threshold다. 적은 사례에서는 공통 기본값을 유지한다. 금액·일정 확정 등에 필요한 사실 근거나 사용자 의사 확인을 선호 threshold가 면제하지 못한다.

저신뢰, 미지원 domain, 잘린 context, 모순된 head, 충돌하는 evidence는 로컬 reasoning 경로로 넘긴다. reasoning은 사실 부재를 메우는 수단이 아니며, 필요한 자료나 사용자 결정이 없으면 확인 질문·보류를 선택한다. 무한 escalation을 막기 위해 최초 정책 판단과 retrieval 각 round 후의 판단만 허용하고, 동일 state에서 reasoning은 한 번으로 제한한다. 오류·시간 예산 초과 시 직접 작성은 계속 가능하다.

### 초기 모델 구축과 학습 데이터

전용 모델은 목표 구성 요소지만 학습 데이터가 생기기 전에 완성된 classifier가 있다고 가정하지 않는다. 먼저 동일 typed 계약의 로컬 LLM baseline으로 policy를 실행하고, 검토된 사례로 작은 multi-head 모델을 학습·비교한다. baseline의 판단은 teacher proposal이며 자동 정답이 아니다. 사용자 원문을 외부 학습 서버로 전송하지 않는다. 공통 모델은 공통 구조·배포 기본 가중치를 뜻하며 사용자 간 원문 통합 수집을 뜻하지 않는다.

1. decision graph의 대표 사례와 실패 조건을 먼저 정하고 초기 검토 label을 만든다.
2. 실제 실행에서 state·head score·정책 선택·근거·사용자 행동을 연결한다.
3. 노드별 label 적격성을 확인한다. 미관측 head는 loss mask로 제외한다.
4. 작은 모델을 shadow mode로 평가한다. shadow 판단으로 추가 검색·사용자 노출을 실행하지 않는다.
5. 검증된 범위에서 fast path에 적용하고 나머지는 로컬 reasoning baseline으로 보낸다.

사용자가 메일을 열었다는 사실만으로 ‘thread insufficient’ 정답은 아니다. 실제 답변에 쓰인 새 근거 또는 명시적 교정이 있어야 강한 label이 된다. Inboxd 밖의 앱 사용은 기본 관측 범위가 아니며, 관측하지 않은 검색을 추측해서 기록하지 않는다. final reply 차이도 곧바로 LoRA 학습에 넣지 않고 §9의 적격 조건을 적용한다.

### 평가와 적용 기준

- thread가 부족한데 충분하다고 판정한 비율, 필요한 답변을 no_reply로 숨긴 비율.
- gap별 재현율, source 근거 적합성, 불필요한 검색과 미해결 gap.
- head별 calibration(Brier score·reliability 구간), fast path coverage 대비 오류율.
- 잘린 입력·새 관계·새 intent에서의 fallback, 정책 모순과 authority 오류.
- State Builder부터 fallback·retrieval까지 포함한 p50/p95 지연·메모리·방 진입 시 준비율.

시간순 train/validation/test 분리와 대화·근접 중복 예시의 누출 방지를 적용한다. threshold와 calibration은 validation에서 정하고 test로 결과를 확인한다. 정답 전체 정확도 하나 대신 intent별 오류 비용을 보고, 로컬 LLM baseline과 end-to-end 품질·비용을 비교한다. 더 작은 모델이라는 이유로 배포하지 않는다.

### 세 학습 축의 경계

| 축 | 초기 구성 | 개선 신호 |
| --- | --- | --- |
| Context Intelligence | 공통 모델 + 사용자별 policy calibration | 검토된 routing/retrieval/authority 판단과 근거 |
| Personal Reply | 로컬 base + 개인 LoRA | 적격 context–reply 및 preference 사례 |
| Delegation | 장기 연구용 정책·평가, 현재 자동 전송 없음 | 수락 패턴에 정확성·결과·사용자 권한 결정을 함께 고려 |

처음부터 세 개의 학습 모델을 모두 운영하지 않는다. 초기 제품은 앞의 두 축을 구축하고 delegation은 근거를 보존한다. 수락률은 선호 신호이며 위임 가능성의 충분조건이 아니다.

## 11. 현재 코드에서 바꿀 위치

현재 코드에는 최신 시각순 정렬의 기본 구현과 provider별 일부 unread 필드가 이미 있다. 새 목록을 전면 작성하기보다 실제 데이터가 UI까지 전달되도록 보완한다.

| 위치 | 현재 기반과 변경 |
| --- | --- |
| `packages/tui/src/workspace-model.ts` | `conversationRows`의 최신순 정렬 유지·보완. 구조화된 unread와 안정적인 chat-key 선택 적용 |
| `packages/tui/src/index.ts` | `chatRows`에서 provider unread가 소실되지 않게 전달. 목록 갱신 후 선택 유지, response session, Tab 상태 전이, 직접 입력과 전송 연결 |
| `packages/tui/src/workspace.ts` | unread 배지, 미확인 경계, 입력창 ghost text, 상태별 Tab 안내 |
| `packages/tui/src/runtime.ts` | 입력창 포커스, 붙여넣기, 실제 표시된 메시지·추천 관측 |
| `crates/inboxd-daemon/src/accounts_live.rs` | 저장 완료된 신규 수신·변경을 unread/reply scheduler에 연결 |
| `crates/inboxd-daemon/src/accounts_backend/*` | provider unread·본인 identity·reply 정보의 실제 지원 범위 확인 및 필요한 정규화 |
| `crates/inboxd-daemon/src/reply.rs` 신규 | background queue, pipeline 단계, evidence-aware cache, 모델 worker, 버전·취소 관리 |
| State Builder / CIM policy executor 신규 | 상태·typed head 검증, calibration/threshold, source 권한·검색 예산, evidence·충돌 처리 |
| daemon의 response service 신규 | seen 경계, 현재 응답 세션, 다음 방 선택 |
| protocol의 Rust/TypeScript 계약 | 구조화된 unread, response API, 전송 metadata |
| `crates/inboxd-storage` 및 migration 정의 | 로컬 seen·응답 세션·추천·trajectory 저장 |
| `crates/inboxd-daemon/src/direct_send.rs` | 전송 직전 session 연결과 결과 반영. 기존 중복 방지 유지 |
| `packages/reply-model/` 신규 | 로컬 생성·판단 계약, 초기 LoRA train/eval/activate/rollback, dataset provenance |

현재 `conversationRows`는 legacy 메시지의 `Unread: N` 문자열을 파싱하지만 account 목록 경로와 충분히 연결되지 않는다. 카카오·Slack의 일부 backend는 unread를 반환한다. 모든 플랫폼에 같은 지원이 있다고 가정하지 않고 실제 전달 경로와 테스트를 확인한다. 첫 구현에서 unread 계약은 문자열 파싱 대신 구조화된 필드로 통일한다.

현재 daemon의 일반 RPC를 모델 완료까지 기다리는 형태로 확장하지 않는다. 모델 작업은 background로 실행하고 API는 즉시 상태를 반환한다. 전송이 추론 완료를 기다리는 구조를 피한다.

## 12. 구현 순서

### A. 목록과 미확인 상태

실시간 최신순 정렬, 숫자 배지, provider evidence와 local seen, 선택한 방 유지부터 구현한다. 이 단계에서는 추천 없이도 새 메시지와 확인 상태가 정확하게 보이는지 확인한다.

완료: 여러 방에 새 메시지가 오면 올바른 방이 위로 이동하고, 선택·draft 목적지는 유지되며, 관측한 중복 메시지가 unread를 부풀리지 않는다.

### B. Tab·Enter 순회 UX

응답 세션과 입력창 포커스, 전송 완료 후 다음 방 이동을 구현한다. 테스트에서는 고정 추천을 주입해 상태 전이를 검증하되, 실제 제품에서 이를 AI 추천처럼 표시하지 않는다.

완료: 추천 수락 또는 직접 작성 → 전송 → 다음 방을 반복할 수 있고, 실패·새 수신·긴 미확인 내역을 잃지 않는다.

### C. Decision graph와 로컬 추천 사전 생성

노드 계약·초기 평가 fixture·step 관측을 먼저 정의하고, unread 기반 queue/cache에 State Builder → typed decision → policy executor → 선택적 source 조회 → 최소 context → 개인화 생성 경로를 붙인다. 첫 실행은 로컬 LLM 판단 baseline을 쓰되 CIM 교체 계약을 유지한다. 첫 실제 source는 현재 thread와 같은 방의 이전 로컬 기록이다. 다른 source는 adapter별로 연결하되 unavailable 상태도 정상 경로로 처리한다.

완료: thread만으로 충분하면 불필요한 조회 없이 빠르게 생성하고, 부족한 경우 해당 gap을 채우는 검색만 수행한다. 근거가 없거나 사용자의 결정이 필요하면 확인 질문/보류를 제안한다. 미개방 방에서도 준비하며 cache miss가 직접 입력을 막지 않는다.

### C와 병행: Personal LoRA 초기 실험

이미 수집된 적격 history로 local dataset과 train/eval 분리를 만들고 base+개인 adapter 학습·적용·rollback 경로를 구현한다. 전체 메일/문서 연결이나 retrieval 최적화가 끝날 때까지 미루지 않는다. history가 부족하면 학습 예시를 만들어내지 않고 빈 dataset/기본 모델 상태를 지원하며 실사용 trajectory를 쌓는다.

완료: 학습 가능한 데이터가 있으면 offline LoRA를 만들고 같은 context에서 base와 비교할 수 있다. adapter 교체·복구가 가능하고 학습 근거·버전이 남는다. 실험 성공과 품질 개선은 별도로 보고한다.

### D. 전용 CIM 학습·검증과 실제 사용

C에서부터 수신·route·source 조회·근거·생성·표시·입력·전송을 기록한다. 이 단계에서는 로컬 사례 조회와 label 검토를 제공하고, 적격 데이터로 전용 CIM 학습·calibration·shadow 평가를 수행한다. 실제로 여러 unread 방을 처리하며 준비 지연, 내용 오류, 작성 부담을 확인한다.

완료: 사례 재구성과 노드별 평가가 가능하고 CIM을 baseline과 비교할 수 있다. 데이터가 부족하면 baseline을 유지하고 미완료 학습 범위를 명시한다. 검증된 fast path만 활성화하며 필요한 관측을 보완한다.

### E. 추천 개선 루프

Router와 Personal LoRA를 각각 개선한다. 부족한 근거를 놓친 문제와 근거는 맞지만 표현/행동이 다른 문제를 분리해 실험한다. 동일 UI와 기록 계약 위에서 비교·적용·복구한다.

완료: 새 버전의 효과를 평가하고 선택해 적용할 수 있다. 파인튜닝 실행 자체가 완료 기준은 아니다.

## 13. 검증 시나리오와 측정

### 필수 동작 검증

- A·B·C방에 순서대로 수신 → 최신순 정렬과 unread 배지 갱신.
- A방을 선택한 상태에서 B방이 위로 이동 → A방 선택과 전송 목적지 유지.
- A방 Tab → Enter → Tab → B방 진입. 그 Tab으로 B 추천까지 수락하지 않음.
- B방 직접 입력 → 추천 즉시 숨김, 첫 문자 유지 → Enter → Tab 순회.
- 현재 방 전송 중 새 수신 → 기존 세션 전송만 완료, 새 미확인 범위 유지.
- 많은 미확인 메시지 중 일부만 표시 → 나머지를 읽음 처리하거나 완료로 소거하지 않음.
- 생성 중 방 이동·연속 수신·편집·삭제 → 오래된 추천 미표시, 사용자 draft 보존.
- provider unread가 없거나 오래됨 → 0으로 위장하지 않고 근거 범위 표시.
- reconnect·daemon 재시작 → 이미 본 동일 메시지를 무조건 새 unread로 세지 않음.
- Sent/Verified → 다음 방 가능. Failed/Uncertain → 성공처럼 이동·자동 재전송하지 않음.
- cache/trajectory 저장 실패 → 원래 전송 경로는 유지, 기록 누락을 드러냄.
- thread 충분 → source 조회 0회로 생성. ‘지난 조건’ 누락 → 해당 과거 기록만 조회.
- source 미연결·조회 실패·서로 충돌하는 근거 → 명시적 unresolved gap, 확인 질문/보류.
- source scope·근거 version·개인 adapter 변경 → 해당 추천 cache 무효화.
- 사용자의 수정만 있는 사례 → 근거 없는 routing 정답 라벨 자동 생성 안 함.
- 동일 context에서 base/Personal LoRA 비교, 동일 adapter에서 thread-only/adaptive context 비교.
- 모델 미설치·중단·메모리 부족 → 직접 작성·검색·수신·전송 유지.
- 모델 설치 후 네트워크 차단 상태에서 추론 성공, 외부 전송 시도 없음.

### 실제 사용에서 볼 지표

- 수신 저장부터 목록·unread 갱신까지 지연
- 수신 저장부터 추천 준비까지 지연과 방 진입 시 준비 완료율
- 준비했지만 표시하지 않은 추천 비율과 불필요한 생성 비용
- Tab 수락·수정 후 전송·직접 작성의 비율과 각 분모
- 전체 unread 처리에 걸린 시간과 사용자 체감 부담
- 잘못된 날짜·금액·약속 등 중요한 의미 수정
- 생성·판단 모델의 지연, cache 사용량, 전체 worker 포함 메모리
- 불필요한 조회, 필요한 근거 누락, gap 해결률, source별 실패·조회 비용
- 같은 evidence에서 개인 adapter의 문체/행동 적절성 및 사실 오류 변화
- 같은 adapter에서 context routing 변경의 효과

Router와 LoRA의 효과를 분리하기 위해 가능한 평가에서는 `thread-only/base`, `adaptive-context/base`, `thread-only/LoRA`, `adaptive-context/LoRA`를 비교한다. 이는 retrieval과 LoRA 중 하나를 고르기 위한 경쟁이 아니라 각각의 기여와 상호작용을 확인하기 위한 실험이다.

기준 Mac의 실제 값으로 목표를 정한다. 항상 즉시 응답, 일정 수의 데이터 이후 특정 정확도 같은 보장은 두지 않는다. 추천이 사용자의 표현에 영향을 줄 수 있으므로 무추천 비교 구간과 사용자 판단을 함께 사용한다.

## 14. 데이터 수명과 경계

메시지·추천·snapshot·관측·개인 모델 산출물은 로컬에서 암호화 관리한다. 기록 끄기·삭제와 보관 기간을 지원하며 기록 OFF 이후 늦은 작업이 개인화 데이터를 다시 만들지 않게 한다. 생성 작업·cache와 저장된 trajectory 모두 원본 메시지 출처를 유지한다.

원본의 명시적 삭제가 확인되면 관련 미완료 작업과 cache를 무효화하고 파생 데이터도 삭제·사용 제외한다. 전송 ledger의 원문 정리는 request ID 예약·결과와 중복 전송 방지를 유지하는 방식으로 설계한다. 단순 조회에서 없다는 이유만으로 삭제를 추정하지 않는다.

외부 MCP로 전달된 원문은 host나 외부 모델에 복제될 수 있으며 로컬 삭제로 회수할 수 없다. 제품의 약속은 ‘내장 추천·개선 과정은 로컬에서 처리한다’이다. 메신저 수신·전송과 사용자가 선택한 외부 연동까지 네트워크가 없다고 표현하지 않는다.

현재 구현 근거는 [검색 기반](20-search-foundation.md), [실시간 동기화](19-live-synchronization.md), [실계정 검증](21-live-reliability-validation.md)을 참조한다. 이 계획의 검증 완료와 기존 제한된 실계정 검증을 혼동하지 않는다.


## 15. 연구 근거와 검증할 가설

- [When to Retrieve (2024)](https://arxiv.org/abs/2404.19705)는 open-domain QA에서 필요한 경우 retrieval을 호출하는 학습을 다룬다. selective retrieval의 근거로 참고하며 개인 메신저 효과가 입증됐다고 해석하지 않는다.
- [Persona-Plug (ACL 2025)](https://aclanthology.org/2025.acl-long.461/)는 일부 retrieved example이 전체 사용자 패턴을 놓칠 수 있음을 지적하고 사용자 embedding을 사용하는 방법이다. **Personal LoRA가 retrieval보다 우수하다는 직접 증거는 아니다.**
- [PURPLE (ACL 2026)](https://aclanthology.org/2026.acl-long.1467/)는 의미 유사성과 실제 개인화 기여가 다를 수 있음을 다룬다. source 선택을 단순 유사도만으로 결정하지 않는 설계에 참고한다.
- [ReaLM-Retrieve (2026)](https://arxiv.org/abs/2604.26649)는 다단계 reasoning 중 선택적으로 evidence를 주입하는 연구다. 공개 QA 결과를 작은 로컬 모델의 한국어 메신저 성능으로 옮겨 주장하지 않는다.

이번 계획의 가설은 ‘필요한 사실을 선택적으로 확인하고, 별도로 사용자의 행동·표현 패턴을 학습하면 더 유용한 추천을 만들 수 있다’이다. 연구는 방향의 근거이며 실제 Inboxd 데이터와 기기에서 검증한다.

## 16. 병행 구현 범위

전체 중단 후 사용자 지시에 따라 TUI 개선을 별도 트랙으로 재개했다. 기존 작업 트리의 변경은 보존했다. 설치된 production daemon과 사용자 메신저는 중지하지 않았다.

- **계속 구현:** 최신순 정렬·unread·Tab/Enter·전송 연결·카카오 사용자 지정 방 이름과 이를 위한 seen/session 기반. 모델과 독립된 API·테스트 fixture로 검증한다.
- **현재 추천 엔진:** decision graph의 typed baseline, 현재 방 history 조회, step/evidence trajectory, 출력 검증을 구현했다. 전용 CIM 학습·보정과 사용자별 개인화 품질은 실사용 데이터로 이어간다.
- **통합 경계:** TUI는 준비 중/추천/보류 결과와 사용자 행동 계약만 사용한다. 내부 판단 모델·retrieval·학습 교체가 입력 동작이나 전송 대상을 바꾸지 않게 한다.

처음부터 모든 connector를 만들거나 현재 미완료 코드를 완료됐다고 보고하지 않는다. 개정 계획에 맞춘 통합·테스트 후 카카오톡 사용자 지정 이름 ‘가족’ 방에서 TUI 확인을 이어간다. 실제 발신 없이도 이름·읽기·추천 표시·Tab 삽입을 확인하고, 발신과 다음 방 순회는 우선 테스트 환경에서 검증한다.

## 17. 첫 구현의 검증과 남은 범위 (2026-09-22)

구현한 것은 TUI 순회, 로컬 추천 실행 경로, 단계별 관측·평가 기반이다. 전용 CIM이나 개인 모델의 학습 품질이 완성됐다는 뜻은 아니다.

- 실제 설치된 SQLCipher v4 DB에서 v5로 업그레이드하고 재시작했다. 처음에는 기존 `owner_sends` 재생성 오류가 발견돼 이전 실행 버전으로 복구한 뒤, 조건부 생성과 전송 기록 보존 회귀 테스트를 추가했다. 수정 후 실제 v5 진단이 정상이다.
- 실제 카카오 서버의 사용자 지정 방 이름은 `CHATINFO.mcMetas`의 JSON `name`에 있었다. 이 필드를 우선 사용하도록 수정하고 TUI에서 ‘가족’ 검색·방 제목을 확인했다.
- ‘가족’ 방 진입 시 입력창 포커스, 직접 입력·삭제를 확인했다. 실제 메시지는 발신하지 않았다. 당시 provider 안읽음은 0이었으므로 새 수신 기반 ghost 표시와 발신 후 순회는 실제 가족방에서 확인했다고 주장하지 않는다. 해당 동작은 테스트 환경에서 검증한다.
- 이후 사용자 제보로 설치본의 사전 생성 실패를 발견했다. Python 가상환경의 실행 파일 심볼릭 링크를 canonicalize하면서 base Python을 실행했고, 실제 `unread_prefetch` 4건이 `mlx_runtime_not_installed`로 실패했다. 실행 경로를 보존하도록 수정하고 회귀 테스트를 추가했다. 수정본 재시작 후 실제 안 읽은 방에서 진입 전 `ready` cache, TUI ghost 표시, Tab 초안 삽입을 확인했다. Enter 전송은 실행하지 않았다. 합성 worker 직접 실행만으로 설치본의 사전 생성까지 검증했다고 판단했던 이전 검증 범위를 정정한다.
- Shift+Tab을 일반 Tab으로 정규화하던 문제를 수정했다. 설치된 TUI에서 채팅방→필터→메시지→채팅방 역방향 순회와 작성 초안 보존·복귀를 확인했다. 메시지 영역 밖에서 Enter가 초안을 전송하지 않도록 회귀 테스트를 추가했다. 일반 Tab의 영역 이동은 제거하고 추천 삽입·다음 안 읽은 방 이동에만 사용한다. 영역 이동은 Shift+Tab만 담당한다. 설치된 TUI에서 일반 Tab이 채팅방·필터 포커스를 유지하는 것을 확인했고, TUI 테스트 140개가 통과했다.
- 읽음 동기화는 local seen만 저장하던 누락을 찾아 카카오 adapter와 연결했다. 낙관적 저장→비동기 요청→실패 복구로 분리하고 schema 6 업그레이드, 실패 복구와 늦은 응답의 경합을 검증했다. 이후 실계정 비교로 일반 단체방(`MultiChat`)과 DIO(`PlusChat`) 모두 `NOTIREAD` ACK만으로는 서버 읽음 상태가 바뀌지 않음을 확인했다. PlusChat만의 문제라는 초기 가설은 폐기했다.
- 근본원인은 과거 메시지의 명시적 읽음 확인에 필요한 `SYNCMSG` 완료 경로를 누락하고, `NOTIREAD` 통지 성공을 own-read 성공으로 취급한 것이다. `SYNCMSG`가 로그를 반환해도 `isOK=false`이면 완료가 아니다. 이미 사용자가 확인한 목표 ID에 `cur=target, max=target, cnt=0`으로 완료를 확인했을 때 DIO 서버 unread가 1→0으로 바뀌고 `LCHATLIST.s`가 목표 ID까지 이동했다. 일반 단체방도 동기화 완료 요청 후 unread 2→0과 서버 읽음 위치 이동을 확인했다. `CHATINFO.lastSeenLogId`는 성공 후에도 0이므로 이 필드만으로 검증하지 않는다. 실제 메시지 발신은 없었다.
- 따라서 서버 읽음 확인은 `SYNCMSG.isOK`와 새 `LCHATLIST.s`를 기준으로 한다. `SYNCMSG`는 서버 읽음 상태를 바꾸므로 사전 추천·백그라운드 수집의 읽기 전용 조회에서는 호출해서는 안 된다. 사용자 읽음 요청 경계에서만 이미 확인한 목표 ID의 동기화 완료를 알린다. SDK source/dist/patch에 반영하고 설치·재시작했다. 설치된 TUI에서 청년부리더의 긴 메시지를 끝까지 확인한 뒤 서버 unread 1→0과 원본 카카오톡의 방 배지·안 읽은 대화 배지 소멸을 확인했다. 가족방에서도 `read_sync: synced`, 로컬·서버 unread 0을 확인했다. 최종 조회에서 청년부리더·가족·DIO·풍성한교회 전체방 모두 로컬·서버 unread 0이었다. 새 패치를 적용한 SDK 클라이언트·프로토콜 테스트 159개, adapter·TUI 회귀 테스트 28개와 프로젝트 타입 검사가 통과했다. 실제 메시지는 보내지 않았다.
- local worker와 개인화 도구는 네트워크 차단 상태에서 합성 입력으로 실행했다. 생성뿐 아니라 Qwen3.5-4B/9B LoRA 학습 1 iteration, base/adapter 평가, 격리된 적용·복구를 확인했다. 실험 adapter를 실제 사용자 모델로 적용하지 않았다.
- 모델 품질·지연·보류 결과는 [모델 검증 기록](23-local-model-evaluation.md)을 따른다. 단독 생성 시간과 router·검증을 포함한 전체 시간을 구분한다.

현재의 source connector는 같은 채팅방의 로컬 과거 기록이다. 다른 대화·메일·파일을 이미 통합했다고 표현하지 않는다. CIM은 엄격한 typed enum을 출력하는 로컬 LLM baseline이며 학습된 encoder/head와 보정된 확률은 아직 없다. 개인 LoRA는 검토된 JSONL을 입력받는 수동 도구다. 실사용 trajectory에서 검토된 dataset으로 전환하는 자동 경로, 개인 모델 산출물의 암호화·삭제 연동, 자동 주기 학습은 남은 구현 범위다.
