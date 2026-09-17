# 03 — Proposal: inboxd

## 핵심 철학

**서버를 믿지 않는다. 쓰기를 믿지 않는다. “결과 없음”과 “모름”을 구분한다.**

- 조회는 로컬 암호화 인덱스에서 수행하고, 원격 상태와의 차이는 coverage로 공개한다.
- 쓰기는 승인 없이는 제안일 뿐이다. 기본 deny이며 승인 경로는 아웃오브밴드다.
- 어댑터는 교체 가능한 얇은 경계다. 진단이 복구보다 먼저다.
- 부분 인덱스의 빈 결과는 정답이 아니다. search/inbox/recent/evidence 응답은 coverage 또는 evidence를 함께 낸다.

## 범위와 현재 판정 (2026-09-17)

목표는 여러 메신저의 근거 메시지를 찾아 사람이 확인한 답장을 안전하게 보내는 로컬-퍼스트 런타임이다. `sync`, `search`, `inbox`, `safe-send`, `doctor/probe`가 핵심이며 CLI/TUI/MCP는 같은 daemon의 얇은 클라이언트다.

현재 작업 트리는 **offline-ready / live-blocked**다. Rust functional core와 TypeScript edge, SQLCipher store, UDS, CLI, MCP, OpenTUI, bounded local adapters, recovery와 performance gate는 로컬에서 관측됐다. 이는 Slack/Kakao 실제 계정 read/send를 재실행했다는 뜻이 아니다. Slack/Kakao live read, live Slack send, 그리고 새 사용자 권한이 필요한 five-question gate는 모두 별도 수락 조건으로 남아 있다.

## 런타임과 소유권

```text
inboxd daemon (DB write · sync · outbox · send token · audit 단독 소유)
  TS Slack/Kakao reader adapters → Rust domain/store/safety → TS SQLCipher I/O
    → search / inbox / message.recent / message.evidence (coverage/evidence 포함)
    → propose → trusted local approval → send → Sent → independent read-back → Verified
  ▲ Unix-domain socket (owner-only)
  cli (agent/approver) · tui (agent/approver) · mcp (agent; propose/read only)
```

- 클라이언트는 DB를 열지 않는다. daemon만 SQLCipher, sync, outbox, credential, audit를 연다.
- daemon은 **자동으로 기동되지 않는다**. owner-only JSON config를 만든 뒤 명시적으로 `bun run daemon -- --config /absolute/path/config.json` 또는 `inboxd-daemon --config /absolute/path/config.json`으로 시작한다. CLI는 이미 실행 중인 UDS에 접속하는 subprocess다.
- 단일 인스턴스는 `state_dir/inboxd.lock`을 `open(..., "wx", 0600)`으로 독점 생성하고 PID liveness를 확인해 stale lock만 회수한다. 소켓+`flock` 계약은 구현이 아니므로 주장하지 않는다.
- config는 regular file, non-symlink, current-user owned, mode `0600`/owner-only이어야 한다. state directory와 UDS도 owner-only다.
- reader config는 Slack/Kakao의 stable account/chat allowlist와 injected binding name만 받는다. 실제 reader factory는 trusted process-local binding registry에서 주입된다. 이 registry는 config만으로 live credential/provider를 생성하지 못하는 의도적 제한이며, registry가 없거나 binding이 없으면 store/adapter I/O 전에 실패한다.

## 데이터와 query 계약

메시지 식별 키는 `(platform, account, chat_id, msg_id)`이며 adapter revision이 있으면 낮은 revision을 무시하고 같은 revision은 idempotent다. tombstone은 create/edit보다 우선하며 FTS 갱신은 같은 transaction에 속한다. revision 없는 Kakao 관측은 같은 chat의 read/apply를 직렬화하고 부분 관측의 부재를 삭제로 추론하지 않는다.

스키마는 현재 **v3**이다. 기존 message/FTS/chats/sync state/coverage/limits/intents/approvals/sends/quota/audit 외에 다음 durable evidence를 포함한다.

- `account_self`: authenticated adapter가 관측한 account→self identity. display name 추론은 허용하지 않으며 unsupported identity는 explicit unknown이다.
- `unread_evidence`: source-qualified unread state. unknown은 zero unread가 아니다.
- `sync_page_sequence`: page compare-and-set sequence. stale/out-of-order page는 cursor, coverage, identity, unread를 전진시키지 못한다.

`applySyncBatch`는 events, cursor, coverage/limits, identity, unread evidence, page sequence를 한 transaction으로 적용한다. config에 선언됐지만 아직 수집되지 않은 chat은 discoverable하되 coverage gap `unknown`으로 남는다. 이는 성공·auth·collection evidence가 아니다.

`message.recent`은 명시된 multi-chat scope, interval, deterministic composite ordering, scope-bound cursor와 coverage를 제공한다. `message.evidence`는 동일 retrieval의 source-linked evidence packet을 제공한다. `sender=self`은 persisted `account_self`가 authenticated adapter source로 known일 때만 match하며 Kakao self identity는 현재 unsupported/unknown이다.

## safe-send: transport acknowledgement와 검증을 분리한다

상태는 `Proposed → Approved → Sending → Sent → Verified`이며 `Failed`, `Uncertain`, `Expired`를 별도 종료 상태로 둔다.

- approval은 immutable intent/account/chat/reply target/exact body/expiry에 bound되고 one-time이다. durable state에는 verifier만 저장하며 raw code는 pending-list나 CLI JSON/argv에 들어가지 않는다. owner-local TUI가 process-private memory로 한 번만 claim하며, restart나 전달 유실 뒤에는 orphan proposal을 expire하고 re-proposal을 요구한다. agent/MCP에는 code가 나오지 않는다. approver role도 trusted local approver binding 없이는 code-bearing 작업을 할 수 없다.
- claim은 allowlist, binding, expiry, per-scope/global quota를 transaction 안에서 재확인하고 `Approved → Sending`을 선점한다. network I/O는 transaction 밖이다.
- transport가 receipt/id를 반환하면 상태는 **`Sent`**이다. 이는 transport acknowledgement일 뿐 목적지에서의 검증이 아니다.
- **`Verified`**는 독립적인 trusted receipt reader가 동일 destination scope, receipt, exact body, reply/thread parent를 read-back하여 대조할 때만 된다. receipt reader 실패·부재는 `Sent`를 `Verified`로 승격하지 않는다.
- crash, timeout, malformed transport outcome, 또는 원격 결과 불명은 `Uncertain`; 자동 재전송은 없다. restart는 residual `Sending`을 `Uncertain`으로 확정한다.
- quota는 proven-not-sent `Failed`만 해제한다. **`Sent`, `Verified`, `Uncertain`은 모두 quota 소비를 유지**한다.
- send-capable composition은 canonical `slack`만, explicit injected transport, positive finite global/per-scope quotas, explicit `allowSend` policy가 모두 있을 때만 구성된다. normal Kakao compose/send는 disabled다.

MVP 보호 주장은 MCP-only agent에 한정된다. 같은 OS user의 shell/file/Keychain access가 있는 process는 daemon isolation boundary 밖이며, wrapped external CLI의 direct send도 그 위협 모델에서 우회 경로다.

## 진단과 증거 경계

`system.status`, `auth.status`, `sync.status`, Doctor는 fabricated green status가 아니라 configured platforms, encrypted-store diagnosis, owner-only UDS endpoint, observed authentication, per-platform job state/retry-at, send capability, and same-user isolation warning을 반환한다. config는 configured-uncollected 상태만 등록한다; credential/auth/read success를 만들지 않는다.

로컬 regression/fixture/UDS evidence와 live account evidence는 분리한다. 2026-09-16의 historical five-question 분류(Q1/Q2/Q5 product gap, Q3 bounded Slack collection miss, Q4 Kakao retrieval 4건)는 역사 기록으로 보존하지만 이번 working-tree gate가 이를 재실행하거나 새 live acceptance로 승격하지 않는다.

자세한 수락 상태는 [04-roadmap](04-roadmap.md), runtime contract는 [06-architecture](06-architecture.md), observed evidence는 [07-evidence-ledger](07-evidence-ledger.md)에 둔다.