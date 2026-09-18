import { describe, expect, test } from "bun:test";

import type { WorkerRequestForOperationV1 } from "../../../packages/protocol/src/schema.ts";
import { createTelegramWorkerCore } from "../src/worker-core.ts";
import type {
  TdlibAuthorizationState,
  TdlibChat,
  TdlibHistoryRequest,
  TdlibMessage,
  TdlibSendTextRequest,
  TdlibUser,
  TdlibUserClientPort,
} from "../src/tdlib-port.ts";

const rawChatId = "-1001234567890";
const chatId = `telegram:chat:${rawChatId}`;
const otherRawChatId = "-1009876543210";
const otherChatId = `telegram:chat:${otherRawChatId}`;
const selfUserId = "777000";
const binding = {
  binding_id: "telegram-primary",
  account: "account:primary",
  self_user_id: selfUserId,
  chat_ids: [chatId, otherChatId],
} as const;
const chat = { v: 1, kind: "chat", platform: "telegram", account: binding.account, chat_id: chatId } as const;
const interval = { from_ts: 10, to_ts: 100 } as const;

function tdMessage(id: string, date: number, overrides: Record<string, unknown> = {}): TdlibMessage {
  return {
    "@type": "message",
    id,
    chat_id: rawChatId,
    sender_id: { "@type": "messageSenderUser", user_id: "888000" },
    date,
    is_outgoing: false,
    content: {
      "@type": "messageText",
      text: { "@type": "formattedText", text: `body-${id}`, entities: [] },
    },
    ...overrides,
  };
}

function readRequest(input: {
  cursor?: string | null;
  requestChat?: WorkerRequestForOperationV1<"read_page">["operation"]["chat"];
  requestInterval?: { readonly from_ts: number; readonly to_ts: number };
  limit?: number;
} = {}): WorkerRequestForOperationV1<"read_page"> {
  return {
    v: 1,
    type: "worker_request",
    request_id: "read-1",
    generation: 4,
    binding_id: binding.binding_id,
    limits: { timeout_ms: 1_000, max_response_bytes: 1_048_576, max_queue_depth: 8 },
    operation: {
      op: "read_page",
      chat: input.requestChat ?? chat,
      interval: input.requestInterval ?? interval,
      limit: input.limit ?? 2,
      cursor: input.cursor ?? null,
    },
  };
}

class ReadPort implements TdlibUserClientPort {
  readonly availability = { available: true } as const;
  readonly calls: Array<{ readonly method: string; readonly input?: unknown }> = [];

  constructor(
    private readonly history: (request: TdlibHistoryRequest) => Promise<readonly TdlibMessage[]>,
    private readonly chatResult: TdlibChat = { "@type": "chat", id: rawChatId, unread_count: 2 },
    private readonly authorizationState: TdlibAuthorizationState = { "@type": "authorizationStateReady" },
  ) {}

  async getAuthorizationState(): Promise<TdlibAuthorizationState> {
    this.calls.push({ method: "getAuthorizationState" });
    return this.authorizationState;
  }

  async getMe(): Promise<TdlibUser> {
    this.calls.push({ method: "getMe" });
    return { "@type": "user", id: selfUserId };
  }

  async getChat(input: string): Promise<TdlibChat> {
    this.calls.push({ method: "getChat", input });
    return this.chatResult;
  }

  async getChatHistory(request: TdlibHistoryRequest): Promise<readonly TdlibMessage[]> {
    this.calls.push({ method: "getChatHistory", input: request });
    return this.history(request);
  }

  async sendTextMessage(_request: TdlibSendTextRequest): Promise<TdlibMessage> {
    throw new Error("unexpected sendTextMessage");
  }

  async getMessage(_chatId: string, _messageId: string): Promise<TdlibMessage> {
    throw new Error("unexpected getMessage");
  }
}

describe("Telegram bounded read_page", () => {
  test("normalizes exact chat messages, self identity, unread state, and a scoped cursor", async () => {
    const port = new ReadPort(async () => [
      tdMessage("200", 90, {
        sender_id: { "@type": "messageSenderUser", user_id: selfUserId },
        is_outgoing: true,
      }),
      tdMessage("100", 80, {
        reply_to: { "@type": "messageReplyToMessage", chat_id: rawChatId, message_id: "200" },
      }),
    ]);
    const worker = createTelegramWorkerCore({ binding, port, now: () => 120 });

    const response = await worker.readPage(readRequest());
    expect(response).toMatchObject({
      ok: true,
      result: { authoritative: false, next_cursor: expect.any(String) },
    });
    if (!response.ok) throw new Error("expected read success");
    expect(response.result.items).toHaveLength(1);
    const page = response.result.items[0];
    expect(page).toEqual({
      v: 1,
      mode: "bounded_history",
      chat,
      interval,
      messages: [
        {
          kind: "create",
          revision: { source: "adapter", value: "200" },
          message: {
            key: { platform: "telegram", account: binding.account, chat_id: chatId, msg_id: `telegram:message:${rawChatId}:200` },
            author_id: `telegram:user:${selfUserId}`,
            ts: 90,
            body: "body-200",
            attachments: [],
          },
        },
        {
          kind: "create",
          revision: { source: "adapter", value: "100" },
          message: {
            key: { platform: "telegram", account: binding.account, chat_id: chatId, msg_id: `telegram:message:${rawChatId}:100` },
            author_id: "telegram:user:888000",
            ts: 80,
            body: "body-100",
            parent_id: { platform: "telegram", account: binding.account, chat_id: chatId, msg_id: `telegram:message:${rawChatId}:200` },
            attachments: [],
          },
        },
      ],
      tombstones: [],
      identity: {
        chat: { platform: "telegram", account: binding.account, chat_id: chatId },
        status: "known",
        self_id: `telegram:user:${selfUserId}`,
        source: "authenticated_adapter",
        observed_at: 120,
      },
      unread: {
        chat: { platform: "telegram", account: binding.account, chat_id: chatId },
        status: "known",
        source: "platform",
        count: 2,
        observed_at: 120,
      },
      coverage: [],
      limits: [],
      next_cursor: response.result.next_cursor,
      authoritative: false,
      observed_at: 120,
    });
    expect(port.calls.at(-1)).toEqual({
      method: "getChatHistory",
      input: { chat_id: rawChatId, from_message_id: "0", offset: 0, limit: 2, only_local: false },
    });
  });

  test("paginates one TDLib page per call, enforces the half-open interval, and claims coverage only after crossing the lower bound", async () => {
    const pages = [
      [tdMessage("300", 100), tdMessage("200", 90)],
      [tdMessage("200", 90), tdMessage("100", 10)],
      [tdMessage("100", 10), tdMessage("50", 9)],
    ];
    const historyRequests: TdlibHistoryRequest[] = [];
    const port = new ReadPort(async (request) => {
      historyRequests.push(request);
      const page = pages.shift();
      if (page === undefined) throw new Error("unexpected extra page");
      return page;
    });
    const worker = createTelegramWorkerCore({ binding, port, now: () => 121 });

    const first = await worker.readPage(readRequest());
    if (!first.ok) throw new Error("expected first page");
    const firstPage = first.result.items[0]!;
    expect((firstPage.messages as unknown[]).map((event: any) => event.message.ts)).toEqual([90]);
    expect(firstPage.coverage).toEqual([]);
    expect(first.result.authoritative).toBe(false);

    const second = await worker.readPage(readRequest({ cursor: first.result.next_cursor }));
    if (!second.ok) throw new Error("expected second page");
    const secondPage = second.result.items[0]!;
    expect((secondPage.messages as unknown[]).map((event: any) => event.message.ts)).toEqual([10]);
    expect(secondPage.coverage).toEqual([]);

    const third = await worker.readPage(readRequest({ cursor: second.result.next_cursor }));
    if (!third.ok) throw new Error("expected terminal page");
    const thirdPage = third.result.items[0]!;
    expect(thirdPage.messages).toEqual([]);
    expect(third.result.next_cursor).toBeNull();
    expect(third.result.authoritative).toBe(true);
    expect(thirdPage.coverage).toEqual([{
      chat: { platform: "telegram", account: binding.account, chat_id: chatId },
      interval,
      kind: "backfill",
      collected_at: 121,
      mutations_verified_at: 121,
    }]);
    expect(historyRequests).toEqual([
      { chat_id: rawChatId, from_message_id: "0", offset: 0, limit: 2, only_local: false },
      { chat_id: rawChatId, from_message_id: "200", offset: 0, limit: 3, only_local: false },
      { chat_id: rawChatId, from_message_id: "100", offset: 0, limit: 3, only_local: false },
    ]);
  });

  test("rejects cursor and requested scope mismatches before any TDLib I/O", async () => {
    const port = new ReadPort(async () => [tdMessage("200", 90), tdMessage("100", 80)]);
    const worker = createTelegramWorkerCore({ binding, port, now: () => 122 });
    const first = await worker.readPage(readRequest());
    if (!first.ok || first.result.next_cursor === null) throw new Error("expected cursor");
    port.calls.splice(0);

    const otherChat = { ...chat, chat_id: otherChatId };
    for (const request of [
      readRequest({ cursor: first.result.next_cursor, requestChat: otherChat }),
      readRequest({ cursor: first.result.next_cursor, requestInterval: { from_ts: 11, to_ts: 100 } }),
      readRequest({ cursor: "not-a-telegram-cursor" }),
      { ...readRequest({ cursor: first.result.next_cursor }), binding_id: "telegram-other" },
      { ...readRequest({ cursor: first.result.next_cursor }), operation: { ...readRequest().operation, chat: { ...chat, platform: "slack" } } },
    ]) {
      await expect(worker.readPage(request as WorkerRequestForOperationV1<"read_page">)).resolves.toMatchObject({
        ok: false,
        error: { code: "TELEGRAM_SCOPE_MISMATCH", retryable: false, may_have_sent: false },
      });
    }
    expect(port.calls).toEqual([]);
  });

  test("rejects provider item overflow and a non-advancing continuation", async () => {
    const overflowingPort = new ReadPort(async () => [
      tdMessage("300", 90), tdMessage("200", 80), tdMessage("100", 70),
    ]);
    const overflowing = createTelegramWorkerCore({ binding, port: overflowingPort, now: () => 123 });
    await expect(overflowing.readPage(readRequest({ limit: 2 }))).resolves.toMatchObject({
      ok: false,
      error: { code: "TELEGRAM_PAGE_BOUND_EXCEEDED", retryable: false, may_have_sent: false },
    });

    let page = 0;
    const stuckPort = new ReadPort(async () => {
      page += 1;
      return page === 1 ? [tdMessage("200", 90), tdMessage("100", 80)] : [tdMessage("100", 80)];
    });
    const stuck = createTelegramWorkerCore({ binding, port: stuckPort, now: () => 124 });
    const first = await stuck.readPage(readRequest());
    if (!first.ok) throw new Error("expected first page");
    await expect(stuck.readPage(readRequest({ cursor: first.result.next_cursor }))).resolves.toMatchObject({
      ok: false,
      error: { code: "TELEGRAM_CURSOR_DID_NOT_ADVANCE", retryable: false, may_have_sent: false },
    });
  });

  test("rejects mismatched chat metadata and message scope rather than normalizing it", async () => {
    const wrongChat = new ReadPort(
      async () => [tdMessage("100", 80)],
      { "@type": "chat", id: otherRawChatId, unread_count: 0 },
    );
    const wrongChatWorker = createTelegramWorkerCore({ binding, port: wrongChat, now: () => 125 });
    await expect(wrongChatWorker.readPage(readRequest())).resolves.toMatchObject({
      ok: false,
      error: { code: "TELEGRAM_SCOPE_MISMATCH" },
    });
    expect(wrongChat.calls.some((call) => call.method === "getChatHistory")).toBe(false);

    const wrongMessage = new ReadPort(async () => [tdMessage("100", 80, { chat_id: otherRawChatId })]);
    const wrongMessageWorker = createTelegramWorkerCore({ binding, port: wrongMessage, now: () => 126 });
    await expect(wrongMessageWorker.readPage(readRequest())).resolves.toMatchObject({
      ok: false,
      error: { code: "TELEGRAM_SCOPE_MISMATCH" },
    });
  });
});
