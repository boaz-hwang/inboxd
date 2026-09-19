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
not at completion. This is not a guarantee that a provider search index is fresh.

Telegram account IDs are converted to the existing bounded-worker key format
when persisted. Account search translates those keys back to workspace IDs.
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

## Current implementation stage

The storage operations and Telegram bounded-history correction are implemented
and regression-tested. Account-service, common RPC, TUI/MCP and diagnostics
integration is pending completion of the concurrent live-update work in another
session. Until that integration lands, account browsing does not automatically
invoke the new persistence operations.

Tests cover restart persistence, mixed legacy/observation ingestion, stale
observation rejection, atomic rollback, tombstone protection, preservation of
rich fields, Unicode, FTS/short queries, tied timestamps, scope-bound cursors,
and response byte limits. No live provider reads or sends are part of these tests.
