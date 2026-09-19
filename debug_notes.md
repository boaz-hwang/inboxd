# Debug Notes: Telegram connected but composer asks for connection

## Rust account backend refactor verification (2026-09-19)

- Initial full suites failed four Rust worker trust tests and two Bun launcher
  tests. New account policy/real subprocess tests passed.
- The inherited macOS temporary directory started with `/var`, a symlink to
  `/private/var`. The production trust checks correctly reject symlink ancestors;
  fixtures used the OS temporary directory and incorrectly expected it trusted.
- Changing only `TMPDIR` to an owner-only temporary directory directly under the
  current user's home made all 13 Rust worker tests and all four Bun launcher
  tests pass. No trust validation was relaxed and no system permissions changed.
- The affected trusted fixture builders now create their temporary roots under
  canonical home paths, including config and provider acceptance fixtures. The
  final full suites pass with the default environment and no `TMPDIR` override.
- Clippy also caught one nonminimal cache-expiry boolean in the new Slack Rust
  backend; simplifying it preserved behavior and the strict Clippy gate passed.
- Review additionally caught lost acknowledged receipts from post-send name
  lookups, cancelled-send cache invalidation, and provider cursor cycles hidden
  by public UUID cursors. Implementation fixes have regression tests.
- Opt-in CLI fixtures were updated to the installed `.inboxd/state/sock` layout
  with a shorter temporary prefix for macOS socket limits. Scope-worker TUI
  fixtures explicitly select their existing scope mode instead of automatically
  entering the new account workspace. Original behavioral assertions remain.
- Final verification: Bun 469 passed/0 failed (release daemon/fake-worker lanes
  enabled); default Rust workspace/all-features passed (one existing opt-in
  large performance gate ignored); strict Clippy, typecheck and boundaries passed.

## Startup performance investigation (2026-09-19)

Follow-up API audit: docs/14-api-call-audit.md. Slack users.list works but omits
one of 15 DM peers, so the directory reduction target is 42→29, not 28.
client.counts works for 20/26 rooms; the six missing rooms are non-archived DMs.
rtm.connect returned a WebSocket URL; event delivery/reconnect remain unverified.
Kakao source SDK packet trace: 54 requests for 46 rooms (3 login, 1 list,
48 CHATINFO, 2 GETMEM). Batch MCHATLOGS/INFOLINK are SDK-supported candidates;
multi-room response completeness has not yet been validated. No product edits.

- Installed TUI: first header 583ms, first chat 4,925ms in a 120x40 PTY.
- Controller: forced directory refresh 5,169–5,976ms; cached 81-room directory
  published in 3ms in a comparison harness. No production behavior changed.
- Per-provider workers: Telegram 83ms, Kakao 1,037ms, Slack 5,641ms.
- Slack trace: 1 list + 26 history + 15 users.info calls, max concurrency 3.
- Daemon stop/start/readiness including Keychain: 166ms. Diagnostics ~1ms.
- Root: unconditional startup refresh and wait-for-all account directory barrier;
  per-room Slack requests and disposable name cache multiply remote work.
- Proposed: immediate snapshot reads, per-account background refresh, encrypted
  persisted snapshots, reusable names. Preserve operation serialization, snapshot
  pagination consistency, failure state and authorization boundaries.
- Full evidence and implementation/verification plan: docs/13-startup-performance.md.
- Analysis only; no startup fix installed and no messages sent during measurement.

## Problem
The authenticated Telegram account appeared connected in Doctor, but selecting
one Telegram conversation showed a connection-required composer.

## Reproduction and evidence
A read-only protocol controller observed authenticated + text-send capability
for the current Telegram resource. `chat.list` also contained a historical
account alias with the same chat ID. The sidebar listed the historical resource
first. Selecting it refused composition with exact resource capability missing;
selecting the configured resource opened the composer normally. No send was made.

## Root cause
The workspace mixed retained history and currently configured resources without
marking their difference. The composer conflated an absent exact capability with
failed authentication. Account + chat + platform scope checks correctly refused
to borrow another account's send authority.

## Fix
Configured resources sort before historical ones. Unregistered retained history
is marked [보관], with a read-only composer and guidance to find a current chat.
Capability loading, probe errors, missing scope and actual unauthentication now
have distinct composer hints. Capability refresh retains the focused resource by
identity if sorting changes. No resources are merged and no account IDs, messages
or stored history are rewritten.

## Verification
The regression failed before the fix: historical Telegram preceded current
Telegram, and loading claimed a connection problem. Both tests pass after the fix.
All 117 TUI tests, typecheck and import-boundary checks passed. Live protocol
recheck: current Telegram appears first and can compose; historical Telegram
remains read-only with the corrected hint. The installed TUI verification checks
conversation search, draft input and cancellation without sending another message.

## Repeated Keychain password prompts during development

- Observed: installed daemon's designated requirement was a `cdhash` requirement;
  rebuilding the monolithic daemon changed that identity. Repeated replacements
  therefore invalidated the previous Keychain grant.
- Fixed: independent `inboxd-keychain` executable, stable across unrelated builds.
  Daemon reads through an owner-validated private subprocess pipe. Normal `get`
  disables Keychain interaction; explicit initialization authorizes the helper.
- No Mac password cache, database-key file, expanded all-application ACL, or
  automatic dialog retry was added. Existing key remains in Keychain.
- Tests: helper hash stability across product rebuilds; missing-item `get` exits
  without prompting; unit validation of labels and key bytes; full test suite.
- Live verification completed: helper authorization retained across three silent
  saved-key reads; two restarts succeeded. After a further daemon source change
  and rebuild, the helper's designated requirement remained identical and the
  updated daemon restarted without another password prompt.

## Account workspace live verification

- Discovered 80 provider chats: Telegram 9, Slack 26, KakaoTalk 45; no unresolved
  titles in this account set. Provider message sender names resolved in all three.
- Global search found results from all three providers; selecting a hit restored
  the exact chat and message focus. Kakao self names use its MemoChat membership
  because the provider's MEMBER query omits self.
- One new owner-TUI message per verified self chat was sent without an approval
  code and read back in Telegram, Slack and KakaoTalk. No third-party test sends.
- Bun suite: 437 passed, 13 opt-in integration cases skipped. Rust daemon/protocol/
  helper tests, typecheck, boundary checks, formatting and Clippy passed.

## Implemented API reduction and startup optimization

Priority corrected to cold API reduction before caching/concurrency. Fresh Slack
directory: 42→29 HTTP calls. Fresh Kakao directory: 54→50 LOCO calls by reusing
CHATINFO for titles/member names and eliminating a redundant self-member snapshot.
Eight fresh Kakao room pages: 8→1 MCHATLOGS; actual full page equality verified.
Kakao 46 room titles: no mismatches against the previous SDK path.

Account workers now retain sessions; background directory snapshots and concurrent
read dispatch expose completed accounts immediately. RPC pagination remains bounded
and immutable; batch responses are split by exact chat. Search hit context retains
the hit even near the beginning of a larger provider page. Explicit refresh bypasses
Kakao history caches. No sending was performed for performance measurements.

Installed TUI first chat: 4,925ms baseline → 362–2,034ms after daemon restart.
Final installation measured 2,034ms. Two existing TUIs auto-reconnect, so these
are not isolated cold-start trials; cold API counts were measured separately.
Final Bun suite: 449 pass, 13 opt-in skips. Full 81-room
refresh still takes seconds; this is first usable chat, not all-provider completion.
See docs/15-startup-optimization-results.md for measurements and remaining limits.

## 2026-09-19: Kakao self-chat send succeeded but history stayed stale

- Observation: the live TUI reported `Verified`; its room preview changed, while message history lagged. The TUI already calls `account.messages` after successful sends. This is separate from unsolicited incoming-message push updates.
- Cause: `direct_send::execute` selects an exact fixed binding before account dispatch. That worker can send and independently verify delivery, but it did not invalidate `AccountService`'s separate history/backend caches. Kakao could therefore return its complete, fresh pre-send snapshot. Account-native sends already fenced those caches. The viewport also retained its previous focus after a successful refresh.
- Reproduction: a real Bun Kakao adapter fixture first loads a complete 100-message history. Delivery through the independent send boundary introduces message 101. Without invalidation, an overlapping read restores stale cached history. The regression fails with the old behavior and passes with the shared boundary.
- Fix: fixed-worker dispatch uses the existing per-account send lock, invalidates cached state before/after dispatch, and holds a weak lifetime marker so overlapping reads cannot publish stale snapshots. Cancellation drops the marker without retaining a false in-progress state. No extra polling loop, send retry, or new cache is introduced. Successful TUI sends focus the newest refreshed message.
- Validation: workspace Rust tests, Clippy, TypeScript checks, import boundaries, all 114 TUI tests, and 70 render captures pass. Tested external-send overlap and cancellation with synthetic providers; no real test messages sent. Installed product refreshed.
