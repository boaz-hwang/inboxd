import { expect, test } from "bun:test";
import { boundedAccountPages } from "../src/pagination.ts";

test("large provider pages are served without additional upstream calls or lost cursors", async () => {
  let calls = 0;
  const adapter = boundedAccountPages({ close() {}, async run() {
    calls++;
    return { messages: Array.from({ length: 100 }, (_, i) => ({ id: String(i), chat_id: "r", author_id: "a", author_name: "원래 이름", ts: i, body: "가".repeat(400) })), next_cursor: "upstream-next", complete: false };
  } });
  let page = await adapter.run({ op: "search", query: "word" });
  const ids = page.messages!.map(m => m.id);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(60_000);
  const firstCursor = page.next_cursor!;
  await expect(adapter.run({ op: "search", query: "other", cursor: firstCursor })).rejects.toThrow();
  while (page.next_cursor?.startsWith("local:")) {
    page = await adapter.run({ op: "search", query: "word", cursor: page.next_cursor });
    ids.push(...page.messages!.map(m => m.id));
  }
  expect(ids).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
  expect(page.next_cursor).toBe("upstream-next"); expect(calls).toBe(1);
  await adapter.close();
});
