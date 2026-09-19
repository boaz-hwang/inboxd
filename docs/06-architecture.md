# 06 — Architecture: Rust core / TypeScript edge (2026-09-17)

This preserves the 2026-09-17 architecture checkpoint; its Bun-host topology,
schema version and validation counts are historical. For the current Rust daemon
and account workspace, see [account architecture](12-account-workspace.md) and
[Rust account backends](16-rust-account-backends.md). In particular, the encrypted
store is now schema v4 with a durable owner-send ledger. Offline evidence below
does not claim that live provider access was exercised by the current refactor.

## 1. Process, startup, and ownership

```text
owner-only config + trusted host binding registry
                    │ explicit start
                    ▼
inboxd daemon ─── Unix-domain socket ─── CLI / OpenTUI / MCP
  owns SQLCipher write connection, migration, sync, safety/outbox, audit
  TS adapters/host I/O ─ Rust domain/store/safety functional core
```

- There is one daemon per state directory. It alone opens the production encrypted store and owns sync, external-reader composition, safety execution, credentials and audit. Clients remain protocol-only.
- Start explicitly: `inboxd-daemon --config <owner-only-config.json>` (or `bun run daemon -- --config <...>`). The CLI does not start the daemon; it connects to the UDS and exits as a normal subprocess.
- The lock is not `flock`: `state_dir/inboxd.lock` is created with exclusive `wx`/0600, stores PID and creation time, checks owner liveness, and only reclaims a stale lock. Socket cleanup happens while that lock is owned.
- State directory/config/socket are owner-only. Config loading rejects symlink, non-regular file, non-current-user ownership, group/other permissions, non-absolute paths, and database/socket paths outside the direct state directory.
- Client role is insufficient for approval. A claimed `approver` role must also satisfy trusted local approver-session authorization; default is deny. MCP is an agent client and never receives approval codes. Raw codes are one-shot owner-TUI memory only; durable approvals store a verifier, pending-list and CLI remain code-free, CLI argv approval is rejected, and restart/lost delivery expires the orphan for re-proposal.

## 2. Reader composition and honest diagnostics

The config declares only exact stable Slack/Kakao account/chat scopes and a binding identifier. Each binding is resolved from a **trusted, injected process-local registry**, not from config values. This makes pre-I/O allowlisting possible and blocks arbitrary module/credential discovery. It also means a shipped config cannot itself construct a live Slack/Kakao client: a host embedding/launcher must intentionally inject the trusted binding registry. Missing/invalid bindings fail before reader factory, encrypted store or external I/O.

Configured chats are inserted only as discoverable scopes. They are **configured-uncollected**, not authenticated or collected. Queries return their interval as `unknown` coverage until a sync transaction records evidence.

`system.status`, `auth.status`, `sync.status` and Doctor report actual values: configured platforms, owner-only UDS endpoint, SQLCipher diagnosis, authenticated/unknown adapter status, active/cooldown/failed/retry_due/success job state, retry time, `send_capable`, and the same-user shell/file/Keychain boundary warning. There is no constant “healthy” diagnostic path.

## 3. Schema v3 and atomic sync

The encrypted schema v3 retains messages/FTS/chats, sync state, coverage/limits, intents/approvals/sends/quota/audit and adds:

| Table | Purpose |
|---|---|
| `account_self` | Authenticated adapter evidence for account→self identity. Unknown/unsupported is durable and never inferred from a display name. |
| `unread_evidence` | Source-qualified unread state; unknown is distinct from zero. |
| `sync_page_sequence` | Per-chat page sequence CAS guarding stale/out-of-order sync pages. |

`applySyncBatch` is the only production batch-apply path. It validates all present collections before transaction start and atomically commits events, FTS changes, sync cursor, coverage/limits, identity, unread evidence, and page sequence. A stale page cannot advance any of those records. Message key is `(platform, account, chat_id, msg_id)`; genuine revision ordering is idempotent and tombstones cannot resurrect. Revisionless observations replace only live rows after same-chat serialization; partial absence does not mean delete.

## 4. Read protocol

All clients share JSON-lines UDS methods. In addition to chat/search/inbox methods, the current public surface includes:

```text
message.recent(chats[], interval, sender?, limit?, cursor?)
  → messages, coverage, identities, unread, next_cursor?
message.evidence(chats[], interval, sender?, limit?, cursor?)
  → source-linked evidence packet and the same scope/coverage contract
```

Both use explicit selected scopes, half-open intervals, deterministic composite ordering and scope-bound cursors. A client cannot widen a cursor from one selected scope to another. `sender=self` matches only an authenticated `account_self` record. Slack can supply this contract when adapter evidence exists; Kakao self identity is currently unsupported and therefore returns/retains unknown rather than a guessed self filter.

Coverage remains an interval evidence model: `covered`, `gaps`, `freshness`, `limits`, `verified_empty`, and absent evidence are separate. A message min/max range, configured scope, connection, or source fixture does not prove complete history.

## 5. Outbox and receipt semantics

```text
Proposed → Approved → Sending → Sent → Verified
                         ↘ Failed / Uncertain
Proposed / Approved → Expired
```

- Durable claim rechecks bound approval, expiry, current allowlist and both quotas; it atomically reserves quota before network I/O.
- A transport success with a nonempty receipt produces **`Sent`**, not `Verified`.
- `Verified` requires a separate trusted receipt-reader operation to read the destination and prove exact scope, receipt, body, and `parent_id`/thread binding. Sender-provided or protocol-caller assertions are insufficient.
- A missing/read-failed receipt reader leaves `Sent` intact. Crash, timeout or ambiguous outcome is `Uncertain`; restart converts residual `Sending` to `Uncertain`; neither gets automatic resend.
- `sync.backfill` requires the independently authenticated owner/approver session before adapter invocation, so reader/agent/MCP callers cannot replace or churn an unfinished Slack job. Each UDS connection also owns its streaming `TextDecoder`, preventing split multibyte state from crossing connections.
- Proven pre-send failure is `Failed` and releases reservation. **`Sent`, `Verified`, and `Uncertain` retain global and scope quota consumption.**
- A send-capable daemon requires an explicitly injected transport, canonical platform `slack`, positive finite per-scope and global quotas, and an explicit allow policy. Kakao is not a normal compose/send platform.

The offline O3 gate includes SIGKILL child-process windows after durable claim and after fake remote success, plus independent exact receipt/body/thread read-back. That demonstrates the state contract with injected local transport; it is not a live outbound send.

## 6. Client surfaces

CLI, MCP, and OpenTUI use UDS only. CLI’s executable path has an observed clean subprocess exit and rejects code-bearing approval argv. MCP exposes read/propose paths without approval-code access. OpenTUI renders coverage/unread truthfully and keeps capability, Sent, Verified and Uncertain distinct; 62 deterministic captures plus a source/capture hash manifest are current offline evidence. Client packages must not import the store, platform adapters or daemon implementation. MCP handler/UDS integration is observed; an external MCP stdio-client round trip is not.

## 7. Observed gates and unobserved gates

The current working tree observed Bun 379 pass / one deliberate opt-in performance skip / zero fail, Rust 4 pass, typecheck, boundaries, Clippy, fmt and diff hygiene. The enabled O5 acceptance used encrypted production `applySyncBatch` for 100,000 anonymous messages (9982.744 ms) and real UDS search with 700 samples (p50 29.346125 ms, p95 72.681875 ms, worst per-query p95 75.873917 ms ≤300). It includes 25 positive and 8 negative Korean/mixed-language cases.

These are offline gates. They do not rerun Slack/Kakao account reads, historical five-question retrieval classification, or any live send. Fresh user authorization is required for L0; V0 must still be independently re-reviewed; no D0 commit exists.
## Stable macOS Keychain access

The database key remains in the login Keychain. `inboxd-keychain` is an independent
Rust executable with no daemon, protocol, UI or provider dependency. Only this
helper accesses Security.framework. Ordinary daemon startup validates the
owner-only helper executable and receives the existing key through a private
pipe, held in zeroizing buffers. Neither a Mac login password nor the database
key is saved in a new plaintext cache or passed in process arguments.

The helper's `get` operation disables Keychain user interaction: normal startup
cannot repeatedly open password dialogs. A locked or unauthorized item produces
an actionable failure instead. The existing explicit `--init-keychain` command
delegates to the helper's `ensure` operation, allowing initial authorization or
creation. Existing installations must grant the helper **Always Allow** once.
Ordinary TUI/daemon/provider updates preserve the helper's code identity. Changing
the helper itself, locking the login Keychain or revoking its access can require
new authorization; this does not bypass macOS access controls.

The packaged artifact test rebuilds twice and checks the helper hash remains
identical, validates its permissions, and exercises a noninteractive missing-item
read. Native tests validate labels and returned key material. Code identity and
Keychain access requirements follow Apple's [code signing model](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/AboutCS/AboutCS.html).
