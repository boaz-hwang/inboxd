import { afterEach, describe, expect, test } from "bun:test";

import { applySyncBatch, readSyncState } from "../src/apply.ts";
import { getMessage, searchMessages } from "../src/queries.ts";
import { createStoreFixture, event, type StoreFixture } from "./fixtures/store-fixture.ts";

describe("revisioned event application", () => {
  const fixtures: StoreFixture[] = [];
  const fixture = () => {
    const value = createStoreFixture();
    fixtures.push(value);
    return value;
  };
  afterEach(() => fixtures.splice(0).forEach((value) => value.dispose()));

  test("is idempotent for duplicate events and ignores stale backfill after an edit", () => {
    const value = fixture();
    applySyncBatch(value.database, { events: [event(value.chat, "create", 1, "m", "first")] });
    applySyncBatch(value.database, { events: [event(value.chat, "edit", 2, "m", "edited")] });
    applySyncBatch(value.database, { events: [event(value.chat, "edit", 2, "m", "edited")] });
    applySyncBatch(value.database, { events: [event(value.chat, "create", 1, "m", "stale")] });

    expect(getMessage(value.database, { ...value.chat, msg_id: "m" })).toMatchObject({ body: "edited", revision: 2, deleted_at: null });
    expect(searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "edited" }).messages).toHaveLength(1);
  });

  test("keeps a tombstone when create is replayed after deletion or arrives after delete", () => {
    const value = fixture();
    applySyncBatch(value.database, { events: [event(value.chat, "create", 1, "replay", "visible"), event(value.chat, "delete", 2, "replay")] });
    applySyncBatch(value.database, { events: [event(value.chat, "create", 3, "replay", "resurrected")] });
    applySyncBatch(value.database, { events: [event(value.chat, "delete", 3, "before"), event(value.chat, "create", 2, "before", "late")] });

    expect(getMessage(value.database, { ...value.chat, msg_id: "replay" })).toMatchObject({ body: null, deleted_at: 102 });
    expect(getMessage(value.database, { ...value.chat, msg_id: "before" })).toMatchObject({ body: null, deleted_at: 102 });
    expect(searchMessages(value.database, { chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query: "visible" }).messages).toEqual([]);
    expect(value.database.query("SELECT count(*) AS count FROM messages_fts").get()).toEqual({ count: 0 });
  });

  test("ignores a stale delete while allowing an equal-or-newer tombstone to win", () => {
    const value = fixture();
    applySyncBatch(value.database, { events: [event(value.chat, "create", 3, "ordered-delete", "current")] });
    applySyncBatch(value.database, { events: [event(value.chat, "delete", 2, "ordered-delete")] });

    expect(getMessage(value.database, { ...value.chat, msg_id: "ordered-delete" })).toMatchObject({
      body: "current",
      revision: 3,
      deleted_at: null,
    });

    applySyncBatch(value.database, { events: [event(value.chat, "delete", 3, "ordered-delete")] });
    expect(getMessage(value.database, { ...value.chat, msg_id: "ordered-delete" })).toMatchObject({
      body: null,
      revision: 3,
      deleted_at: 102,
    });
  });

  test("rolls back events and cursor when coverage persistence fails", () => {
    const value = fixture();
    expect(() => applySyncBatch(value.database, {
      events: [event(value.chat, "create", 1, "atomic", "must rollback")],
      sync: { chat: value.chat, cursor: "next", updated_at: 10 },
      coverage: [{ chat: value.chat, interval: { from_ts: 10, to_ts: 10 }, kind: "backfill", collected_at: 10, mutations_verified_at: null }],
    })).toThrow();

    expect(getMessage(value.database, { ...value.chat, msg_id: "atomic" })).toBeNull();
    expect(readSyncState(value.database, value.chat)).toBeNull();
  });
});
