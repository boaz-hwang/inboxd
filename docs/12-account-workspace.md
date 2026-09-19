# Account-wide messaging workspace

Personal-account connections expose the provider's chat directory, message pages,
search and owner-TUI sends through four additive RPC methods: `account.list`,
`account.messages`, `account.search`, `account.send`. Existing scope-bound workers
and the agent approval protocol remain available for their original consumers.

## Boundaries

- The TUI owns presentation, focus, drafts and result navigation. It imports only
  protocol contracts and never loads provider SDKs or credentials.
- `crates/inboxd-daemon/src/accounts.rs` owns configured account identities,
  directory caching/pagination, exact chat validation, worker lifetime and send
  request deduplication. Provider output cannot choose an account or platform.
- `packages/accounts` defines the worker contract and fixed composition root.
  The daemon launches its owner-only sibling `inboxd-account-worker` with a cleared
  environment. Account credentials stay inside daemon/worker processes. Requests
  and responses have byte and time limits; raw provider errors are not sent to UI.
  A private JSON-lines worker is retained per account; operations for that account
  stay serialized. Broken/cancelled workers are discarded without replaying requests.
- Provider adapters live in `platforms/slack/src/account.ts`,
  `platforms/telegram/src/account.ts`, and `contrib/kakao/src/account.ts`.
  They normalize remote titles, sender names, timestamps and message identifiers.
  Adding a provider requires an adapter plus configuration registration; the TUI
  continues using the same four RPCs.

## Directory and search

Each immutable directory snapshot is paged consistently. Startup reads snapshots
without waiting for remote work; completed accounts appear while other accounts
continue loading. Snapshot reads do not acquire the remote-operation mutex.
The daemon sorts by latest message timestamp; the TUI preserves this ordering
through messenger filtering. Telegram includes main and archived chat lists;
Slack includes joined public/private channels and direct/group conversations;
KakaoTalk uses the complete SDK login directory and resolved titles.

Telegram and Slack use provider search. KakaoTalk has no equivalent exposed by
this SDK, so it scans paginated server-retained history, resolving the actual
senders by ID rather than requiring a stable full membership snapshot. Search
results are deduplicated by platform, account, chat and message ID. The TUI shows
results progressively, searches accounts concurrently, follows up to 25 RPC pages per account, and
leaves an `n` continuation when more remain. New queries/cancellation invalidate
old responses. Selecting a hit loads its chat context and focuses the exact ID.
Provider retention limits still apply; this is not a local-device history index.
Slack/Telegram search requests up to 100 provider results; bounded worker pages
retain overflow locally instead of refetching it. Kakao batches up to eight
independent room-history requests into one native MCHATLOGS request. SDK-supplied
author names and CHATINFO member data are reused before requesting MEMBER.
Kakao initial chat loading follows forward pages to show the latest 30 messages,
with a 100-page bound and explicit continuation if reached.

## Direct sends

`account.send` requires the authenticated owner approver handshake, including its
local token; reader, agent and MCP roles cannot invoke it. The owner TUI sends
immediately on Enter without requesting a code. Requests are restricted to chats
in that exact configured account's discovered directory, with send permission.
The TUI prevents another Enter during dispatch. The daemon reserves a request ID
before calling the provider and returns the same outcome for a repeated identical
request. Reusing that ID for different content is rejected. This deduplication is
in memory for the current daemon lifetime; there is no automatic replay on restart.

Provider acknowledgement is `Sent`, not independent delivery verification.
Timeouts or ambiguous failures return `Uncertain` and are never retried. Agent
proposals continue through the existing approval lifecycle. The new owner flow
is separate and does not manufacture or auto-submit an approval code.

Startup displays the current directory snapshot and refreshes it in the background
when absent or older than 30 seconds. `b` explicitly requests a remote directory refresh. Remote account-wide push
subscriptions are not implemented. Cached titles/history are held in memory, not
written to an unencrypted secondary database.

## Call reduction before caching

Fresh Slack directory reads use bulk users.list plus individual missing users.
For the measured account this reduces 42 calls to 29. client.counts is deferred
until subsequent refreshes so it adds no first-load request. Its invalidation
watermark is a string in the measured personal-session API; unknown shapes and
missing conversations fall back to history reads.

Fresh Kakao directory reads use each CHATINFO response for both title and the
SDK member-name mapping. MemoChat detail supplies the same own-name value as the
previous four-call member snapshot, avoiding that extra snapshot (54→50 calls).
Eight independent fresh room pages were compared with one batch: identical pages.
Transmissions use one send operation; the acknowledged message is returned to
the TUI to avoid a display-only history reread. Independent receipt verification
in the original approval flow is unchanged.

Cache reuse and concurrency are additional improvements. Account caches are not
yet a durable encrypted history index, and no new RTM/push subscription is enabled.
The first full directory still performs remote work; early display is not a claim
that every account has already finished. See docs/15-startup-optimization-results.md.
