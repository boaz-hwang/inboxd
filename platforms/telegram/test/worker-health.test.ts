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

const binding = {
  binding_id: "telegram-primary",
  account: "account:primary",
  self_user_id: "777000",
  chat_ids: ["telegram:chat:-1001234567890"],
} as const;

const healthRequest = (bindingId: string = binding.binding_id): WorkerRequestForOperationV1<"health"> => ({
  v: 1,
  type: "worker_request",
  request_id: "health-1",
  generation: 3,
  binding_id: bindingId,
  limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 8 },
  operation: { op: "health" },
});

class HealthPort implements TdlibUserClientPort {
  readonly availability = { available: true } as const;
  getMeCalls = 0;

  constructor(
    private readonly authorizationState: TdlibAuthorizationState,
    private readonly selfId: string = binding.self_user_id,
  ) {}

  async getAuthorizationState(): Promise<TdlibAuthorizationState> {
    return this.authorizationState;
  }

  async getMe(): Promise<TdlibUser> {
    this.getMeCalls += 1;
    return { "@type": "user", id: this.selfId };
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

  async getMessage(_chatId: string, _messageId: string): Promise<TdlibMessage> {
    throw new Error("unexpected getMessage");
  }
}

describe("Telegram worker health and account authentication", () => {
  test("reports ready only after TDLib ready and exact getMe account binding", async () => {
    const port = new HealthPort({ "@type": "authorizationStateReady" });
    const worker = createTelegramWorkerCore({ binding, port, now: () => 100 });

    await expect(worker.health(healthRequest())).resolves.toEqual({
      v: 1,
      type: "worker_response",
      request_id: "health-1",
      generation: 3,
      operation: "health",
      ok: true,
      result: {
        state: "ready",
        auth: { state: "authenticated", reason: null, observed_at: 100 },
      },
    });
    expect(port.getMeCalls).toBe(1);
  });

  test("reports interactive login states as degraded without treating them as a user session", async () => {
    const port = new HealthPort({ "@type": "authorizationStateWaitPassword" });
    const worker = createTelegramWorkerCore({ binding, port, now: () => 101 });

    await expect(worker.health(healthRequest())).resolves.toMatchObject({
      ok: true,
      result: {
        state: "degraded",
        auth: {
          state: "unauthenticated",
          reason: "authorizationStateWaitPassword",
          observed_at: 101,
        },
      },
    });
    expect(port.getMeCalls).toBe(0);
  });

  test("fails closed when the TDLib session belongs to another user", async () => {
    const port = new HealthPort({ "@type": "authorizationStateReady" }, "888000");
    const worker = createTelegramWorkerCore({ binding, port, now: () => 102 });

    await expect(worker.health(healthRequest())).resolves.toMatchObject({
      ok: true,
      result: {
        state: "unavailable",
        auth: { state: "unknown", reason: "tdlib_account_scope_mismatch", observed_at: 102 },
      },
    });
  });

  test("rejects a binding mismatch before any TDLib call", async () => {
    const port = new HealthPort({ "@type": "authorizationStateReady" });
    const worker = createTelegramWorkerCore({ binding, port, now: () => 103 });

    await expect(worker.health(healthRequest("telegram-other"))).resolves.toMatchObject({
      ok: false,
      error: { code: "TELEGRAM_SCOPE_MISMATCH", retryable: false, may_have_sent: false },
    });
    expect(port.getMeCalls).toBe(0);
  });

  test("reports a missing TDLib runtime pack as unavailable", async () => {
    const port: TdlibUserClientPort = {
      availability: { available: false, reason: "missing TDLib runtime pack" },
      async getAuthorizationState() { throw new Error("must not be called"); },
      async getMe() { throw new Error("must not be called"); },
      async getChat() { throw new Error("must not be called"); },
      async getChatHistory() { throw new Error("must not be called"); },
      async sendTextMessage() { throw new Error("must not be called"); },
      async getMessage() { throw new Error("must not be called"); },
    };
    const worker = createTelegramWorkerCore({ binding, port, now: () => 104 });

    await expect(worker.health(healthRequest())).resolves.toMatchObject({
      ok: true,
      result: {
        state: "unavailable",
        auth: { state: "unknown", reason: "missing TDLib runtime pack", observed_at: 104 },
      },
    });
  });
});
