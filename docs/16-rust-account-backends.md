# Rust-owned account backends

The account workspace now keeps application state and policy in the Rust daemon.
Account read/search RPCs are retained. All authenticated clients now use
`message.send`. The previous `account.send` entrypoint is removed.

| Owner | Responsibilities |
| --- | --- |
| `accounts.rs` / `accounts_schedule.rs` | Account/chat authority, directory snapshots, bounded jobs, worker lifetime and operation timeout |
| `direct_send.rs` / `owner_sends.rs` | Common authenticated send, durable identity/outcome/audit, optional receipt verification |
| `accounts_backend/pagination.rs` | Response size/count limits, overflow buffers, expiring scope-bound public cursors, provider cursor cycle detection |
| `accounts_backend/slack.rs` | Directory/member traversal, names and member expiry, summary watermark reuse, invalidation, history/search composition |
| `accounts_backend/kakao.rs` | Directory/title/name caches, history pages and ordered accumulation, latest/context selection, search plans and matching |
| `accounts_backend/telegram.rs` | Main/archive traversal, sender cache, history/search pagination and ordering |
| Bun account adapters | SDK authentication/session, one explicitly requested provider operation, provider data conversion |
| Bun dispatcher | Execute the Rust-selected read batch (at most eight), retain result order, await started reads on failure |

Slack keeps at most three concurrent profile/history/member requests. Kakao keeps
native multi-chat history batching, at most eight search pages per request and
100 pages per initial history traversal. Telegram preserves separate user/chat
sender identities and main/archive directory deduplication. These are Rust
decisions; SDK-internal connection/session state remains with the SDK.

Public page cursors no longer contain provider tokens. They bind to one account,
operation, chat and search query. The daemon retains up to 32 continuation entries
and 16 MB for 120 seconds. Pages contain at most 80 messages and stay within a
58 KB result budget including account/platform tags. Provider cursor cycles fail
instead of being hidden behind fresh public tokens.

No provider send is batched or retried automatically. Rust invalidates dependent
caches before dispatch and reserves the request ID before the operation. After
a successful provider acknowledgement, no optional asynchronous name lookup can
delay or discard its receipt. Ambiguous outcomes remain `Uncertain`. These
direct-send reservations and outcomes now survive daemon restarts in the
SQLCipher `owner_sends` ledger (schema v4). Interrupted reservations remain
`Uncertain` without replay. Deduplication applies to the same request ID and
the complete canonical envelope, not a new user send with another ID. See
[account workspace](12-account-workspace.md#direct-sends) for retention and
migration behavior.

Per-account admission permits four jobs with at most three reads. Traversals
release a FIFO worker lock after each primitive or explicit batch, allowing an
interactive request to proceed between history pages. Writes remain serialized.
Cache generations and active-send markers prevent an overlapping read from
publishing stale caches or continuation tokens. Congestion does not erase a
healthy directory snapshot.

Storage RPCs use `StorageActor::call_async`: requests enter the same bounded
single-owner DB queue while Tokio awaits a oneshot response. A timeout or
cancelled wait does not cancel an already accepted transaction, so callers
must not infer rollback or replay a write. The synchronous API remains for
synchronous compatibility consumers.

The private primitive contract has one source schema in
`packages/accounts/schema/primitives.json`. It generates operation-specific Rust
serde models and TypeScript discriminated types. Both runtime boundaries validate
the nested provider fields consumed by policy; additive response fields remain
compatible, while unknown private request fields and invalid/write/nested batches
are rejected before SDK work starts. Backend aggregation still uses JSON values
after validation. Run `bun scripts/generate-account-contract.ts --check` to detect
generated declaration drift; shared fixtures compare both validators. See the
[schema guide](../packages/accounts/schema/README.md).

## Removed execution paths

The previous send coordinator, approval-code generation/storage, proposal/approval
and send-quota execution, unused client helpers and TUI approval prompts are removed.
The historical intent schema, recovery and read/reject operations remain so existing
records are not discarded or dispatched. Active RPCs no longer include approval
execution or `account.send`. Tests seed historical rows directly instead of retaining
retired execution just to construct fixtures.

## Verification

- Existing account behavior assertions moved from TypeScript adapter tests into
  Rust policy tests, including TTLs, invalidation, continuation, Unicode search,
  bounded traversal, chronological history and name reuse.
- Thin-adapter tests exercise actual SDK request translation with synthetic
  ports. Dispatcher tests reject write/nested/oversized batches before I/O.
- `accounts_process_tests.rs` launches Bun with the production adapters and
  synthetic SDK ports. All three platforms exercise directory, history, search,
  buffered and provider continuation, send acknowledgement, deduplication and
  lost acknowledgement over real JSON-lines pipes.
- Regression tests cover cancellation during sends, no post-acknowledgement
  awaits, malformed results, oversized pages, expired/mismatched cursors,
  repeated provider cursors, and historical context preserving the latest cache.
- Full workspace tests, strict Clippy, TypeScript checks, import boundaries,
  standalone product artifact builds, native TUI rendering, and release daemon
  CLI/MCP/TUI parity are the integration gates.

Provider traffic in these tests is synthetic. No live-account send or installed
application replacement is part of this refactor verification.

Final verification (2026-09-19): `cargo test --workspace --all-features --locked`
passed. The existing opt-in 100k-message benchmark remains ignored. Bun passed
657 tests with zero failures and no skipped release integration lanes, using
retained release test-feature daemon/fake-worker binaries. The production artifact
build and real UDS CLI/MCP/TUI tests passed. Strict workspace Clippy, Rust formatting,
TypeScript typechecking, import boundaries and generated contract drift checks passed.

Cancellation/restart tests use explicit worker gates rather than timing a fixed
sleep. A duplicated-file-descriptor regression also verifies that actor shutdown
releases the writer lock after closing SQLCipher, even while inherited descriptor
copies exist. Provider traffic is synthetic; these results do not establish live
provider acceptance of the changed send flow.
