# Inboxd memory investigation — 2026-11-03

## Live measurement

macOS `vmmap -summary`, physical footprint, approximately 21:23 KST:

- Local MLX reply worker: 5.1 GiB (peak 8.4 GiB), including 4.9 GiB in IOAccelerator graphics allocations.
- Five account workers: 49.9, 48.6, 64.4, 48.6, 85.5 MiB; total 297 MiB.
- Rust daemon: 20.5 MiB; CLI/MCP process: 63.7 MiB.
- Configured accounts: three Slack, one Telegram, one Kakao.

These are snapshots, not leak measurements. `ps` RSS missed most of the MLX GPU
allocation; summing RSS also double-counts shared pages. Physical footprint is
used here for attribution. Library mappings and virtual address reservations
must not be mistaken for private RAM. `vmmap` warned that its Bun malloc-zone
analysis is incomplete; do not infer object-level heap breakdown from that table.

The installed Python worker matched source SHA-256. It loads Qwen3.5-9B-4bit,
retains loaded models in `self.models`, and waits for subsequent stdin requests.
The Rust service retained that subprocess indefinitely. This explains retained
model memory, without proving a leak or attributing all graphics memory to weights
rather than MLX caches. The Python process was terminated at the user's request.

## Account workers: observed architecture

`packages/accounts/src/worker.ts` statically imports all three provider adapters.
Every account therefore initializes common SDK dependencies in its own Bun/JSC
runtime even when it uses only one provider. The product build bundles 375 modules
in the account worker. `WorkerTransport` keeps one process per account for live
push and takes ownership during each provider operation; cancellation drops that
process, preventing ambiguous sends from being automatically replayed.

Slack's adapter already uses direct HTTP for ordinary API calls, but uses
agent-messenger's SlackClient/SlackListener for login and WebSocket events. Kakao
has native-protocol session state and member-name maps in its SDK. Telegram uses
native TDLib through tdl. Their retained state has different purposes; deleting
all caches or periodically killing workers would not be a transparent change.

## Isolated import experiment

Reproduce with `python3 scripts/measure-worker-imports.py` on this Mac.
The script compiles temporary workers, imports modules, and holds stdin open.
It supplies dummy configuration, sends no requests, and never logs in. Each live
process is measured after one second and then terminated. Two samples per provider
and variant. The prototype pre-imports the selected provider so the comparison
is not against an empty worker. Raw results: `measurements/2026-11-03-worker-imports.json`.

| Imported provider | Current static imports | Selected-provider imports | Selected imports + Bun --smol |
| --- | --- | --- | --- |
| Slack | 44.1–44.9 MiB | 29.4–31.3 MiB | 28.3–31.1 MiB |
| Telegram | 37.3–44.8 MiB | 19.5–19.9 MiB | 19.9–20.1 MiB |
| Kakao | 37.3–43.6 MiB | 25.0–25.8 MiB | 23.2–24.9 MiB |

The experiment establishes lower startup/import cost, not production steady-state
savings, throughput, latency or long-term growth. It does not isolate each object's
allocation. --smol provided no clear additional benefit in this small sample.
An earlier 0.5-second sampling attempt returned unreliable startup observations
and was discarded; only the one-second repeated run is included above.

## Recommended order

1. **Load only the selected provider.** Keep one process per account; dynamically
   import or compile distinct provider entrypoints. The cold experiment suggests
   roughly 60–100 MiB aggregate savings for this account mix, but measure connected
   idle state, room loading, history/search and reconnection before promising that.
   This is the lowest-risk candidate because IPC and fault isolation stay intact.
2. **If more savings are needed, migrate Slack's persistent transport to Rust.**
   There are three Slack workers. Ordinary HTTP operations are already a narrow
   interface. Move WebSocket lifecycle, heartbeat, reconnect and event decoding,
   while keeping credential recovery/interactive login as an on-demand helper.
   Verify token refresh, workspace isolation, bounded payloads and send semantics.
   Removing three JS runtimes has a larger ceiling than tuning their allocation,
   but no Rust prototype has yet established the attainable savings.
3. **Consider a shared Slack worker only after evaluating failure semantics.**
   Three accounts could share one runtime while maintaining three independent
   connections. Need per-account request IDs, cancellation, fairness and reconnect
   state. The current kill-on-cancellation contract cannot simply be carried over:
   killing a shared worker would disconnect unrelated accounts. Never replay an
   ambiguous send. A single worker for all platforms expands the blast radius.
4. **Keep TDLib and Kakao until profiling justifies a rewrite.** Rust can replace
   the Telegram bridge but does not remove native TDLib's state. Kakao's protocol,
   authentication and reconnection implementation makes a rewrite substantially
   broader than its expected tens-of-MiB opportunity. Inspect cache growth over a
   fixed workload before adding eviction; current snapshots do not prove a leak.

Do not idle-kill live messenger workers as a memory shortcut: this interrupts
push delivery and introduces reconnect work. AI generation is independent and can
be disabled without those side effects.

## Shipped change and validation

`inboxd reply off|on|status` controls the local AI service through owner-authenticated
RPC. Off persists in the daemon state directory, cancels active generation, waits
for worker termination, and prevents new automatic generations. On allows lazy
loading on a future generation. Status exposes enabled/running/PID. Opening or
requesting a new AI response while disabled returns an actionable disabled error.

Validated: 120 daemon unit tests (including blocked-generation cancellation and
persistent switch state), 10 Rust protocol integration tests, 50 CLI/protocol
TypeScript tests, TypeScript typecheck. Installed-product off/on/status and daemon
health were checked; final intended state is disabled. No messages were sent.
Account-worker optimizations above are measured proposals, not production changes.

This repository has no Beads database (`bd prime` reports no database); this file
records investigation and validation evidence, not a parallel task tracker.
