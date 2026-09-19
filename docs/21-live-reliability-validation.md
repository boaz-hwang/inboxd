# Live reliability validation

Status: **in progress; P0 not passed**. Initial live checks ran on 2026-09-19/20
(KST), using the installed production build from `200ea2e`. All mutations targeted
only the owner's self conversation. No historical ingestion was started.

## Initial results

| Scenario | Slack | Telegram | Kakao |
| --- | --- | --- | --- |
| Daemon send followed by actual provider read | One matching message | One matching message | One matching message |
| Independently generated new message | Observed after provider API send | Pending | Pending |
| Independent edit | Updated body observed | Pending manual app action | Pending manual app action/support check |
| Independent delete | Absent remotely, **still present in local search** | Pending | Pending |
| Wi-Fi off for 20 seconds, then on | Connected; earlier probe still present once | Same | Same |
| Account worker termination and recovery | Connected; earlier probe still present once | Same | Same |
| Daemon restart | Recovery verified after retry; first scenario invocation errored | Same shared daemon | Same shared daemon |
| sleep/wake | Pending: automatic wake scheduling requires administrator privileges | Same | Same |
| Changes made during disconnection | Pending | Pending | Pending |
| 24h+ continuous observation | Running; not yet established | Running | Running |

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

### Outstanding execution constraints

- Official-app UI automation could not start: its session authentication broker
  rejected this environment. No authentication checks were bypassed. Manual
  Telegram/Kakao edit actions have been requested; only the newly created probe
  messages should be modified or deleted.
- Automatic wake scheduling returned an administrator-required error. Sleep was
  not triggered without an established wake mechanism.
- The first restart scenario returned an error before recording its final check.
  A subsequent restart and actual per-provider reads succeeded. The original error
  reason was not retained, so a clean single-attempt restart remains unproven.

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

A 25-hour wall-clock run is not automatically a 24-hour daemon-operation pass.
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
