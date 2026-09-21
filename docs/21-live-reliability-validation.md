# Live reliability validation

Status: **observation completed with approximately 9h 27m continuous evidence;
P0 not passed because correctness and scenario gaps remain**. Initial live checks ran on 2026-09-19/20
(KST), using the installed production build from `200ea2e`. All mutations targeted
only the owner's self conversation. No historical ingestion was started.

## Initial results

| Scenario | Slack | Telegram | Kakao |
| --- | --- | --- | --- |
| Daemon send followed by actual provider read | One matching message | One matching message | One matching message |
| Independently generated new message | Observed after provider API send | Pending | Pending |
| Independent edit | Updated body observed | Manual app edit confirmed in remote read and local search | Manual app edit confirmed in remote read and local search |
| Independent delete | Absent remotely, **still present in local search** | Absent from refreshed history, **still present in local search** | Still present remotely and locally; no deletion option was shown, server deletion unconfirmed |
| Wi-Fi off for 20 seconds, then on | Connected; earlier probe still present once | Same | Same |
| Account worker termination and recovery | Connected; earlier probe still present once | Same | Same |
| Daemon restart | Recovery verified after retry; first scenario invocation errored | Same shared daemon | Same shared daemon |
| sleep/wake | Pending: automatic wake scheduling requires administrator privileges | Same | Same |
| Changes made during disconnection | Pending | Pending | Pending |
| Continuous observation (revised scope) | Approximately 9h 27m captured | Same shared observation window | Same shared observation window |

The network test verified that Wi-Fi was actually off and back on. It did not
establish that each provider exposed a disconnected state during the short
outage. Checking an earlier message after recovery proves accessibility, not
collection of messages/edits/deletions made while offline. These are separate
acceptance criteria.

The independent Slack scenario observed account invalidations and then explicitly
refreshed history. New/edit/delete were reflected in provider reads within roughly
4.3–4.8 seconds including the deliberate three-second wait. This is not a latency
percentile or proof that the TUI automatically rendered each change.

### Confirmed failure: deleted Slack message remains locally searchable

1. Create a unique test message through the Slack provider API in the self DM.
2. Read it through `account.messages`, which persists the observation.
3. Edit it through Slack; refresh and confirm the updated body.
4. Delete that same test message through Slack.
5. Refresh: the message is absent from remote history.
6. Search the unique marker in `message.search` with `mode: local`: one stale hit
   remains.

Remote absence must not be treated as a deletion without authoritative evidence.
The current content-free invalidation path and partial-observation storage do not
propagate a durable deletion here. Consequently, remote/live correctness and
local-search correctness must be judged separately. This failure prevents claiming
end-to-end deletion reliability. No production fix is included in this validation
change.

### Manual Telegram/Kakao deletion check

The owner confirmed deleting the edited probes. Explicit `account.messages`
refreshes and exact-marker local searches showed:

- Telegram: zero remote matches, one stale edited local hit. This reproduces the
  deletion propagation gap also observed with Slack.
- Kakao: one edited remote match and one matching local hit. This is not yet an
  established deletion propagation failure. The owner reported that no deletion
  option was shown and suspected local-only deletion in the self conversation.
  Server-side deletion remains unconfirmed; this is not a confirmed failure.

### Outstanding execution constraints

- Official-app UI automation could not start: its session authentication broker
  rejected this environment. No authentication checks were bypassed. Manual
  Telegram/Kakao edits were subsequently confirmed in both refreshed remote reads
  and local search, with one matching message and identical edited bodies in each.
  This establishes read/persistence correctness after a manual edit, not automatic
  TUI refresh or precise event latency. After the owner reported deleting both probes, Telegram returned zero remote
  matches but one edited local-search hit. Kakao returned one edited match in both
  refreshed history and local search. The owner subsequently reported no deletion
  option; server-side deletion is unconfirmed.
- Automatic wake scheduling returned an administrator-required error. Sleep was
  not triggered without an established wake mechanism.
- The first restart scenario returned an error before recording its final check.
  A subsequent restart and actual per-provider reads succeeded. The original error
  reason was not retained, so a clean single-attempt restart remains unproven.

## Completed observation and revised scope

On 2026-09-21 the owner accepted the approximately **9h 27m continuous observation**
as the duration for this validation, replacing the original 24h+ requirement.
No additional 24-hour run is required solely to satisfy the former duration target.
This changes the evidence duration, not the unresolved correctness findings.

The observer ran from 2026-09-20 00:03:42 to 2026-09-21 01:08:24 KST:

- Total elapsed wall time: approximately 25h 5m; 1,276 samples.
- Observation gaps: 60 (sample interval exceeding 75 seconds); longest gap about
  18 minutes. Their cause was not established by this observer.
- Longest uninterrupted sample span: approximately 9h 27m, calculated from actual
  samples rather than the terminal duration field.
- Observed daemon PID changes: 0; status request failures: 0. Gaps still prevent
  asserting uninterrupted operation across the entire wall-clock run.
- Kakao states: 1,273 connected, 2 disconnected, 1 degraded samples.
- Slack states: 1,234 connected, 42 degraded samples.
- Telegram states: 1,275 connected, 1 disconnected sample.

These state counts cover the whole run, not exclusively its longest continuous
span. Continuous observation is not a claim of continuously healthy providers.
Deletion persistence, degraded states, offline changes and the remaining manual
scenarios retain their separate findings and pending status.

## Approved P1 policy (2026-09-21)

The owner selected **1-B / 2-A**:

- Continuously observe and persist messages from all accessible rooms of connected
  accounts, including rooms never opened in the TUI. This supersedes the earlier
  opened-room-only scope for future live collection. Bulk historical collection
  remains a separate opt-in; this decision does not authorize a full-history crawl.
- Apply durable deletion only with explicit authoritative provider evidence.
  Absence from a page or even a complete range requery is not itself a deletion
  instruction. Where evidence is unavailable, expose the uncertainty rather than
  claim deletion synchronization succeeded.

This records the agreed implementation scope; targeted live reconciliation and
its persistence/deletion path are not implemented by this documentation change.
Provider contract normalization and core separation remain deferred.

## Content-free observation

Run the observer against an already installed/running daemon:

```sh
bun scripts/live-observe.ts "$HOME/.inboxd/live-validation/<run>" 25 30
```

It records a production binary digest, timestamps, provider state, snapshot age,
revision counters, invalidation counts, daemon RSS, request failures and observed
PID changes. It does not send messages, restart services, read chat history, or
save account/chat identifiers, credentials, message text or raw error payloads.
The output directory is owner-only and outside the repository. The observer
reconnects after request failures and stops after the chosen duration.

- `run.json`: start, scheduled end, binary digest and sampling interval.
- `samples.jsonl`: sanitized samples; missing requests are failures, not success.
- `summary.json`: latest interim counts and conservative continuous observation
  duration. A detected restart, request failure or observation gap resets that
  duration.
- `finished.json`: terminal evidence, including interruption/deadline status.
  Its presence supersedes the interim summary. It deliberately never asserts
  message-delivery success.

Elapsed wall time alone is not proof of continuous daemon operation.
Review observation gaps, restarts, per-provider degradation and snapshot ages.
The sampler cannot rule out short failures between samples; RSS covers the daemon,
not the worker processes. Complete the mutation and offline-change matrix before
any P0 pass decision. If the product build changes, start a fresh observation run.

Local evidence for this execution is under `~/.inboxd/live-validation/`; the
`current-run` file points to the active observation directory. Private target
identifiers and probe metadata stay there and must never be committed.

Validation of the observer: actual-daemon smoke run, TypeScript checking and
repository import-boundary checks. This instrumentation does not replace the
provider scenario checks above.
