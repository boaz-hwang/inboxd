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
