# inboxd

A local-first messaging runtime with encrypted search and authenticated direct writes.

- **Local search:** SQLCipher-encrypted message index with Korean and mixed-language search.
- **Honest results:** retrieval includes coverage and limits, distinguishing “no matches” from “not collected.”
- **Authenticated writes:** TUI, CLI and delegated MCP clients send directly through one durable path. Uncertain sends are never automatically retried.
- **Shared runtime:** a Rust core and TypeScript edges expose one daemon through CLI, MCP, and OpenTUI clients over a Unix-domain socket.

## Status

**Experimental — personal self-chat live-tested.** The packaged TUI has been
previously used with the former approval flow to connect Telegram, Slack and KakaoTalk personal accounts, read their
self-chat scopes, and send one approval-gated message per platform with matching
independent readback. This is bounded live evidence, not a guarantee of complete
history, all conversation types, or long-running session reliability.

Kakao personal account transport is separate from the measurement-gated local
reader and official template sender. It supports text sends without automatic
retry, no replies, and a bounded first page of history with explicit coverage
limits. Existing personal sessions were reused in the recorded live test; fresh
QR/phone-code authentication is a separate path.

## Build and test

The current local workflow targets macOS with Bun, Rust (see `rust-toolchain.toml`), and Homebrew SQLCipher installed.

```sh
brew install sqlcipher
bun install --frozen-lockfile
bun run build:native
bun run build:product
bun run test
bun run lint
bun run check:boundaries
cargo test --workspace --locked
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

The 100k-message benchmark is opt-in and is not run by the default test suite:

```sh
cargo test --locked --release -p inboxd-storage \
  --test performance_100k -- --ignored --nocapture
```

See the [evidence ledger](docs/07-evidence-ledger.md) for recorded validation and its limits.

## Run

`bun run install:local` installs the packaged application. Run `inboxd` for the
TUI; first run opens the account connection flow. macOS may ask to allow
`inboxd-daemon` to read its SQLCipher key from Keychain, including after a daemon
binary rebuild. Complete that prompt locally; never paste the key or Mac password
into Inboxd or chat. To add or reconnect accounts,
press `5` (Doctor), then `C`, or run:

```sh
inboxd connect
inboxd connect telegram
inboxd connect slack
inboxd connect kakao
```

- Telegram: scan the QR in the opened browser with Telegram → Settings → Devices.
  An already authenticated session resumes without another scan.
- Slack: select a logged-in workspace and a conversation by name. No token or
  channel ID entry. Missing/expired sessions use the installed `agent-messenger`
  login importer, which may request macOS Keychain access.
- KakaoTalk: resume the personal session, or follow the installed
  `agent-messenger` secondary-device login and phone-code prompt. Choose a chat
  by name; the default first choice is the self chat. Device replacement is never
  forced by Inboxd.

The developer installer supplies Telegram application credentials from local
configuration. Users do not register Slack/Kakao developer apps. The fallback
Slack/Kakao login helper currently requires `agent-messenger` on PATH.

Connections are saved one at a time in owner-only configuration; a successful
change restarts the daemon. Cancelling an unchanged connection menu keeps the
current daemon. The owner TUI sends personal-account messages directly with Enter;
delegated MCP/agent clients use the same direct-send path. `inboxd mcp` starts
the MCP stdio server with local owner authority. See the
[current send contract](docs/12-account-workspace.md#direct-sends).

The sidebar discovers every chat returned by connected Telegram, Slack and
KakaoTalk accounts and sorts them by latest message time, using provider titles
and sender names. `/` or Ctrl+F opens message search across the selected messenger
filter; Enter on a hit returns to its conversation and highlights the message.
Ctrl+K finds a conversation by name. Tab cycles filters, rooms and messages;
left/right selects a messenger while filters are focused. Enter opens a chat,
Enter again starts composing, and Enter sends. Shift+Enter inserts a newline.
`b` refreshes chats and messages; `n` continues paginated results. `d` and `5`
show details and connections. See [workspace design](docs/11-tui-workspace.md)
and [account adapters](docs/12-account-workspace.md).

Normal data subcommands do not auto-start the daemon. `inboxd daemon start`
launches it explicitly. See [connection architecture](docs/10-connection-architecture.md)
and [daemon startup contract](docs/06-architecture.md).

## Safety boundaries

A transport acknowledgement means **Sent**, not **Verified**. Verification requires independent matching read-back evidence. Interrupted or ambiguous sends remain **Uncertain**, without automatic retries.

Sending requires an authenticated local owner credential. There is no per-message
approval. Request IDs and encrypted send records survive daemon restarts;
`send.status` recovers outcomes without retransmission. These controls do not
protect against a process with the same user's unrestricted shell, file, or Keychain access.

## Documentation

- [Interactive architecture map (HTML)](docs/visuals/inboxd-architecture.html)

- [Product and safety contract](docs/03-proposal.md)
- [Roadmap and remaining live gates](docs/04-roadmap.md)
- [Architecture](docs/06-architecture.md)
- [Evidence and limitations](docs/07-evidence-ledger.md)

## License

[MIT](LICENSE). Third-party dependencies retain their respective licenses.
