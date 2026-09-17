# inboxd

A local-first messaging runtime with encrypted search and approval-gated writes.

- **Local search:** SQLCipher-encrypted message index with Korean and mixed-language search.
- **Honest results:** retrieval includes coverage and limits, distinguishing “no matches” from “not collected.”
- **Human-controlled writes:** agents propose; a trusted local operator approves. Uncertain sends are never automatically retried.
- **Shared runtime:** a Rust core and TypeScript edges expose one daemon through CLI, MCP, and OpenTUI clients over a Unix-domain socket.

## Status

**Experimental — offline-ready, live-blocked.** Local integration tests exercise the encrypted store, real daemon socket, CLI/MCP/TUI flows, and crash recovery. They do not establish current live-account reliability.

Slack has bounded read adapters; Kakao read support is experimental and measurement-gated. Normal Kakao sending is unsupported. Fresh live reads and a separately approved Slack send remain pending. This is a developer build, not a turnkey multi-messenger app.

## Build and test

The current local workflow targets macOS with Bun, Rust (see `rust-toolchain.toml`), and Homebrew SQLCipher installed.

```sh
brew install sqlcipher
bun install --frozen-lockfile
bun run build:native
bun run test
bun run lint
bun run check:boundaries
cargo test --workspace --locked
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

The 100k-message benchmark is opt-in and is not run by the default test suite:

```sh
INBOXD_RUN_100K_ACCEPTANCE=1 NODE_ENV=test \
SQLCIPHER_PATH="$(brew --prefix sqlcipher)/lib/libsqlcipher.dylib" \
bun test packages/store/test/performance-100k.test.ts
```

See the [evidence ledger](docs/07-evidence-ledger.md) for recorded validation and its limits.

## Run

Clients do not auto-start the daemon. Startup requires an owner-only JSON configuration with absolute state, database, and socket paths. Live readers additionally require explicit allowlisted scopes and trusted host bindings; configuration does not discover credentials automatically. See the [architecture and startup contract](docs/06-architecture.md) and [launcher implementation](packages/daemon/src/launcher.ts).

```sh
chmod 600 /absolute/path/inboxd-config.json
bun run daemon -- --config /absolute/path/inboxd-config.json
```

## Safety boundaries

A transport acknowledgement means **Sent**, not **Verified**. Verification requires independent matching read-back evidence. Interrupted or ambiguous sends remain **Uncertain**, without automatic retries.

Approval codes are ephemeral and unavailable to MCP/agent clients. These controls do not protect against an agent with the same user's unrestricted shell, file, or Keychain access.

## Documentation

- [Product and safety contract](docs/03-proposal.md)
- [Roadmap and remaining live gates](docs/04-roadmap.md)
- [Architecture](docs/06-architecture.md)
- [Evidence and limitations](docs/07-evidence-ledger.md)

## License

[MIT](LICENSE). Third-party dependencies retain their respective licenses.
