import { afterEach, describe, expect, test } from "bun:test";

import { applySyncBatch } from "../src/apply.ts";
import { searchMessages } from "../src/queries.ts";
import { createStoreFixture, event, type StoreFixture } from "./fixtures/store-fixture.ts";

describe("Korean hybrid search", () => {
  const fixtures: StoreFixture[] = [];
  const fixture = () => { const value = createStoreFixture(); fixtures.push(value); return value; };
  afterEach(() => fixtures.splice(0).forEach((value) => value.dispose()));

  test("uses escaped LIKE for short code-point queries", () => {
    const value = fixture();
    applySyncBatch(value.database, { events: [event(value.chat, "create", 1, "literal", "100%_안녕"), event(value.chat, "create", 1, "other", "100xX안녕")] });

    expect(searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "%_" }).messages.map((message) => message.msg_id)).toEqual(["literal"]);
  });

  test("retrieves Korean queries of at least three Unicode code points through FTS", () => {
    const value = fixture();
    applySyncBatch(value.database, { events: [event(value.chat, "create", 1, "ko", "회의 일정 확인"), event(value.chat, "create", 1, "other", "무관한 대화")] });

    expect(searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "일정 확" }).messages.map((message) => message.msg_id)).toEqual(["ko"]);
  });
});
