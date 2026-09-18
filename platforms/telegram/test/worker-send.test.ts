import { describe, expect, test } from "bun:test";

import type { WorkerRequestForOperationV1 } from "../../../packages/protocol/src/schema.ts";
import { createTelegramWorkerCore } from "../src/worker-core.ts";
import {
  TdlibCallError,
  type TdlibAuthorizationState,
  type TdlibChat,
  type TdlibHistoryRequest,
  type TdlibMessage,
  type TdlibSendTextRequest,
  type TdlibUser,
  type TdlibUserClientPort,
} from "../src/tdlib-port.ts";

const rawChatId = "-1001234567890";
const chatId = `telegram:chat:${rawChatId}`;
const otherRawChatId = "-1009876543210";
const selfUserId = "777000";
const binding = {
  binding_id: "telegram-primary",
  account: "account:primary",
  self_user_id: selfUserId,
  chat_ids: [chatId],
} as const;
const destination = { v: 1, kind: "chat", platform: "telegram", account: binding.account, chat_id: chatId } as const;
const body = "exact text\n한🙂";
const parentId = `telegram:message:${rawChatId}:500`;

function sentMessage(overrides: Record<string, unknown> = {}): TdlibMessage {
  return {
    "@type": "message",
    id: "600",
    chat_id: rawChatId,
    sender_id: { "@type": "messageSenderUser", user_id: selfUserId },
    date: 90,
    is_outgoing: true,
    content: {
      "@type": "messageText",
      text: { "@type": "formattedText", text: body, entities: [] },
    },
    ...overrides,
  };
}

function sendRequest(input: {
  requestDestination?: WorkerRequestForOperationV1<"send">["operation"]["envelope"]["destination"];
  reply?: { readonly parent_id: string };
  text?: string;
} = {}): WorkerRequestForOperationV1<"send"> {
  return {
    v: 1,
    type: "worker_request",
    request_id: "send-1",
    generation: 5,
    binding_id: binding.binding_id,
    limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 8 },
    operation: {
      op: "send",
      idempotency_key: "a".repeat(64),
      envelope: {
        v: 2,
        destination: input.requestDestination ?? destination,
        content: { mode: "text", body: input.text ?? body },
        ...(input.reply === undefined ? {} : { reply: input.reply }),
      },
    },
  };
}

class SendPort implements TdlibUserClientPort {
  readonly availability = { available: true } as const;
  readonly calls: TdlibSendTextRequest[] = [];

  constructor(
    private readonly handler: (request: TdlibSendTextRequest) => Promise<TdlibMessage>,
    private readonly authorizationState: TdlibAuthorizationState = { "@type": "authorizationStateReady" },
  ) {}

  async getAuthorizationState(): Promise<TdlibAuthorizationState> {
    return this.authorizationState;
  }

  async getMe(): Promise<TdlibUser> {
    return { "@type": "user", id: selfUserId };
  }

  async getChat(_chatId: string): Promise<TdlibChat> {
    throw new Error("unexpected getChat");
  }

  async getChatHistory(_request: TdlibHistoryRequest): Promise<readonly TdlibMessage[]> {
    throw new Error("unexpected getChatHistory");
  }

  async sendTextMessage(request: TdlibSendTextRequest): Promise<TdlibMessage> {
    this.calls.push(request);
    return this.handler(request);
  }

  async getMessage(_chatId: string, _messageId: string): Promise<TdlibMessage> {
    throw new Error("unexpected getMessage");
  }
}

describe("Telegram exact text and reply send", () => {
  test("dispatches the exact text and same-chat reply once and returns the structural receipt", async () => {
    const port = new SendPort(async () => sentMessage({
      reply_to: { "@type": "messageReplyToMessage", chat_id: rawChatId, message_id: "500" },
    }));
    const worker = createTelegramWorkerCore({ binding, port, now: () => 130 });

    await expect(worker.send(sendRequest({ reply: { parent_id: parentId } }))).resolves.toEqual({
      v: 1,
      type: "worker_response",
      request_id: "send-1",
      generation: 5,
      operation: "send",
      ok: true,
      result: { outcome: "sent", receipt_id: `telegram:message:${rawChatId}:600` },
    });
    expect(port.calls).toEqual([{
      chat_id: rawChatId,
      text: body,
      reply_to_message_id: "500",
      timeout_ms: 1_000,
    }]);
  });

  test("sends a non-reply with an explicit null reply target without changing text bytes", async () => {
    const exact = "  leading\ntrailing  \ud800";
    const port = new SendPort(async () => sentMessage({
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: exact, entities: [] },
      },
    }));
    const worker = createTelegramWorkerCore({ binding, port, now: () => 131 });

    const response = await worker.send(sendRequest({ text: exact }));
    expect(response).toMatchObject({ ok: true, result: { outcome: "sent" } });
    expect(port.calls).toEqual([{
      chat_id: rawChatId,
      text: exact,
      reply_to_message_id: null,
      timeout_ms: 1_000,
    }]);
  });

  test("rejects destination and reply scope mismatches before TDLib send I/O", async () => {
    const port = new SendPort(async () => sentMessage());
    const worker = createTelegramWorkerCore({ binding, port, now: () => 132 });
    const otherDestination = { ...destination, chat_id: `telegram:chat:${otherRawChatId}` };

    for (const request of [
      sendRequest({ requestDestination: otherDestination }),
      sendRequest({ requestDestination: { ...destination, account: "account:other" } }),
      sendRequest({ requestDestination: { ...destination, platform: "slack" } }),
      sendRequest({ reply: { parent_id: `telegram:message:${otherRawChatId}:500` } }),
      { ...sendRequest(), binding_id: "telegram-other" },
    ]) {
      await expect(worker.send(request as WorkerRequestForOperationV1<"send">)).resolves.toMatchObject({
        ok: false,
        error: { code: "TELEGRAM_SCOPE_MISMATCH", retryable: false, may_have_sent: false },
      });
    }
    expect(port.calls).toEqual([]);
  });

  test("surfaces TDLib flood-wait as retryable only when the provider definitely rejected the send", async () => {
    const port = new SendPort(async () => {
      throw new TdlibCallError(429, "Too Many Requests: retry after 17", false);
    });
    const worker = createTelegramWorkerCore({ binding, port, now: () => 133 });

    await expect(worker.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "TELEGRAM_FLOOD_WAIT",
        message: "Too Many Requests: retry after 17",
        retryable: true,
        may_have_sent: false,
      },
    });
    expect(port.calls).toHaveLength(1);
  });

  test("marks transport ambiguity non-retryable and never attempts the send twice", async () => {
    const port = new SendPort(async () => {
      throw new Error("connection lost after dispatch");
    });
    const worker = createTelegramWorkerCore({ binding, port, now: () => 134 });

    await expect(worker.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "TELEGRAM_SEND_AMBIGUOUS",
        retryable: false,
        may_have_sent: true,
      },
    });
    expect(port.calls).toHaveLength(1);
  });

  test("treats a mismatched TDLib acknowledgement as possibly sent and does not retry", async () => {
    const port = new SendPort(async () => sentMessage({
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: "changed", entities: [] },
      },
    }));
    const worker = createTelegramWorkerCore({ binding, port, now: () => 135 });

    await expect(worker.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "TELEGRAM_SEND_AMBIGUOUS",
        retryable: false,
        may_have_sent: true,
      },
    });
    expect(port.calls).toHaveLength(1);
  });

  test("does not treat pending or failed TDLib sending states as a confirmed send", async () => {
    for (const sendingState of [
      { "@type": "messageSendingStatePending", sending_id: 1 },
      { "@type": "messageSendingStateFailed", error: { code: 500, message: "failed" } },
    ]) {
      const port = new SendPort(async () => sentMessage({ sending_state: sendingState }));
      const worker = createTelegramWorkerCore({ binding, port, now: () => 136 });

      await expect(worker.send(sendRequest())).resolves.toMatchObject({
        ok: false,
        error: {
          code: "TELEGRAM_SEND_AMBIGUOUS",
          retryable: false,
          may_have_sent: true,
        },
      });
      expect(port.calls).toHaveLength(1);
    }
  });
});
