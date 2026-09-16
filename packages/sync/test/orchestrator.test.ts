import { afterEach, describe, expect, test } from "bun:test";

import { coverageFor } from "../../store/src/coverage.ts";
import { applySyncBatch, readSyncState } from "../../store/src/apply.ts";
import { getMessage } from "../../store/src/queries.ts";
import { createStoreFixture, event, type StoreFixture } from "../../store/test/fixtures/store-fixture.ts";
import { normalizeMessageEvent } from "../../core/src/models.ts";
import { decideReadAdapterWidening, syncHistorical } from "../src/index.ts";

const fixtures: StoreFixture[] = [];
function fixture(): StoreFixture {
  const value = createStoreFixture();
  fixtures.push(value);
  return value;
}
afterEach(() => fixtures.splice(0).forEach((value) => value.dispose()));

function atomicStore(value: StoreFixture, calls: unknown[] = []) {
  return {
    readSyncState: (chat: typeof value.chat) => readSyncState(value.database, chat),
    apply: (batch: unknown) => {
      calls.push(batch);
      applySyncBatch(value.database, batch as Parameters<typeof applySyncBatch>[1]);
    },
  };
}

describe("atomic sync orchestration", () => {
  test("applies cursor, events, coverage, and limits through one atomic store call", async () => {
    const value = fixture();
    const calls: unknown[] = [];
    const store = atomicStore(value, calls);
    const interval = { from_ts: 10, to_ts: 20 };

    await syncHistorical({
      chat: value.chat,
      interval,
      now: () => 50,
      store,
      adapter: {
        fetchHistorical: async () => ({
          events: [normalizeMessageEvent(event(value.chat, "create", 1, "scoped-message", "atomic body"))],
          coverage: [{ chat: value.chat, interval, kind: "backfill", collected_at: 50, mutations_verified_at: null }],
          limits: [{ chat: value.chat, interval, reason: "unsupported", observed_at: 50 }],
          next_cursor: "cursor-1",
        }),
      },
    });

    expect(calls).toHaveLength(1);
    expect(readSyncState(value.database, value.chat)).toMatchObject({ cursor: "cursor-1", updated_at: 50 });
    expect(getMessage(value.database, { ...value.chat, msg_id: "scoped-message" })).toMatchObject({ body: "atomic body" });
    expect(coverageFor(value.database, { chat: value.chat, interval })).toMatchObject({
      covered: [{ interval, kind: "backfill" }],
      limits: [{ interval, reason: "unsupported" }],
    });
  });

  test("does not advance a stored cursor when the runner fails", async () => {
    const value = fixture();
    applySyncBatch(value.database, { sync: { chat: value.chat, cursor: "previous", updated_at: 1 } });

    await expect(syncHistorical({
      chat: value.chat,
      interval: { from_ts: 10, to_ts: 20 },
      now: () => 50,
      store: atomicStore(value),
      adapter: { fetchHistorical: async () => { throw new Error("runner failed"); } },
    })).rejects.toThrow("runner failed");

    expect(readSyncState(value.database, value.chat)).toMatchObject({ cursor: "previous", updated_at: 1 });
  });

  test("does not advance a stored cursor when atomic application fails", async () => {
    const value = fixture();
    const interval = { from_ts: 10, to_ts: 20 };
    applySyncBatch(value.database, { sync: { chat: value.chat, cursor: "previous", updated_at: 1 } });

    await expect(syncHistorical({
      chat: value.chat,
      interval,
      now: () => 50,
      store: atomicStore(value),
      adapter: {
        fetchHistorical: async () => ({
          events: [normalizeMessageEvent(event(value.chat, "create", 1, "rollback", "must not persist"))],
          coverage: [{ chat: value.chat, interval: { from_ts: 10, to_ts: 10 }, kind: "backfill", collected_at: 50, mutations_verified_at: null }],
          limits: [],
          next_cursor: "next",
        }),
      },
    })).rejects.toThrow();

    expect(readSyncState(value.database, value.chat)).toMatchObject({ cursor: "previous", updated_at: 1 });
    expect(getMessage(value.database, { ...value.chat, msg_id: "rollback" })).toBeNull();
  });

  test("resumes an interrupted sequence from the cursor committed by the preceding call", async () => {
    const value = fixture();
    const observedCursors: Array<string | undefined> = [];
    const store = atomicStore(value);
    const adapter = {
      fetchHistorical: async (request: { cursor?: string }) => {
        observedCursors.push(request.cursor);
        return observedCursors.length === 1
          ? { events: [], coverage: [], limits: [], next_cursor: "after-first" }
          : { events: [], coverage: [], limits: [], next_cursor: "after-second" };
      },
    };

    await syncHistorical({ chat: value.chat, interval: { from_ts: 10, to_ts: 20 }, now: () => 50, store, adapter });
    await syncHistorical({ chat: value.chat, interval: { from_ts: 10, to_ts: 20 }, now: () => 51, store, adapter });

    expect(observedCursors).toEqual([undefined, "after-first"]);
    expect(readSyncState(value.database, value.chat)).toMatchObject({ cursor: "after-second", updated_at: 51 });
  });
});

describe("read-contract widening", () => {
  test("requires a direct cursor adapter when authoritative history is requested", () => {
    expect(decideReadAdapterWidening({
      authoritative_history: true,
      capabilities: { fetch_historical: true, read_cursor_comparison: "none" },
    })).toEqual({ decision: "direct_cursor_adapter_required" });
  });

  test("keeps a degraded adapter for non-authoritative reads", () => {
    expect(decideReadAdapterWidening({
      authoritative_history: false,
      capabilities: { fetch_historical: true, read_cursor_comparison: "none" },
    })).toEqual({ decision: "degraded_adapter_allowed" });
  });
});
