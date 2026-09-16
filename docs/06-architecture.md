# 06 — Architecture: TUI까지의 설계 (2026-09-16)

05-review의 6개 보완점을 결정으로 바꾸고, 첫 사용자 인터페이스인 TUI까지 도달하는
구조를 정한다. 03-proposal의 철학·기능·스키마는 유지하고, 이 문서는 **누가 무엇을
소유하고, 저장소가 어떤 계약을 지키고, 어떤 순서로 쌓는지**를 정한다.

목표 인터페이스 순서: **CLI → TUI → MCP.** Slack 기반 TUI가 첫 제품 마일스톤이다.
그 전에 제한 채팅의 수집부터 CLI 검색까지 작은 실제 동작 경로를 검증한다.
전체 MVP 완료에는 카카오 읽기 통합과 두 플랫폼의 실질문 검증도 필요하다.
MCP는 같은 데몬 API 위의 얇은 클라이언트로 붙인다. 아래 결정은 기본안이며,
스파이크에서 반례가 확인되면 관련 계약과 검증 기준을 함께 수정한다.
이 문서는 **목표 설계와 수락 계약**이다. 2026-09-16 현재 core/store/protocol/daemon/
CLI/safety/OpenTUI/MCP와 측정-gated Kakao read adapter는 로컬·합성 경로에서 구현됐다.
Slack/Kakao live coverage, controlled send, 사용자 확인 실질문은 별도 수락 gate다.

## 1. 런타임 모델 — 데몬 1개 + 클라이언트 (05-review #1 결정)

```text
┌──────────────────────── inboxd (daemon, 사용자 세션당 1개) ────────────────────────┐
│  owns: DB write 커넥션 · sync(백필/watch) · outbox 실행기 · 발송 토큰 · audit    │
│                                                                                  │
│  platforms/*  →  normalize  →  store(SQLCipher)  →  query(search/inbox+coverage) │
│                                     ↑                                            │
│                         safety(outbox 상태기계, 승인 검증)                        │
│                                                                                  │
│  API: Unix domain socket, JSON 라인 프로토콜 (request/response + event stream)   │
└──────────────────────────────────────────────────────────────────────────────────┘
        ▲                    ▲                     ▲
   inboxd-cli            inboxd-tui            inboxd-mcp (TUI 이후)
   (TTY, approve 가능)   (TTY, approve 가능)    (propose만, code 미수신)
```

결정 근거. 상시 동기화, TUI·CLI·MCP 동시 사용, Uncertain 판정 주체, 승인 코드의
전달 경로 분리가 모두 "쓰기와 토큰을 한 프로세스가 소유"할 때 가장 단순해진다.
05-review가 지적했듯 데몬 자체가 승인 경계를 만들지는 않는다. 경계는 §4에서 정한다.

| 책임 | 소유자 | 비고 |
|---|---|---|
| DB write 커넥션 | 데몬 (1개) | 클라이언트는 DB 파일을 열지 않는다. 읽기도 API 경유 |
| sync (fetchHistorical 백필, watch) | 데몬 | 클라이언트 생존과 무관하게 지속 |
| outbox 실행 (send) | 데몬 | 발송 토큰은 데몬 프로세스 메모리에만 |
| 승인 코드 발급·검증 | 데몬 | 코드는 approve 가능 클라이언트에게만 전달 |
| 승인 입력 | CLI/TUI (TTY) | approve측 TTY 게이트 (openkakao 방식) |
| Uncertain 판정 | 데몬 (재시작 시) | 미완료 `Sending`은 재시작 시 `Uncertain`으로 확정 |
| audit log | 데몬 | 읽기·propose·approve·send 전부 |
| 진단 (doctor) | CLI → 데몬 API | 데몬 미기동 시 CLI가 로컬 진단만 수행 |

수명. 데몬은 CLI/TUI 첫 실행 시 자동 기동(`inboxd daemon start`, 소켓 없으면 spawn).
launchd 등록은 MVP 이후. 단일 인스턴스는 소켓 파일 + flock으로 보장한다.
동기화 최신성은 데몬 가동 시간에 종속되며, 이는 coverage `collected_to`로 정직하게 드러난다.

IPC. `~/.inboxd/sock` Unix domain socket. 요청·응답은 JSON 한 줄. 이벤트 스트림
(`message.upserted`, `coverage.changed`, `intent.changed`)은 구독형. 스키마는
`packages/protocol`에 두고 모든 클라이언트가 공유한다. 메서드 초안:

```text
search(query, platforms?, since?, until?, chats?)      → { hits[], coverage }
inbox(platforms?)                                       → { chats[]: {unread|unknown, mentions}, coverage }
chat.messages(chat_ref, before?, limit)                 → { messages[], coverage }
chats.list()                                            → { chats[] }
intent.propose(account, chat, body, reply_to?)          → { intent_id, expires_at }   // code 없음
intent.list(state?)                                     → { intents[] }               // code 포함 (approve 채널만)
intent.approve(intent_id, code)                         → { state }
intent.cancel(intent_id)                                → { state }
sync.status()                                           → { adapters[], coverage summary }
doctor()                                                → { checks[] }
subscribe(topics[])                                     → ready 응답 후 event stream
```

approve 채널 여부는 클라이언트 종류가 아니라 **접속 시 선언 + TTY 확인**으로 정한다.
`intent.list`가 code를 돌려주는 조건: 클라이언트가 `role=approver`로 접속했고,
그 프로세스가 TTY에 붙어 있음을 클라이언트가 자체 확인한다(openkakao의
`require_approval_session` 이식). MCP 클라이언트는 `role=agent`로만 접속한다.
등급 (b) 에이전트는 `role=approver`로 접속할 수 있으므로 §4의 한계가 그대로 적용된다.

구독은 변경된 조회 결과를 다시 읽으라는 알림이다. 데몬은 DB 커밋 후 알림을 내보내며,
`ready` 응답 전에 구독을 등록한다. 클라이언트는 구독 완료 후 데이터를 조회한다.
조회 중 알림이 오면 해당 조회를 dirty로 표시해 응답 적용 후 다시 조회한다(§5.2).
연결이 끊기면 구독과 진행 중 조회를 폐기하고 이 과정을 반복한다. MVP는 영속 이벤트
재생을 구현하지 않는다. 알림 버퍼가 넘치면 조용히 버리지 않고 연결을 종료해 재조회한다.

## 2. 패키지 구조 (Bun workspace)

```text
packages/
  core/       UnifiedMessage v2, Gateway ports(core+ext), capability manifest 타입
  store/      SQLCipher 열기·검증, migrations, 저장 계약(§3) 구현
  sync/       백필·watch 엔진. 어댑터 이벤트 → store 적용. cursor·coverage 갱신
  safety/     outbox 상태기계, 승인 바인딩·검증, quota·allowlist, audit
  daemon/     프로세스 소유자. 위 넷을 조립하고 UDS API 노출
  protocol/   API 스키마 + 클라이언트 라이브러리(연결·재연결·구독)
  cli/        inboxd 명령 (daemon/sync/search/inbox/approve/doctor)
  tui/        OpenTUI 기반 화면 (§5)
  mcp/        MCP stdio 서버. propose·search·inbox만. TUI 이후
platforms/
  slack/      wrapper-first 어댑터 (Spike A)
contrib/
  kakao/      Spike B 검증 후 제품에 연결하는 읽기 전용 어댑터. 개인 사용 면책
spikes/
  0-encryption/  1-...                      스파이크 산출물(manifest, 측정치)
fixtures/
  slack/  kakao/  ko-search/                캡처 재생·한국어 검색 fixture
```

의존 방향: `cli/tui/mcp → protocol → core`,
`daemon → protocol/sync/safety/store/core/platforms`, `sync/safety → store/core`,
`store/platforms → core`. 데몬이 어댑터를 조립해 ports로 주입한다.
`tui`가 `store`나 `platforms`를 import하면 구조 위반이다.
검색은 `store`의 query 모듈에만 있고 어댑터에는 없다(03-proposal 원칙 2 유지).

## 3. store 계약 (05-review #2·#5·#6 결정)

### 3.1 식별과 적용 순서 (#5)

- 메시지 식별 키: `(platform, account, chat_id, msg_id)`. 이 밖의 키로 upsert하지 않는다.
- 어댑터는 이벤트마다 `revision`을 제공한다. Slack은 `edited.ts`(없으면 원본 `ts`),
  삭제 이벤트는 `deleted_at`. revision을 못 주는 어댑터(카카오 DB 폴링)는 capability에
  `revision: none`을 선언한다. 해당 채팅의 재조회는 직렬화하고, 완전하게 읽었다고
  확인한 범위만 적용한다. 부분 조회에서 보이지 않는 메시지를 삭제로 추론하지 않는다.
  읽기 일관성이나 변경 확인이 불가능하면 `mutations_verified_at`은 미확인으로 남긴다.
  수신 시각으로 원본 변경 순서를 대체하지 않는다.
- 적용 규칙:
  1. tombstone(`deleted_at` 있음)은 어떤 create/edit보다 우선한다. create가 나중에 와도 되살리지 않는다.
  2. 같은 키에 낮은 revision이 오면 무시한다. 같은 revision은 멱등(no-op).
  3. 생성보다 삭제가 먼저 오면 식별 키만으로 tombstone 행을 만든다(body null).
  4. 채택된 상태와 FTS 갱신은 같은 트랜잭션.
- 검증 fixture: 동일 이벤트 반복 / 수정 뒤 오래된 백필 / 삭제 뒤 create 재생 /
  create보다 먼저 온 delete. 네 경우 모두 messages와 FTS 결과가 일치해야 한다.

### 3.2 coverage 구간 (#2)

`sync_coverage`는 **채팅당 여러 행**이다. 행 하나 = 검증된 구간 하나.

```text
sync_coverage {
  platform, account, chat_id,
  from_ts, to_ts,          // [from_ts, to_ts) 수집 범위. 변경 확인 시각은 별도
  kind,                    // backfill | watch | verified_empty
  collected_at,            // 구간 수집 완료 시각
  mutations_verified_at,   // 이 구간의 수정·삭제를 마지막으로 확인한 시각 (null=미확인)
  limit_reason?            // retention | permission | rate_limit | unsupported
}
PRIMARY KEY (platform, account, chat_id, from_ts, to_ts)

sync_limits {
  platform, account, chat_id, from_ts, to_ts,
  reason,                 // retention | permission | rate_limit | unsupported
  observed_at, resolved_at?
}
// 미수집 범위의 사유. 완전 수집을 뜻하지 않으며 coverage 행이 없어도 기록한다.
```

- 구간은 반개구간으로 다룬다. `kind`·`limit_reason`·`collected_at`·
  `mutations_verified_at`이 모두 같은 인접 구간만 병합한다. 겹치는 구간은 경계에서
  분할해 검증 근거와 시각을 유지한다. 새로운 검증 결과는 실제 재검증한 범위에만
  적용하며, 한 구간의 최신 시각을 다른 구간으로 확장하지 않는다.
- 관측한 메시지의 min/max ts만으로 그 사이를 완전하다고 쓰지 않는다. 백필은
  어댑터가 페이지 경계와 누락 없음을 확인한 범위를 커밋한다. watch 연결만으로 완전을
  주장하지 않고, 전달 보장 또는 재검증 근거가 있는 구간만 coverage에 넣는다.
  WS 끊김은 구간이 닫히는 것이고, 재연결 후 `fetchHistorical(since=last_to)`로 메꾼 뒤
  신규 메시지 수집 구간을 새로 쓴다. 이 백필로 과거 메시지의 수정·삭제까지 확인했다고
  간주하지 않는다. 과거 변경은 어댑터의 변경 재생 또는 범위 재조회로 별도 검증하고,
  지원하지 않거나 아직 확인하지 않은 범위는 이전 확인 시각 또는 null을 유지한다.
- `verified_empty`는 "조회했고 메시지가 없었다"이며, 행이 없는 구간은 "모름"이다.
- 응답 coverage 계산: 요청 범위 ∩ 각 채팅의 구간 집합 → `covered[]`, `gaps[]`,
  `freshness[]`(구간별 수집·변경 확인 시각), `limits[]`를 반환하고 검색 대상도 명시한다.
  `collected_to`는 요약값일 뿐 중간 구간의 최신성을 대체하지 않는다. 미해소
  `sync_limits`를 요청 범위와 교차해 사유를 반환하며, 사유도 모르면 unknown으로 표시한다.
  재수집·재검증이 성공한 범위만 제한 기록을 해소한다.
- 원자성: 메시지 upsert + `sync_state.cursor` + coverage·제한 해소를 한 트랜잭션에서
  커밋한다. 수집 실패는 cursor를 전진시키지 않고 제한 사유만 기록한다.
- 검증: 확인 시각이 다른 인접 구간, 행 없는 권한 제한 구간, 재연결 중 과거 수정·삭제를
  포함한다. 신규 메시지만 복구됐을 때 과거 변경까지 최신으로 표시하면 실패다.

### 3.3 outbox 상태기계 (#6)

```text
Proposed ──approve(code)──▶ Approved ──claim──▶ Sending ──receipt──▶ Verified
Proposed / Approved ──expire(15m) / cancel──▶ Expired (사유 구분 기록)
Approved / Sending ──원격 호출 전 확정 미발송──▶ Failed
Sending ──결과 불명 / 실행기 종료 후 재시작──▶ Uncertain (자동 재전송 없음)
```

`Failed` 이후 재시도는 새 intent와 사용자 재승인을 통해서만 한다. `Uncertain`은
재관측 또는 사람 판단으로 해소하기 전까지 실패로 간주하거나 자동 재시도하지 않는다.

- `intents` 행: `intent_id, account, chat_id, reply_to?, body, body_hash, proposed_by, expires_at, state`.
- `approvals` 행: `intent_id, code_hash, approved_at, approved_via(cli|tui), bound_hash`.
  `bound_hash = H(intent_id, account, chat_id, reply_to, body_hash, expires_at)`.
  approve 시 데몬이 재계산해 일치할 때만 `Approved`. 이후 intent 필드는 불변.
- claim 트랜잭션에서 승인 바인딩·만료·현재 발송 allowlist를 재검사하고,
  채팅별·전체 quota 잔여량 확인과 attempt별 예약, 아래 선점을 함께 커밋한다.
  `UPDATE intents SET state='Sending', attempt_id=?, claimed_at=? WHERE
  intent_id=? AND state='Approved' AND expires_at>now` — 영향 행 1일 때만 발송.
  실패하면 quota 예약도 롤백한다. quota 부족은 `Approved`로 대기하되 다음 claim에서
  만료와 정책을 다시 검사한다. allowlist 거부는 미발송 `Failed`로 남긴다.
  claim은 원격 호출 직전에 수행하며 네트워크 대기 중 트랜잭션을 열어두지 않는다.
  claim 이후 호출 전에 정책 변경을 관측하면 발송을 중단한다. 이미 시작된 원격 요청은
  취소를 보장하지 않는다. 확정 미발송은 예약 해제, `Verified`·`Uncertain`은 해당
  rate-limit 시간창에서 소비로 유지해 재시작으로 quota를 우회하지 못하게 한다.
- receipt: `Verified`(플랫폼 메시지 id 수신, `sends` 행에 기록) /
  `Uncertain`(id 없음 또는 실행기 사망). 데몬 재시작 시 `Sending` 잔여 건은 전부
  `Uncertain`으로 확정하고 사용자에게 표시한다. 살아 있는 실행기의 발송을 타임아웃만으로
  회수하지 않는다.
- 멱등 키 `(account, chat_id, body_hash, 시간창)`은 **중복 propose 경고**에만 쓴다.
  사용자가 별도로 승인한 동일 본문은 발송한다.
- 검증: 동일 승인 건 동시 claim → 원격 호출 1회. claim 직후 종료 / 원격 성공 직후
  종료를 주입 → 재시작 후 자동 발송 없이 `Uncertain` 표시. 승인 후 allowlist 제외는
  원격 호출 0회, quota 1개를 놓고 서로 다른 intent가 동시 claim하면 최대 1회여야 한다.

## 4. 승인 접근 경계 (05-review #3 결정)

MVP가 보호를 **주장하는** 범위와 하지 않는 범위를 명시한다.

| 주체 | DB 파일 | 데몬 API | 승인 code | 발송 토큰 | audit |
|---|---|---|---|---|---|
| 데몬 | R/W | — | 발급·검증 | 보유 | 기록 |
| CLI/TUI (approver) | 없음 | 전체 | 조회·입력 | 없음 | 조회 |
| MCP (agent) | 없음 | search/inbox/propose | **수신 불가** | 없음 | 없음 |
| 등급 (b) 셸 에이전트 | 열 수 있음 | approver로 접속 가능 | 조회 가능 | 키체인 접근 가능 | 변조 가능 |

- **등급 (a) MCP-only 에이전트: MVP가 보호한다.** propose 응답에 code가 없고,
  code는 approver 접속에만 내려간다. 승인은 바인딩 해시로 내용에 묶이고 1회용이다.
- **등급 (b) 셸 에이전트: MVP는 보호를 주장하지 않는다.** OS 사용자 분리·샌드박스
  없이는 경계가 없다. README와 doctor 출력에 이 사실을 표시한다.
  등급 (b) 대응은 데몬을 별도 OS 사용자로 옮기고 소켓 권한으로 approver를 제한하는
  형태가 후보이며, 현 구조(토큰·write를 데몬이 독점)는 그 이행을 막지 않는다.
- wrapper-first로 감싼 외부 CLI가 자체 send 명령을 가지면 등급 (b)에서는 우회 경로다.
  승인 우회 거부 테스트 범위는 "데몬 API를 통한 발송 시도"로 한정해 기록한다.
- HMAC 등 특정 암호 방식은 확정하지 않는다. MVP의 `bound_hash`는 위조 방지가 아니라
  **승인 후 내용 변경 무효화**를 위한 것이다. 이 구분을 코드 주석과 문서에 남긴다.

## 5. TUI 설계

기반: OpenTUI (`@opentui/core` + `@opentui/react`), beeptui의 4계층
(`gateway → state(reducer) → store(로컬 view 상태) → tui`)을 따른다. 단 여기서
gateway는 Beeper가 아니라 `packages/protocol` 클라이언트이고, 메시지 본문은 TUI가
저장하지 않는다(데몬 API에서 읽는다).

### 5.1 화면 (MVP 5개)

| 화면 | 내용 | coverage 표기 |
|---|---|---|
| Inbox | 채팅별 unread·mention. `unknown`은 `?`로 표시하고 0과 구분 | 채팅 행마다 최신성 배지(마지막 수집 시각) |
| Search | 쿼리 + 플랫폼·기간 필터. 결과와 함께 `gaps`를 상단에 고정 표시 | "검색 범위 중 N개 채팅·M구간 미수집" 문장 + 상세 토글 |
| Chat | 한 채팅의 메시지 시간순. tombstone은 "삭제됨"으로, 수정은 `(edited)` | 표시 구간의 gap을 인라인 구분선으로 |
| Approvals | `Proposed/Approved/Sending/Uncertain` 목록. 본문·대상·만료 표시. code 입력으로 승인 | — |
| Doctor | 어댑터별 auth·DB·암호화·endpoint 상태, 데몬 가동 시간, 등급 (b) 경고 | — |

Compose(propose)는 Chat 화면에서 가능하다. TUI에서 쓴 초안도 `intent.propose`로
들어가고 Approvals에서 code를 입력해야 발송된다. 인터페이스에 따라 승인 경로를
줄이지 않는다(TUI 사용자도 같은 outbox).

### 5.2 상태와 갱신

- reducer는 순수 함수. 입력은 API 응답과 이벤트 스트림뿐.
- 데몬 연결 끊김은 상단 상태줄에 `degraded`로 표시하고 마지막 응답을 유지한다.
  발송 관련 조작은 비활성화하며 요청을 자동 재전송하지 않는다. protocol 클라이언트가
  지수백오프로 재연결하고 §1의 구독→조회 순서로 Inbox·현재 Search/Chat·Approvals·
  진단 상태를 다시 읽는다. 이전 연결의 늦은 응답은 연결 세대값으로 거부한다.
- 조회 중 이벤트가 발생하면 해당 데이터를 다시 읽는다. 화면 데이터 재조회가
  성공하기 전까지는 stale 표시를 유지하고, 실패한 화면을 최신인 것처럼 표시하지 않는다.
  끊긴 동안의 수정·삭제·발송 상태 변경과 구독/조회 사이의 변경을 주입해 검증한다.
- 로컬 저장은 `~/.inboxd/tui.json`에 화면 이름과 플랫폼·기간 같은 비본문 설정만 둔다.
  검색어·본문·초안·승인 code·토큰은 저장하지 않는다. **MVP 초안은 메모리 전용**이며
  종료 시 유실됨을 안내한다. 영속 초안은 이후 데몬의 암호화 저장소로만 확장한다.
  propose 완료된 본문은 기존 암호화 outbox에서 확인한다.
- capability 게이팅: `send: false`면 compose를 비활성화한다. `revision: none` 자체를
  수정·삭제 미지원으로 해석하지 않고 어댑터의 변경 확인 능력과 coverage의 실제
  확인 시각을 표시한다.

### 5.3 TUI가 하지 않는 것

thread 뷰, 첨부 인라인, 편집·삭제, 멀티계정 전환, 테마. 04-roadmap Non-goals 그대로.

## 6. 암호화 (05-review #4 결정)

상태: **PASS_LOCAL (macOS arm64, SQLCipher 4.19.0).** 파일 재개방·FTS·WAL,
wrong/no-key·일반 SQLite 거부를 관측했다. production은 고정 Cellar 경로와 SHA-256을
검증하며 ambient `SQLCIPHER_PATH`를 무시한다. 다른 OS/build는 아직 채택하지 않는다.

- 엔진: SQLCipher. macOS는 `Database.setCustomSQLite(libsqlcipher.dylib)`를 DB 생성
  전에 호출. 다른 OS는 phase 2(해당 API가 no-op).
- 키: macOS 키체인 서비스 `inboxd` 항목. 데몬만 읽는다. 등급 (b)는 읽을 수 있다(§4).
- 검증(Spike 0, 실제 메시지 저장 전 필수):
  1. `PRAGMA cipher_version`이 비어 있으면 store 초기화 실패.
  2. fixture DB를 쓰고 닫은 뒤 새 연결에서: 올바른 키로 본문·FTS 복원 /
     키 없음·틀린 키·일반 SQLite로는 스키마도 읽히지 않음 / WAL 파일 포함.
  3. 실패 시 데몬은 sync를 시작하지 않고 doctor에 FAIL을 낸다.
- doctor 항목 `encryption`: cipher_version + 파일 헤더 검사(평문 SQLite 매직 바이트가
  보이면 FAIL). 암호화는 파일 유출 대비이며 키 접근 가능 주체를 막지 않는다고 출력한다.

## 7. TUI와 전체 MVP까지의 빌드 순서

전체 패키지를 완성한 뒤 연결하지 않는다. 먼저 작은 실제 경로를 통과시키고 기능과
검증 규모를 늘린다. 아래 통과 기준은 다음 통합 단계의 조건이며 독립적인 fixture·UI
작업을 막지 않는다. 실제 메시지 저장은 항상 암호화 검증 이후다.

| # | 단계 | 산출물 | 검증 |
|---|---|---|---|
| 0 | Spike 0 암호화 | `spikes/0-encryption/manifest.json` | §6 검증 1·2 통과 |
| 1 | Spike A: Slack 제한 채팅 → store → daemon API → CLI search | 최소 core/protocol·어댑터·암호화 저장·API·CLI, 인증/권한/수집/발송 방식 manifest | 실제 수집 후 CLI 검색을 원문과 대조, coverage 반환, allowlist 밖 수집 차단, 읽기 audit |
| 2 | 읽기 계약 확장 | 백필·watch·재개, inbox/chat/search, 구간별 coverage, subscribe·doctor | §3.1·3.2 fixture, 실제 중단·재개, 두 클라이언트 구독, 한국어 fixture, 10만 건 p95 300ms 목표 |
| 3 | safety + CLI approve | §3.3 상태기계, 바인딩·quota·allowlist·audit, TTY 게이트 | 승인 우회 거부, 동시 claim, 정책 변경, quota 경쟁, 종료 주입과 Uncertain 복구 |
| 4 | **Slack TUI 마일스톤** | §5 화면 5개 | coverage 표기, 실제 승인 발송, Uncertain 표시, 재연결 후 상태 일치, 초안 평문 저장 없음 |
| 5 | MCP | propose/search/inbox | 기존 API를 통해 동작, code 미수신·승인 불가. 승인 경계를 약화하지 않음 |
| B | Spike B 카카오 측정 | `spikes/B/manifest.json`, 읽기 가능 범위·변경 감지·제약 | 1~2와 병행 가능. 아키텍처 증명과 분리 |
| 6 | 카카오 읽기 제품 통합 | B 결과를 반영한 `contrib/kakao → sync → store → API → TUI`, `send: false` | 허용 채팅 수집·재개, 누락·변경 미확인 표시, Slack·카카오 실질문 10개 대조 |

4번은 Slack 기반 제품 마일스톤이며 전체 MVP 완료가 아니다. 6번은 B와 읽기 계약
검증 이후 진행하며, 독립적인 어댑터 작업은 TUI/MCP 작업과 병행할 수 있다.
전체 MVP는 MCP와 카카오 통합을 포함해 04-roadmap의 모든 완료 기준을 충족해야 한다.
카카오 측정이 실패하면 Slack TUI 성과는 유지하되 전체 MVP는 미완료로 기록한다.
MCP는 core·store·safety 재작성 없이 붙이는 것을 목표로 한다. 부족한 API 계약은
실제 요구에 맞게 보완하고 모든 클라이언트의 호환성을 검증한다.

### 현재 단계 판정 (2026-09-16)

- 0: PASS_LOCAL — provenance-checked SQLCipher 재개방 gate 통과.
- 1–5: IMPLEMENTED_LOCAL — store·daemon API·CLI·safe-send state machine·5화면 OpenTUI·MCP,
  bounded pagination/read audit/UDS 0600 포함. 146개 자동 테스트 통과; live platform 증거는 아님.
- 6: IMPLEMENTED_SYNTHETIC / LIVE_BLOCKED — Kakao 측정 PASS 전 adapter I/O 거부.
- B: BLOCKED_SAFE_HARNESS — 별도 KakaoTalk·Telegram wrapper 합성 확장은 B나 6의 live 증거가 아니다.

## 8. 이 문서가 바꾸지 않는 것

03-proposal의 철학·핵심 기능 5개·UnifiedMessage v2·safe-send 정책·보존 정책 OPEN·
ToS 격리·언어 선택. 04-roadmap의 소유 범위 게이트·Spike A/B 목적·실질문 10개 게이트.
