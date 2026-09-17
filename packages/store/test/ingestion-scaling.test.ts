import { expect, spyOn, test } from "bun:test";

import { applySyncBatch } from "../src/apply.ts";
import { searchMessages } from "../src/queries.ts";
import { createStoreFixture, event } from "./fixtures/store-fixture.ts";

test("new messages avoid full FTS delete scans; replacements still remove stale bodies", () => {
  const value = createStoreFixture();
  const originalRun = value.database.run.bind(value.database);
  const deletes: number[] = [];
  const trace = spyOn(value.database, "run").mockImplementation((sql, params) => {
    const start = performance.now();
    const result = originalRun(sql, params);
    if (sql.startsWith("DELETE FROM messages_fts")) deletes.push(performance.now() - start);
    return result;
  });
  try {
    // Optional bounded diagnosis measures real SQLCipher statements, never a fake SQL host.
    const count = process.env.INBOXD_PROFILE_INGESTION === "1" ? 5_000 : 12;
    const batchSize = Math.min(count, 1_000);
    const batches: { rows: number; elapsed_ms: number; fts_delete_ms: number }[] = [];
    for (let start = 0; start < count; start += batchSize) {
      const deleteStart = deletes.length;
      const begin = performance.now();
      applySyncBatch(value.database, { events: Array.from({ length: batchSize }, (_, offset) =>
        event(value.chat, "create", 1, `m${start + offset}`, "이전안건 초안")) });
      batches.push({ rows: start + batchSize, elapsed_ms: performance.now() - begin,
        fts_delete_ms: deletes.slice(deleteStart).reduce((sum, ms) => sum + ms, 0) });
    }
    if (process.env.INBOXD_PROFILE_INGESTION === "1") console.log(JSON.stringify({ profile: "production-ingestion-fts-deletes", batches, delete_count: deletes.length }));
    expect(value.database.query("SELECT COUNT(*) AS count FROM messages_fts").get()).toEqual({ count });
    // Deterministic complexity guard: an absent key cannot have an FTS row. Its unindexed
    // metadata DELETE visits the whole growing index and makes fresh ingestion quadratic.
    expect(deletes).toHaveLength(0);

    applySyncBatch(value.database, { events: [event(value.chat, "create", 2, "m0", "변경안건 확정")] });
    applySyncBatch(value.database, { events: [event(value.chat, "edit", 3, "m0", "최종안건 완료")] });
    const ids = (query: string) => searchMessages(value.database, {
      chat: value.chat, interval: { from_ts: 0, to_ts: 200 }, query,
    }).messages.map(message => message.msg_id);
    expect(ids("이전안건")).not.toContain("m0");
    expect(ids("변경안건")).toEqual([]);
    expect(ids("최종안건")).toEqual(["m0"]);
    expect(value.database.query("SELECT COUNT(*) AS count FROM messages_fts").get()).toEqual({ count });
    applySyncBatch(value.database, { events: [event(value.chat, "delete", 4, "m0")] });
    expect(ids("최종안건")).toEqual([]);
    const previousDeletes = deletes.length;
    applySyncBatch(value.database, { events: [event(value.chat, "delete", 1, "never-seen")] });
    expect(deletes).toHaveLength(previousDeletes);
    applySyncBatch(value.database, { events: [event(value.chat, "create", 5, "m0", "부활안건")] });
    expect(ids("부활안건")).toEqual([]);
  } finally {
    trace.mockRestore();
    value.dispose();
  }
}, 60_000);
