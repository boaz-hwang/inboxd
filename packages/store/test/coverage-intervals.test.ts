import { afterEach, describe, expect, test } from "bun:test";

import { applySyncBatch, readSyncState } from "../src/apply.ts";
import { coverageFor } from "../src/coverage.ts";
import { searchMessages, recentMessages } from "../src/queries.ts";
import { createStoreFixture, event, type StoreFixture } from "./fixtures/store-fixture.ts";

const segment = (chat: StoreFixture["chat"], from_ts: number, to_ts: number, collected_at: number, kind: "backfill" | "watch" | "verified_empty" = "backfill") => ({ chat, interval: { from_ts, to_ts }, kind, collected_at, mutations_verified_at: kind === "watch" ? collected_at + 1 : null });

describe("persisted coverage intervals", () => {
  const fixtures: StoreFixture[] = [];
  const fixture = () => { const value = createStoreFixture(); fixtures.push(value); return value; };
  afterEach(() => fixtures.splice(0).forEach((value) => value.dispose()));



  test("committed page sequence rejects stale replay including identical cursor values", () => {
    const value = fixture();
    const batch = (expected_page_sequence: number, count: number) => ({
      expected_page_sequence,
      sync: { chat: value.chat, cursor: "same-provider-position", updated_at: 100 },
      identity: { platform: value.chat.platform, account: value.chat.account, status: "known" as const, source: "authenticated_adapter" as const, self_id: `self-${count}`, observed_at: 100 },
      unread: { chat: value.chat, status: "known" as const, source: "platform" as const, count, observed_at: 100 },
    });
    applySyncBatch(value.database, batch(0, 1));
    applySyncBatch(value.database, batch(1, 2));
    const before = recentMessages(value.database, { chats: [value.chat], interval: { from_ts: 0, to_ts: 200 } });
    expect(before.identities[0]).toMatchObject({ self_id: "self-2" });
    expect(before.unread[0]).toMatchObject({ count: 2 });
    expect(() => applySyncBatch(value.database, batch(1, 9))).toThrow("Stale sync page");
    expect(recentMessages(value.database, { chats: [value.chat], interval: { from_ts: 0, to_ts: 200 } })).toEqual(before);
    expect(readSyncState(value.database, value.chat)).toMatchObject({ page_sequence: 2 });
    const older = batch(2, 3);
    applySyncBatch(value.database, { ...older, identity: { ...older.identity, observed_at: 99 }, unread: { ...older.unread, observed_at: 99 } });
    expect(recentMessages(value.database, { chats: [value.chat], interval: { from_ts: 0, to_ts: 200 } })).toEqual(before);
    expect(readSyncState(value.database, value.chat)).toMatchObject({ page_sequence: 3 });
    for (const expected_page_sequence of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => applySyncBatch(value.database, batch(expected_page_sequence, 9))).toThrow();
    }
  });



  test("trusted metadata requires a scoped page sequence and cannot bypass a tracked cursor", () => {
    const value = fixture();
    const sync = { chat: value.chat, cursor: "one", updated_at: 100 };
    const identity = { platform: value.chat.platform, account: value.chat.account, status: "known" as const, source: "authenticated_adapter" as const, self_id: "self", observed_at: 100 };
    const unread = { chat: value.chat, status: "known" as const, source: "platform" as const, count: 1, observed_at: 100 };
    expect(() => applySyncBatch(value.database, { sync, identity, unread })).toThrow("page sequence");
    for (const invalid of [
      { identity: { ...identity, account: "other" } },
      { unread: { ...unread, chat: { ...value.chat, chat_id: "other" } } },
    ]) expect(() => applySyncBatch(value.database, { sync, expected_page_sequence: 0, ...invalid })).toThrow("scope");
    expect(readSyncState(value.database, value.chat)).toBeNull();
    applySyncBatch(value.database, { sync, expected_page_sequence: 0, identity, unread });
    expect(() => applySyncBatch(value.database, { sync: { ...sync, cursor: "unguarded" } })).toThrow("page sequence");
    expect(readSyncState(value.database, value.chat)).toMatchObject({ cursor: "one", page_sequence: 1 });
  });

  test("preserves two interior gaps across interrupted and resumed backfill", () => {
    const value = fixture();
    applySyncBatch(value.database, { coverage: [segment(value.chat, 0, 20, 1)] });
    // A process may stop between pages; later batches resume without filling unknown space.
    applySyncBatch(value.database, { coverage: [segment(value.chat, 40, 60, 2)] });
    applySyncBatch(value.database, { coverage: [segment(value.chat, 80, 100, 3)] });
    const result = coverageFor(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 100 } });

    expect(result.gaps.map((gap) => gap.interval)).toEqual([{ from_ts: 20, to_ts: 40 }, { from_ts: 60, to_ts: 80 }]);
    expect(result.freshness.map((freshness) => freshness.collected_at)).toEqual([1, 2, 3]);
  });

  test("distinguishes verified empty from unseen chats and preserves unequal freshness", () => {
    const value = fixture();
    applySyncBatch(value.database, { coverage: [segment(value.chat, 0, 25, 4, "verified_empty"), segment(value.chat, 25, 100, 9, "watch")] });
    const known = coverageFor(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 100 } });
    const unknown = coverageFor(value.database, { chat: { ...value.chat, chat_id: "unseen" }, interval: { from_ts: 0, to_ts: 100 } });

    expect(known.covered[0]?.kind).toBe("verified_empty");
    expect(known.gaps).toEqual([]);
    expect(known.freshness.map((freshness) => freshness.collected_at)).toEqual([4, 9]);
    expect(unknown.covered).toEqual([]);
    expect(unknown.gaps).toEqual([{ interval: { from_ts: 0, to_ts: 100 }, reason: "unknown" }]);
  });

  test("keeps mutation freshness independent of collection, edits, and deletes until explicitly verified", () => {
    const value = fixture();
    const target = { chat: value.chat, interval: { from_ts: 0, to_ts: 200 } };
    const backfill = segment(value.chat, 0, 100, 300);
    const watch = { ...segment(value.chat, 100, 200, 310, "watch"), mutations_verified_at: 250 };
    applySyncBatch(value.database, { coverage: [backfill, watch], events: [event(value.chat, "create", 1, "mutable", "원본안건")] });
    const initial = [
      { interval: backfill.interval, collected_at: 300, mutations_verified_at: null },
      { interval: watch.interval, collected_at: 310, mutations_verified_at: 250 },
    ];
    expect(coverageFor(value.database, target).freshness).toEqual(initial);

    applySyncBatch(value.database, { events: [event(value.chat, "edit", 2, "mutable", "변경안건")] });
    expect(searchMessages(value.database, { ...target, query: "변경안건" }).coverage.freshness).toEqual(initial);
    applySyncBatch(value.database, { events: [event(value.chat, "delete", 3, "mutable")] });
    const deleted = searchMessages(value.database, { ...target, query: "변경안건" });
    expect(deleted.messages).toEqual([]);
    expect(deleted.coverage.freshness).toEqual(initial);
    expect(deleted.coverage.gaps).toEqual([]);

    // A later collection cannot manufacture evidence that historical edits/deletes were checked.
    applySyncBatch(value.database, { coverage: [{ ...backfill, collected_at: 400 }] });
    expect(coverageFor(value.database, target).freshness).toEqual([
      { ...initial[0], collected_at: 400 }, initial[1],
    ]);
    applySyncBatch(value.database, { coverage: [{ ...watch, collected_at: 410, mutations_verified_at: 405 }] });
    const verified = coverageFor(value.database, target);
    expect(verified.freshness).toEqual([
      { interval: backfill.interval, collected_at: 400, mutations_verified_at: null },
      { interval: watch.interval, collected_at: 410, mutations_verified_at: 405 },
    ]);
    expect(verified.covered).toHaveLength(2);
    expect(searchMessages(value.database, { ...target, query: "없는안건" }).coverage).toEqual(verified);
  });

  test("retains unresolved limits and records their later resolution", () => {
    const value = fixture();
    const limit = { chat: value.chat, interval: { from_ts: 0, to_ts: 50 }, reason: "retention" as const, observed_at: 5 };
    applySyncBatch(value.database, { limits: [limit] });
    expect(coverageFor(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 100 } }).limits).toEqual([limit]);
    applySyncBatch(value.database, { limits: [{ ...limit, observed_at: 5, resolved_at: 12 }] });

    expect(coverageFor(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 100 } }).limits).toEqual([{ ...limit, resolved_at: 12 }]);
  });
});
