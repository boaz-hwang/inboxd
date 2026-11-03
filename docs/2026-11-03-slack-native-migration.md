# Connected Slack memory comparison and native migration

Date: 2026-11-03, macOS arm64. User instruction: keep every selected platform/account
connected; measure moving persistent Slack connections to Rust, and ship if it saves
memory. No selective platform-loading optimization was applied.

## Connected A/B evidence

`scripts/compare-slack-memory.py` launches the installed Bun account worker and the
release Rust worker together for each of the three configured Slack accounts.
Both perform `client.counts` and self `users.info`, then keep RTM WebSockets alive
for 45 seconds (including a 30-second heartbeat). It measures physical footprint
with `vmmap -summary` after 5, 20 and 45 seconds. Credentials are passed privately
in the existing account environment contract, never arguments or report output.
Only account indices and aggregate health/memory metrics are recorded.

Final paired samples, MiB:

| Account index | Bun | Rust | Saved |
| --- | ---: | ---: | ---: |
| 1 | 42.1 | 4.39 | 37.71 |
| 2 | 42.1 | 4.59 | 37.51 |
| 3 | 42.2 | 4.33 | 37.87 |
| Total | 126.4 | 13.31 | 113.09 |

Reduction: **89.5%** under this matched read-and-connected-idle workload. Both
variants passed reads and matched the configured self identity for every account.
Every worker reported connected; none reported disconnected during observation.
The active second account delivered change hints through both implementations.
Hint counts need not match: the existing Bun emitter coalesces hints, while Rust
uses bounded delivery into the daemon's existing coalescing observer.

Raw data: [paired samples](measurements/2026-11-03-slack-native-connected.json).
This is neither a long-term leak test nor a promise that memory stays at 13 MiB
under full history or attachment workloads.

## Shipped architecture

- `crates/inboxd-slack`: an account-isolated, single-runtime-thread Rust worker for
  persistent HTTP and RTM WebSocket transport. One native process per Slack account.
- The daemon routes only Slack accounts to `inboxd-slack-native`. Telegram and
  Kakao remain on their existing account workers. All configured connections stay on.
- Reads, batch concurrency, pagination primitives, text sends, file upload and leave
  use the same validated account wire contract. The worker reuses the existing Rust
  schema validator and generated types rather than adding another schema copy.
- `inboxd-slack-auth-helper` runs the existing credential recovery/store code only
  at startup or when needed, then exits. There is no resident Slack Bun runtime.
  Current-credential lookup, verified identity, recovery lineage, file permissions
  and cross-process refresh locks remain handled by the tested existing auth store.
- RTM uses bounded frames, 30-second application pings, 10-second pong timeout,
  reconnect backoff up to 30 seconds, and reconnects after credentials change.
  Hints omit message content and are bounded; overflow becomes an explicit gap.
- Sends/leave/uploads are never automatically replayed on transport or auth errors.
  Only reads can recover authentication and retry once. HTTP redirects are disabled;
  attachment identity is verified before provider I/O and upload hosts are checked.
- AI reply generation remains disabled independently of messenger connectivity.

The matched benchmark was performed before routing production accounts to Rust.
Once savings and connection evidence were established, `bun run install:local`
installed the new product and the daemon was restarted.

## Installation issue resolved

The initial combined Cargo build unified the native TLS stack's dependency features
with the otherwise stable Keychain helper. Its binary identity changed, so Keychain
correctly refused noninteractive access and the daemon temporarily could not start.

The product builder now builds the native Slack worker separately, then builds the
daemon and Keychain helper with their original package/feature selection. The restored
installed helper SHA-256 exactly matched the previously authorized 21:31 artifact
(`16279dbc222c8ec6daf3f49f94138fe5006929f4e089fd64fc728b366fed60d8`). The daemon then
started without another authorization prompt. No Keychain secret was displayed or
exported. The product integration test now compares the packaged helper against
an independent daemon/Keychain-only build to prevent this regression.

## Installed-product verification

After installation, `inboxd sync status` reported all five accounts connected:
three Slack, one Kakao, one Telegram; receiving state `live`. None reported
observation failure. Ordinary background room reconciliation was active and
progressing. Installed native Slack workers totaled approximately **28 MiB** in
initial operating samples, higher than the narrow benchmark because normal
background directory/history work was running. These operating samples are not
a matched before/after comparison.

Raw data: [installed samples](measurements/2026-11-03-slack-native-installed.json).
`inboxd reply status` confirmed disabled with no AI worker. The room-directory read
was also checked without exposing message or room content in the report.

Validation:

- 15 native worker tests, including real local HTTP transport, bounded responses,
  fixture text-send/leave semantics, concurrent auth recovery, input framing,
  selected-file integrity, endpoint restrictions, WebSocket heartbeat timeout,
  credential-change reconnect, and content-free/gap events.
- 120 daemon unit tests and 70 existing Slack adapter/auth tests.
- 3 product artifact integration tests, including atomic packaging, manifest hashes,
  real packaged workers, and stable Keychain helper identity.
- TypeScript typecheck, client import boundaries, native-worker Clippy with warnings
  denied, and installed-product connectivity/memory checks.
- No real messages, uploads, room leaves, or read receipts were sent during validation.

No Beads database exists in this repository; `bd prime --no-memories` reported that
at task start. This document records implementation/validation evidence only.
