import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { applySyncBatch } from "../src/apply.ts";
import { getMessage, searchMessages } from "../src/queries.ts";
import { createStoreFixture, event, type StoreFixture } from "./fixtures/store-fixture.ts";

interface SearchCorpus {
  messages: { id: string; body: string }[];
  positive_cases: { name: string; query: string; expected_ids: string[] }[];
  negative_cases: { name: string; query: string }[];
}
const corpus: SearchCorpus = JSON.parse(readFileSync(new URL("../../../fixtures/ko-search/acceptance.json", import.meta.url), "utf8"));
const interval = { from_ts: 0, to_ts: 200 };

describe("Korean hybrid search on the encrypted production store", () => {
  const fixtures: StoreFixture[] = [];
  const fixture = () => { const value = createStoreFixture(); fixtures.push(value); return value; };
  afterEach(() => fixtures.splice(0).forEach((value) => value.dispose()));

  test("keeps exactly 25 positive cases and explicit negative cases with valid expected IDs", () => {
    expect(corpus.positive_cases).toHaveLength(25);
    expect(corpus.negative_cases).toHaveLength(8);
    const ids = new Set(corpus.messages.map((message) => message.id));
    expect(ids.size).toBe(corpus.messages.length);
    expect(new Set([...corpus.positive_cases, ...corpus.negative_cases].map((item) => item.name)).size).toBe(33);
    for (const item of corpus.positive_cases) {
      expect(item.expected_ids.length).toBeGreaterThan(0);
      for (const id of item.expected_ids) expect(ids.has(id)).toBe(true);
    }
  });

  for (const item of corpus.positive_cases) {
    test(`retrieves exact IDs: ${item.name} (${item.query})`, () => {
      const value = fixture();
      applySyncBatch(value.database, { events: corpus.messages.map((message) => event(value.chat, "create", 1, message.id, message.body)) });
      const result = searchMessages(value.database, { chat: value.chat, interval, query: item.query });
      expect(result.messages.map((message) => message.msg_id).sort()).toEqual([...item.expected_ids].sort());
      expect(result.next_cursor).toBeUndefined();
      // A matching body proves nothing about collection or mutation coverage.
      expect(result.coverage.gaps).toEqual([{ interval, reason: "unknown" }]);
    });
  }

  for (const item of corpus.negative_cases) {
    test(`does not interpret query syntax: ${item.name}`, () => {
      const value = fixture();
      applySyncBatch(value.database, { events: corpus.messages.map((message) => event(value.chat, "create", 1, message.id, message.body)) });
      const result = searchMessages(value.database, { chat: value.chat, interval, query: item.query });
      expect(result.messages).toEqual([]);
      expect(result.next_cursor).toBeUndefined();
      expect(result.coverage.gaps).toEqual([{ interval, reason: "unknown" }]);
    });
  }

  test("rejects empty and over-limit Unicode queries rather than returning arbitrary hits", () => {
    const value = fixture();
    for (const query of ["", "가".repeat(1_025), "😀".repeat(1_025)]) {
      expect(() => searchMessages(value.database, { chat: value.chat, interval, query })).toThrow("query");
    }
  });

  test("isolates both LIKE and FTS hits by platform, account, chat, and half-open time bounds", () => {
    const value = fixture();
    const body = "회의록 안녕";
    const outsideChats = [
      { ...value.chat, platform: "other-platform" },
      { ...value.chat, account: "other-account" },
      { ...value.chat, chat_id: "other-chat" },
    ];
    applySyncBatch(value.database, { events: [
      event(value.chat, "create", 1, "inside", body),
      ...outsideChats.map((chat) => event(chat, "create", 1, "inside", body)),
      ...[99, 200].map((ts) => ({
        kind: "create", revision: { source: "adapter", value: 1 },
        message: { key: { ...value.chat, msg_id: `outside-${ts}` }, author_id: "person-1", ts, body, attachments: [] },
      })),
    ] });
    for (const query of ["안녕", "회의록"]) {
      const result = searchMessages(value.database, { chat: value.chat, interval: { from_ts: 100, to_ts: 200 }, query });
      expect(result.messages.map((message) => ({ platform: message.platform, account: message.account, chat_id: message.chat_id, msg_id: message.msg_id })))
        .toEqual([{ ...value.chat, msg_id: "inside" }]);
    }
  });

  test("edits and tombstones immediately refresh LIKE and FTS without stale replay resurrection", () => {
    const value = fixture();
    const ids = (query: string) => searchMessages(value.database, { chat: value.chat, interval, query }).messages.map((message) => message.msg_id);
    applySyncBatch(value.database, { events: [event(value.chat, "create", 1, "mutable", "이전안건 초안")] });
    for (const query of ["초안", "이전안건"]) expect(ids(query)).toEqual(["mutable"]);

    applySyncBatch(value.database, { events: [event(value.chat, "edit", 2, "mutable", "변경안건 확정")] });
    for (const query of ["초안", "이전안건"]) expect(ids(query)).toEqual([]);
    for (const query of ["확정", "변경안건"]) expect(ids(query)).toEqual(["mutable"]);

    applySyncBatch(value.database, { events: [event(value.chat, "delete", 3, "mutable")] });
    applySyncBatch(value.database, { events: [
      event(value.chat, "create", 1, "mutable", "이전안건 초안"),
      event(value.chat, "edit", 2, "mutable", "변경안건 확정"),
    ] });
    for (const query of ["초안", "이전안건", "확정", "변경안건"]) expect(ids(query)).toEqual([]);
    expect(getMessage(value.database, { ...value.chat, msg_id: "mutable" })).toMatchObject({ body: null, deleted_at: 102, revision: 3 });
  });
});
