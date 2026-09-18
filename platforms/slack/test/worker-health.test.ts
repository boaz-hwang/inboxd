import { describe, expect, test } from "bun:test";
import {
  createSlackWorker,
  type SlackApiCall,
  type SlackApiTransport,
  type SlackWorkerOptions,
} from "../src/worker.ts";

const baseRequest = {
  v: 1 as const,
  type: "worker_request" as const,
  request_id: "health-1",
  generation: 4,
  binding_id: "slack-work",
  limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 8 },
  operation: { op: "health" as const },
};

function transportWith(responses: readonly unknown[]) {
  const calls: SlackApiCall[] = [];
  let index = 0;
  const transport: SlackApiTransport = {
    async call(call) {
      calls.push(call);
      const response = responses[index++];
      if (response instanceof Error) throw response;
      return { status: 200, headers: {}, body: response };
    },
  };
  return { transport, calls };
}

function options(transport: SlackApiTransport, overrides: Partial<SlackWorkerOptions> = {}): SlackWorkerOptions {
  return {
    bindingId: "slack-work",
    account: "work",
    expectedTeamId: "T123",
    allowedChatIds: ["C123"],
    transport,
    now: () => 1_726_650_002,
    ...overrides,
  };
}

describe("Slack worker health and fixed authority", () => {
  test("reports freshly observed authenticated health for the fixed Slack account", async () => {
    const fake = transportWith([{ ok: true, team_id: "T123", user_id: "U-self" }]);
    const worker = createSlackWorker(options(fake.transport));

    expect(await worker.handle(baseRequest)).toEqual({
      v: 1,
      type: "worker_response",
      request_id: "health-1",
      generation: 4,
      operation: "health",
      ok: true,
      result: {
        state: "ready",
        auth: { state: "authenticated", reason: null, observed_at: 1_726_650_002 },
      },
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ method: "auth.test", payload: {} });
  });

  test("refuses a request for any binding other than the immutable configured binding before I/O", async () => {
    const fake = transportWith([{ ok: true, team_id: "T123", user_id: "U-self" }]);
    const worker = createSlackWorker(options(fake.transport));

    expect(await worker.handle({ ...baseRequest, binding_id: "slack-other" })).toMatchObject({
      request_id: "health-1",
      generation: 4,
      operation: "health",
      ok: false,
      error: { code: "binding_mismatch", retryable: false, may_have_sent: false },
    });
    expect(fake.calls).toHaveLength(0);
  });

  test("does not authenticate a token belonging to a different fixed Slack team", async () => {
    const fake = transportWith([{ ok: true, team_id: "T-other", user_id: "U-self" }]);
    const worker = createSlackWorker(options(fake.transport));

    expect(await worker.handle(baseRequest)).toMatchObject({
      ok: true,
      result: {
        state: "unavailable",
        auth: { state: "unauthenticated", reason: "account_scope_mismatch" },
      },
    });
  });

  test("normalizes definitive auth failure separately from unobserved transport health", async () => {
    const invalid = transportWith([{ ok: false, error: "invalid_auth" }]);
    expect(await createSlackWorker(options(invalid.transport)).handle(baseRequest)).toMatchObject({
      result: { state: "unavailable", auth: { state: "unauthenticated", reason: "invalid_auth" } },
    });

    const offline = transportWith([new Error("secret local details")]);
    expect(await createSlackWorker(options(offline.transport)).handle(baseRequest)).toMatchObject({
      result: { state: "degraded", auth: { state: "unknown", reason: "transport_unavailable" } },
    });
  });

  test("classifies an expired token as a definitive authentication failure", async () => {
    const expired = transportWith([{ ok: false, error: "token_expired" }]);

    expect(await createSlackWorker(options(expired.transport)).handle(baseRequest)).toMatchObject({
      ok: true,
      result: {
        state: "unavailable",
        auth: { state: "unauthenticated", reason: "token_expired" },
      },
    });
  });

  test("rejects malformed or duplicate fixed configuration", () => {
    const fake = transportWith([]);
    for (const override of [
      { bindingId: "" },
      { account: "" },
      { expectedTeamId: "workspace-name" },
      { allowedChatIds: [] },
      { allowedChatIds: ["C123", "C123"] },
      { allowedChatIds: ["not-a-slack-chat"] },
    ] satisfies Partial<SlackWorkerOptions>[]) {
      expect(() => createSlackWorker(options(fake.transport, override))).toThrow();
    }
  });
});
