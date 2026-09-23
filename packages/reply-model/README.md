# Local reply pipeline

The daemon queues one current context per chat. Persistent MLX workers produce
typed context decisions; Rust enforces source permissions, retrieval limits and
message versions. Only the user can accept and send a draft in the TUI.

The current decision model is a **local LLM baseline**, not a trained multi-head
CIM. Its categorical selections are recorded separately from calibrated scores.
The first retrieval adapter searches already-collected history in the current
chat. Email, files, calendars and other conversations are not connected sources.
Missing facts or user intent lead to clarification or abstention.

## Runtime

The installed default is `~/.inboxd/reply-model/models/Qwen3.5-9B-4bit`.
See the [model selection and measured limits](../../docs/23-local-model-evaluation.md)
for the pinned weight revision and synthetic evaluation.

Install `requirements.txt` in a local Python environment and download an MLX model
separately. Set these before starting the daemon to override its installed paths:

```sh
export INBOXD_REPLY_PYTHON=/absolute/path/to/venv/bin/python
export INBOXD_REPLY_MODEL=/absolute/path/to/local/model
export INBOXD_REPLY_WORKERS=1 # optional: 1 or 2
```

The worker accepts a local model directory, never a remote model ID. Inference
uses Hugging Face offline mode with telemetry disabled. Installation downloads
model files; ordinary messenger receiving/sending still uses provider networks.
An unavailable runtime leaves manual composition and sending usable.

The central queue dispatches unread rooms first, then newest incoming message
within each unread/read group. Opening a room does not jump that order. Work
already running completes without preemption. The queue retains all rooms rather
than failing rooms after a 128-job cutoff.

On macOS with at least 48 GiB physical RAM the default pool size is two; otherwise
it is one. The override is capped at two. Two 9B workers were measured on this
M4 Pro / 48 GiB machine: generation plus checking throughput improved about 21%,
while individual latency increased under GPU contention. This helps backlog
drain, not single-draft speed. See
[measured results](evaluation-results/concurrency-qwen35-9b.json).

## Local observation and review

These commands authenticate as the local owner and never expose trajectories
through the MCP role:

```sh
inboxd trajectory list '{"limit":20}'
inboxd trajectory list '{"status":"failed","summary":true,"limit":25}'
inboxd trajectory list '{"suggestion_id":"ID"}'
inboxd trajectory settings '{"recording":false}'
inboxd trajectory settings '{"recording":true,"retention_days":90}'
inboxd trajectory delete '{"suggestion_id":"ID"}'
```

Each case links its snapshot, decisions, actual retrievals, evidence, draft,
grounding check, visible recommendation, user actions and send result. Unshown
drafts are not rejection labels. A user's edit is not automatically a routing
error. Use `evaluation.py` with reviewed cases to compare policy versions; keep
held-out cases separate from prompt development and model training.

A generation attempt drafts once and checks once. A rejected draft or runtime
error remains failed with its diagnostic trajectory; opening the room again does
not retry the same context. A changed conversation or model runtime creates a new
version. The decision and grounding stages remain enabled. The summary listing
omits conversation/model inputs so multiple failure reasons can be inspected
without exceeding the owner protocol's response size limit.

## Personal adapter experiments

`personalization.py --help` documents manual dataset inspection, training,
evaluation, activation and rollback. It accepts explicitly reviewed examples and
keeps temporal train/validation/test splits and provenance. Training does not
activate its output automatically. The registry is
`~/.inboxd/reply-model/active-adapter.json`.

The runtime loads an activated adapter only when its base-model identity,
completed training manifest and weight digest match. It uses the base model for
context decisions and grounding checks. An adapter changes phrasing, never
source permissions or send authority.

Message snapshots and trajectories live in SQLCipher. Experimental adapter and
training artifacts currently use owner-only filesystem permissions; they are
not application-encrypted. Deleting examples does not remove information from
existing weights: exclude the examples, rebuild and explicitly activate a new
adapter or roll back.

## Checks

```sh
python3 -m unittest discover -s packages/reply-model/test
```

Synthetic model outputs in unit tests test state transitions only. Production
has no fixed-text recommendation fallback.
