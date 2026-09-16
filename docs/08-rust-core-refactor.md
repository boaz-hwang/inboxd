# Rust core / TypeScript edge refactor

## Decision and baseline

The refactor retains the single Bun daemon and its proven, provenance-checked
SQLCipher connection. A Rust library owns domain and persistence decisions;
TypeScript owns OS, database-driver, network, and presentation I/O. This is a
functional core with synchronous host ports, not a second daemon or a second
database. The public JSON-lines protocol and encrypted schema remain compatible.

Keep the abstraction deliberately small: one Rust crate, domain/store/safety
modules, one synchronous host interface, and existing TS function facades.
Do not introduce a generic repository framework, plugin system, second IPC
protocol, or parallel implementation. Serialization compatibility belongs in
private bridge codecs; asynchronous I/O remains ordinary TS functions. Each new
abstraction must clarify ownership or remove duplication.

Baseline: commit `8c3bdb2`, clean worktree; official typecheck, boundary check,
and full test command passed (156 tests, 552 assertions) on 2026-09-16.
An isolated copy of that commit is retained temporarily for differential checks.

## Ownership and implementation sequence

1. Prove a versioned Bun FFI → Rust → SQLCipher host callback round trip, including
   callback errors, native result lifetime, panic containment, and rollback.
2. Move message normalization, revision/tombstone rules, coverage, migrations,
   atomic batch application, query planning and pagination into Rust. Existing TS
   exports become typed compatibility facades, with no TS business fallback.
3. Move approval binding, expiry, transitions, quota accounting, pending pagination,
   claims, finalization and restart recovery into Rust. Inject clock/random IDs/
   approval codes/policy via host ports. Keep asynchronous remote send and timeout
   in TS; commit claim before starting remote I/O.
4. Account for capability/read-contract validation, daemon quota configuration,
   chat-list pagination and read audit. Keep connection authorization, protocol
   parsing, event delivery, lifecycle and asynchronous sync scheduling at the edge.
5. Integrate, review, and run every regression gate below before completion.

Analysis and implementation are assigned to GPT-5.6 Sol/Terra. Direction,
integration management and plan review use GPT-6 Astra medium. Astra's independent
plan review accepted this boundary with explicit FFI, serialization, atomicity,
distribution, and expanded regression gates.

## Hard compatibility contracts

- Composite identifiers; adapter revision ordering uses existing JS semantics;
  tombstones cannot be resurrected; FTS changes share the message transaction.
- Half-open ranges, explicit unknown gaps, segment freshness, verified-empty and
  limit evidence; no new claims of authoritative Slack/Kakao history.
- Existing SQLCipher pack, key handling, encrypted file format/schema and WAL;
  wrong/no-key/plaintext rejection; startup gates before external work.
- Existing query and pending cursors, Unicode search and pagination ordering;
  JS serialization semantics for persisted approval hashes and cursor envelopes.
- Default-denied approval channels, bound single-use codes, durable expiry,
  atomic global/scope quotas, policy callback inside claim transaction,
  timeout/restart Uncertain behavior, no automatic resend, redacted audit.
- Existing UDS methods, roles, events, client reconnection and backpressure;
  CLI/TUI/MCP remain protocol-only clients; TUI retains all five screens.

## Completion gates

- [x] Full original regression suite, typecheck and strengthened boundary check.
- [x] Native build, Rust tests, ABI/load/error/lifetime and rollback checks.
- [x] Differential checks against the original commit, including Unicode,
  reordered properties, numeric boundaries, cursor bytes and named errors.
- [x] Original encrypted database reopening, FTS/messages/coverage pagination,
  old pending approval consumption with fake transport and interrupted recovery.
- [x] Offline daemon/CLI/MCP integration and actual TUI render evidence.
- [x] Build and runtime from outside repository cwd; missing/wrong native ABI
  fails closed; runtime does not require Cargo.
- [x] Final source audit: declared Rust responsibilities have no duplicate TS
  implementation; every existing feature maps to current verification evidence.

Live account data and actual outbound sends are not required for this refactor.
Existing live collection limitations remain documented in the evidence ledger.
Local transports exercise the same product paths without external side effects.

## Regression inventory

| Existing surface | Required evidence |
| --- | --- |
| Model keys, normalization, capabilities | Original core tests + differential Unicode/invalid input vectors |
| Coverage and limits | Original core/store interval tests + original/new output comparison |
| Encryption, WAL, migrations | Original encryption/migration tests + old encrypted database reopen |
| Message ordering and atomic sync | Original apply/orchestrator tests + callback failure rollback |
| Korean search, pagination | Original query/search tests + old cursor continuation + numeric/Unicode vectors |
| Approval state and quotas | Original safety tests + old hashes/pending codes + concurrent claim/policy/error cases |
| Recovery | Original restart tests + paired transition rollback + no remote retry |
| UDS owner and permissions | Original single-instance/ownership/security composition tests |
| UDS framing, paging, events | Original API/protocol/reconnect tests + native-backed daemon integration |
| Slack/Kakao adapters | Original read guards, measurement gate and composed backfill tests |
| CLI | Original handler tests + real UDS CLI requests against native-backed daemon |
| MCP | Original server/inbox integration + agent boundary and secret rejection |
| TUI | Original controller/render/reconnect tests + regenerate and validate all 25 captures |
| Distribution | Explicit native build + unrelated cwd load + missing/wrong ABI + Cargo-free runtime |

Pre-refactor performance reference (synthetic, same machine): one 10,000-event
batch took approximately 17.8 seconds; 30 broad Korean first-page searches had
p95 approximately 370 ms. This is a regression reference, not a new product
performance claim or proof of the older 100k benchmark target.

The same pre-refactor encrypted 10k database was reopened through the native
query path: all 30 first pages contained 50 messages; p95 was approximately
368 ms (baseline 370 ms). The 25 TUI captures were regenerated and validated
with no byte changes. A direct comparison of 26 message/key normalization
cases against the baseline matched, including Korean, astral characters,
unpaired UTF-16 surrogates, private-use characters and ECMAScript whitespace.

## Final verification (2026-09-16)

A separate source copy with no existing `node_modules`, native library or Cargo
target artifacts passed the following commands:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run check:boundaries
bun run test
cargo test --locked
cargo fmt --all -- --check
```

Result: **168 Bun tests / 632 assertions, 4 Rust tests, zero failures**.
The original regression tests remain, with stronger cursor and CLI request
assertions. New tests cover the native ABI/host boundary, persisted approval and
quota compatibility, and real UDS CLI/MCP/TUI workflows with an injected local
send transport. No live external send was performed.

Additional direct checks:

- An original TS-generated search cursor resumed through Rust at the next two
  message IDs. The original TS code reopened an encrypted DB mutated by Rust and
  retrieved its new fractional-timestamp message through both direct lookup and
  FTS. SQLCipher bootstrap/provenance code and database schema version remain
  unchanged.
- `serde_json` enables `float_roundtrip`: all 20,000 seeded timestamp values
  round-tripped exactly. Fixed regressions also exercise extreme finite values,
  message normalization and SQL callback results.
- All 25 TUI render captures match their previous bytes. Product smoke exercises
  real daemon restart, TUI resubscription and encrypted persisted reads, with no
  extra send.
- Source audit finds SQL execution in TS only in SQLCipher bootstrap and the
  native host driver. Domain/store/safety facades contain no parallel business
  implementation. Client import checks parse runtime imports, including dynamic
  imports, and reject native/database/platform access.

An earlier GPT-6 Astra medium review found and closed numeric precision and
TUI-notice regressions. A later high-effort architecture review found three
additional refactor blockers; all three were remediated before this report was
refreshed:

- malformed present `events`, `coverage`, or `limits` collections now fail
  before a transaction and cannot advance cursor, coverage, FTS, or limits;
- the raw-pointer C entry point is explicitly `unsafe`, with documented input,
  callback, result, and free ownership contracts;
- the native build pins and copies from the same resolved Cargo target
  directory, including custom `CARGO_TARGET_DIR` builds.

The new regressions in `apply-ordering.test.ts` and `bridge.test.ts` pass, as
does Clippy with warnings denied. The refreshed local gate is **170 Bun tests /
652 assertions and 4 Rust tests, zero failures**, plus typecheck, boundaries,
formatting, 25 TUI capture checks, and `git diff --check`. This closes the
reviewed refactor blockers; it is not a full-MVP ship verdict.
Integration also exposed a pre-existing CLI `message get` request-shape mismatch:
the flat CLI input now maps to the daemon's existing `{chat, msg_id}` protocol.
The public command interface is unchanged. No additional abstraction layer was
needed during review.

The full product remains incomplete. Runnable two-platform composition and
truthful diagnostics, Q1/Q2/Q5 retrieval contracts, crash-process and
receipt-verification evidence, client capability/pagination/reconnect behavior,
the encrypted 100k performance gate, and expanded Korean search acceptance are
tracked in the accepted living plan. Live/account-bound observations remain
separate and require fresh authorization.
