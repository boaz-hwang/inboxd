import { afterEach, describe, expect, test } from "bun:test";

import { applySyncBatch } from "../src/apply.ts";
import { inboxMessages, searchMessages } from "../src/queries.ts";
import { createStoreFixture, event, type StoreFixture } from "./fixtures/store-fixture.ts";

describe("message queries with evidence", () => {
  const fixtures: StoreFixture[] = [];
  const fixture = () => { const value = createStoreFixture(); fixtures.push(value); return value; };
  afterEach(() => fixtures.splice(0).forEach((value) => value.dispose()));

  test("returns coverage even when a query has zero hits", () => {
    const value = fixture();
    applySyncBatch(value.database, { coverage: [{ chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, kind: "verified_empty", collected_at: 4, mutations_verified_at: null }] });

    const result = searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "absent" });
    expect(result.messages).toEqual([]);
    expect(result.coverage.covered).toHaveLength(1);
    expect(result.coverage.gaps).toEqual([]);
  });

  test("uses half-open timestamp bounds while returning evidence", () => {
    const value = fixture();
    applySyncBatch(value.database, { events: [event(value.chat, "create", 1, "left", "at lower"), { ...event(value.chat, "create", 1, "right", "at upper"), message: { ...event(value.chat, "create", 1, "right", "at upper").message, ts: 200 } }] });

    const result = searchMessages(value.database, { chat: value.chat, interval: { from_ts: 100, to_ts: 200 }, query: "at" });
    expect(result.messages.map((message) => message.msg_id)).toEqual(["left"]);
    expect(result.coverage.gaps).toEqual([{ interval: { from_ts: 100, to_ts: 200 }, reason: "unknown" }]);
  });

  test("paginates inbox with an opaque cursor without repeating equal-timestamp messages", () => {
    const value = fixture();
    applySyncBatch(value.database, { events: [
      event(value.chat, "create", 1, "a", "first"),
      event(value.chat, "create", 1, "b", "second"),
      { ...event(value.chat, "create", 1, "c", "third"), message: { ...event(value.chat, "create", 1, "c", "third").message, ts: 101 } },
    ] });

    const first = inboxMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, limit: 2 });
    expect(first.messages.map((message) => message.msg_id)).toEqual(["a", "b"]);
    // Frozen from the pre-Rust TypeScript implementation: existing clients can
    // resume an in-flight page across the core upgrade.
    expect(first.next_cursor).toBe("eyJ2IjoxLCJzY29wZSI6IntcImNoYXRcIjp7XCJwbGF0Zm9ybVwiOlwidGVzdC1wbGF0Zm9ybVwiLFwiYWNjb3VudFwiOlwiYWNjb3VudC0xXCIsXCJjaGF0X2lkXCI6XCJjaGF0LTFcIn0sXCJpbnRlcnZhbFwiOntcImZyb21fdHNcIjowLFwidG9fdHNcIjoyMDB9fSIsInRzIjoxMDAsIm1zZ19pZCI6ImIifQ");

    const second = inboxMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, limit: 2, cursor: first.next_cursor });
    expect(second.messages.map((message) => message.msg_id)).toEqual(["c"]);
    expect(second.next_cursor).toBeUndefined();
  });

  test("paginates search, validates page bounds, and rejects cursors for another query", () => {
    const value = fixture();
    applySyncBatch(value.database, { events: [
      event(value.chat, "create", 1, "a", "needle first"),
      event(value.chat, "create", 1, "b", "needle second"),
      { ...event(value.chat, "create", 1, "c", "needle third"), message: { ...event(value.chat, "create", 1, "c", "needle third").message, ts: 101 } },
    ] });

    const first = searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "needle", limit: 2 });
    expect(first.messages.map((message) => message.msg_id)).toEqual(["a", "b"]);
    expect(first.next_cursor).toEqual(expect.any(String));
    expect(searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "needle", limit: 2, cursor: first.next_cursor }).messages.map((message) => message.msg_id)).toEqual(["c"]);
    expect(() => searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "different", cursor: first.next_cursor! })).toThrow("cursor");
    expect(() => searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "needle", limit: 101 })).toThrow("limit");
    expect(() => searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "x".repeat(1_025) })).toThrow("query");
  });
});
