import { expect, test } from "bun:test";
import { batchHistoryReads } from "../src/batch-reads.ts";

test("eight uncached room reads become one native request with exact per-room responses", async () => {
  const calls: { ids: unknown[]; cursors: unknown[] }[] = [];
  const session = { async getChatLogs(ids: unknown[], cursors: unknown[]) {
    calls.push({ ids, cursors });
    return { statusCode: 0, body: { status: 0, eof: true, chatLogs: ids.map((id, i) => ({ chatId: id, logId: String(i), message: "body" })) } };
  } };
  const stop = batchHistoryReads(session as never);
  const result = await Promise.all(Array.from({ length: 8 }, (_, i) => session.getChatLogs([String(i)], [String(100 + i)])));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.cursors).toEqual(Array.from({ length: 8 }, (_, i) => String(100 + i)));
  result.forEach((response, i) => expect(response.body.chatLogs.map(m => m.chatId)).toEqual([String(i)]));
  stop();
});

test("a batch containing a foreign room fails instead of mixing account data", async () => {
  const session = { async getChatLogs(_: unknown[], __: unknown[]) {
    return { statusCode: 0, body: { status: 0, chatLogs: [{ chatId: "foreign" }] } };
  } };
  const stop = batchHistoryReads(session as never);
  await expect(session.getChatLogs(["a"], ["0"])).rejects.toThrow("scope mismatch");
  stop();
});
