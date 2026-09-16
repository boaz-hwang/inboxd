# Spike 0 — SQLCipher bootstrap

This spike proves Bun can load Homebrew SQLCipher before any `bun:sqlite` database is opened and that the store refuses every plaintext fallback path.

## Run

```sh
SQLCIPHER_PATH="$(brew --prefix sqlcipher)/lib/libsqlcipher.dylib" bun run spikes/0-encryption/run.ts
```

The runner writes `manifest.json`, validated by `manifest.schema.json`. The manifest records boolean outcomes and the SQLCipher version only; it never records keys, credentials, or message bodies.

## Acceptance checks

- SQLCipher reports a non-empty `cipher_version`.
- Encrypted data and FTS reopen using the same injected ephemeral key.
- Existing databases reject missing and wrong keys before schema access.
- A plain Bun SQLite child process cannot read the encrypted schema.
- WAL is enabled and its `-wal` path is observed while the connection remains open.
- A `SQLite format 3` header is rejected before opening.
- Unset and invalid `SQLCIPHER_PATH` fail in fresh child processes, with no fallback SQLite.
