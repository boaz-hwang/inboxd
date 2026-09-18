import { describe, expect, test } from "bun:test";
import {
  createSlackWorker,
  type SlackApiCall,
  type SlackApiResponse,
  type SlackApiTransport,
} from "../src/worker.ts";

const chat = { v: 1 as const, kind: "chat" as const, platform: "slack", account: "work", chat_id: "C123" };
const request = {
  v: 1 as const,
  type: "worker_request" as const,
  request_id: "read-1",
  generation: 9,
  binding_id: "slack-work",
  limits: { timeout_ms: 1_000, max_response_bytes: 1_048_576, max_queue_depth: 8 },
  operation: {
    op: "read_page" as const,
    chat,
    interval: { from_ts: 1_726_650_000, to_ts: 1_726_653_600 },
    limit: 2,
    cursor: "opaque+/=cursor",
  },
};

function apiResponse(body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): SlackApiResponse {
  return { status, headers, body };
}

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

const auth = apiResponse({ ok: true, team_id: "T123", user_id: "U-self" });
const info = (channel: unknown = { id: "C123", unread_count: 3 }) => apiResponse({ ok: true, channel });
const history = (overrides: Record<string, unknown> = {}) => apiResponse({
  ok: true,
  messages: [{
    type: "message",
    ts: "1726650001.250000",
    user: "U1",
    text: "hello",
    thread_ts: "1726650000.000001",
    edited: { ts: "1726650001.500000" },
  }],
  has_more: true,
  response_metadata: { next_cursor: "opaque-next+/=" },
  ...overrides,
});

describe("Slack worker bounded read_page", () => {
  test("forwards one opaque cursor and emits one fully normalized non-authoritative page", async () => {
    const fake = scripted([auth, history(), info()]);
    const response = await worker(fake.transport).handle(request);

    expect(fake.calls.map(({ method, payload }) => ({ method, payload }))).toEqual([
      { method: "auth.test", payload: {} },
      {
        method: "conversations.history",
        payload: {
          channel: "C123",
          oldest: "1726650000",
          latest: "1726653599.999999",
          inclusive: true,
          limit: 2,
          cursor: "opaque+/=cursor",
        },
      },
      { method: "conversations.info", payload: { channel: "C123" } },
    ]);
    expect(response).toEqual({
      v: 1,
      type: "worker_response",
      request_id: "read-1",
      generation: 9,
      operation: "read_page",
      ok: true,
      result: {
        items: [{
          v: 1,
          mode: "bounded_history",
          chat,
          interval: request.operation.interval,
          messages: [{
            kind: "create",
            message: {
              key: { platform: "slack", account: "work", chat_id: "C123", msg_id: "1726650001.250000" },
              author_id: "U1",
              ts: 1_726_650_001.25,
              body: "hello",
              parent_id: { platform: "slack", account: "work", chat_id: "C123", msg_id: "1726650000.000001" },
              attachments: [],
              edited_at: 1_726_650_001.5,
            },
            revision: { source: "adapter", value: "1726650001.500000" },
          }],
          tombstones: [],
          identity: {
            chat: { platform: "slack", account: "work", chat_id: "C123" },
            status: "known",
            source: "authenticated_adapter",
            self_id: "U-self",
            observed_at: 1_726_650_002,
          },
          unread: {
            chat: { platform: "slack", account: "work", chat_id: "C123" },
            status: "known",
            source: "platform",
            count: 3,
            observed_at: 1_726_650_002,
          },
          coverage: [],
          limits: [{
            chat: { platform: "slack", account: "work", chat_id: "C123" },
            interval: request.operation.interval,
            reason: "unsupported",
            observed_at: 1_726_650_002,
          }],
          next_cursor: "opaque-next+/=",
          authoritative: false,
          observed_at: 1_726_650_002,
        }],
        next_cursor: "opaque-next+/=",
        authoritative: false,
      },
    });
  });

  test("uses null for exhausted pagination and explicit unknown unread when Slack cannot expose it", async () => {
    const fake = scripted([
      auth,
      history({ has_more: false, response_metadata: { next_cursor: "" } }),
      apiResponse({ ok: false, error: "missing_scope", needed: "channels:read" }),
    ]);
    const response = await worker(fake.transport).handle({
      ...request,
      operation: { ...request.operation, cursor: null },
    });

    expect(response).toMatchObject({
      ok: true,
      result: {
        next_cursor: null,
        authoritative: false,
        items: [{
          unread: { status: "unknown", source: "unknown", count: null, reason: "unavailable" },
          coverage: [],
          limits: [{ reason: "unsupported" }],
          next_cursor: null,
          authoritative: false,
        }],
      },
    });
    expect(fake.calls[1]?.payload).not.toHaveProperty("cursor");
  });

  test("discards an exact upper-boundary message while preserving valid items and the cursor", async () => {
    const fake = scripted([
      auth,
      history({
        messages: [
          { type: "message", ts: "1726650001.000001", user: "U1", text: "inside" },
          { type: "message", ts: "1726653600.000000", user: "U2", text: "at upper bound" },
        ],
      }),
      info(),
    ]);

    const response = await worker(fake.transport).handle(request);
    expect(response).toMatchObject({
      ok: true,
      result: {
        next_cursor: "opaque-next+/=",
        items: [{
          messages: [{
            message: {
              key: { msg_id: "1726650001.000001" },
              body: "inside",
            },
          }],
          next_cursor: "opaque-next+/=",
        }],
      },
    });
    expect(JSON.stringify(response)).not.toContain("1726653600.000000");
    expect(fake.calls[1]).toMatchObject({
      method: "conversations.history",
      payload: {
        oldest: "1726650000",
        latest: "1726653599.999999",
        inclusive: true,
      },
    });
  });

  test("surfaces a rate limit without retrying or advancing provider state", async () => {
    const fake = scripted([
      auth,
      apiResponse({ ok: false, error: "ratelimited" }, 429, { "retry-after": "7" }),
      history(),
    ]);
    const response = await worker(fake.transport).handle(request);

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "slack_rate_limited",
        message: "Slack API rate limited the read for 7 seconds",
        retryable: true,
        may_have_sent: false,
      },
    });
    expect(fake.calls).toHaveLength(2);
  });

  test("rejects auth, account, chat, cursor and page scope mismatches before output", async () => {
    const cases: readonly { responses: readonly SlackApiResponse[]; changed?: unknown }[] = [
      { responses: [apiResponse({ ok: true, team_id: "T999", user_id: "U-self" })] },
      { responses: [auth], changed: { ...chat, account: "other" } },
      { responses: [auth], changed: { ...chat, chat_id: "C999" } },
      { responses: [auth, history({ response_metadata: { next_cursor: "opaque+/=cursor" } })] },
      { responses: [auth, history(), info({ id: "C999", unread_count: 3 })] },
    ];

    for (const entry of cases) {
      const fake = scripted(entry.responses);
      const changedRequest = entry.changed === undefined
        ? request
        : { ...request, operation: { ...request.operation, chat: entry.changed } };
      expect(await worker(fake.transport).handle(changedRequest)).toMatchObject({ ok: false });
    }
  });

  test("rejects provider overflow and malformed messages rather than truncating or guessing", async () => {
    for (const providerHistory of [
      history({ messages: [
        { type: "message", ts: "1726650001.000001", user: "U1", text: "one" },
        { type: "message", ts: "1726650002.000001", user: "U2", text: "two" },
        { type: "message", ts: "1726650003.000001", user: "U3", text: "three" },
      ] }),
      history({ messages: [{ type: "message", ts: "not-a-timestamp", user: "U1", text: "bad" }] }),
      history({ messages: [{ type: "message", ts: "1726649999.000001", user: "U1", text: "outside" }] }),
      history({ has_more: true, response_metadata: { next_cursor: "" } }),
      history({ response_metadata: { next_cursor: "한".repeat(1_366) } }),
    ]) {
      const fake = scripted([auth, providerHistory, info()]);
      expect(await worker(fake.transport).handle(request)).toMatchObject({
        ok: false,
        error: { code: "malformed_provider_response", may_have_sent: false },
      });
    }
  });
});
