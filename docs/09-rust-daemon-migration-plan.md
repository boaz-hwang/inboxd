# Rust daemon migration and platform delivery

## Accepted direction and execution order

The user approved Rust sole daemon/storage ownership with TypeScript clients and optional adapter processes. All coding and independent review agents use the current session model. Independent review means a separate context, not another model.

Latest ordering amendment: finish Rust ownership changes before any conflicting platform integration. Only demonstrably independent adapter work may run alongside that migration. KakaoTalk sending is now allowed by the target product policy, subject to explicit destination/body approval, configured capability, exact allowlist, finite quotas and independent read-back. This supersedes the earlier product exclusion, not the current implementation's safety checks. Do not merely remove the Bun Slack-only guard before a compatible replacement exists.

Current baseline: fe16bded80f663641aaeb7f621c2e27ce8a96ad4 on main; clean before this plan was created. No Rust daemon migration implementation has landed. This document is a living plan, not completion evidence.

## Ownership and dependency boundaries

| Unit | Exclusive write scope | Dependency / restriction |
| --- | --- | --- |
| R0: compatibility contracts and fixtures | Parent-owned protocol/fixture contracts and this plan | First; verify exact paths before adding files |
| R1: Rust storage and runtime | `crates/`, root Cargo manifests, native bridge and daemon runtime | R0; one owner for SQLCipher, serialization, lifecycle, approval, outbox and transactions |
| A0: independent provider preparation | New isolated provider-specific modules/tests under `platforms/telegram/` or `contrib/kakao/`, only after an exact file list is assigned | May overlap R1 only if no shared imports, manifests, existing reader files or runtime contracts change |
| R2: daemon client cutover | `packages/daemon/`, shared `packages/protocol/`, CLI/MCP/TUI integration, root scripts/manifests and integration tests | R1; parent controls shared edits; no parallel platform writers here |
| A1: platform integration | Existing/new platform adapters, Rust adapter bridge, capability/policy configuration and TUI compose gating | R2 verified; consume frozen contracts, not guessed interfaces |
| V: independent review and verification | Read-only review; fixes returned to the owning lane | All producers for the behavior under review |
| L: live TUI verification | Approved accounts and bounded exact destinations only | Relevant runtime + platform integration + V; actual destination/body authorization before sends |

A0 may inspect documented provider APIs and build pure normalization/error/receipt parsing with synthetic fixtures. Production provider SDK bindings require observed public APIs and supported authentication. A0 must not discover credentials, send live messages, implement its own approval policy, or invent a parallel daemon protocol. If no meaningful work meets these constraints, defer A0 rather than manufacture parallelism.

Conflicting work explicitly deferred until R2: shared IPC schema, daemon worker registration, configuration parsing, SQL ownership, safety allow policy, send coordinator, global manifests/lockfiles, TUI capability/compose changes and end-to-end fixtures. Telegram/Kakao readiness must not become an excuse to bypass the Rust-first dependency.

## Mandatory deletion and size discipline

The user requires obsolete code to be removed during this refactor, not retained indefinitely as compatibility scaffolding. For each migrated responsibility, inventory callers and tests, prove the replacement through the real surface, then delete the superseded implementation, unused exports, adapters/shims, dependencies, build scripts and obsolete implementation-specific tests. Preserve behavioral regression coverage by moving it to the new owner; never delete a failing behavioral assertion merely to make the replacement pass.

Temporary dual paths are permitted only within an explicitly unfinished migration phase. Each must have a named removal gate in this plan. Before final acceptance, production must have one daemon/storage/safety owner, no unused Bun SQL host or Rust callback bridge retained without a demonstrated consumer, and no unused dependencies or stale setup instructions. Keep TS client and provider code that still has a real role; do not replace useful code solely to reduce LOC.

Use Git checkpoints for rollback rather than keeping backup source files or parallel legacy directories. Validate deletions through caller/import searches, package/build entrypoints, full tests, typecheck, boundary checks and real Rust daemon client flows. Final reporting includes added/deleted lines and any deliberately retained compatibility code with its actual consumer and removal condition; net LOC reduction is not a substitute for correctness.

## Migration gates

### R0 — Pin compatibility

Inventory all 21 protocol methods (19 current server implementations, settings.get/settings.update remain unsupported), role/token authorization, three event types and 21 Host operations. Independently recheck reviewer counts against source before fixture generation.

Pin JS JSON property order and number formatting, UTF-16/lone surrogate/PUA behavior, null versus absent fields, base64url cursors, quota scope bytes, approval hash and idempotency bytes. Preserve safety milliseconds versus adapter timestamp seconds. Do not substitute serde_json defaults without differential proof.

Verification: existing `bun run test`, `bun run typecheck`, `bun run check:boundaries`; targeted new golden tests added before their implementation. Rollback: additions only; baseline path remains usable.

### R1 — Native storage and safety ownership

Rust owns SQLCipher open/migrate/diagnose and the single writer. Preserve schema v3, raw-key semantics, WAL, library provenance requirements and atomic messages/FTS/cursor/coverage/identity/unread/page-CAS updates. Rust owns ephemeral approval codes, latest-policy checks, quota reservations, outbox state and recovery. No SQL, database keys or approval codes cross into provider workers.

Evidence required: synthetic Bun-created DB -> Rust write -> Bun reopen and reverse; stale-page rejection, rollback, tombstones/FTS consistency and persisted-state compatibility. Successful scratch reads do not meet this gate.

An earlier wrong-key scratch command was blocked by approval timeout. Do not repeat or disguise it; obtain renewed approval for that blocked verification before executing it. No real account database migration in this phase.

Verification: targeted native storage/safety tests, full Bun suite, `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`. FFI/unsafe changes require the Rust skill's escalated checks; unavailable evidence stays an explicit gap.

Rollback: keep old entrypoints until newest synthetic database state can be reopened safely by them. Never roll back an outbox database snapshot after a possibly executed external send.

### R2 — Runtime and client cutover

Preserve owner-only config/state/socket/token, cross-version single-instance exclusion, startup ordering, bounded JSON-lines framing, subscriptions/backpressure, typed errors, auth/sync diagnostics and post-commit events. A Rust actor owns the connection; external I/O must not hold a database transaction open.

Map every TS injected port to a verified native or bounded-worker replacement before removing it. In particular, an arbitrary synchronous allowSend callback must not become an unbounded subprocess call inside the claim transaction.

Worker contracts need request IDs/generations, time/byte/queue limits, fixed trusted bindings and cleanup. A timeout or EOF after possible send stays Uncertain with quota retained and no automatic resend. Receipt-read failure after acknowledged Sent does not undo Sent.

Verification: real Rust executable with existing CLI/MCP/TUI clients, cross-runtime single owner, fragmented frames, reconnect/no replay, bounded shutdown, SIGKILL recovery and approval code loss. Retain old interfaces until each consumer group passes. Rollback: stop the new owner/workers before returning to the verified old binary under the same lock contract.

### A1 — Telegram/Kakao integration after runtime boundary freezes

Connect provider adapters through R2 contracts. Replace the historical Kakao product exclusion with explicit capability/allowlist policy; keep unknown/noncanonical platforms denied. Kakao authenticated self identity remains unsupported unless independently established; permission to send is not identity evidence.

Implement Telegram support rather than inferring it from historical wrapper notes. SDK/authentication limitations remain explicit blockers. Do not weaken tests or provider controls to claim success.

Verification: bounded read normalization, exact destination binding, capability revocation, unauthorized scope refusal, one-shot approval, transport outcome classification, receipt matching and worker failure isolation. Run these through the Rust daemon and real TUI surface, not solely controller or fake-provider tests.

### V/L — Finish and live acceptance

Run the full repository gates, independent current-model review, deterministic TUI rendering and the opt-in 100k ingestion/UDS search gate. Record actual command exit codes, artifacts and cleanup receipts. Fix failures within their owning lane and re-run affected integration gates.

After R2 and its review, proceed to the user's requested live Slack test (option 2); do not wait for unrelated provider work if Slack's own runtime path is verified. Require exact destination/body approval and one bounded send, with receipt and independent read-back. Telegram/Kakao live TUI reads/sends additionally depend on A1 and their own account/destination/body authorization. Never automatically repeat an ambiguous live send to make a test pass.

Completion means implemented, exercised, independently reviewed and documented behavior, not an unconditional perfection claim. No remote push or live account migration is implied by local tests. Keep unfinished milestones pending.

## Evidence ledger (append-only)

- Before this plan: existing Bun baseline reported 379 pass / 1 opt-in skip / 0 fail. These tests use the existing Bun-owned daemon, not a new Rust daemon.
- Scratch probe: rusqlite 0.32.1 with SQLCipher 4.19.0 read a synthetic schema-v3 DB made by existing production open/migrate/apply code; message, cursor and FTS matched. Rust write compatibility and production packaging not established.
- Independent review received: serialization, SQL ownership, approval/send lifecycle, injected-port replacements and SQLCipher provenance are migration blockers until implemented and verified; no implementation changes from that review.
- Latest user amendment recorded here: conflict-free A0 only alongside R1; conflicting A1 follows verified Rust cutover. No implementation lane dispatched under this amended plan yet.
