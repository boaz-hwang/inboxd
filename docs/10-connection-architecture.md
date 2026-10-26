# Connection architecture

Connection setup is an owner-local control-plane operation. Message reads and
sends continue to use the daemon RPC and its approval coordinator.

## Dependency direction

`CLI composition -> connect runtime -> connection service -> provider drivers`

- `packages/connect`: connection contracts, registry, orchestration, private
  configuration persistence, and interactive setup. Drivers return verified
  provider configuration; they never send test messages as part of login.
- `packages/host`: packaged executable validation and daemon lifecycle shared
  by setup and the CLI; it has no dependency on either UI or providers.
- Platform drivers own authentication, account verification and scope discovery.
  UI receives display labels and choices, never raw token responses.
- CLI/TUI/MCP message operations remain protocol-only. MCP cannot invoke setup.
- Existing CLI setup exports are compatibility shims, not implementations.

## Lifecycle and storage

Choose provider -> authenticate -> verify identity -> choose scope -> save.
An unsuccessful connection never writes a binding. Existing bindings survive
failure/cancellation. Each completed connection is persisted atomically, so a
failure in another provider cannot discard earlier work. Setup is repeatable
after first run through `inboxd connect`.

Account connections use the existing personal-client sessions: Telegram TDLib
QR login, Slack desktop/browser session import, and Kakao secondary-device login
with phone confirmation. No developer application registration is required from
the user. Session material is owner-local and must never enter UI logs. The
version-pinned Kakao SDK has a persisted patch disabling send retries.

## Capability honesty

- Telegram: QR first; TDLib may subsequently require account 2FA/code. Default
  scope is Saved Messages, verified against the authenticated self identity.
- Slack: reuse a logged-in workspace and select a conversation by name; no
  access-token or channel-ID entry. Invalid sessions require desktop login.
- Kakao: reuse a valid personal session, or login as a secondary tablet with
  phone confirmation. A separate personal worker supports bounded message reads
  and approval-gated text sends. The existing local-read and official-template
  workers retain their separate capability contracts.

Authentication, read capability, send capability, transport acknowledgement and
independent readback are distinct. Expired or missing authorization must remain
visible rather than being reported as a successful connection.

## Validation

Test registry dispatch, cancellation/failure persistence, session validation,
provider identity/scope verification and real daemon compatibility. Run boundary
checks and render TUI evidence at both supported sizes. Record live observations
separately from mocked transport tests; never call an offline test a live pass.

## Slack multi-account identity — 2026-10-24

The Slack driver now reads saved inboxd providers separately from the external
session-extraction cache. Connection choices distinguish a saved account,
reauthentication of that account, and adding another account. A new account is
identified by `team_id + user_id`, with a scoped account key and binding ID.
Reauthentication requires both identifiers to match; a different user in the
same workspace cannot replace that account. Settings writes preserve other users.

Existing account strings are database namespaces. A verified legacy connection
therefore retains its account and binding IDs and gains `user_id`; no database
rename is performed. If its expired credentials cannot establish identity, the
imported session must prove ownership of its existing self-DM before reuse.
Unverified legacy connections are not silently adopted by another user.

The daemon forwards optional `user_id` to both Slack runtimes. Auth recovery uses
an inboxd-owned private cache at `~/.inboxd/slack-credentials.json`, checking both
workspace and user and retaining credential lineage. The external workspace-keyed
cache is only an import source. Healthy legacy connections establish recovery
metadata on successful reads; already-expired sessions without that metadata
require explicit reconnect. Writes are never replayed by authentication recovery.

The current external extractor returns one session per workspace, preferring
Slack desktop sessions. The imported workspace and user must match the intended account. Previously
imported users remain separately saved in inboxd, subject to their Slack session
remaining valid. Users who already signed in can import directly; the browser
login window opens only on explicit request, with a continue step before
extraction. Changing only the browser user is not guaranteed to change the
desktop session imported. This does not implement OAuth or a new
login service.

Validation: 95 connection/Slack/provider setup tests and 18 Rust config tests
passed, including the final login-window UX correction. Typecheck and import
boundaries passed. Installed `inboxd connect slack` reauthenticated an expired
legacy Robopet session, retained its account/binding IDs, and added `user_id`;
all three unrelated provider configurations stayed unchanged. Installed TUI
displayed 26 Slack conversations. A subsequent PLCO login was independently
verified as the user-requested email before saving its new team+user identity;
the daemon returned PLCO conversations. The other pre-existing expired Slack
account still reports its authentication error. Add-account cancellation does
not save a connection. Same-workspace two-user coexistence and isolation were
validated with controlled tests, not two live logins.

After the final install, the daemon was restarted and the installed add-account
menu offered direct session import and an explicit login-window action. Opening
the menu and cancelling did not open another login window.

## Slack read failures after successful authentication — 2026-10-26

Authentication and directory success do not prove message-page success. Slack
huddle messages may supply `channel` as a string, unlike search matches' object
shape. The adapter normalizes that vendor variant to `{id}` before the shared
primitive validator; it retains the original ID and still rejects malformed
values. A valid huddle no longer rejects the entire history/replies page.

Account worker console diagnostics are isolated from RPC stdout and the
content-free event stderr channel. In particular, Slack WebClient retry notices
must never be interpreted as JSON responses. Allowlisted RPC error mapping
remains active, including rate-limit classifications from read batches.

CLI `message search` now forwards account scope, mode, limits, cursors and refresh
IDs, matching the daemon search contract rather than silently stripping these
into the legacy local-search form. Installed history reads were verified on the
development, planning, and shared development/planning channels.

Channel-scoped Slack search must use `in:<#CHANNEL_ID>`. A bare `in:CHANNEL_ID`
is interpreted as a name and can return an empty successful result despite
existing messages. Live comparisons confirmed the ID-reference and channel-name
forms return messages with the same date interval; the bare ID did not.

Final verification: rebuilt with `bun run install:local`, restarted the packaged
daemon, and used the installed CLI for channel-scoped remote search with the
same KST day interval. Development returned 21 messages, planning 5, and the
shared channel 21, including thread replies; all three searches completed.
The 14 Rust Slack backend tests passed. Search completeness here is provider
response completeness, not proof of exhaustive Slack index coverage.

## Follow-up read-boundary audit — 2026-10-26

Background room observations refresh provider data through a private internal
path. They do not invalidate the account-wide user pagination registry or
fence concurrent search snapshots. Explicit user refresh, directory refresh,
sends and room mutations retain their existing invalidation semantics. The
internal observation choice is not a caller-supplied RPC bypass flag.

Slack and Telegram search page sizes honor the requested bounded limit rather
than always requesting 100 rows. A superseded snapshot must also satisfy the
caller limit before it can be returned; oversized results fail rather than
silently dropping messages or restoring invalidated continuation handles.

Mixed read-batch failures select an allowlisted authentication classification
first, then throttling, then a generic failure. All started reads are awaited;
raw provider errors remain private.

Validation: after rebuilding the installed release and restarting its daemon,
real Slack CLI search returned one distinct message per page across three
consecutive pages with `limit:1`. Controlled process tests cover all three
providers, concurrent polling/search, and retained explicit-refresh fencing.

## Slack thread-read verification — 2026-10-26

The installed CLI's `account messages` path reads channel history only. Remote
search can return thread replies but its normalized projection does not retain
thread parent linkage. The `sync backfill` connected-account reader enumerates
channel roots and drains all `conversations.replies` pages for roots reporting
replies, preserving parent IDs in storage. Upserts deduplicate repeated roots.

Live verification on a product development channel committed one 100-message
channel page, then thread pages of 3 and 2 messages. A sampled root and both
replies were individually readable through installed `message get`. The
multipage-thread traversal test passed. This bounded verification is not a full
workspace export; the durable job remains pending and coverage remains unknown.

Gap: routine background polling uses channel history, so thread-only new replies
are not reliably hydrated. A terminal durable history job does not automatically
reopen to collect later replies. Thus ability to read accessible thread pages
does not imply continuous or exhaustive thread synchronization.
