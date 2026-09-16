import { describe, expect, test } from "bun:test";

import { createDegradedSlackReadAdapter, type SlackRunnerRequest } from "../src/index.ts";

const account = "stable:account_alpha";
const chat = { platform: "slack", account, chat_id: "stable:chat_alpha" };
const fixture = await Bun.file(new URL("../../../fixtures/slack/anonymous-history.json", import.meta.url)).json();

function adapterWithRunner(runner: (request: SlackRunnerRequest) => Promise<readonly unknown[]>) {
  return createDegradedSlackReadAdapter({
    allowedChats: [{ account, chat_id: chat.chat_id }],
    now: () => 100,
    runner,
  });
}

describe("degraded Slack read adapter", () => {
  test("denies a non-exact stable account/chat allowlist match before runner I/O", async () => {
    let runnerCalls = 0;
    const adapter = adapterWithRunner(async () => {
      runnerCalls += 1;
      return fixture;
    });

    await expect(adapter.fetchHistorical!({
      chat: { ...chat, chat_id: "stable:chat_alpha_suffix" },
      interval: { from_ts: 10, to_ts: 20 },
    })).rejects.toThrow("Slack read denied: exact stable account/chat allowlist required");
    expect(runnerCalls).toBe(0);
  });

  test("rejects a future since value before runner I/O", async () => {
    let runnerCalls = 0;
    const adapter = adapterWithRunner(async () => {
      runnerCalls += 1;
      return fixture;
    });

    await expect(adapter.fetchHistorical!({
      chat,
      interval: { from_ts: 101, to_ts: 102 },
    })).rejects.toThrow("Slack read denied: future since");
    expect(runnerCalls).toBe(0);
  });

  test("uses composite scoped IDs and filters fixture events at the invocation upper bound", async () => {
    const requests: SlackRunnerRequest[] = [];
    const adapter = adapterWithRunner(async (request) => {
      requests.push(request);
      return fixture;
    });

    const result = await adapter.fetchHistorical!({
      chat,
      interval: { from_ts: 10, to_ts: 150 },
    });

    expect(requests).toEqual([{
      account,
      chat_id: chat.chat_id,
      interval: { from_ts: 10, to_ts: 100 },
      upper_bound_ts: 100,
      max_pages: 1,
    }]);
    expect(result.events).toMatchObject([
      { kind: "create", message: { key: { platform: "slack", account, chat_id: chat.chat_id, msg_id: "m-in-range" }, ts: 20 }, revision: { value: 21 } },
      { kind: "create", message: { key: { platform: "slack", account, chat_id: chat.chat_id, msg_id: "m-before-upper-bound" }, ts: 99 }, revision: { value: 99 } },
    ]);
    expect(result.events).toHaveLength(2);
  });

  test("never infers complete coverage and exposes an explicit unsupported limit", async () => {
    const adapter = adapterWithRunner(async () => fixture);

    const result = await adapter.fetchHistorical!({ chat, interval: { from_ts: 10, to_ts: 150 } });

    expect(result.coverage).toEqual([]);
    expect(result.limits).toEqual([{
      chat,
      interval: { from_ts: 10, to_ts: 100 },
      reason: "unsupported",
      observed_at: 100,
    }]);
    expect("complete" in result).toBe(false);
    expect(adapter.capabilities).toEqual({
      list_chats: false,
      fetch_historical: true,
      send: false,
      watch: false,
      revision: "adapter",
      read_cursor_comparison: "none",
    });
    expect(adapter.read_limits).toEqual({
      authoritative_backfill: false,
      pagination: "unavailable",
      cursor: "unavailable",
      max_pages: 1,
    });
    expect("send" in adapter).toBe(false);
  });
});
