# inboxd

깨져도 진단되고 데이터는 남는 멀티메신저 로컬-퍼스트 런타임.

- 로컬 암호화 인덱스가 검색 경로다.
- 쓰기는 승인 없이는 제안일 뿐이다. 기본 deny, 아웃오브밴드 승인.
- `결과 없음`과 `모름`을 구분한다. 조회 응답은 coverage/evidence를 함께 낸다.
- 어댑터는 교체 가능하며 진단이 복구보다 먼저다.

## 현재 상태 — 2026-09-17

**offline-ready / live-blocked.** 현재 dirty working tree에서 Rust core/TypeScript edge, SQLCipher store, daemon/UDS, CLI/MCP/OpenTUI, bounded local reader composition, outbox crash handling, and O5 scale/search gates가 로컬에서 관측됐다. 이는 Slack/Kakao 실제 계정 read/send를 이번에 실행했다는 뜻이 아니다.

- Bun **379 pass / 1 intentional opt-in skip / 0 fail**, Rust **4 pass**.
- typecheck, boundary check, Clippy, format check, diff hygiene pass; deterministic OpenTUI captures **62**.
- O5: encrypted production `applySyncBatch`가 anonymous 100k messages를 **9982.744 ms**에 ingest; real UDS 700 samples p50 **29.346125 ms**, p95 **72.681875 ms**, worst per-query p95 **75.873917 ms** (≤300).
- Korean/mixed fixture acceptance는 **25 positive / 8 negative** cases다. fixture evidence는 live account/user-question evidence가 아니다.
- Fresh live Slack/Kakao read, same five live retrieval intents, and a separately approved Slack send are still pending fresh user authorization. Normal Kakao compose/send and Kakao authoritative `sender=self` are unsupported.

## 문서

- `docs/03-proposal.md` — product/runtime/safety contract and evidence boundary
- `docs/04-roadmap.md` — completed offline criteria versus pending live criteria
- `docs/06-architecture.md` — daemon, schema v3, UDS, reader composition and receipt contract
- `docs/07-evidence-ledger.md` — local, historical live and pending-live evidence matrix
- `docs/08-rust-core-refactor.md` — Rust refactor historical/current checkpoints

## Build and local gate

```sh
bun install
bun run build:native
bun run typecheck
bun run check:boundaries
bun run test
cargo test --locked
cargo clippy --locked -- -D warnings
cargo fmt --all -- --check
git diff --check
```

The 100k acceptance is deliberately opt-in because it is a long local benchmark:

```sh
INBOXD_RUN_100K_ACCEPTANCE=1 NODE_ENV=test \
SQLCIPHER_PATH="$(brew --prefix sqlcipher)/lib/libsqlcipher.dylib" \
bun test packages/store/test/performance-100k.test.ts
```

## Explicit daemon startup

The daemon does **not** auto-start from a client. Create an owner-only, non-symlink JSON config with absolute state/database/socket paths and then run:

```sh
chmod 600 /absolute/path/inboxd-config.json
bun run daemon -- --config /absolute/path/inboxd-config.json
# or: inboxd-daemon --config /absolute/path/inboxd-config.json
```

The daemon requires config ownership by the current user and rejects group/other-readable files. It takes a PID-file lock with exclusive `wx` creation and PID liveness recovery; it does not use `flock`. Database, socket and state directory are daemon-owned and owner-only; clients are UDS-only.

Reader config contains exact stable Slack/Kakao allowlisted scopes plus binding identifiers. Binding factories are supplied by a trusted injected host registry; config cannot discover credentials or create arbitrary provider clients. A configured chat may appear in discovery before collection, but its coverage is `unknown` until observed sync evidence exists.

## Safety semantics

`Proposed → Approved → Sending → Sent → Verified` is intentionally two-stage after transport I/O:

- a transport receipt is `Sent`, not delivery verification;
- `Verified` requires an independent trusted read-back matching exact destination scope, receipt, body, and reply/thread parent;
- `Uncertain` is terminal until human/re-observation and is never auto-retried;
- quota remains consumed for `Sent`, `Verified`, and `Uncertain`; only proven-not-sent failure releases it.

Raw approval codes are never durable: only a verifier is stored, pending-list/CLI JSON are code-free, the owner-local TUI can claim a code once into process-private memory, and restart or lost delivery expires/requires re-proposal. CLI argv approval is rejected. MCP/agent clients cannot receive approval codes. A claimed approver role also needs trusted local approver-session authorization; `sync.backfill` additionally requires that trusted owner session. Streaming JSON decoders own connection-local UTF-8 state. The protection claim does not cover same-user shell/file/Keychain access.

## Historical live boundary

The historical five-question record is retained: Q1/Q2/Q5 product gaps, Q3 Slack collection miss, Q4 Kakao retrieval. It was not rerun by the current offline gate. Likewise, the historical Kakao controlled send is not a new authorization or a current live send result.

No commit, push, PR, merge or deployment is represented by this README.