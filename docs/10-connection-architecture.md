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
