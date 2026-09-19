# Private account primitives

`primitives.json` is the source of truth for the daemon-to-provider contract. It describes 25 operations, their individual request/result shapes, and the vendor fields the Rust policies consume. `bun scripts/generate-account-contract.ts` generates Rust serde models and TS discriminated types; `--check` verifies both checked-in outputs, including Rust formatting. Generation requires Bun and the Rust toolchain.

The wire format stays the existing JSON-lines envelope. Product builds package the daemon and provider worker together; this change does not add a version negotiation protocol or support independently updating workers.

Requests reject unknown operations, unknown fields, missing required values, invalid enums, unbounded/unsafe integers, nested batches, write batches, and batches over eight operations. Batch validation finishes before any member starts. Rust also checks the configured account platform. The TS worker validates before creating an SDK session. SDK outputs are explicitly `unknown` until validated; `dispatch` exposes the operation-specific result to typed callers, while `dispatchWire` accepts untrusted input.

Results tolerate additional vendor fields, but required arrays/objects and the types of every declared field are checked recursively. Optional response fields accept omission or null; that expresses absence, not a fabricated empty array or a claim of completion. Receipts and declared message/chat IDs must be nonempty. TS and Rust consume the same malformed/additive fixture matrix. Rust uses shape validation before serde because serde can otherwise deserialize some arrays as structs.

The backends still use `serde_json::Value` for internal aggregation/cache policy. They receive validated operation-specific results at the production transport boundary; this change does not relocate provider pagination, fallback, cache, or send semantics to TypeScript. Logical identity checks (for example, a returned Kakao page must belong to the requested chat) remain in the backend.

`parity-fixtures.json` is read by both Rust and Bun tests. Add accepted and rejected wire examples when changing a schema; add realistic adapter fixtures for behavior that needs SDK normalization. A new optional vendor field generally requires no change here unless a policy begins reading it. A change to a consumed field must update the schema, generated declarations, and fixtures together.
