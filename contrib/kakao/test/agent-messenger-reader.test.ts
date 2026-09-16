import { expect, test } from "bun:test";

import { createAgentMessengerKakaoReader } from "../src/agent-messenger-reader.ts";

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
    { chatId: binding.transport_chat_id, options: { count: 2 } },
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
