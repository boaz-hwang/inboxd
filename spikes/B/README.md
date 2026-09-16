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
