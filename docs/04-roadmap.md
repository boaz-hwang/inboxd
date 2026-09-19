# 04 — Roadmap

> 이 문서는 2026-09-17 기준의 제품/검증 기록이다. 이후 전송은 요청별 승인 없이
> 인증된 `message.send` 하나로 통합했다. 현재 동작은
> [전송 계약](12-account-workspace.md#direct-sends)과
> [리팩토링 구조](16-rust-account-backends.md)를 따른다.

## 상태 읽는 법

- **COMPLETED_OFFLINE**: anonymous fixture, encrypted store, real local UDS, subprocess, crash child process 또는 deterministic render에서 관측됨. live account/product acceptance는 아니다.
- **HISTORICAL_LIVE**: 과거에 제한된 실제 계정에서 관측됐으나 이번 작업 트리에서 재실행하지 않았다.
- **PENDING_LIVE_AUTHORIZATION**: fresh user authorization과 bounded scope가 있어야 실행할 수 있다.
- **BLOCKED/UNSUPPORTED**: 구현 또는 evidence가 해당 contract를 제공하지 않는다.

현재 결론은 **offline-ready / live-blocked**다. 완료 표시는 offline criteria에만 적용되며 live gate를 닫지 않는다.

## 완료된 offline 기준 (2026-09-17 working tree)

| 영역 | 상태 | 관측된 범위 |
|---|---|---|
| R0 / refactor remediation | COMPLETED_OFFLINE | Rust core/TS edge, malformed batch rejection, unsafe FFI contract, configured Cargo target packaging, regression fan-in |
| O1 daemon lifecycle/read composition | COMPLETED_OFFLINE | owner-only config validation, injected Slack/Kakao binding registry, configured-uncollected discovery, truthful auth/sync/endpoint diagnostics, Slack cursor/restart/rate-limit fixtures |
| O2 retrieval/identity | COMPLETED_OFFLINE | schema v3 `account_self`/`unread_evidence`/`sync_page_sequence`, atomic `applySyncBatch`, `message.recent`/`message.evidence`, UDS/CLI/MCP/TUI paths, deterministic scope cursors and unknown coverage |
| O3 safety/outbox | COMPLETED_OFFLINE | verifier-only durable approvals, one-shot owner-TUI code delivery, orphan expiry, CLI argv denial, child-process SIGKILL recovery to `Uncertain`, no retry, quota retention, allowlist removal zero I/O, independent read-back contract |
| O4 client surfaces | COMPLETED_OFFLINE | owner-only backfill, connection-local UTF-8 decoders, actual CLI subprocess exit, UDS clients, MCP methods, OpenTUI lifecycle/capability state, 62 deterministic captures plus capture manifest |
| O5 scale/search | COMPLETED_OFFLINE | encrypted production `applySyncBatch` ingestion of 100,000 anonymous messages and real UDS query observation; 25 positive/8 negative Korean/mixed cases |

### Fresh offline gate results

- Bun: **379 pass / 1 intentional opt-in skip / 0 fail**.
- Rust: **4 pass**.
- `typecheck`, `check:boundaries`, Clippy with warnings denied, `cargo fmt --check`, and `git diff --check`: pass.
- Deterministic OpenTUI evidence: **62 captures**.
- O5 enabled acceptance: 100,000 records through production `applySyncBatch` in **9982.744 ms**; real UDS production searches measured **700** samples, aggregate **p50 29.346125 ms**, **p95 72.681875 ms**, and worst per-query p95 **75.873917 ms** (all ≤300 ms). Corpus is anonymous synthetic data, not live provider history.

MCP handler/UDS integration is observed, but a separate external MCP stdio-client round trip remains unobserved because the installed SDK exposes server-side stdio only.

## Still-pending live acceptance

| Criterion | Status | What is still required |
|---|---|---|
| Slack bounded read, cursor/restart/rate-limit | PENDING_LIVE_AUTHORIZATION | fresh authorized Slack account, exact allowlisted chat scope, live cursor/restart/rate-limit observation; local adapter tests do not replace it |
| Kakao bounded read | PENDING_LIVE_AUTHORIZATION | fresh authorized Kakao scope and product-path read/restart observation; no live Kakao read was rerun here |
| Five user-originated retrieval intents | PENDING_LIVE_AUTHORIZATION | rerun the same five intents against fresh authorized Slack/Kakao data and classify results; do not add questions |
| Slack controlled send | PENDING_LIVE_AUTHORIZATION | separate exact destination/body approval, one attempt, and independent exact destination/body/receipt/thread read-back. Transport acknowledgement alone ends at `Sent` |
| Kakao normal compose/send | UNSUPPORTED | normal composition is read-only/compose-disabled; do not infer self identity or enable send |
| Kakao `sender=self` | BLOCKED/UNSUPPORTED | authenticated `account_self` evidence is unavailable for Kakao, so it remains unknown rather than inferred |
| Original Kakao DB/KDF/schema/AX route | BLOCKED | wrapper product path and local fixtures do not prove this separate route |

No live Slack/Kakao read, live send, or live retrieval-question result was produced by the 2026-09-17 offline gates. The historical controlled Kakao self-chat send remains historical evidence only and does not authorize repetition.

## Build and acceptance order

```text
R0 → O1 → {O2, O3} → O4 → O5 → V0 re-review → L0 fresh authorization/live gates → D0 checkpoint
```

1. **R0 — Rust core remediation.** Preserve protocol/database compatibility while Rust owns domain/store/safety decisions and TS owns SQLCipher driver, async adapters, UDS and presentation.
2. **O1 — runnable composition.** Explicit daemon startup, bounded readers, owner-only config, truth-telling diagnostics and Slack state/retry behavior.
3. **O2 — retrieval contract.** Multi-scope recent/evidence, scope cursors, configured-uncollected coverage, authenticated self identity, source-qualified unread.
4. **O3 — outbox correctness.** `Sent`/`Verified` separation, independent read-back, crash recovery, no retry and durable quota.
5. **O4 — user surfaces.** CLI, MCP, TUI and deterministic captures against the same UDS protocol.
6. **O5 — scale/search.** Encrypted production ingestion plus real UDS timing and Korean acceptance.
7. **V0 — independent re-review.** Re-run independent code/security/evidence/visual review and make a clause→evidence/blocker matrix. First V0 findings are remediated and fresh parent gates are observed; **V0 re-review remains pending**.
8. **L0 — live acceptance.** Requires fresh user authorization. It remains pending; no live work is implied by V0 or offline gates.
9. **D0 — dedicated checkpoint.** Only after V0/L0 evidence reconciliation. Commit/push/PR/merge are not done or implied.

## Operational configuration gate

Daemon startup is an explicit owner action, not client auto-spawn. The config needs absolute state/database/socket paths, keychain service/account, and optional Slack/Kakao readers with 1–100 exact stable allowed chats each. It must be a non-symlink owner-only regular file. Reader names resolve only through a trusted injected binding registry supplied to the daemon host; this prevents config from becoming credential discovery but means a standalone config cannot conjure a live provider.

The daemon uses exclusive PID-file creation (`inboxd.lock`, `wx`, mode 0600) and stale-owner liveness checks. It does not use `flock`. The state directory and UDS are owner-only. Configured chats appear in discovery before collection, but their coverage remains `unknown` until observed sync evidence is committed.

## Historical evidence retained, not rewritten

The 2026-09-16 five-question record remains: Q1/Q2/Q5 were protocol/product gaps; Q3 was a bounded Slack collection miss; Q4 was a Kakao retrieval with four messages. That history classified 5/5 questions but did not prove live completeness or resolve its gaps. It is not replaced by the new 25/8 anonymous Korean corpus.

## Non-goals / guardrails

- Do not call a wrapper degraded path authoritative history.
- Do not equate a transport receipt with `Verified`.
- Do not broaden configured reader scopes into discovery.
- Do not retry `Uncertain` sends or release their quota.
- Do not claim a full MVP, live acceptance, commit, PR, merge, or deployment from offline gates alone.