import { expect, test } from "bun:test";
import * as slack from "../src/index.ts";

const chat = { platform: "slack", account: "stable:account", chat_id: "stable:chat" };
const interval = { from_ts: 10, to_ts: 200 };
const raw = (id: string, ts = 20) => ({ channel_id: chat.chat_id, message_id: id, author_id: "someone", ts, body: id });
const page = (next_cursor: string | null, events = [raw("one")]) => ({
  status: "ok" as const, account: chat.account, chat_id: chat.chat_id,
  self_id: "authenticated-self", unread_count: 0, events, next_cursor,
});

test("authenticated Slack fetches one bounded page with a scope-bound provider continuation, never claims coverage", async () => {
  const requests: unknown[] = [];
  const adapter = slack.createCursorSlackReadAdapter({
    allowedChats: [chat], now: () => 100,
    authenticatedRunner: async (request) => { requests.push(request); return page(request.provider_cursor ? null : "provider-page-2"); },
  });
  const first = await adapter.fetchHistorical({ chat, interval, limit: 2 });
  expect(requests).toEqual([{ account: chat.account, chat_id: chat.chat_id, interval: { from_ts: 10, to_ts: 100 }, upper_bound_ts: 100, max_pages: 1, limit: 2 }]);
  expect(first.next_cursor).toEqual(expect.any(String));
  expect(first.next_cursor).not.toBe("provider-page-2");
  expect(first.coverage).toEqual([]);
  expect(first.limits.map((limit) => limit.reason)).toEqual(["unsupported"]);
  expect(first).toMatchObject({ degraded: true, incomplete: true, page_status: "more" });
  const second = await adapter.fetchHistorical({ chat, interval, cursor: first.next_cursor });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ provider_cursor: "provider-page-2", max_pages: 1 });
  expect(second).toMatchObject({ page_status: "exhausted", degraded: true, incomplete: true });
  await adapter.fetchHistorical({ chat, interval, cursor: second.next_cursor });
  expect(requests).toHaveLength(2);
  expect(adapter.capabilities.send).toBe(false);
});

test("cursor scope and page bounds are validated before provider I/O", async () => {
  let calls = 0;
  let now = 100;
  const other = { ...chat, chat_id: "stable:other" };
  const adapter = slack.createCursorSlackReadAdapter({ allowedChats: [chat, other], now: () => now,
    authenticatedRunner: async () => { calls++; return page("next"); } });
  const first = await adapter.fetchHistorical({ chat, interval });
  for (const request of [
    { chat: other, interval, cursor: first.next_cursor },
    { chat, interval: { from_ts: 11, to_ts: 200 }, cursor: first.next_cursor },
    { chat, interval, cursor: "provider-token-is-not-a-checkpoint" },
    { chat, interval, cursor: "{}" },
    { chat, interval, limit: 0 }, { chat, interval, limit: 201 }, { chat, interval, limit: 1.5 },
  ]) await expect(adapter.fetchHistorical(request)).rejects.toThrow();
  expect(calls).toBe(1);
  now = Number.NaN;
  await expect(adapter.fetchHistorical({ chat, interval })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("provider page overflow and non-advancing continuation are rejected rather than silently skipped", async () => {
  const oversized = slack.createCursorSlackReadAdapter({ allowedChats: [chat], now: () => 100,
    authenticatedRunner: async () => page("next", [raw("one"), raw("two")]) });
  await expect(oversized.fetchHistorical({ chat, interval, limit: 1 })).rejects.toThrow("page bound");
  const stuck = slack.createCursorSlackReadAdapter({ allowedChats: [chat], now: () => 100,
    authenticatedRunner: async () => page("same") });
  const first = await stuck.fetchHistorical({ chat, interval });
  await expect(stuck.fetchHistorical({ chat, interval, cursor: first.next_cursor })).rejects.toThrow("advance");
});

test("rate limit checkpoints preserve provider position and cooldown across adapter reconstruction", async () => {
  let now = 100;
  const requests: slack.SlackPageRequest[] = [];
  const runner = async (request: slack.SlackPageRequest) => {
    requests.push(request);
    if (requests.length === 1) return page("next");
    if (requests.length === 2) return { status: "rate_limited" as const, retry_after_ms: 50 };
    return page(null);
  };
  const options = { allowedChats: [chat], now: () => now, authenticatedRunner: runner };
  const adapter = slack.createCursorSlackReadAdapter(options);
  const first = await adapter.fetchHistorical({ chat, interval });
  const limited = await adapter.fetchHistorical({ chat, interval, cursor: first.next_cursor });
  expect(limited).toMatchObject({ events: [], coverage: [], page_status: "rate_limited", retry_at: 100.05, degraded: true, incomplete: true });
  expect(limited.limits.map((limit) => limit.reason)).toEqual(["rate_limit"]);
  now = 100.049;
  const restarted = slack.createCursorSlackReadAdapter(options);
  const paused = await restarted.fetchHistorical({ chat, interval, cursor: limited.next_cursor });
  expect(paused.next_cursor).toBe(limited.next_cursor);
  expect(requests).toHaveLength(2);
  now = 100.05;
  const resumed = await restarted.fetchHistorical({ chat, interval, cursor: paused.next_cursor });
  expect(requests[2]).toMatchObject({ provider_cursor: "next", upper_bound_ts: 100, interval: { from_ts: 10, to_ts: 100 } });
  expect(resumed.page_status).toBe("exhausted");
  expect(requests).toHaveLength(3);
});

test("rejects nonfinite, unsafe, overflowing or nonadvancing cooldown deadlines", async () => {
  for (const [now, retry_after_ms] of [
    [100, 0], [100, -1], [100, NaN], [100, Infinity], [100, Number.MAX_SAFE_INTEGER + 1],
    [Number.MAX_SAFE_INTEGER, 1], [Number.MAX_SAFE_INTEGER, 1000],
    [Number.MAX_VALUE, 1000], [Infinity, 1000],
  ]) {
    const adapter = slack.createCursorSlackReadAdapter({ allowedChats: [chat], now: () => now!,
      authenticatedRunner: async () => ({ status: "rate_limited", retry_after_ms: retry_after_ms! }) });
    await expect(adapter.fetchHistorical({ chat, interval })).rejects.toThrow();
  }
  let calls = 0;
  const adapter = slack.createCursorSlackReadAdapter({ allowedChats: [chat], now: () => 100,
    authenticatedRunner: async () => { calls++; return page("next"); } });
  const first = await adapter.fetchHistorical({ chat, interval });
  for (const retry_at of [null, "101", 0, 100, 1e100]) {
    const cursor = JSON.stringify({ ...JSON.parse(first.next_cursor), retry_at });
    await expect(adapter.fetchHistorical({ chat, interval, cursor })).rejects.toThrow();
  }
  expect(calls).toBe(1);
});

test("provider continuation is bounded to 4096 UTF-8 bytes on input and output", async () => {
  let token = "a".repeat(4096);
  let calls = 0;
  const adapter = slack.createCursorSlackReadAdapter({ allowedChats: [chat], now: () => 100,
    authenticatedRunner: async () => { calls++; return page(token); } });
  const first = await adapter.fetchHistorical({ chat, interval });
  for (const oversized of ["a".repeat(4097), "한".repeat(1366)]) {
    token = oversized;
    await expect(adapter.fetchHistorical({ chat, interval })).rejects.toThrow("cursor");
    const before = calls;
    await expect(adapter.fetchHistorical({ chat, interval, cursor: JSON.stringify({ ...JSON.parse(first.next_cursor), provider_cursor: oversized }) })).rejects.toThrow("cursor");
    expect(calls).toBe(before);
  }
});


