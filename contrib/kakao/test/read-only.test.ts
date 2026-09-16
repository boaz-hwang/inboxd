import { describe, expect, test } from "bun:test";

import { createBlockedManifest } from "../../../spikes/B/probe.ts";
import { createKakaoReadAdapter, type KakaoMeasurementEvidence, type KakaoReaderRequest } from "../src/index.ts";

const account = "stable:kakao_account_alpha";
const chat = { platform: "kakao", account, chat_id: "stable:kakao_chat_alpha" };
const now = 1_000;
const fixture = await Bun.file(new URL("../fixtures/anonymous-history.json", import.meta.url)).json();

const measuredEvidence: KakaoMeasurementEvidence = {
  schema_version: "kakao-contrib-read-measurement/v1",
  kind: "kakao-read-field-measurement",
  status: "VALIDATED",
  observation: "observed",
  source: "authorized-live-measurement",
  observed_at: now,
  send: false,
  supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body", "revision"],
};

function adapterWithReader(
  reader: (request: KakaoReaderRequest) => Promise<readonly unknown[]>,
  measurement?: unknown,
) {
  const activeMeasurement = arguments.length >= 2 ? measurement : measuredEvidence;
  return createKakaoReadAdapter({
    allowedChats: [{ account, chat_id: chat.chat_id }],
    measurement: activeMeasurement,
    max_measurement_age: 100,
    now: () => now,
    reader,
  });
}

describe("measurement-gated Kakao read adapter", () => {
  test("rejects the current Spike B BLOCKED/not_observed manifest before reader I/O", async () => {
    let readerCalls = 0;
    const adapter = adapterWithReader(async () => {
      readerCalls += 1;
      return [];
    }, createBlockedManifest("probe"));

    await expect(adapter.fetchHistorical!({ chat, interval: { from_ts: 10, to_ts: 20 } }))
      .rejects.toThrow("Kakao read denied: measurement status must be VALIDATED");
    expect(readerCalls).toBe(0);
  });

  test("rejects missing measurement evidence before reader I/O", async () => {
    let readerCalls = 0;
    const adapter = adapterWithReader(async () => {
      readerCalls += 1;
      return [];
    }, undefined);

    await expect(adapter.fetchHistorical!({ chat, interval: { from_ts: 10, to_ts: 20 } }))
      .rejects.toThrow("Kakao read denied: measurement evidence is required");
    expect(readerCalls).toBe(0);
  });

  test("rejects stale measurement evidence before reader I/O", async () => {
    let readerCalls = 0;
    const adapter = adapterWithReader(async () => {
      readerCalls += 1;
      return [];
    }, { ...measuredEvidence, observed_at: 899 });

    await expect(adapter.fetchHistorical!({ chat, interval: { from_ts: 10, to_ts: 20 } }))
      .rejects.toThrow("Kakao read denied: measurement evidence is stale");
    expect(readerCalls).toBe(0);
  });

  test("rejects measurement evidence without every required live read field before reader I/O", async () => {
    let readerCalls = 0;
    const adapter = adapterWithReader(async () => {
      readerCalls += 1;
      return [];
    }, { ...measuredEvidence, supported_read_fields: ["account_id", "chat_id"] });

    await expect(adapter.fetchHistorical!({ chat, interval: { from_ts: 10, to_ts: 20 } }))
      .rejects.toThrow("Kakao read denied: measurement evidence does not prove required live read fields");
    expect(readerCalls).toBe(0);
  });

  test("exposes no send port and no cursor resume capability", () => {
    const adapter = adapterWithReader(async () => []);

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
      cursor: "unverified",
      max_pages: 1,
    });
    expect("send" in adapter).toBe(false);
  });

  test("denies a non-exact stable account/chat allowlist match before reader I/O", async () => {
    let readerCalls = 0;
    const adapter = adapterWithReader(async () => {
      readerCalls += 1;
      return [];
    });

    await expect(adapter.fetchHistorical!({
      chat: { ...chat, chat_id: "stable:kakao_chat_alpha_suffix" },
      interval: { from_ts: 10, to_ts: 20 },
    })).rejects.toThrow("Kakao read denied: exact stable account/chat allowlist required");
    expect(readerCalls).toBe(0);
  });

  test("normalizes artificial records to composite identities and filters at the invocation upper bound", async () => {
    const requests: KakaoReaderRequest[] = [];
    const adapter = adapterWithReader(async (request) => {
      requests.push(request);
      return fixture;
    });

    const result = await adapter.fetchHistorical!({ chat, interval: { from_ts: 10, to_ts: 1_500 } });

    expect(requests).toEqual([{
      account,
      chat_id: chat.chat_id,
      interval: { from_ts: 10, to_ts: now },
      upper_bound_ts: now,
      max_pages: 1,
    }]);
    expect(result.events).toMatchObject([
      {
        kind: "create",
        message: { key: { platform: "kakao", account, chat_id: chat.chat_id, msg_id: "m-in-range" }, ts: 20 },
        revision: { source: "adapter", value: 21 },
      },
      {
        kind: "create",
        message: { key: { platform: "kakao", account, chat_id: chat.chat_id, msg_id: "m-before-upper-bound" }, ts: 999 },
        revision: { source: "adapter", value: 999 },
      },
    ]);
    expect(result.events).toHaveLength(2);
  });

  test("never overclaims coverage, limits, or a next cursor", async () => {
    const adapter = adapterWithReader(async () => []);

    const result = await adapter.fetchHistorical!({ chat, interval: { from_ts: 10, to_ts: 1_500 } });

    expect(result.coverage).toEqual([]);
    expect(result.limits).toEqual([{
      chat,
      interval: { from_ts: 10, to_ts: now },
      reason: "unsupported",
      observed_at: now,
    }]);
    expect("next_cursor" in result).toBe(false);
  });

  test("rejects an unmeasured cursor before reader I/O", async () => {
    let readerCalls = 0;
    const adapter = adapterWithReader(async () => {
      readerCalls += 1;
      return [];
    });

    await expect(adapter.fetchHistorical!({ chat, interval: { from_ts: 10, to_ts: 20 }, cursor: "unverified-cursor" }))
      .rejects.toThrow("Kakao read denied: cursor resume is not measured");
    expect(readerCalls).toBe(0);
  });
});
