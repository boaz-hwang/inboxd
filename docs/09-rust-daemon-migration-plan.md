# Rust daemon migration and platform delivery

## Accepted direction and execution order

The user approved Rust sole daemon/storage ownership with TypeScript clients and optional adapter processes. Coding and code-review agents use the current session model. At the user's explicit request, GPT-6 Astra performed one read-only scheduling/architecture re-review (`deleg_b382ab57`); it did not implement or accept R0.

Latest ordering amendment: finish Rust ownership changes before any conflicting platform integration. Only demonstrably independent adapter work may run alongside that migration. KakaoTalk official sending is allowed only for a separately identified, consented, template-constrained destination under explicit approval, configured capability, exact allowlist and finite quotas. API acknowledgement is `Sent`, never `Verified`, because no independent official read-back exists. This supersedes the earlier product exclusion, not the current implementation's safety checks. Do not merely remove the Bun Slack-only guard before a compatible replacement exists.

Current execution baseline: G0 checkpoint `6eb653d895c1793699bc27075270887eb7704d63` on `migration/rust-daemon-three-messenger`; the tree was clean when this R0 increment began. This document is a living plan; only commands recorded in the evidence ledger are completion evidence for their stated scope.

## Ownership and dependency boundaries

| Unit | Exclusive write scope | Dependency / restriction |
| --- | --- | --- |
| R0: compatibility contracts and fixtures | Parent-owned protocol/fixture contracts and this plan | First; verify exact paths before adding files |
| R1: Rust storage and runtime | `crates/`, root Cargo manifests, native bridge and daemon runtime | R0; one owner for SQLCipher, serialization, lifecycle, approval, outbox and transactions |
| A0: independent provider preparation | New isolated pure modules/tests: Telegram normalization, Kakao local bounds, Kakao official template validation | May overlap R1 only after R0 acceptance/checkpoint and exact file assignment; no shared imports, manifests, existing reader files, runtime contracts, SDK/auth, or enablement claims |
| R2: daemon client cutover | `packages/daemon/`, shared `packages/protocol/`, CLI/MCP transport parity, root scripts/manifests and integration tests | R1; parent controls shared edits; no parallel platform writers here |
| A1: platform integration | Existing/new platform adapters, Rust adapter bridge and provider-local capability behavior | R2 verified; consume frozen contracts, not guessed interfaces |
| U1: capability-aware OpenTUI | `packages/tui/**` only; deterministic fake-worker fixtures and render artifacts | May overlap A1 after R2; one TUI owner; shared daemon registration remains Integration-owned |
| V: independent review and verification | Read-only review; fixes returned to the owning lane | All producers for the behavior under review |
| L: live TUI verification | Approved accounts and bounded exact destinations only | Relevant runtime + platform integration + V; actual destination/body authorization before sends |

A0 may inspect documented provider APIs and build pure normalization/error/receipt parsing with synthetic fixtures. Production provider SDK bindings require observed public APIs and supported authentication. A0 must not discover credentials, send live messages, implement its own approval policy, or invent a parallel daemon protocol. If no meaningful work meets these constraints, defer A0 rather than manufacture parallelism.

Conflicting work explicitly deferred until R2: shared IPC schema, daemon worker registration, configuration parsing, SQL ownership, safety allow policy, send coordinator, global manifests/lockfiles, TUI capability/compose changes and end-to-end fixtures. Telegram/Kakao readiness must not become an excuse to bypass the Rust-first dependency.

The reviewed acyclic topology is: `G0 -> R0 accepted/checkpointed -> {R1 single owner || optional A0-T/A0-KR/A0-KW pure preparation} -> R2 single owner -> {Slack/Telegram/Kakao-read/Kakao-write provider lanes || U1 capability-aware TUI} -> one shared registration/integration owner -> integrated Rust UDS/OpenTUI acceptance -> verification/review -> cutover/deletion -> final offline gate -> separately authorized live gates`. R1 and R2 remain sequential one-owner work because they share storage, safety, lifecycle and compatibility invariants. A0 scopes are limited to new provider-local pure modules and tests. U1 may overlap provider implementations only after R2 freezes capability discovery and normalized page/update contracts; it consumes deterministic fake-worker fixtures and does not own shared integration. Root manifests/locks, protocol, core, daemon/config/registration, boundary scripts, shared integration tests, and plan/evidence edits always remain single-owner.

Exact optional A0 scopes after R0 freeze:

- A0-T: `platforms/telegram/src/normalization.ts` and `platforms/telegram/test/normalization.test.ts` only.
- A0-KR: `contrib/kakao/src/read-page-bounds.ts` and `contrib/kakao/test/read-page-bounds.test.ts` only.
- A0-KW: `platforms/kakao-message/src/template-envelope.ts` and `platforms/kakao-message/test/template-envelope.test.ts` only.

No A0 lane may install dependencies, edit a root/package manifest or lockfile, duplicate approval/quota policy, use credentials, or claim a runnable provider. Ownership must explicitly transfer before the corresponding full provider lane starts.

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

R1 must implement both legacy v1 text safety bytes and v2 destination/template safety semantics: exact approval hashes, quota-resource keys, persisted intent recovery, template ID/arguments/preview binding, and legal `Pending -> Sending -> Sent/Verified/Uncertain/Failed` transitions. This remains safety-owner work and must not leak into A0-KW or shared integration.

Boundary clarification: R1 ends with a production-ready Rust storage/safety owner and a single-writer command/actor API. R2 owns process lifecycle, UDS protocol compatibility, bounded provider workers and client cutover. This interpretation prevents the actor boundary from being omitted or counted twice.

Evidence required: synthetic Bun-created DB -> Rust write -> Bun reopen and reverse; stale-page rejection, rollback, tombstones/FTS consistency and persisted-state compatibility. Successful scratch reads do not meet this gate.

An earlier wrong-key scratch command was blocked by approval timeout. Do not repeat or disguise it; obtain renewed approval for that blocked verification before executing it. No real account database migration in this phase.

Verification: targeted native storage/safety tests, full Bun suite, `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`. FFI/unsafe changes require the Rust skill's escalated checks; unavailable evidence stays an explicit gap.

Rollback: keep old entrypoints until newest synthetic database state can be reopened safely by them. Never roll back an outbox database snapshot after a possibly executed external send.

### R2 — Runtime and client cutover

Preserve owner-only config/state/socket/token, cross-version single-instance exclusion, startup ordering, bounded JSON-lines framing, subscriptions/backpressure, typed errors, auth/sync diagnostics and post-commit events. A Rust actor owns the connection; external I/O must not hold a database transaction open.

Map every TS injected port to a verified native or bounded-worker replacement before removing it. In particular, an arbitrary synchronous allowSend callback must not become an unbounded subprocess call inside the claim transaction.

Worker contracts need request IDs/generations, time/byte/queue limits, fixed trusted bindings and cleanup. A timeout or EOF after possible send stays Uncertain with quota retained and no automatic resend. Receipt-read failure after acknowledged Sent does not undo Sent.

Before any full provider or U1 lane consumes R2, R2 must freeze and verify: the capability-discovery RPC and its placement; capability refresh, revocation and freshness behavior; normalized page/update payloads including identity, unread and coverage provenance; raw-frame parser use at the worker wire boundary; and fake-worker enforcement of time, byte and queue limits. The parent selects and pins shared provider dependencies after this gate; provider lanes never mutate shared manifests independently.

Verification: real Rust executable with existing CLI/MCP/TUI clients, cross-runtime single owner, fragmented frames, reconnect/no replay, bounded shutdown, SIGKILL recovery and approval code loss. Retain old interfaces until each consumer group passes. Rollback: stop the new owner/workers before returning to the verified old binary under the same lock contract.

### A1 — Telegram/Kakao integration after runtime boundary freezes

Connect provider adapters through R2 contracts. Replace the historical Kakao product exclusion with explicit capability/allowlist policy; keep unknown/noncanonical platforms denied. Kakao authenticated self identity remains unsupported unless independently established; permission to send is not identity evidence.

Implement Telegram support rather than inferring it from historical wrapper notes. SDK/authentication limitations remain explicit blockers. Do not weaken tests or provider controls to claim success.

Verification: bounded read normalization, exact destination binding, capability revocation, unauthorized scope refusal, one-shot approval, transport outcome classification, receipt matching and worker failure isolation. Run these through the Rust daemon and real TUI surface, not solely controller or fake-provider tests.

### V/L — Finish and live acceptance

Run the full repository gates, independent current-model review, deterministic TUI rendering and the mandatory 100k ingestion/UDS search gate. Record actual command exit codes, artifacts and cleanup receipts. Fix failures within their owning lane and re-run affected integration gates.

Live gates run only after the final offline gate for the relevant provider path. Slack does not wait for unrelated provider live readiness, but it still requires its completed integration, TUI path, offline verification and independent review. Require exact destination/body approval and one bounded send, with receipt and independent read-back. Telegram and Kakao additionally require their own completed paths and account/destination/body or template authorization. Never automatically repeat an ambiguous live send to make a test pass. The 100k ingestion/UDS search gate is mandatory for final offline acceptance, not optional.

Completion means implemented, exercised, independently reviewed and documented behavior, not an unconditional perfection claim. No remote push or live account migration is implied by local tests. Keep unfinished milestones pending.

## Current checkpoint

### R0 compatibility and exact-resource contracts

Status: **SHIP after independent re-review; checkpoint gate ready**. The protocol now freezes versioned structural `ChatRef` and write-only `DestinationRef` values, a per-resource capability directory, v2 text/template send envelopes, legacy Slack v1 normalization with unchanged v1 approval bytes, and bounded v1 worker frames for `read_page`, `send`, `read_receipt`, and `health`. Kakao measured local reads and Kakao official template destinations are represented by different resource kinds and cannot inherit one another's capabilities.

The compatibility fixtures pin all 21 existing request methods, all three events, all 21 Host operations, explicit unsupported `settings.get`/`settings.update`, safety/host milliseconds versus provider/retry seconds, JavaScript property/number formatting, UTF-16 lone-surrogate/private-use behavior, null versus absence, base64url cursor bytes, canonical quota scope, approval/bound hashes, idempotency bytes, the four provider capability shapes, and all four worker operations. Template ID, arguments, and preview are included in the v2 approval payload. No existing method/event was removed or renamed.

Observed vertical TDD evidence:

- Capability RED: `bun test packages/protocol/test/capabilities.test.ts` exited 1 because `parseResourceCapability` was absent. GREEN: 4 pass / 0 fail.
- Send/golden RED: the focused v1 Slack normalization test exited 1 because `normalizeSendEnvelope` was absent. GREEN: focused 1 pass / 0 fail; the complete schema file later passed 11 tests.
- Worker RED: `bun test packages/protocol/test/worker-contract.test.ts` exited 1 because `parseWorkerRequest` was absent. GREEN: 5 pass / 0 fail.
- Ambiguous-send retry RED: the focused failed-frame test exited 1 because a response with both `may_have_sent: true` and `retryable: true` was accepted. GREEN: focused 1 pass / 0 fail; possibly executed sends are now non-retryable by contract.
- Review remediation RED/GREEN: request/receipt mismatches, queue/frame/payload/aggregate JSON overflows, an impossible destination/text capability, prototype-sensitive JSON keys, missing Host/time-unit exports, and multibyte/lone-surrogate cursors were each observed failing before their production fixes. Responses are now request-aware and operation-correlated; verified evidence must match exact destination, receipt, content and reply; JSON objects use inert own properties; and cursor limits use encoded UTF-8 bytes.

Observed R0 gate evidence after final remediation: protocol schema/capability/worker/framing tests passed 28 tests / 280 expectations / 0 failures; the complete Rust `wire_roundtrip` target passed 2 tests; configured TypeScript typecheck and import-boundary checks passed; `git diff --check` passed before this status edit. UB escalation verdict: `not_escalated` because this increment adds no Rust implementation, `unsafe`, raw pointers, FFI, `MaybeUninit`, unsafe `Send`/`Sync`, `transmute`, or hand-written lock-free primitive. The worker parser validates declarations and raw frames; elapsed timeout and queue scheduling remain explicit R2 supervisor responsibilities. Final independent re-review `deleg_c4e80313` returned SHIP with no new P1/P2 findings and confirmed both residual blockers closed. R1/R2, provider runtime integration, OpenTUI work, live sends, CI, merge, and commit remain unobserved.

R0/R1 storage increment received independent review `deleg_6ac26b6c`: its original no-ship identified equivalent JSON integer spelling and Bun/Rust SQL numeric binding differences. Those two regressions were later implemented in the preserved G0 work and were freshly remeasured after R0 review: the exact Rust serialization test passed 1/1 and the Bun/Rust numeric SQL compatibility test passed 1/1. This closes only the numeric compatibility blockers; `inboxd-storage` still owns a development-only SQLCipher connection, production provenance and the bounded actor are absent, and approval-code lifetime, full v2 safety/outbox semantics, UDS lifecycle and client migration remain R1/R2 work. Existing Bun/FFI consumers remain active; their deletion gate is R2 client verification, not this storage checkpoint.

Latest parent verification: Cargo debug and release each 12 passing tests; Bun 381 pass / 1 opt-in skip / 0 fail; fmt, clippy, cargo doc, lint/typecheck and boundary checks passed. Bun output is recorded at `/tmp/inboxd-storage-full-test.log` (temporary local evidence). Independent storage review dispatched as `deleg_6ac26b6c`; dispatch is not review acceptance. No live provider send or production DB migration performed.

## Evidence ledger (append-only)

- Before this plan: existing Bun baseline reported 379 pass / 1 opt-in skip / 0 fail. These tests use the existing Bun-owned daemon, not a new Rust daemon.
- Scratch probe: rusqlite 0.32.1 with SQLCipher 4.19.0 read a synthetic schema-v3 DB made by existing production open/migrate/apply code; message, cursor and FTS matched. Rust write compatibility and production packaging not established.
- Independent review received: serialization, SQL ownership, approval/send lifecycle, injected-port replacements and SQLCipher provenance are migration blockers until implemented and verified; no implementation changes from that review.
- Latest user amendment recorded here: conflict-free A0 only alongside R1; conflicting A1 follows verified Rust cutover. No implementation lane dispatched under this amended plan yet.
- R0 increment: implemented `wire_from_utf16_units` using safe Rust, with reserved-PUA, paired/lone-surrogate fixtures and exhaustive single-code-unit roundtrips. Observed RED: missing API, cargo exit 101; GREEN: 2 new tests pass. Full Cargo: 6 tests pass; Bun: 379 pass / 1 opt-in skip / 0 fail; fmt, clippy, lint/typecheck and import boundaries pass. No FFI/unsafe changes. This helper does not establish native SQL ownership or daemon cutover. The tests were not committed separately before implementation; red-commit discipline was missed, although tool receipts record RED before edits.
- Delegation `deleg_c8f3699d` was dispatched then cancelled by the coordinator before observed implementation; do not count it as delivered work. No user request to cancel was received; the cancellation message incorrectly attributed that decision to the user. The parent wrote the above increment. Remaining R0 serialization and R1 native storage work remain open.
- Three-provider discovery `deleg_b39102d1` completed read-only and was parent-rechecked. Slack has bounded read adapters but no provider sender/receipt binding; Kakao has a measurement-gated reader but no sender/receipt binding; Telegram has no implementation. Parent verification passed 144 focused Slack/Kakao/daemon/TUI tests and `check:boundaries`. The existing R1 compatibility test initially blocked `bun run typecheck` because its `expected` array was typed as `unknown[]`; narrowing that local test declaration restored a zero-exit configured typecheck without changing runtime behavior. This is baseline recovery, not R1 numeric compatibility, R2 cutover, provider delivery, or live-account evidence.
- TUI discovery `deleg_374c2d33` completed read-only. Existing TUI tests and deterministic captures pass, but the requested three-messenger UX is no-ship: an empty active Chat currently falls back to aggregate Inbox rows and can display another channel's messages; mixed Inbox rows do not identify platform/account clearly; compose is gated by a global `sendCapable` boolean plus a Slack-only check; and all render evidence is Slack-only with stale hard-coded Git provenance. After R2 freezes exact-scope capabilities, one TUI owner must implement a messenger/account/channel directory, structural scope breadcrumbs, explicit READ/WRITE/UNKNOWN state and reasons, one-action channel opening, strict empty-chat isolation, mixed-provider 80x24/120x40 evidence, and native OpenTUI mock-input over a real synthetic UDS session. No TUI implementation from this discovery is claimed.
- The current user instruction to run tests and keep fixing until they pass is the renewed explicit authorization required by the prior checkpoint for the two synthetic numeric compatibility regressions. Parent-observed RED: `equivalent_json_number_spellings_keep_integer_validation_compatible` exited 101 because JSON `1.0` produced no `as_u64()` value; the Bun/Rust numeric SQL compatibility test exited 1 because Rust bound large JavaScript numbers as SQLite INTEGER where Bun binds REAL, producing different storage classes and persisted text. No real database, credential, account or live provider operation was involved. The regression assertions must not be edited or weakened; implementation-only fixes now own GREEN.
- R0 exact-resource contract increment: four observed RED→GREEN cycles froze structural chat/destination refs, the four provider capability shapes, v1 Slack-to-v2 normalization, v1 compatibility bytes, template-bound v2 approvals, bounded worker request/response contracts, and non-retryability after a possible send. Final focused protocol evidence was 20 pass / 0 fail; the requested Rust UTF-16 filter passed 1 matching test and the full target passed 2; typecheck, boundary checks, and diff whitespace checks passed. No unsafe/FFI, credential, provider I/O, live service, commit, or push was involved.
- R0 review `deleg_864c7074` returned NO_SHIP for unbound verified evidence, declaration-only bounds, an incomplete capability matrix, prototype-sensitive JSON reconstruction, missing Host/time-unit goldens, uncorrelated response types, and character-count cursor limits. Remediation added request-aware receipt and response validation, operation-correlated response types, encoded payload/evidence and aggregate JSON limits, explicit queue declarations for R2 enforcement, exhaustive capability tests, null-prototype own-property reconstruction, all 21 Host operations and time-unit goldens, and UTF-8 byte cursor limits including lone surrogates. Re-review `deleg_d2075865` closed six findings but returned NO_SHIP on two residual contract defects: object reserialization could not enforce received frame bytes, and write-only destinations could incorrectly request a verified receipt. A second RED→GREEN remediation added raw string/byte worker frame parsers that enforce request and negotiated response limits before `JSON.parse` (including padded and escape-inflated regressions), and limited independent `read_receipt` plus verified evidence to readable chat/text resources; Kakao official destinations remain `ack_only`/`Sent`. Fresh focused evidence is 28 pass / 280 expectations / 0 fail; Rust wire roundtrip 2 pass; typecheck, boundaries and diff-check pass. Final re-review `deleg_c4e80313` returned SHIP with no new P1/P2; R0 is frozen pending its checkpoint commit.
