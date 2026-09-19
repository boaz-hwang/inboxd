# 07 — Evidence Ledger

CI, fixture, local UDS, historical live observation and newly authorized live observation are separate evidence classes. A passing local test never substitutes for an account-bound observation.

## Status vocabulary

- `LOCAL_OBSERVED`: current working-tree code ran locally with captured test/subprocess/UDS evidence; no live provider claim.
- `HISTORICAL_LIVE`: retained sanitized prior account observation; not rerun by the current gate.
- `PENDING_LIVE_AUTHORIZATION`: requires fresh user authorization and bounded scope.
- `BLOCKED` / `UNSUPPORTED`: contract cannot currently be safely observed or does not exist.

## Current local observation — 2026-09-17

| Claim | Status | Observed evidence | Limit |
|---|---|---|---|
| Full offline parent gate | LOCAL_OBSERVED | Bun **379 pass / 1 intentional opt-in skip / 0 fail**; Rust **4 pass**; typecheck, boundaries, Clippy, fmt, diff hygiene pass | no live provider I/O claimed |
| Deterministic user surface | LOCAL_OBSERVED | **62** OpenTUI deterministic captures with source/capture hash manifest; CLI executable subprocess exit; UDS CLI/MCP/TUI integration | synthetic/local transport only; external MCP stdio-client round trip unobserved |
| O1 Slack lifecycle | LOCAL_OBSERVED | cursor, interruption/restart and rate-limit fixtures; bounded binding/allowlist and truthful diagnostics | no fresh live Slack run |
| O2 retrieval contract | LOCAL_OBSERVED | schema v3, atomic page CAS, configured-uncollected coverage, `message.recent`/`message.evidence`, UDS/CLI/MCP/TUI routes | Kakao self identity is unsupported/unknown |
| O3 outbox | LOCAL_OBSERVED | SIGKILL child processes after claim and after remote success recover to `Uncertain`; no retry; allowlist removal zero I/O; independent exact receipt/body/thread read-back test | injected local transport/reader, not live send |
| O5 encrypted scale | LOCAL_OBSERVED | production `applySyncBatch` ingested **100,000** rows in **9982.744 ms**; real UDS had **700** measured samples, p50 **29.346125 ms**, p95 **72.681875 ms**, worst per-query p95 **75.873917 ms** ≤300 | anonymous synthetic corpus, warm local UDS; no live history claim |
| Approval/backfill/decoder security | LOCAL_OBSERVED | verifier-only approval persistence; one-shot owner-TUI delivery; restart orphan expiry; pending/CLI/argv code denial; owner-only backfill; per-connection split-UTF-8 regression | same-user shell/Keychain isolation and live providers are outside this evidence |
| Korean/mixed search | LOCAL_OBSERVED | **25 positive / 8 negative** deterministic cases through encrypted production store | fixture retrieval is not live-question evidence |
| Schema/query safety | LOCAL_OBSERVED | v3 `account_self`, `unread_evidence`, `sync_page_sequence`; malformed batches reject before advancement; scoped cursors and unknown coverage | config alone is not collection evidence |
| Sender/self | LOCAL_OBSERVED | only authenticated-adapter account self binding can filter `sender=self` | Kakao lacks supported self identity; result remains unknown |

## Historical live evidence retained verbatim in meaning

| Claim | Status | Historical boundary |
|---|---|---|
| Slack limited read | HISTORICAL_LIVE | prior 89 unique rows and a bounded 30-day 2+2 cursor probe; no complete history or 429 recovery proof |
| Five user-originated questions | HISTORICAL_LIVE | Q1/Q2/Q5 product gaps, Q3 bounded Slack collection miss, Q4 Kakao retrieval of four messages; 5/5 classified, not 5/5 retrieval success |
| Kakao wrapper resume/read | HISTORICAL_LIVE | prior bounded wrapper transport/product-path observations; does not prove local DB/KDF/schema/AX route |
| Kakao controlled self-chat send | HISTORICAL_LIVE | prior exact approved payload, transport call and read-back record; it is not authorization to repeat or a current live-send result |

The current local gates do **not** rewrite those five-question outcomes. They also do not promote historical live evidence to `LOCAL_OBSERVED` or current live acceptance.

## Receipt and quota evidence boundary

| Claim | Status | Rule |
|---|---|---|
| Transport acknowledgement | LOCAL_OBSERVED | a valid transport receipt moves `Sending` to **`Sent`** only |
| Verified delivery | LOCAL_OBSERVED | independent trusted reader must match exact destination scope, receipt, body and parent/thread binding before `Sent → Verified` |
| Ambiguous crash/timeout | LOCAL_OBSERVED | becomes `Uncertain`; no automatic resend |
| Quota | LOCAL_OBSERVED | releases only proven-not-sent `Failed`; **`Sent`, `Verified`, `Uncertain` retain quota** |

## Pending / blocked evidence

- `PENDING_LIVE_AUTHORIZATION`: fresh bounded Slack read including cursor/restart/rate-limit behavior.
- `PENDING_LIVE_AUTHORIZATION`: fresh bounded Kakao read/restart and the same five user-originated retrieval intents. No live Slack/Kakao reads were rerun for this working-tree gate.
- `PENDING_LIVE_AUTHORIZATION`: one separately approved Slack send with exact destination/body and independent destination/body/receipt/thread read-back. Ambiguity remains terminal `Uncertain`.
- `UNSUPPORTED`: normal Kakao compose/send and authoritative Kakao self identity. Do not infer `sender=self`.
- `BLOCKED`: original Kakao local DB/KDF/schema/AX route; wrapper evidence cannot substitute.
- `PENDING`: independent V0 re-review (code, security, evidence, visual) and clean clause→evidence/blocker matrix; first-review findings were remediated but re-review is not yet observed.
- `PENDING`: D0 dedicated commit. There is no commit/push/PR/merge evidence.

## Evidence hygiene rules

1. Configured reader scope is discoverable but uncollected until an atomic sync observation writes evidence.
2. A binding registry is trusted injected host state; it is not proof that config can create a live provider or that credentials are available.
3. Never store message bodies, private identifiers, credentials, live timestamps, database copies, or raw accessibility trees in this ledger.
4. `offline-ready/live-blocked` is the only current product posture; it is not full-MVP or production-live acceptance.

## 2026-09-19 — personal account connections and real packaged TUI

Scope: owner-local macOS installation, existing Telegram/Slack/Kakao personal
sessions, self conversations only. No third-party conversation was used for
sending. Private account/chat IDs, message bodies, credentials and approval codes
are intentionally omitted from this ledger.

| Platform | Connection evidence | Read | One TUI-approved send | Independent readback |
| --- | --- | --- | --- | --- |
| Telegram | TDLib resumed the existing QR-authenticated session | Passed | Passed | Verified |
| Slack | Existing personal desktop/web session, self DM | Passed | Passed | Verified |
| KakaoTalk | Existing secondary-device session, self chat | Passed | Passed | Verified |

Actual interaction used the installed `inboxd` executable in a 120×40 PTY:
Chat resource selection, bounded backfill, text composition, Approvals, ephemeral
code entry and the rendered Verified outcome. Doctor → C opened the account
connection menu and returning from it resumed the TUI. Fresh account login/QR
scanning and fresh Kakao phone registration were not forced on already-valid
sessions and are not claimed as live-tested here.

Failures discovered during live validation and fixed:

- OpenTUI was dynamically imported through a variable and omitted from the
  standalone build. Literal imports include it in the packaged launcher.
- Refreshing auth timestamps published capability changes indefinitely; events
  now represent changes in auth state/reason, while timestamps still update.
- Personal Slack sessions need form-encoded API calls and their scoped cookie;
  bot-token transport retains JSON. Both make exactly one send attempt.
- Kakao incremental LOGINLIST snapshots could produce empty/partial chat lists
  on subsequent processes. The existing bootstrap fix is now an installed,
  lockfile-tracked dependency patch, together with disabled send replay.
- Personal Kakao observations use the core's `unversioned` revision contract.
- Backfill commits now publish message/coverage notifications for subscribed UIs.
- Doctor reads actual storage diagnostics and provider auth observations.
- Renderer shutdown ignores late updates rather than touching destroyed buffers.

Offline validation: full Bun suite passed (416 passed, 13 opt-in daemon integration
cases skipped, 0 failed); isolated packaged-artifact checks subsequently passed
(3 tests). Package smoke tests use a temporary HOME to avoid live configuration. Cargo workspace all-feature tests and all-target all-feature
Clippy passed. macOS trusted-path tests require a private canonical TMPDIR, and
artifact tests require the Rust toolchain on PATH. TUI render evidence is
regenerated for both 80×24 and 120×40.

Limits: this does not establish multi-account concurrency, complete Kakao
history, Kakao replies, unsupported message types, or long-running token refresh.
Kakao historical pages remain non-authoritative with explicit limits. Existing
experimental local-reader and official-template safety contracts are unchanged.

Final rebuild restart: the new daemon initially waited inside macOS
`SecItemCopyMatching` / `get_generic_password`, reaching the launcher readiness
deadline. After the user handled the local Keychain prompt, the daemon reported
ready=true with SQLCipher schema_valid=true. The final installed TUI launched
from /tmp, connected and displayed Doctor diagnostics; provider authentication
then reported authenticated=true. This resolves the final-rebuild startup block.
No additional test messages were sent during this restart check.

## 2026-09-19 — conversation workspace and search

The default screen now uses a provider-marked conversation sidebar and a unified
recent-message feed; raw capability/storage evidence remains available under `d`.
Conversation search (`/`, Ctrl+K) filters local titles/providers immediately.
Ctrl+F searches within an open conversation. Message selection, draft editing,
explicit proposal review and local code approval retain exact resource scopes.

Validation: full Bun suite passed (427 passed, 13 opt-in daemon cases skipped,
0 failed), followed by the added native mouse/resize regression (workspace suite:
12 passed). Typecheck, import boundary checks and diff whitespace checks passed.
Deterministic synthetic 80×24 / 120×40 captures include hashes of the new layout,
selectors, theme and terminal-cell helpers. Existing inspector tests still cover
capability evidence, disconnects, unknown outcomes and no automatic resend.

The installed final executable was launched from /tmp in an 80×24 PTY with the
existing daemon. The live journey found Slack through conversation search,
opened it, searched for the earlier Inboxd test message, opened the result,
typed a temporary reply draft, cancelled it and exited with code 0. No additional
message was sent during this UI validation. The wider layout was exercised in a
120×40 PTY and both sizes also passed the native OpenTUI keyboard tests.

Scope limits: conversation names depend on the daemon's available metadata;
missing names receive fallback labels. The unified feed covers registered scopes
and collected pages. Content search is per conversation, not across all remote
history; unknown unread/identity/coverage observations are not fabricated.
