import { afterEach, describe, expect, test } from "bun:test";

import { applySyncBatch } from "../src/apply.ts";
import { coverageFor } from "../src/coverage.ts";
import { createStoreFixture, type StoreFixture } from "./fixtures/store-fixture.ts";

const segment = (chat: StoreFixture["chat"], from_ts: number, to_ts: number, collected_at: number, kind: "backfill" | "watch" | "verified_empty" = "backfill") => ({ chat, interval: { from_ts, to_ts }, kind, collected_at, mutations_verified_at: kind === "watch" ? collected_at + 1 : null });

describe("persisted coverage intervals", () => {
  const fixtures: StoreFixture[] = [];
  const fixture = () => { const value = createStoreFixture(); fixtures.push(value); return value; };
  afterEach(() => fixtures.splice(0).forEach((value) => value.dispose()));

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

  test("retains unresolved limits and records their later resolution", () => {
    const value = fixture();
    const limit = { chat: value.chat, interval: { from_ts: 0, to_ts: 50 }, reason: "retention" as const, observed_at: 5 };
    applySyncBatch(value.database, { limits: [limit] });
    expect(coverageFor(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 100 } }).limits).toEqual([limit]);
    applySyncBatch(value.database, { limits: [{ ...limit, observed_at: 5, resolved_at: 12 }] });

    expect(coverageFor(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 100 } }).limits).toEqual([{ ...limit, resolved_at: 12 }]);
  });
});
