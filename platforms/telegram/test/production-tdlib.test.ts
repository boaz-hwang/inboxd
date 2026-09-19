import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  MISSING_TDLIB_PRODUCTION_PACK_REASON,
  createProductionTdlibPort,
} from "../src/production-tdlib.ts";
import { createTelegramWorkerCore } from "../src/worker-core.ts";

const options = {
  apiId: 12345,
  apiHash: "0123456789abcdef0123456789abcdef",
  databaseDirectory: "/private/telegram-db",
  filesDirectory: "/private/telegram-files",
  databaseEncryptionKey: "database-secret",
} as const;

describe("Telegram production TDLib adapter", () => {
  test("fails closed with a deterministic non-secret reason when the TDLib pack is unavailable", async () => {
    const loaderSecret = "loader leaked api_hash=forbidden";
    const port = await createProductionTdlibPort({
      ...options,
      loadModule: async () => { throw new Error(loaderSecret); },
    });

    expect(port.availability).toEqual({
      available: false,
      reason: MISSING_TDLIB_PRODUCTION_PACK_REASON,
    });
    expect(JSON.stringify(port.availability)).not.toContain(options.apiHash);
    expect(JSON.stringify(port.availability)).not.toContain(options.databaseEncryptionKey);
    expect(JSON.stringify(port.availability)).not.toContain(loaderSecret);
    await expect(port.getAuthorizationState()).rejects.toThrow(MISSING_TDLIB_PRODUCTION_PACK_REASON);
  });

  test("adapts an injected tdl user client without Bot API or console logging", async () => {
    const queries: Record<string, unknown>[] = [];
    const configurations: unknown[] = [];
    const clientOptions: unknown[] = [];
    let closeCalls = 0;
    const client = {
      async invoke(query: Record<string, unknown>): Promise<unknown> {
        queries.push(query);
        switch (query._) {
          case "getAuthorizationState": return { _: "authorizationStateReady" };
          case "getMe": return { _: "user", id: 777000 };
          case "getChat": return { _: "chat", id: query.chat_id, unread_count: 4 };
          case "getChatHistory": return { _: "messages", messages: [] };
          case "sendMessage": return {
            _: "message",
            id: 600,
            chat_id: query.chat_id,
            sender_id: { _: "messageSenderUser", user_id: 777000 },
            date: 90,
            is_outgoing: true,
            reply_to: { _: "messageReplyToMessage", chat_id: query.chat_id, message_id: 500 },
            content: { _: "messageText", text: { _: "formattedText", text: "exact", entities: [] } },
          };
          case "getMessage": return {
            _: "message",
            id: query.message_id,
            chat_id: query.chat_id,
            sender_id: { _: "messageSenderUser", user_id: 777000 },
            date: 90,
            is_outgoing: true,
            content: { _: "messageText", text: { _: "formattedText", text: "exact", entities: [] } },
          };
          default: throw new Error("unexpected query");
        }
      },
      async close(): Promise<void> { closeCalls += 1; },
    };
    const modules: Record<string, unknown> = {
      tdl: {
        configure(value: unknown) { configurations.push(value); },
        createClient(value: unknown) { clientOptions.push(value); return client; },
      },
      "prebuilt-tdlib": { getTdjson: () => "/runtime/libtdjson.dylib" },
    };
    const consoleError = console.error;
    let consoleCalls = 0;
    console.error = () => { consoleCalls += 1; };
    try {
      const port = await createProductionTdlibPort({
        ...options,
        loadModule: async (specifier) => modules[specifier],
      });

      expect(port.availability).toEqual({ available: true });
      await expect(port.getAuthorizationState()).resolves.toEqual({ "@type": "authorizationStateReady" });
      await expect(port.getMe()).resolves.toEqual({ "@type": "user", id: 777000 });
      await expect(port.getChat("-1001234567890")).resolves.toMatchObject({
        "@type": "chat",
        id: -1001234567890,
        unread_count: 4,
      });
      await expect(port.getChatHistory({
        chat_id: "-1001234567890",
        from_message_id: "0",
        offset: 0,
        limit: 10,
        only_local: false,
      })).resolves.toEqual([]);
      await expect(port.sendTextMessage({
        chat_id: "-1001234567890",
        text: "exact",
        reply_to_message_id: "500",
        timeout_ms: 1_000,
      })).resolves.toMatchObject({
        "@type": "message",
        id: 600,
        content: { "@type": "messageText" },
      });
      await expect(port.getMessage("-1001234567890", "600")).resolves.toMatchObject({
        "@type": "message",
        id: 600,
      });
      await port.close?.();
    } finally {
      console.error = consoleError;
    }

    expect(configurations).toEqual([{ tdjson: "/runtime/libtdjson.dylib" }]);
    expect(clientOptions).toEqual([{
      apiId: options.apiId,
      apiHash: options.apiHash,
      databaseDirectory: options.databaseDirectory,
      filesDirectory: options.filesDirectory,
      databaseEncryptionKey: options.databaseEncryptionKey,
    }]);
    expect(queries).toContainEqual({ _: "getAuthorizationState" });
    expect(queries).toContainEqual({
      _: "sendMessage",
      chat_id: -1001234567890,
      topic_id: null,
      reply_to: { _: "inputMessageReplyToMessage", message_id: 500, quote: null, checklist_task_id: 0 },
      options: null,
      reply_markup: null,
      input_message_content: {
        _: "inputMessageText",
        text: { _: "formattedText", text: "exact", entities: [] },
        link_preview_options: null,
        clear_draft: false,
      },
    });
    expect(closeCalls).toBe(1);
    expect(consoleCalls).toBe(0);
  });

  test("correlates a pending send with the exact success update chat and temporary message id", async () => {
    const rawChatId = -1001234567890;
    const temporaryMessageId = -600;
    const finalMessage = {
      _: "message",
      id: 600,
      chat_id: rawChatId,
      sender_id: { _: "messageSenderUser", user_id: 777000 },
      date: 90,
      is_outgoing: true,
      content: { _: "messageText", text: { _: "formattedText", text: "exact", entities: [] } },
    };
    class PendingClient extends EventEmitter {
      async invoke(query: Record<string, unknown>): Promise<unknown> {
        if (query._ !== "sendMessage") throw new Error("unexpected query");
        queueMicrotask(() => {
          this.emit("update", {
            _: "updateMessageSendSucceeded",
            old_message_id: temporaryMessageId,
            message: { ...finalMessage, chat_id: -1009876543210 },
          });
          this.emit("update", {
            _: "updateMessageSendSucceeded",
            old_message_id: temporaryMessageId - 1,
            message: finalMessage,
          });
          this.emit("update", {
            _: "updateMessageSendSucceeded",
            old_message_id: temporaryMessageId,
            message: finalMessage,
          });
        });
        return {
          ...finalMessage,
          id: temporaryMessageId,
          sending_state: { _: "messageSendingStatePending", sending_id: 91 },
        };
      }
    }
    const client = new PendingClient();
    const modules: Record<string, unknown> = {
      tdl: { configure() {}, createClient: () => client },
      "prebuilt-tdlib": { getTdjson: () => "/runtime/libtdjson.dylib" },
    };
    const port = await createProductionTdlibPort({
      ...options,
      loadModule: async (specifier) => modules[specifier],
    });

    const result = await port.sendTextMessage({
      chat_id: String(rawChatId),
      text: "exact",
      reply_to_message_id: null,
      timeout_ms: 100,
    });
    expect(result).toMatchObject({
      "@type": "message",
      id: 600,
      chat_id: rawChatId,
    });
    expect(result.sending_state).toBeUndefined();
    await port.close?.();
    expect(client.listenerCount("update")).toBe(0);
  });

  test("correlates the exact failed update as a definite failure without retrying the send", async () => {
    const rawChatId = -1001234567890;
    const temporaryMessageId = -700;
    let invokeCalls = 0;
    class FailedClient extends EventEmitter {
      async invoke(query: Record<string, unknown>): Promise<unknown> {
        if (query._ !== "sendMessage") throw new Error("unexpected query");
        invokeCalls += 1;
        queueMicrotask(() => {
          this.emit("update", {
            _: "updateMessageSendFailed",
            old_message_id: temporaryMessageId - 1,
            message: { _: "message", id: temporaryMessageId - 1, chat_id: rawChatId },
            error: { _: "error", code: 429, message: "wrong pending message" },
          });
          this.emit("update", {
            _: "updateMessageSendFailed",
            old_message_id: temporaryMessageId,
            message: { _: "message", id: temporaryMessageId, chat_id: rawChatId },
            error: { _: "error", code: 400, message: "send failed" },
          });
        });
        return {
          _: "message",
          id: temporaryMessageId,
          chat_id: rawChatId,
          sending_state: { _: "messageSendingStatePending", sending_id: 92 },
        };
      }
    }
    const client = new FailedClient();
    const modules: Record<string, unknown> = {
      tdl: { configure() {}, createClient: () => client },
      "prebuilt-tdlib": { getTdjson: () => "/runtime/libtdjson.dylib" },
    };
    const port = await createProductionTdlibPort({
      ...options,
      loadModule: async (specifier) => modules[specifier],
    });

    let caught: unknown;
    try {
      await port.sendTextMessage({
        chat_id: String(rawChatId),
        text: "exact",
        reply_to_message_id: null,
        timeout_ms: 20,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({
      name: "TdlibCallError",
      code: 400,
      mayHaveSent: false,
      message: "TDLib reported that the send failed",
    }));
    expect(invokeCalls).toBe(1);
    await port.close?.();
  });

  test("reports an unmatched pending-send timeout as ambiguous and never retries", async () => {
    const rawChatId = "-1001234567890";
    const chatId = `telegram:chat:${rawChatId}`;
    const temporaryMessageId = -800;
    let sendCalls = 0;
    class TimedOutClient extends EventEmitter {
      async invoke(query: Record<string, unknown>): Promise<unknown> {
        if (query._ === "getAuthorizationState") return { _: "authorizationStateReady" };
        if (query._ === "getMe") return { _: "user", id: 777000 };
        if (query._ !== "sendMessage") throw new Error("unexpected query");
        sendCalls += 1;
        queueMicrotask(() => {
          this.emit("update", {
            _: "updateMessageSendSucceeded",
            old_message_id: temporaryMessageId,
            message: { _: "message", id: 800, chat_id: -1009876543210 },
          });
        });
        return {
          _: "message",
          id: temporaryMessageId,
          chat_id: Number(rawChatId),
          sending_state: { _: "messageSendingStatePending", sending_id: 93 },
        };
      }
    }
    const client = new TimedOutClient();
    const modules: Record<string, unknown> = {
      tdl: { configure() {}, createClient: () => client },
      "prebuilt-tdlib": { getTdjson: () => "/runtime/libtdjson.dylib" },
    };
    const port = await createProductionTdlibPort({
      ...options,
      loadModule: async (specifier) => modules[specifier],
    });
    const worker = createTelegramWorkerCore({
      binding: {
        binding_id: "telegram-primary",
        account: "account:primary",
        self_user_id: "777000",
        chat_ids: [chatId],
      },
      port,
      now: () => 301,
    });

    await expect(worker.send({
      v: 1,
      type: "worker_request",
      request_id: "send-timeout",
      generation: 1,
      binding_id: "telegram-primary",
      limits: { timeout_ms: 10, max_response_bytes: 65_536, max_queue_depth: 1 },
      operation: {
        op: "send",
        idempotency_key: "b".repeat(64),
        envelope: {
          v: 2,
          destination: {
            v: 1,
            kind: "chat",
            platform: "telegram",
            account: "account:primary",
            chat_id: chatId,
          },
          content: { mode: "text", body: "exact" },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "TELEGRAM_SEND_AMBIGUOUS",
        retryable: false,
        may_have_sent: true,
      },
    });
    expect(sendCalls).toBe(1);
    await port.close?.();
  });

  test("keeps a malformed post-dispatch TDLib response ambiguous at the worker boundary", async () => {
    const client = {
      async invoke(query: Record<string, unknown>): Promise<unknown> {
        if (query._ === "getAuthorizationState") return { _: "authorizationStateReady" };
        if (query._ === "getMe") return { _: "user", id: 777000 };
        if (query._ === "sendMessage") return { _: "ok" };
        throw new Error("unexpected query");
      },
    };
    const modules: Record<string, unknown> = {
      tdl: { configure() {}, createClient: () => client },
      "prebuilt-tdlib": { getTdjson: () => "/runtime/libtdjson.dylib" },
    };
    const port = await createProductionTdlibPort({
      ...options,
      loadModule: async (specifier) => modules[specifier],
    });
    const rawChatId = "-1001234567890";
    const chatId = `telegram:chat:${rawChatId}`;
    const binding = {
      binding_id: "telegram-primary",
      account: "account:primary",
      self_user_id: "777000",
      chat_ids: [chatId],
    } as const;
    const worker = createTelegramWorkerCore({ binding, port, now: () => 300 });

    await expect(worker.send({
      v: 1,
      type: "worker_request",
      request_id: "send-malformed",
      generation: 1,
      binding_id: binding.binding_id,
      limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 1 },
      operation: {
        op: "send",
        idempotency_key: "a".repeat(64),
        envelope: {
          v: 2,
          destination: {
            v: 1,
            kind: "chat",
            platform: "telegram",
            account: binding.account,
            chat_id: chatId,
          },
          content: { mode: "text", body: "exact" },
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "TELEGRAM_SEND_AMBIGUOUS",
        retryable: false,
        may_have_sent: true,
      },
    });
  });

  test("keeps internal and unknown coded post-dispatch errors ambiguous and non-retryable", async () => {
    for (const code of [406, 500, 777]) {
      let sendCalls = 0;
      const client = {
        async invoke(query: Record<string, unknown>): Promise<unknown> {
          if (query._ === "getAuthorizationState") return { _: "authorizationStateReady" };
          if (query._ === "getMe") return { _: "user", id: 777000 };
          if (query._ === "sendMessage") {
            sendCalls += 1;
            throw { code, message: "coded post-dispatch failure" };
          }
          throw new Error("unexpected query");
        },
      };
      const modules: Record<string, unknown> = {
        tdl: { configure() {}, createClient: () => client },
        "prebuilt-tdlib": { getTdjson: () => "/runtime/libtdjson.dylib" },
      };
      const port = await createProductionTdlibPort({
        ...options,
        loadModule: async (specifier) => modules[specifier],
      });
      const rawChatId = "-1001234567890";
      const chatId = `telegram:chat:${rawChatId}`;
      const binding = {
        binding_id: "telegram-primary",
        account: "account:primary",
        self_user_id: "777000",
        chat_ids: [chatId],
      } as const;
      const worker = createTelegramWorkerCore({ binding, port, now: () => 302 });

      await expect(worker.send({
        v: 1,
        type: "worker_request",
        request_id: `send-coded-${code}`,
        generation: 1,
        binding_id: binding.binding_id,
        limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 1 },
        operation: {
          op: "send",
          idempotency_key: String(code).padStart(64, "c"),
          envelope: {
            v: 2,
            destination: {
              v: 1,
              kind: "chat",
              platform: "telegram",
              account: binding.account,
              chat_id: chatId,
            },
            content: { mode: "text", body: "exact" },
          },
        },
      })).resolves.toMatchObject({
        ok: false,
        error: {
          code: "TELEGRAM_SEND_AMBIGUOUS",
          retryable: false,
          may_have_sent: true,
        },
      });
      expect(sendCalls).toBe(1);
      await port.close?.();
    }
  });
});

  test("document upload waits for the remote receipt, not the local pending message", async () => {
    const rawChatId = -1001234567890;
    const temporaryMessageId = -600;
    const finalMessage = {
      _: "message",
      id: 600,
      chat_id: rawChatId,
      sender_id: { _: "messageSenderUser", user_id: 777000 },
      date: 90,
      is_outgoing: true,
      content: { _: "messageText", text: { _: "formattedText", text: "exact", entities: [] } },
    };
    class PendingClient extends EventEmitter {
      async invoke(query: Record<string, unknown>): Promise<unknown> {
        if (query._ !== "sendMessage") throw new Error("unexpected query");
        expect(query.input_message_content).toMatchObject({ _: "inputMessageDocument", document: { _: "inputFileLocal", path: "/tmp/report.pdf" } });
        queueMicrotask(() => {
          this.emit("update", {
            _: "updateMessageSendSucceeded",
            old_message_id: temporaryMessageId,
            message: { ...finalMessage, chat_id: -1009876543210 },
          });
          this.emit("update", {
            _: "updateMessageSendSucceeded",
            old_message_id: temporaryMessageId - 1,
            message: finalMessage,
          });
          this.emit("update", {
            _: "updateMessageSendSucceeded",
            old_message_id: temporaryMessageId,
            message: finalMessage,
          });
        });
        return {
          ...finalMessage,
          id: temporaryMessageId,
          sending_state: { _: "messageSendingStatePending", sending_id: 91 },
        };
      }
    }
    const client = new PendingClient();
    const modules: Record<string, unknown> = {
      tdl: { configure() {}, createClient: () => client },
      "prebuilt-tdlib": { getTdjson: () => "/runtime/libtdjson.dylib" },
    };
    const port = await createProductionTdlibPort({
      ...options,
      loadModule: async (specifier) => modules[specifier],
    });

    const result = await port.sendDocumentMessage!({
      chat_id: String(rawChatId),
      path: "/tmp/report.pdf",
      timeout_ms: 100,
    });
    expect(result).toMatchObject({
      "@type": "message",
      id: 600,
      chat_id: rawChatId,
    });
    expect(result.sending_state).toBeUndefined();
    await port.close?.();
    expect(client.listenerCount("update")).toBe(0);
  });

test("account observers reuse TDLib updates, replay connection state and detach on close", async () => {
  const emitter = new EventEmitter();
  const port = await createProductionTdlibPort({
    ...options,
    loadModule: async specifier => specifier === "tdl" ? {
      configure() {},
      createClient: () => ({
        invoke: async () => ({ _: "authorizationStateReady" }),
        on: emitter.on.bind(emitter), off: emitter.off.bind(emitter), close: async () => {},
      }),
    } : { getTdjson: () => "/synthetic/libtdjson.dylib" },
  });
  emitter.emit("update", { _: "updateConnectionState", state: { _: "connectionStateReady" } });
  const updates: unknown[] = [];
  const stop = port.onAccountUpdate!(update => updates.push(update));
  expect(updates).toEqual([{ "@type": "updateConnectionState", state: { "@type": "connectionStateReady" } }]);
  emitter.emit("update", { _: "updateDeleteMessages", chat_id: 1, message_ids: [2] });
  expect(updates).toHaveLength(2);
  stop();
  emitter.emit("update", { _: "updateMessageContent", chat_id: 1, message_id: 2 });
  expect(updates).toHaveLength(2);
  await port.close!();
  expect(emitter.listenerCount("update")).toBe(0);
  expect(emitter.listenerCount("error")).toBe(0);
});
