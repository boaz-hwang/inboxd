import { expect, test } from "bun:test";
import {
  createSlackWorker,
  type SlackApiCall,
  type SlackApiResponse,
  type SlackApiTransport,
} from "../src/worker.ts";

const destination = { v: 1 as const, kind: "chat" as const, platform: "slack", account: "work", chat_id: "C123" };
const receiptId = "1726650001.000002";
const parentId = "1726650000.000001";
const request = {
  v: 1 as const,
  type: "worker_request" as const,
  request_id: "receipt-1",
  generation: 12,
  binding_id: "slack-work",
  limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 8 },
  operation: {
    op: "read_receipt" as const,
    destination,
    receipt_id: receiptId,
    expected: {
      v: 2 as const,
      destination,
      content: { mode: "text" as const, body: "deploy exactly" },
      reply: { parent_id: parentId },
    },
  },
};

function scripted(responses: readonly SlackApiResponse[]) {
  const calls: SlackApiCall[] = [];
  let index = 0;
  const transport: SlackApiTransport = {
    async call(call) {
      calls.push(call);
      const response = responses[index++];
      if (response === undefined) throw new Error("unexpected synthetic call");
      return response;
    },
  };
  return { transport, calls };
}

function worker(transport: SlackApiTransport) {
  return createSlackWorker({
    bindingId: "slack-work",
    account: "work",
    expectedTeamId: "T123",
    allowedChatIds: ["C123"],
    transport,
    now: () => 1_726_650_002,
  });
}

const response = (body: unknown, status = 200): SlackApiResponse => ({ status, headers: {}, body });
const auth = response({ ok: true, team_id: "T123", user_id: "U-self" });

test("Slack read_receipt verifies only an independently read exact receipt/body/thread match", async () => {
  const fake = scripted([
    auth,
    response({
      ok: true,
      messages: [{ type: "message", ts: receiptId, text: "deploy exactly", thread_ts: parentId, user: "U-self" }],
      has_more: false,
    }),
  ]);

  expect(await worker(fake.transport).handle(request)).toEqual({
    v: 1,
    type: "worker_response",
    request_id: "receipt-1",
    generation: 12,
    operation: "read_receipt",
    ok: true,
    result: {
      outcome: "verified",
      evidence: {
        destination,
        receipt_id: receiptId,
        content: { mode: "text", body: "deploy exactly" },
        reply: { parent_id: parentId },
      },
    },
  });
  expect(fake.calls.map(({ method, payload }) => ({ method, payload }))).toEqual([
    { method: "auth.test", payload: {} },
    {
      method: "conversations.replies",
      payload: {
        channel: "C123",
        ts: parentId,
        oldest: receiptId,
        latest: receiptId,
        inclusive: true,
        limit: 100,
      },
    },
  ]);
});

test("Slack read_receipt exposes rate limiting as unavailable without retry", async () => {
  const fake = scripted([
    auth,
    { status: 429, headers: { "retry-after": "9" }, body: { ok: false, error: "ratelimited" } },
  ]);

  expect(await worker(fake.transport).handle(request)).toMatchObject({
    ok: true,
    result: { outcome: "unavailable", reason: "Slack receipt rate limited for 9 seconds" },
  });
  expect(fake.calls.filter((call) => call.method === "conversations.replies")).toHaveLength(1);
});

test("Slack read_receipt returns not_found for every receipt, body, thread, or authenticated-sender mismatch", async () => {
  for (const candidate of [
    { type: "message", ts: "1726650001.999999", text: "deploy exactly", thread_ts: parentId, user: "U-self" },
    { type: "message", ts: receiptId, text: "different", thread_ts: parentId, user: "U-self" },
    { type: "message", ts: receiptId, text: "deploy exactly", thread_ts: "1726650000.999999", user: "U-self" },
    { type: "message", ts: receiptId, text: "deploy exactly", thread_ts: parentId, user: "U-other" },
  ]) {
    const fake = scripted([auth, response({ ok: true, messages: [candidate], has_more: false })]);
    expect(await worker(fake.transport).handle(request)).toMatchObject({
      ok: true,
      result: { outcome: "not_found" },
    });
  }
});

test("Slack read_receipt uses bounded history for an exact top-level message", async () => {
  const topLevelRequest = {
    ...request,
    operation: {
      ...request.operation,
      expected: {
        v: 2 as const,
        destination,
        content: { mode: "text" as const, body: "deploy exactly" },
      },
    },
  };
  const fake = scripted([
    auth,
    response({ ok: true, messages: [{ type: "message", ts: receiptId, text: "deploy exactly", user: "U-self" }], has_more: false }),
  ]);

  expect(await worker(fake.transport).handle(topLevelRequest)).toMatchObject({
    ok: true,
    result: { outcome: "verified", evidence: { receipt_id: receiptId, content: { body: "deploy exactly" } } },
  });
  expect(fake.calls[1]).toMatchObject({
    method: "conversations.history",
    payload: { channel: "C123", oldest: receiptId, latest: receiptId, inclusive: true, limit: 100 },
  });
  expect(fake.calls[1]?.payload).not.toHaveProperty("ts");
});
