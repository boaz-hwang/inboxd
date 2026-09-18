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
const receiptId = `telegram:message:${rawChatId}:600`;
const parentId = `telegram:message:${rawChatId}:500`;
const body = "receipt body";
const binding = {
  binding_id: "telegram-primary",
  account: "account:primary",
  self_user_id: selfUserId,
  chat_ids: [chatId],
} as const;
const destination = { v: 1, kind: "chat", platform: "telegram", account: binding.account, chat_id: chatId } as const;

function receiptMessage(overrides: Record<string, unknown> = {}): TdlibMessage {
  return {
    "@type": "message",
    id: "600",
    chat_id: rawChatId,
    sender_id: { "@type": "messageSenderUser", user_id: selfUserId },
    date: 90,
    is_outgoing: true,
    reply_to: { "@type": "messageReplyToMessage", chat_id: rawChatId, message_id: "500" },
    content: {
      "@type": "messageText",
      text: { "@type": "formattedText", text: body, entities: [] },
    },
    ...overrides,
  };
}

function receiptRequest(input: {
  requestDestination?: WorkerRequestForOperationV1<"read_receipt">["operation"]["destination"];
  requestedReceiptId?: string;
  expectedBody?: string;
  reply?: { readonly parent_id: string };
} = {}): WorkerRequestForOperationV1<"read_receipt"> {
  const requestDestination = input.requestDestination ?? destination;
  return {
    v: 1,
    type: "worker_request",
    request_id: "receipt-1",
    generation: 6,
    binding_id: binding.binding_id,
    limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 8 },
    operation: {
      op: "read_receipt",
      destination: requestDestination,
      receipt_id: input.requestedReceiptId ?? receiptId,
      expected: {
        v: 2,
        destination: requestDestination,
        content: { mode: "text", body: input.expectedBody ?? body },
        reply: input.reply ?? { parent_id: parentId },
      },
    },
  };
}

class ReceiptPort implements TdlibUserClientPort {
  readonly availability = { available: true } as const;
  readonly calls: Array<{ readonly chatId: string; readonly messageId: string }> = [];

  constructor(
    private readonly handler: (chatId: string, messageId: string) => Promise<TdlibMessage>,
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

  async sendTextMessage(_request: TdlibSendTextRequest): Promise<TdlibMessage> {
    throw new Error("unexpected sendTextMessage");
  }

  async getMessage(chatId: string, messageId: string): Promise<TdlibMessage> {
    this.calls.push({ chatId, messageId });
    return this.handler(chatId, messageId);
  }
}

describe("Telegram independent receipt readback", () => {
  test("verifies only an independently read exact destination, receipt, text, and reply", async () => {
    const port = new ReceiptPort(async () => receiptMessage());
    const worker = createTelegramWorkerCore({ binding, port, now: () => 140 });

    await expect(worker.readReceipt(receiptRequest())).resolves.toEqual({
      v: 1,
      type: "worker_response",
      request_id: "receipt-1",
      generation: 6,
      operation: "read_receipt",
      ok: true,
      result: {
        outcome: "verified",
        evidence: {
          destination,
          receipt_id: receiptId,
          content: { mode: "text", body },
          reply: { parent_id: parentId },
        },
      },
    });
    expect(port.calls).toEqual([{ chatId: rawChatId, messageId: "600" }]);
  });

  test("returns not_found only for a definite TDLib 404", async () => {
    const port = new ReceiptPort(async () => {
      throw new TdlibCallError(404, "Message not found", false);
    });
    const worker = createTelegramWorkerCore({ binding, port, now: () => 141 });

    await expect(worker.readReceipt(receiptRequest())).resolves.toMatchObject({
      ok: true,
      result: { outcome: "not_found" },
    });
    expect(port.calls).toHaveLength(1);
  });

  test("does not promote mismatched body, reply, receipt, sender, chat, or sending state", async () => {
    const mismatches = [
      receiptMessage({
        content: { "@type": "messageText", text: { "@type": "formattedText", text: "changed", entities: [] } },
      }),
      receiptMessage({
        reply_to: { "@type": "messageReplyToMessage", chat_id: rawChatId, message_id: "501" },
      }),
      receiptMessage({ id: "601" }),
      receiptMessage({ sender_id: { "@type": "messageSenderUser", user_id: "888000" } }),
      receiptMessage({ chat_id: otherRawChatId }),
      receiptMessage({ sending_state: { "@type": "messageSendingStatePending", sending_id: 1 } }),
      receiptMessage({
        sending_state: { "@type": "messageSendingStateFailed", error: { code: 500, message: "failed" } },
      }),
    ];

    for (const mismatch of mismatches) {
      const port = new ReceiptPort(async () => mismatch);
      const worker = createTelegramWorkerCore({ binding, port, now: () => 142 });
      await expect(worker.readReceipt(receiptRequest())).resolves.toMatchObject({
        ok: true,
        result: { outcome: "unavailable", reason: "receipt_mismatch" },
      });
      expect(port.calls).toHaveLength(1);
    }
  });

  test("rejects receipt scope mismatches before TDLib readback", async () => {
    const port = new ReceiptPort(async () => receiptMessage());
    const worker = createTelegramWorkerCore({ binding, port, now: () => 143 });
    const otherDestination = { ...destination, chat_id: `telegram:chat:${otherRawChatId}` };

    for (const request of [
      receiptRequest({ requestDestination: otherDestination }),
      receiptRequest({ requestedReceiptId: `telegram:message:${otherRawChatId}:600` }),
      { ...receiptRequest(), binding_id: "telegram-other" },
    ]) {
      await expect(worker.readReceipt(request as WorkerRequestForOperationV1<"read_receipt">)).resolves.toMatchObject({
        ok: false,
        error: { code: "TELEGRAM_SCOPE_MISMATCH", retryable: false, may_have_sent: false },
      });
    }
    expect(port.calls).toEqual([]);
  });

  test("returns unavailable on an inconclusive TDLib read failure", async () => {
    const port = new ReceiptPort(async () => {
      throw new Error("connection lost");
    });
    const worker = createTelegramWorkerCore({ binding, port, now: () => 144 });

    await expect(worker.readReceipt(receiptRequest())).resolves.toMatchObject({
      ok: true,
      result: { outcome: "unavailable", reason: "tdlib_readback_failed" },
    });
    expect(port.calls).toHaveLength(1);
  });
});
