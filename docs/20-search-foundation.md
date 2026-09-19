# Shared search and observed-message persistence

Approved scope: common local/remote/refresh search for TUI and MCP, persistence
of messages actually read by the user, Telegram mutation correctness, and honest
work diagnostics. Provider contract normalization and core/SQL/FFI separation
are deferred. Historical bulk collection remains an explicit separate action.

## Storage foundation

`StorageOperation::ObserveMessages` writes partial account observations into the
existing encrypted `messages`, `messages_fts`, `chats`, and `identities` tables.
It does not create an alternate message store or change the on-disk schema.
The whole page is atomic. An invalid row rolls back the page. Missing replies,
attachments, and edit metadata do not erase existing richer metadata. Tombstones
are not resurrected.

The daemon supplies the read's start order in `observed_at`; observations of the
same message with an older order cannot overwrite a newer observation. The
internal `observed:<order>` revision records collection order, not a provider
version. Bounded adapter ingestion recognizes this marker as unversioned and can
replace it with actual provider evidence. The order must be assigned before I/O,
not at completion. Buffered continuations retain the original observation order;
replaying an old cursor cannot overwrite newer rows. Older overlapping reads
cannot republish backend caches after a newer read. This is not a guarantee that
a provider search index is fresh.

Telegram account IDs are converted to the existing bounded-worker key format
at the daemon's provider boundary before persistence. Account search translates
those keys back to workspace IDs; storage contains no provider ID parsing.
This keeps the same message in one row across both read paths.

`StorageOperation::SearchAccountMessages` searches one explicit account and an
optional chat and time interval. Ordering is timestamp descending, then chat and
message ID ascending. Cursors bind to account, chat, interval and search text;
scope hashes keep long query strings out of the cursor. Rows and encoded bytes
are both bounded. Three or more characters use FTS trigram phrase matching;
shorter queries use escaped LIKE, preserving existing local substring semantics.

Observation writes never advance a sync cursor, claim interval coverage,
declare verified-empty history, or assert mutation reconciliation. Account-wide
results conservatively report unknown coverage. Existing bounded-sync coverage
remains available through the original per-chat evidence APIs.

## Common search API

`message.search` accepts `platform`, `account`, `query`, an explicit `mode`, and
optional `chat_id`, half-open `interval`, `limit` (1–80), and `cursor`. A structural
`chat` can replace platform/account/chat_id. Accounts must be configured; the
remote path uses the same directory authority and scheduler as browsing.

- `local` reads the shared encrypted index without contacting the provider.
- `remote` confirms one provider page, persists the returned messages, and reports
  `source: remote`, `semantics: provider`, and `checked_at`. A first page explicitly
  invalidates history/search caches. Provider cursors remain private; public
  continuation handles bind to account, chat, query, interval and page limit.
- `refresh` immediately returns the local page and `refresh: {id, state: running}`.
  Poll the same request with `refresh_id` until `succeeded` or `failed`. Success
  returns the provider page; failure preserves local results and explicitly reports
  the failed remote confirmation. Continue a returned page using `local` or
  `remote` mode according to its `source`, with `next_cursor` as `cursor`.

Refresh jobs coalesce identical active scopes, expire after 120 seconds, and retain
at most 32 bounded results. Remote confirmation has a 100-second refresh-job
deadline. Shutdown cancels and awaits these tasks. Query text is not included in
work diagnostics or read audit subjects.

TUI account search requests the local page first, then confirms remote pages even
when local hits exist. It merges structural message identities, labels evidence
by source, preserves local results on remote failure, and keeps local/remote page
cursors separate. MCP's `inbox_search` exposes the same modes and refresh handles.
An existing chat+interval search without mode retains the legacy local response,
cursor and coverage semantics. `account.search` remains compatible; its returned
observations also persist. Browsing via `account.messages` persists returned
pages, with commit notifications only for changed message content.

This stores messages actually returned by explicit reads, not every message from
internal directory previews. It does not automatically backfill unopened rooms,
collect all history, or infer deletions from missing search hits. Provider search
syntax/ranking may differ from local substring matching. Coverage remains unknown
for partial observations and search results, including zero-hit pages.

## Work diagnostics

`sync.status.state` reports active work (`running`, `idle`, or `failed`).
`receiving_state` and `accounts` separately describe transport/reconciliation
state from the live-update subsystem. `work` contains up to 64 jobs, their
operation and account/chat scope, start/finish times, active count and
`last_successful_work_at`. Completed jobs are evicted before active ones; global
admission rejects a 65th active job. Cancelled jobs become `interrupted`, never
successful. Account reads include persistence, and backfill includes the commit.
A successful work timestamp is not whole-account mutation verification.

Doctor displays both receiving state and active/recent work. Storage timeouts
retain the actor's existing semantics: a cancelled wait does not prove rollback
of an already accepted transaction.

## Validation

Tests cover restart persistence, mixed legacy/observation ingestion, stale
observation rejection, atomic rollback, tombstone protection, preservation of
rich fields, Unicode, FTS/short queries, tied timestamps, scope-bound cursors,
and response byte limits. Synthetic real-adapter process tests cover all three
providers' remote-to-local searches; UDS tests compare common and legacy searches
for reader/agent sessions. Refresh tests cover immediate local results, concurrent
local reads, coalescing, failure, scope mismatches, shutdown and buffered replay.
No live provider reads or sends are part of these tests.

Verification: workspace Rust tests passed (the existing opt-in 100k performance
benchmark remains ignored); Bun passed 693 tests with zero failures and no skipped
release integration lanes using retained release test-feature daemon/worker
binaries. Strict workspace Clippy, formatting, TypeScript checks, client import
boundaries, generated-contract drift checks, product artifact builds and the
70-capture TUI validation passed.
