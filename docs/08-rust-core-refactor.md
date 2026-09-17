# Rust core / TypeScript edge refactor

## Decision

inboxd retains one Bun daemon and its provenance-checked SQLCipher connection. Rust is an in-process functional core for domain, store/query, coverage, safety/outbox, quota and recovery decisions. TypeScript owns SQLCipher/keychain driver work, asynchronous reader/transport I/O, lifecycle/UDS, CLI, MCP and OpenTUI. The public JSON-lines protocol and encrypted store remain compatible; this does not create a second daemon or database.

## Historical checkpoints (preserved)

These are historical checkpoints, not assertions about the current dirty working tree.

| Date / reference | Historical observed result |
|---|---|
| 2026-09-16 baseline `8c3bdb2` | clean worktree; official typecheck, boundary check and full test command: **156 tests / 552 assertions** |
| 2026-09-16 clean-source final verification | **168 Bun tests / 632 assertions**, 4 Rust tests, zero failures |
| 2026-09-16 post-review refresh | **170 Bun tests / 652 assertions**, 4 Rust tests, zero failures, typecheck/boundaries/fmt, 25 deterministic TUI captures and diff hygiene |

The pre-refactor synthetic reference was approximately 17.8 seconds for a 10k-event batch and p95 approximately 370 ms for 30 broad Korean first-page searches. Those numbers are comparison context, not a current product claim.

## Compatibility invariants

- Composite message keys, revision ordering, tombstone permanence and same-transaction FTS changes.
- Half-open coverage intervals, explicit unknown gaps, segment freshness, verified-empty and limit evidence; no authoritative Slack/Kakao history claim without live evidence.
- SQLCipher bootstrap/provenance, key handling, encrypted format/schema and WAL; wrong/no-key/plaintext must fail closed.
- Existing serialization/cursor behavior, Unicode search, pagination ordering and durable approval hash compatibility.
- Bound one-time approvals, current-policy claim, atomic per-scope/global quota, no automatic resend and redacted audit.
- UDS-only clients, explicit role plus trusted approver-session authorization, reconnect/backpressure behavior, and all five TUI screens.

## Remediated implementation

The current implementation adds the previously missing production-shaped contracts:

1. **Daemon and composition:** explicit `inboxd-daemon --config` startup; owner-only config; exclusive PID-file lock instead of flock; exact Slack/Kakao allowlists; trusted injected binding registry; configured-uncollected discovery; truthful diagnostic state.
2. **Schema and retrieval:** schema v3 adds `account_self`, `unread_evidence`, and `sync_page_sequence`; `applySyncBatch` atomically applies pages and their evidence; `message.recent` and `message.evidence` provide deterministic scoped retrieval/evidence.
3. **Identity/unread:** only authenticated adapter evidence establishes self identity; unknown remains unknown. Kakao self identity is unsupported rather than inferred.
4. **Outbox:** transport acknowledgement is `Sent`. `Verified` requires an independent exact destination/scope/body/receipt/parent-thread read-back. Quota remains consumed for `Sent`, `Verified`, and `Uncertain`; only proven-not-sent failure releases it.
5. **Surface and scale:** real UDS exercise covers CLI/MCP/TUI, actual CLI subprocess exit, Slack cursor/restart/rate-limit fixtures, crash child processes, deterministic captures, encrypted production ingestion and UDS performance.

## Current working-tree checkpoint — 2026-09-17 (not a commit)

This checkpoint describes the present **dirty working tree**. It must not be represented as a replacement commit, merged change, or production/live acceptance.

- Bun gate: **379 pass / 1 intentional opt-in skip / 0 fail**.
- Rust gate: **4 pass**.
- `bun run typecheck`, `bun run check:boundaries`, Clippy with warnings denied, `cargo fmt --all -- --check`, and `git diff --check`: pass.
- **62 deterministic** OpenTUI captures were regenerated/validated.
- The enabled O5 acceptance ingested **100,000** anonymous messages through encrypted production `applySyncBatch` in **9982.744 ms**, then queried through a real UDS daemon/client topology. It measured **700** samples: aggregate p50 **29.346125 ms**, p95 **72.681875 ms**, worst per-query p95 **75.873917 ms**, each within the 300 ms criterion.
- The production-search corpus has **25 positive** and **8 negative** Korean/mixed-language cases. It is fixture evidence, not user-question or live provider evidence.
- O2 UDS/CLI/MCP/TUI, O3 SIGKILL/recovery/read-back, Slack cursor/restart/rate-limit, and CLI subprocess exit have local observed evidence.

The first V0 review findings are remediated and the parent offline gates above are observed. **A fresh independent V0 re-review remains pending.** L0 still requires fresh user authorization for bounded live Slack/Kakao reads, the same five retrieval intents, and any separate Slack send. D0 reconciliation and a dedicated commit are pending; no commit, push, PR or merge is claimed.

## Completion boundary

Live account data and actual outbound sends are not required for the refactor’s offline regression gate, but the product remains `offline-ready/live-blocked` until L0 is separately authorized and observed. Existing historical live evidence remains in `docs/07-evidence-ledger.md`; do not turn it into current evidence by documentation alone.