import { afterEach, describe, expect, test } from "bun:test";

import { applySyncBatch } from "../src/apply.ts";
import { searchMessages } from "../src/queries.ts";
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
});
