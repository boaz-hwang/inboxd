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
- Slack: reuse a logged-in workspace, selecting it only when several are available.
  Verify the self chat automatically without a scope or conversation picker; the
  account runtime discovers all workspace conversations independently. Reconnecting
  replaces older Slack bindings for that account to avoid retaining stale credentials.
  No access-token or channel-ID entry. Invalid sessions require desktop login.
- Kakao: reuse a valid personal session, or login as a secondary tablet with
  phone confirmation. The connector automatically verifies a one-message read
  from the self chat and saves the connection without a chat-selection prompt.
  This self-chat binding preserves the legacy worker contract; the account
  adapter independently discovers all chats, and full-history collection remains
  explicit. Reconnecting replaces prior personal bindings for the same account
  so the account runtime cannot select stale credentials from an older binding.
  A separate personal worker supports bounded message reads
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

2026-10-18: after `bun run install:local`, the installed `inboxd connect kakao`
reused the existing session, verified reading, saved successfully without a chat
selection prompt, and restarted the packaged daemon. The installed TUI then
showed 39 Kakao chats with the Kakao filter selected and no list-load warning.
This verifies existing-session reconnect and directory display, not fresh phone
authentication or complete historical-message collection. Connection tests (6),
TypeScript typecheck and import-boundary checks passed.

2026-10-18 (Slack/Telegram follow-up): the installed Slack connector offered the
workspace menu for multiple sessions, then verified and saved an existing
workspace with no scope or room-selection prompt and restarted the daemon.
Single-workspace auto-selection, multi-workspace selection, cancellation,
self-chat identity mismatch and expired-session recovery passed offline tests.
All connection tests (12), typecheck and import-boundary checks passed.
The installed Telegram command displayed the revised conditional QR notice;
that verification was cancelled after observing the notice, so this change does
not claim a new Telegram authentication success.
The installed TUI showed 26 conversations with the Slack filter selected.
The shared workspace also displayed a partial account-list load warning; this
check does not establish that every connected account loaded successfully.

## Onboarding review — 2026-10-20 (proposal, not implemented)

Scope: current source, existing validation records, and the installed
`inboxd connect` menu (opened and cancelled without connecting an account).
Fresh authentication, first-run Keychain prompts, and provider failure paths
were inspected in code, not reproduced against live accounts.

The room-picker removal already reduces Slack/Kakao setup friction. Remaining
work should prioritize reaching the first usable conversation and recovering
from interruption:

1. **P0 — Give successful setup an explicit destination.**
   `packages/connect/src/setup-runtime.ts:connectInstalledAccounts` loops back
   to the provider menu after saving; its only exit is labelled "취소".
   After one connection, offer "대화 시작" as the default and "다른 메신저 추가"
   as the secondary action. Show connected account/workspace labels. Explicit
   `inboxd connect <provider>` should retain its command-oriented exit behavior.
2. **P0 — Resume incomplete onboarding.**
   `ensureInstalledConfiguration` checks configuration-file existence, although
   the empty base configuration is created before account setup. Cancelling or
   failing before any successful connection therefore skips automatic setup on
   the next launch. Distinguish no-account, intentionally skipped, and completed
   states. Give the no-account TUI a direct connect action instead of requiring
   `5 → C`; preserve already saved accounts when another connection fails.
3. **P1 — Make authentication progress and recovery actionable.**
   Explain the Keychain request before initializing it. Telegram currently
   opens the QR page once, waits for bootstrap exit, ignores AUTH_READY, and
   collapses failures into a generic authentication error. Emit sanitized
   progress/error codes for QR waiting, additional authentication, verification,
   cancellation, and timeout. Provide reopen/retry/back actions and bounded
   network waits without interrupting a user who is still entering a code.
   Preserve hidden password input and credential-free logs.
4. **P1 — Separate authentication success from usable-directory success.**
   Slack/Kakao announce loading the full list before the daemon's directory
   result is known. Display "계정 인증 완료" first, then actual directory status
   and count in the TUI. `loadAccountDirectory` currently reduces account errors
   to a generic warning; `workspace.ts:doctor` derives provider rows from
   discovered resources rather than the configured account inventory. A failed
   account with no rows can therefore disappear from that view. Render every
   configured account, including workspace, failure reason, and targeted
   reconnect action. Keep successful accounts usable.
5. **P2 — Reduce repeated setup and first-use uncertainty.**
   Mark existing Slack workspaces and optionally allow selecting several in one
   pass, persisting each successful connection independently. After first list
   load, show a short dismissible hint for opening a chat, finding a room, and
   composing/sending; explain that the visible list is not a full-history import.
6. **Distribution prerequisite.**
   The current installer builds locally, requires macOS arm64 and Telegram
   application credentials, while fresh Slack/Kakao authentication requires
   `agent-messenger` on PATH. For onboarding on another person's Mac, provide
   validated packaged prerequisites and provider-specific preflight checks.
   This is a distribution proposal, not evidence of a tested external install.

Suggested flow: launch → short introduction/preflight → choose messenger →
reuse session or authenticate → verify account → "대화 시작" (default) /
"다른 메신저 추가" → incremental directory loading → first conversation.

Acceptance checks for implementation: first-run cancellation resumes sensibly;
one successful account reaches the inbox without choosing "취소"; failed second
connections preserve the first; QR/browser failure offers a concrete next step;
an account returning no chats remains visible in connection management; partial
directory failure leaves healthy accounts usable. Validate changes in the
installed product, including fresh-auth paths separately from session reuse.

## Slack stale-session recovery — 2026-10-24

Credential extraction merges valid imports into the agent-messenger cache; it
does not remove stale workspaces. Cache membership is therefore not evidence of
a current login. On an authentication rejection, reconnect extracts once and
rechecks the selected workspace. If it remains unavailable, reconnect verifies
the alternatives and asks the user to select one explicitly. Cancellation
preserves bindings. Network/service failures do not trigger extraction.

Installed verification: selecting stale QMIT produced its login notice and a
recovery menu containing only authenticated Robopet/PLCO; cancellation completed
without saving a different account. This does not establish a working QMIT login.

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
