# Kakao original Spike B: privacy-safe measurement harness

This directory is an **offline, no-send harness** for documenting the boundaries that any later Kakao DB/KDF/schema or accessibility (AX) measurement work must satisfy. It deliberately does not implement a Kakao client, database reader, KDF derivation, credential lookup, accessibility inspection, screenshot capture, path discovery, or message transmission.

## Default behavior

All entry points are safe without inputs:

```sh
bun run spikes/B/probe.ts
bun run spikes/B/db-measure.ts --help
bun run spikes/B/ax-measure.ts --help
```

`probe.ts` returns a JSON manifest with:

- `status: "BLOCKED"` and `observation: "not_observed"`
- `send: false` (fixed by schema and validator)
- an empty stable-chat allowlist
- explicit redaction declarations for bodies, secrets, and paths
- synthetic-only measurement records

The schema (`manifest.schema.json`) disallows unrecognised top-level fields and fixes the safety-critical fields. The runtime validator additionally rejects body, secret, and path-like field names before a manifest can be accepted.

## Future live work is not implemented

`requireStablePreIoAllowlist` in `db-measure.ts` models the required gate for a future **read-only** callback. It refuses before invoking that callback unless both conditions are met:

1. an explicit authorization flag is true; and
2. a non-empty allowlist contains only stable opaque identifiers in the `stable:<opaque-id>` form.

This repository supplies no code path that invokes the callback for a Kakao database or AX tree. Do not add one without a separate, explicit authorization and privacy review. Never log, serialize, fixture, or commit raw message bodies, credentials, tokens, database locations, screenshots, accessibility trees, or user identifiers.

## Tests

```sh
bun test spikes/B/test
```

The tests cover required manifest fields, fixed `send: false`, recursive redaction of body/secret/path values, rejection of raw body/secret manifest fields, default AX blocking, and refusal before I/O when no stable pre-I/O allowlist exists.

## agent-messenger 2.37.1 session-resume investigation

The live wrapper investigation remains separate from the original DB/KDF/schema/AX Spike B. It found a local wrapper defect: the Kakao client persisted LOGINLIST checkpoints but not a restorable complete chat snapshot, so a fresh process could treat an empty or partial incremental LOGINLIST response as the complete list and query LCHATLIST from the latest cursor.

`patches/agent-messenger-2.37.1-kakao-chat-bootstrap.patch` is an upstream-style patch generated against the published 2.37.1 tarball. It:

- adds isolated RED regressions for empty and partial incremental responses across fresh clients;
- marks a client loaded from persisted sync state as requiring a full chat-list bootstrap;
- starts only that bootstrap's first LCHATLIST page at zero and preserves real continuation cursors;
- isolates client tests from the user's real config directory.

Observed local verification: 151/151 Kakao client tests, targeted lint with zero findings, TypeScript typecheck, and package build pass.

The corrected runtime was then observed in two independent authenticated processes. Each returned 49 chats, 49 unique chats, exactly one MemoChat, and the same privacy-safe aggregate digest. A bounded MemoChat read was connected through the exact-bound contrib reader, sync, encrypted store, daemon, CLI, TUI, and MCP. These observations validate the wrapper transport path only; they do not establish the original local DB KDF/schema or AX route.

After the read and retrieval gates, one separately approved self-chat payload was sent through inboxd's propose → trusted local TTY approve → execute boundary. The transport was called exactly once, and the returned receipt and exact body were read back. No approval code, credential, raw identifier, timestamp, or message body is retained here. This controlled send does not change this Spike B harness's default `send: false` contract and does not add a default live sender to the repository.
