import { expect, test } from "bun:test";

import { createAgentMessengerKakaoReader } from "../src/agent-messenger-reader.ts";
import { createKakaoLocalReadWorker } from "../src/worker-core.ts";

const binding = {
  account: "stable:kakao_account_alpha",
  chat_id: "stable:kakao_chat_alpha",
  transport_account_id: "private-account",
  transport_chat_id: "private-chat",
};

const request = {
  account: binding.account,
  chat_id: binding.chat_id,
  interval: { from_ts: 0, to_ts: 100 },
  upper_bound_ts: 100,
  limit: 1,
  max_pages: 1 as const,
};

test("maps one bounded agent-messenger page into scoped adapter records", async () => {
  const calls: unknown[] = [];
  let closed = 0;
  const reader = createAgentMessengerKakaoReader({
    bindings: [binding],
    page_size: 2,
    createClient: async (accountId) => {
      calls.push({ accountId });
      return {
        async getMessagePage(chatId, options) {
          calls.push({ chatId, options });
          return {
            messages: [{
              log_id: "11",
              author_id: 7,
              message: "fixture body",
              sent_at: 20,
            }],
            next_cursor: "11",
            complete: false,
          };
        },
        close() { closed += 1; },
      };
    },
  });

  await expect(reader(request)).resolves.toEqual([{
    account_id: binding.account,
    chat_id: binding.chat_id,
    message_id: "11",
    author_id: "7",
    ts: 20,
    body: "fixture body",
    revision: "11",
  }]);
  expect(calls).toEqual([
    { accountId: binding.transport_account_id },
    { chatId: binding.transport_chat_id, options: { count: 1 } },
  ]);
  expect(closed).toBe(1);
});

test("rejects duplicate stable bindings before any client can be created", () => {
  expect(() => createAgentMessengerKakaoReader({
    bindings: [binding, { ...binding, transport_chat_id: "other-private-chat" }],
    page_size: 2,
    createClient: async () => { throw new Error("must not run"); },
  })).toThrow("Kakao reader bindings must be unique");
});

test("rejects empty transport bindings before external I/O", () => {
  let clientCalls = 0;
  expect(() => createAgentMessengerKakaoReader({
    bindings: [{ ...binding, transport_account_id: "", transport_chat_id: "" }],
    page_size: 2,
    createClient: async () => {
      clientCalls += 1;
      throw new Error("must not run");
    },
  })).toThrow("transport account/chat identifiers must be non-empty strings");
  expect(clientCalls).toBe(0);
});

test("does not expose external client errors", async () => {
  const reader = createAgentMessengerKakaoReader({
    bindings: [binding],
    page_size: 2,
    createClient: async () => { throw new Error("private transport marker"); },
  });

  await expect(reader(request)).rejects.toThrow("Kakao transport read failed");
  await expect(reader(request)).rejects.not.toThrow("private transport marker");
});

test("bounds source I/O at the invocation clock while preserving the exact response interval", async () => {
  const calls: unknown[] = [];
  const reader = createAgentMessengerKakaoReader({
    bindings: [binding],
    page_size: 10,
    createClient: async () => ({
      async getMessagePage(chatId, options) {
        calls.push({ chatId, options });
        return {
          messages: [
            { log_id: "before-from", author_id: 1, message: "before", sent_at: 9 },
            { log_id: "at-from", author_id: 2, message: "first", sent_at: 10 },
            { log_id: "before-upper", author_id: 3, message: "last", sent_at: 99 },
            { log_id: "at-upper", author_id: 4, message: "upper", sent_at: 100 },
            { log_id: "after-upper", author_id: 5, message: "after", sent_at: 149 },
          ],
          next_cursor: "private-unmeasured-cursor",
          complete: false,
        };
      },
      close() {},
    }),
  });
  const worker = createKakaoLocalReadWorker({
    binding_id: "kakao-local-alpha",
    allowed_chat: {
      v: 1,
      kind: "chat",
      platform: "kakao",
      account: binding.account,
      chat_id: binding.chat_id,
    },
    measurement: {
      schema_version: "kakao-contrib-read-measurement/v1",
      kind: "kakao-read-field-measurement",
      status: "VALIDATED",
      observation: "observed",
      source: "authorized-live-measurement",
      observed_at: 90,
      send: false,
      supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body", "revision"],
    },
    max_measurement_age: 20,
    max_items: 5,
    max_raw_bytes: 65_536,
    now: () => 100,
    reader,
  });

  const response = await worker.handle({
    v: 1,
    type: "worker_request",
    request_id: "interval-page-request",
    generation: 7,
    binding_id: "kakao-local-alpha",
    limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 1 },
    operation: {
      op: "read_page",
      chat: {
        v: 1,
        kind: "chat",
        platform: "kakao",
        account: binding.account,
        chat_id: binding.chat_id,
      },
      interval: { from_ts: 10, to_ts: 150 },
      limit: 5,
      cursor: null,
    },
  });

  expect(calls).toEqual([{
    chatId: binding.transport_chat_id,
    options: { count: 5 },
  }]);
  expect(response).toMatchObject({
    operation: "read_page",
    ok: true,
    result: {
      next_cursor: null,
      authoritative: false,
      items: [{
        interval: { from_ts: 10, to_ts: 150 },
        messages: [
          { message: { key: { msg_id: "at-from" } } },
          { message: { key: { msg_id: "before-upper" } } },
        ],
        coverage: [],
        limits: [{ interval: { from_ts: 10, to_ts: 150 }, reason: "unsupported" }],
        next_cursor: null,
        authoritative: false,
      }],
    },
  });
});
