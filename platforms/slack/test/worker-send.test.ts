import { expect, test } from "bun:test";
import {
  createSlackWorker,
  type SlackApiCall,
  type SlackApiResponse,
  type SlackApiTransport,
} from "../src/worker.ts";

const destination = { v: 1 as const, kind: "chat" as const, platform: "slack", account: "work", chat_id: "C123" };
const request = {
  v: 1 as const,
  type: "worker_request" as const,
  request_id: "send-1",
  generation: 11,
  binding_id: "slack-work",
  limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 8 },
  operation: {
    op: "send" as const,
    envelope: {
      v: 2 as const,
      destination,
      content: { mode: "text" as const, body: "deploy exactly" },
      reply: { parent_id: "1726650000.000001" },
    },
    idempotency_key: "a".repeat(64),
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

test("Slack send makes one exact text/thread write attempt and returns the provider receipt", async () => {
  const fake = scripted([
    auth,
    response({
      ok: true,
      channel: "C123",
      ts: "1726650001.000002",
      message: {
        ts: "1726650001.000002",
        text: "deploy exactly",
        thread_ts: "1726650000.000001",
        client_msg_id: "a".repeat(64),
      },
    }),
  ]);

  expect(await worker(fake.transport).handle(request)).toEqual({
    v: 1,
    type: "worker_response",
    request_id: "send-1",
    generation: 11,
    operation: "send",
    ok: true,
    result: { outcome: "sent", receipt_id: "1726650001.000002" },
  });
  expect(fake.calls.map(({ method, payload }) => ({ method, payload }))).toEqual([
    { method: "auth.test", payload: {} },
    {
      method: "chat.postMessage",
      payload: {
        channel: "C123",
        text: "deploy exactly",
        thread_ts: "1726650000.000001",
        client_msg_id: "a".repeat(64),
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
      },
    },
  ]);
  expect(fake.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test("Slack send classifies post-dispatch timeout as may_have_sent and never retries", async () => {
  let postAttempts = 0;
  const transport: SlackApiTransport = {
    async call(call) {
      if (call.method === "auth.test") return auth;
      postAttempts += 1;
      await new Promise<void>((_resolve, reject) => {
        call.signal.addEventListener("abort", () => reject(new Error("timeout after dispatch")), { once: true });
      });
      throw new Error("unreachable");
    },
  };
  const timedRequest = { ...request, limits: { ...request.limits, timeout_ms: 10 } };

  expect(await worker(transport).handle(timedRequest)).toMatchObject({
    ok: false,
    error: {
      code: "slack_send_uncertain",
      retryable: false,
      may_have_sent: true,
    },
  });
  expect(postAttempts).toBe(1);
});

test("Slack send returns a definitive failed outcome for a provider rejection without retry", async () => {
  const fake = scripted([auth, response({ ok: false, error: "missing_scope", needed: "chat:write" })]);

  expect(await worker(fake.transport).handle(request)).toMatchObject({
    ok: true,
    result: { outcome: "failed", reason: "Slack send rejected: missing_scope" },
  });
  expect(fake.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test("Slack send treats every non-allowlisted post-dispatch rejection as uncertain", async () => {
  for (const body of [
    { ok: false, error: "unknown_error" },
    { ok: false, error: "ratelimited" },
    { ok: false, error: "future_slack_error" },
    { ok: false, error: { code: "malformed_error" } },
  ]) {
    const fake = scripted([auth, response(body)]);

    expect(await worker(fake.transport).handle(request)).toMatchObject({
      ok: false,
      error: {
        code: "slack_send_uncertain",
        retryable: false,
        may_have_sent: true,
      },
    });
    expect(fake.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
  }
});

test("Slack send treats malformed ok flags as uncertain even with an allowlisted error", async () => {
  for (const body of [
    { error: "missing_scope" },
    { ok: null, error: "missing_scope" },
  ]) {
    const fake = scripted([auth, response(body)]);

    expect(await worker(fake.transport).handle(request)).toMatchObject({
      ok: false,
      error: {
        code: "slack_send_uncertain",
        retryable: false,
        may_have_sent: true,
      },
    });
    expect(fake.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
  }
});

test("Slack send treats structured fatal and internal errors after dispatch as ambiguous", async () => {
  for (const providerCode of ["fatal_error", "internal_error"]) {
    const fake = scripted([auth, response({ ok: false, error: providerCode })]);

    expect(await worker(fake.transport).handle(request)).toMatchObject({
      ok: false,
      error: {
        code: "slack_send_uncertain",
        retryable: false,
        may_have_sent: true,
      },
    });
    expect(fake.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
  }
});

test("Slack send treats inconsistent top-level and message acknowledgement timestamps as uncertain", async () => {
  const fake = scripted([
    auth,
    response({
      ok: true,
      channel: "C123",
      ts: "1726650001.000002",
      message: {
        ts: "1726650001.000003",
        text: "deploy exactly",
        thread_ts: "1726650000.000001",
        client_msg_id: "a".repeat(64),
      },
    }),
  ]);

  expect(await worker(fake.transport).handle(request)).toMatchObject({
    ok: false,
    error: { code: "slack_send_uncertain", retryable: false, may_have_sent: true },
  });
  expect(fake.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});

test("Slack send treats a mismatched success acknowledgement as uncertain", async () => {
  const fake = scripted([
    auth,
    response({
      ok: true,
      channel: "C123",
      ts: "1726650001.000002",
      message: { text: "changed by provider", thread_ts: "1726650000.000001" },
    }),
  ]);

  expect(await worker(fake.transport).handle(request)).toMatchObject({
    ok: false,
    error: { code: "slack_send_uncertain", retryable: false, may_have_sent: true },
  });
  expect(fake.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
});
