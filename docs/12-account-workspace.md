# Account-wide messaging workspace

Personal-account connections expose the provider's chat directory, message pages,
search through `account.list`, `account.messages`, and common `message.search`
local/remote/refresh modes. `account.search` remains a compatibility read path.
Returned history/search messages enter the same encrypted index used by MCP;
see [shared search](20-search-foundation.md) for paging and freshness semantics.
TUI, CLI and delegated MCP sends use the single `message.send` entrypoint. Scope-bound workers remain
available for supported replies, templates and independent receipt readback.

## Boundaries

- The TUI owns presentation, focus, drafts and result navigation. It imports only
  protocol contracts and never loads provider SDKs or credentials.
- `crates/inboxd-daemon/src/accounts.rs` owns configured account identities,
  directory caching/pagination, exact chat validation, worker lifetime and send
  request deduplication. Provider output cannot choose an account or platform.
- `crates/inboxd-daemon/src/accounts_backend/` owns provider orchestration,
  name/member/summary/history caches and their expiry/invalidation, Kakao search
  plans and history traversal, and message page splitting. Public continuation
  tokens are Rust-owned and bound to the account, operation, chat and query.
  Buffered results expire after 120 seconds and are limited to 32 entries/16 MB.
- `packages/accounts` defines the private primitive worker contract and fixed composition root.
  The daemon launches its owner-only sibling `inboxd-account-worker` with a cleared
  environment. Account credentials stay inside daemon/worker processes. Requests
  and responses have byte and time limits; raw provider errors are not sent to UI.
  A private JSON-lines worker is retained per account. Each primitive or explicit
  batch uses a FIFO worker lock; multi-page traversals release it between calls.
  At most four jobs run per account, with at most three reads to leave send capacity.
  Sends are serialized; cache generations fence reads overlapping writes or refresh. Rust can explicitly request a batch of at most eight read
  primitives. Bun dispatches that batch without its own scheduling policy or
  application cache. Broken/cancelled workers are discarded without replaying requests.
- Provider adapters live in `platforms/slack/src/account.ts`,
  `platforms/telegram/src/account.ts`, and `contrib/kakao/src/account.ts`.
  They own SDK sessions, provider API calls and provider response conversion.
  They do not own search plans, history accumulation, application cache expiry,
  public cursors or UI page sizes. Adding a provider requires a Rust backend,
  thin adapter and configuration registration; the TUI
  continues using the same read/search and common send RPCs.

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
Slack/Telegram search requests up to 100 provider results; bounded Rust pages
retain overflow in daemon memory instead of refetching it. Kakao batches up to eight
independent room-history requests into one native MCHATLOGS request. SDK-supplied
author names and CHATINFO member data are reused before requesting MEMBER.
Kakao initial chat loading follows forward pages to show the latest 30 messages,
with a 100-page bound and explicit continuation if reached.

## Direct sends

`message.send` requires a credentialed `sender` (or compatible owner approver)
handshake. TUI, CLI and the `inboxd mcp` process load the owner-only local token;
MCP does not accept credentials as tool arguments. Plain reader/agent/MCP roles
cannot send merely because a provider session is logged in. This is shared local
owner authority, not per-agent scoped grants. Replacing the token and restarting
the daemon revokes existing access. No per-message confirmation is required. The ledger transaction records the
authenticated role/session and outcome in the existing audit table without
credentials or message bodies.

Requests carry a stable `request_id` and either chat/text/optional parent or a
complete v2 envelope. Exact fixed bindings preserve supported replies, templates
and independent readback. Personal account fallback currently supports plain text
and verifies directory membership and send capability. A cold CLI/MCP send
loads only its target account directory with a bounded wait. Unsupported
reply/template requests fail explicitly. Legacy create/claim/approve and `account.send` RPCs are no longer registered; historical records remain readable and are never auto-sent.

The daemon commits a request ID reservation to SQLCipher before provider dispatch.
Repeated identical requests return stored outcomes, including after restart.
The ID binds the complete canonical envelope, including destination, reply parent,
template ID and arguments. Reusing it for different content fails. Interrupted
reservations recover as `Uncertain` without replay. Acknowledged fixed-worker
sends checkpoint `Sent` before optional readback, which may upgrade to `Verified`.
`send.status {id}` queries results; the TUI retains its last request ID during the
session and uses `s` to query it. Another Enter is blocked during dispatch.

This guarantee is request-ID scoped: a new UUID is a new send, even for identical
text. It does not establish exactly-once provider delivery. Storage failure before
reservation prevents dispatch; failure to persist an outcome returns `Uncertain`.
The encrypted ledger retains exact envelopes and outcomes without eviction.
Schema v4 adds `owner_sends` through a validated atomic v3 migration. Older binaries
reject the upgraded schema; application rollback alone does not downgrade it.

Startup displays the current directory snapshot and refreshes it in the background
when absent or older than 30 seconds. `b` explicitly requests a remote directory refresh.
The daemon subscribes to account pushes and reconciles snapshots independently of
clients; see [live synchronization](19-live-synchronization.md). Cached titles/history
are held in memory, not written to an unencrypted secondary database.

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
the TUI to avoid a display-only history reread. Compatible fixed bindings retain independent receipt verification
through the common direct-send flow.

Cache reuse and concurrency are additional improvements. Account caches are not
yet a durable encrypted history index. Push notifications invalidate workspace
snapshots; they do not claim a durable history commit.
The first full directory still performs remote work; early display is not a claim
that every account has already finished. See docs/15-startup-optimization-results.md.

### 파일 첨부

macOS TUI에서 대화를 연 뒤 `a` 또는 `Ctrl+O`로 파일 선택 창을 연다. 선택하면 파일명과 크기를 표시하며 `Enter`로 전송, `Esc`로 취소한다. 카카오톡·Slack·Telegram 개인 계정에서 파일 하나씩, 1바이트부터 100 MiB까지 지원한다. 텍스트와 파일은 각각 전송한다.

파일도 인증된 사용자 권한의 `message.send`를 사용한다. 요청에는 `request_id`, `chat`, `file: {path, name, size, sha256}`가 들어간다. 선택 시 기록한 크기와 SHA-256을 업로드 직전에 다시 확인한다. 전체 파일 식별 정보를 영속 전송 기록에 포함하므로 동일 요청 ID를 재조회해도 업로드를 반복하지 않는다. 응답 유실 시 `Uncertain`으로 남기고 `s`로 상태를 조회한다.

Slack은 외부 업로드 URL 발급·바이트 업로드·공유 완료 API를 사용한다. KakaoTalk은 기존 사용자 세션의 파일 전송을 사용하며 연결 오류 후 자동 재전송하지 않는다. Telegram은 검증한 바이트를 임시 파일에 복사해 TDLib document로 전달하고 서버 전송 완료를 기다린다. 플랫폼의 계정 권한·파일 제한은 그대로 적용된다.
