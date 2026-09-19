import type {
  JsonValue,
  WorkerRequestForOperationV1,
  WorkerResponseV1,
} from "../../../packages/protocol/src/schema.ts";
import { TelegramAuthStateMachine, type TelegramAuthObservation } from "./auth.ts";
import { normalizeTelegramMessage, TelegramNormalizationError } from "./normalization.ts";
import { TdlibCallError, type TdlibMessage, type TdlibUserClientPort } from "./tdlib-port.ts";

export interface TelegramWorkerBinding {
  readonly binding_id: string;
  readonly account: string;
  readonly self_user_id: string;
  readonly chat_ids: readonly string[];
}

export interface TelegramWorkerCoreOptions {
  readonly binding: TelegramWorkerBinding;
  readonly port: TdlibUserClientPort;
  readonly now: () => number;
}

export interface TelegramWorkerCore {
  health(request: WorkerRequestForOperationV1<"health">): Promise<WorkerResponseV1<"health">>;
  readPage(request: WorkerRequestForOperationV1<"read_page">): Promise<WorkerResponseV1<"read_page">>;
  send(request: WorkerRequestForOperationV1<"send">): Promise<WorkerResponseV1<"send">>;
  readReceipt(request: WorkerRequestForOperationV1<"read_receipt">): Promise<WorkerResponseV1<"read_receipt">>;
}

interface TelegramReadCursorV1 {
  readonly v: 1;
  readonly binding_id: string;
  readonly account: string;
  readonly chat_id: string;
  readonly from_ts: number;
  readonly to_ts: number;
  readonly from_message_id: string;
}

interface AuthenticatedSession {
  readonly observation: TelegramAuthObservation;
  readonly selfUserId: string;
}

class TelegramOperationError extends Error {
  readonly name = "TelegramOperationError";

  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function canonicalInt53(value: unknown, label: string, positive: boolean): string {
  let canonical: string;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    canonical = String(value);
  } else if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) {
    canonical = value;
  } else {
    throw new TelegramOperationError("TELEGRAM_MALFORMED_RESPONSE", `${label} must be a canonical TDLib int53`);
  }
  const parsed = BigInt(canonical);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new TelegramOperationError("TELEGRAM_MALFORMED_RESPONSE", `${label} exceeds TDLib int53 bounds`);
  }
  if (positive ? parsed <= 0n : parsed === 0n) {
    throw new TelegramOperationError("TELEGRAM_MALFORMED_RESPONSE", `${label} is outside the accepted TDLib identifier range`);
  }
  return canonical;
}

function finiteObservedAt(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    throw new TelegramOperationError(
      "TELEGRAM_CLOCK_INVALID",
      "Telegram worker clock must return finite non-negative seconds",
    );
  }
  return value;
}

function healthSuccess(
  request: WorkerRequestForOperationV1<"health">,
  state: "ready" | "degraded" | "unavailable",
  auth: TelegramAuthObservation["auth"],
): WorkerResponseV1<"health"> {
  return {
    v: 1,
    type: "worker_response",
    request_id: request.request_id,
    generation: request.generation,
    operation: "health",
    ok: true,
    result: { state, auth },
  };
}

function failure<O extends "health" | "read_page" | "send" | "read_receipt">(
  request: WorkerRequestForOperationV1<O>,
  code: string,
  message: string,
  retryable = false,
  mayHaveSent = false,
): WorkerResponseV1<O> {
  return {
    v: 1,
    type: "worker_response",
    request_id: request.request_id,
    generation: request.generation,
    operation: request.operation.op,
    ok: false,
    error: { code, message, retryable, may_have_sent: mayHaveSent },
  } as WorkerResponseV1<O>;
}

function rawChatId(stableChatId: string): string {
  const match = /^telegram:chat:(-?(?:0|[1-9]\d*))$/.exec(stableChatId);
  if (match === null) {
    throw new TelegramOperationError(
      "TELEGRAM_SCOPE_MISMATCH",
      "Telegram chat_id must be a stable telegram:chat TDLib identifier",
    );
  }
  return canonicalInt53(match[1], "Telegram chat_id", false);
}

function validateBinding(binding: TelegramWorkerBinding): TelegramWorkerBinding {
  if (typeof binding.binding_id !== "string" || binding.binding_id.length === 0) {
    throw new TypeError("Telegram binding_id must be non-empty");
  }
  if (typeof binding.account !== "string" || binding.account.length === 0) {
    throw new TypeError("Telegram account must be non-empty");
  }
  let self_user_id: string;
  try {
    self_user_id = canonicalInt53(binding.self_user_id, "Telegram self_user_id", true);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "Telegram self_user_id is invalid");
  }
  if (!Array.isArray(binding.chat_ids) || binding.chat_ids.length === 0) {
    throw new TypeError("Telegram binding requires at least one readable chat");
  }
  const chat_ids = [...binding.chat_ids];
  try {
    for (const chatId of chat_ids) rawChatId(chatId);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "Telegram chat binding is invalid");
  }
  if (new Set(chat_ids).size !== chat_ids.length) {
    throw new TypeError("Telegram binding contains a duplicate chat");
  }
  return { binding_id: binding.binding_id, account: binding.account, self_user_id, chat_ids };
}

function assertReadScope(
  request: WorkerRequestForOperationV1<"read_page">,
  binding: TelegramWorkerBinding,
): string {
  const { chat, interval, limit } = request.operation;
  if (request.binding_id !== binding.binding_id
    || chat.platform !== "telegram"
    || chat.account !== binding.account
    || !binding.chat_ids.includes(chat.chat_id)) {
    throw new TelegramOperationError(
      "TELEGRAM_SCOPE_MISMATCH",
      "read_page requires the exact configured Telegram binding, account, and chat",
    );
  }
  if (!Number.isFinite(interval.from_ts) || !Number.isFinite(interval.to_ts)
    || Math.abs(interval.from_ts) > Number.MAX_SAFE_INTEGER
    || Math.abs(interval.to_ts) > Number.MAX_SAFE_INTEGER
    || interval.from_ts >= interval.to_ts) {
    throw new TelegramOperationError("TELEGRAM_INTERVAL_INVALID", "read_page interval is invalid");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TelegramOperationError("TELEGRAM_PAGE_BOUND_EXCEEDED", "read_page limit must be 1..100");
  }
  return rawChatId(chat.chat_id);
}

const CURSOR_PREFIX = "telegram-cursor-v1.";
const CURSOR_KEYS = [
  "account",
  "binding_id",
  "chat_id",
  "from_message_id",
  "from_ts",
  "to_ts",
  "v",
] as const;

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${base64}${"=".repeat((4 - base64.length % 4) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeCursor(cursor: TelegramReadCursorV1): string {
  const encoded = `${CURSOR_PREFIX}${base64urlEncode(new TextEncoder().encode(JSON.stringify(cursor)))}`;
  if (new TextEncoder().encode(encoded).byteLength > 4_096) {
    throw new TelegramOperationError("TELEGRAM_CURSOR_INVALID", "Telegram cursor exceeds 4096 UTF-8 bytes");
  }
  return encoded;
}

function decodeCursor(
  value: string,
  request: WorkerRequestForOperationV1<"read_page">,
  binding: TelegramWorkerBinding,
): TelegramReadCursorV1 {
  if (!value.startsWith(CURSOR_PREFIX)) {
    throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "Telegram cursor format or scope mismatch");
  }
  const payload = value.slice(CURSOR_PREFIX.length);
  if (payload.length === 0 || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "Telegram cursor format or scope mismatch");
  }
  let decoded: unknown;
  try {
    const bytes = base64urlDecode(payload);
    if (base64urlEncode(bytes) !== payload) throw new Error("non-canonical base64url");
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "Telegram cursor format or scope mismatch");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "Telegram cursor format or scope mismatch");
  }
  const cursor = decoded as Record<string, unknown>;
  const keys = Object.keys(cursor).sort();
  if (keys.length !== CURSOR_KEYS.length || keys.some((key, index) => key !== CURSOR_KEYS[index])) {
    throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "Telegram cursor format or scope mismatch");
  }
  const scoped = cursor.v === 1
    && cursor.binding_id === binding.binding_id
    && cursor.account === binding.account
    && cursor.chat_id === request.operation.chat.chat_id
    && cursor.from_ts === request.operation.interval.from_ts
    && cursor.to_ts === request.operation.interval.to_ts;
  if (!scoped) {
    throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "Telegram cursor format or scope mismatch");
  }
  const from_message_id = canonicalInt53(cursor.from_message_id, "Telegram cursor message id", true);
  return {
    v: 1,
    binding_id: binding.binding_id,
    account: binding.account,
    chat_id: request.operation.chat.chat_id,
    from_ts: request.operation.interval.from_ts,
    to_ts: request.operation.interval.to_ts,
    from_message_id,
  };
}

function readFailure(
  request: WorkerRequestForOperationV1<"read_page">,
  error: unknown,
): WorkerResponseV1<"read_page"> {
  if (error instanceof TelegramOperationError) {
    return failure(request, error.code, error.message, error.retryable);
  }
  if (error instanceof TdlibCallError && error.code === 429) {
    return failure(request, "TELEGRAM_FLOOD_WAIT", error.message, true);
  }
  return failure(request, "TELEGRAM_READ_FAILED", "TDLib history read failed", false);
}

function rawMessageFields(raw: unknown, expectedChatId: string): {
  readonly raw: TdlibMessage;
  readonly id: string;
  readonly date: number;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TelegramOperationError("TELEGRAM_MALFORMED_PAGE", "TDLib history item must be a message object");
  }
  const message = raw as TdlibMessage;
  if (message["@type"] !== "message") {
    throw new TelegramOperationError("TELEGRAM_MALFORMED_PAGE", "TDLib history item must be a message");
  }
  const chatId = canonicalInt53(message.chat_id, "TDLib message chat_id", false);
  if (chatId !== expectedChatId) {
    throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "TDLib history returned a message from another chat");
  }
  const id = canonicalInt53(message.id, "TDLib message id", true);
  if (typeof message.date !== "number" || !Number.isInteger(message.date)
    || message.date < 0 || message.date > 2_147_483_647) {
    throw new TelegramOperationError("TELEGRAM_MALFORMED_PAGE", "TDLib message date is invalid");
  }
  return { raw: message, id, date: message.date };
}

function messageEvent(
  raw: TdlibMessage,
  account: string,
): { readonly [key: string]: JsonValue } {
  let normalized;
  try {
    normalized = normalizeTelegramMessage(raw);
  } catch (error) {
    const code = error instanceof TelegramNormalizationError && error.code === "UNSUPPORTED_CONTENT"
      ? "TELEGRAM_UNSUPPORTED_CONTENT"
      : "TELEGRAM_MALFORMED_PAGE";
    throw new TelegramOperationError(code, error instanceof Error ? error.message : "TDLib message is malformed");
  }
  const key = {
    platform: "telegram",
    account,
    chat_id: normalized.chat_id,
    msg_id: normalized.message_id,
  };
  return {
    kind: "create",
    // A message ID identifies a message, not its mutation order. The daemon's
    // page CAS serializes observations; equal IDs must not suppress edits.
    revision: { source: "observation", value: "unversioned" },
    message: {
      key,
      author_id: normalized.sender.id,
      ts: normalized.timestamp,
      body: normalized.body,
      ...(normalized.reply_to === null ? {} : {
        parent_id: {
          platform: "telegram",
          account,
          chat_id: normalized.reply_to.chat_id,
          msg_id: normalized.reply_to.message_id,
        },
      }),
      attachments: [],
    },
  };
}

function rawMessageId(stableMessageId: string, expectedRawChatId: string): string {
  const prefix = `telegram:message:${expectedRawChatId}:`;
  if (!stableMessageId.startsWith(prefix)) {
    throw new TelegramOperationError(
      "TELEGRAM_SCOPE_MISMATCH",
      "Telegram reply or receipt message is outside the requested chat",
    );
  }
  return canonicalInt53(stableMessageId.slice(prefix.length), "Telegram message id", true);
}

function assertSendScope(
  request: WorkerRequestForOperationV1<"send">,
  binding: TelegramWorkerBinding,
): { readonly chatId: string; readonly replyMessageId: string | null; readonly body: string } {
  const { envelope } = request.operation;
  const destination = envelope.destination;
  if (request.binding_id !== binding.binding_id
    || destination.kind !== "chat"
    || destination.platform !== "telegram"
    || destination.account !== binding.account
    || !binding.chat_ids.includes(destination.chat_id)
    || envelope.content.mode !== "text") {
    throw new TelegramOperationError(
      "TELEGRAM_SCOPE_MISMATCH",
      "send requires the exact configured Telegram binding, account, and readable chat",
    );
  }
  if (typeof envelope.content.body !== "string" || envelope.content.body.length === 0
    || new TextEncoder().encode(envelope.content.body).byteLength > 65_536) {
    throw new TelegramOperationError("TELEGRAM_SEND_INVALID", "Telegram text body is invalid");
  }
  const chatId = rawChatId(destination.chat_id);
  const replyMessageId = envelope.reply === undefined
    ? null
    : rawMessageId(envelope.reply.parent_id, chatId);
  return { chatId, replyMessageId, body: envelope.content.body };
}

function validateSentAcknowledgement(input: {
  readonly raw: TdlibMessage;
  readonly expectedRawChatId: string;
  readonly expectedBody: string;
  readonly expectedReplyMessageId: string | null;
  readonly selfUserId: string;
}): string {
  rawMessageFields(input.raw, input.expectedRawChatId);
  if (input.raw.is_outgoing !== true) {
    throw new TelegramOperationError("TELEGRAM_SEND_ACK_MISMATCH", "TDLib send acknowledgement is not outgoing");
  }
  if (input.raw.sending_state !== undefined && input.raw.sending_state !== null) {
    throw new TelegramOperationError(
      "TELEGRAM_SEND_ACK_MISMATCH",
      "TDLib send acknowledgement is not confirmed",
    );
  }
  let normalized;
  try {
    normalized = normalizeTelegramMessage(input.raw);
  } catch {
    throw new TelegramOperationError("TELEGRAM_SEND_ACK_MISMATCH", "TDLib send acknowledgement is malformed");
  }
  const expectedReplyId = input.expectedReplyMessageId === null
    ? null
    : `telegram:message:${input.expectedRawChatId}:${input.expectedReplyMessageId}`;
  if (normalized.chat_id !== `telegram:chat:${input.expectedRawChatId}`
    || normalized.sender.kind !== "user"
    || normalized.sender.id !== `telegram:user:${input.selfUserId}`
    || normalized.body !== input.expectedBody
    || (normalized.reply_to?.message_id ?? null) !== expectedReplyId
    || (normalized.reply_to !== null
      && normalized.reply_to.chat_id !== `telegram:chat:${input.expectedRawChatId}`)) {
    throw new TelegramOperationError(
      "TELEGRAM_SEND_ACK_MISMATCH",
      "TDLib send acknowledgement did not match the exact send",
    );
  }
  return normalized.message_id;
}

function assertReceiptScope(
  request: WorkerRequestForOperationV1<"read_receipt">,
  binding: TelegramWorkerBinding,
): {
  readonly chatId: string;
  readonly messageId: string;
  readonly expectedBody: string;
  readonly expectedReplyMessageId: string | null;
} {
  const { destination, expected, receipt_id: receiptId } = request.operation;
  if (request.binding_id !== binding.binding_id
    || destination.platform !== "telegram"
    || destination.account !== binding.account
    || !binding.chat_ids.includes(destination.chat_id)
    || expected.destination.kind !== "chat"
    || expected.destination.platform !== destination.platform
    || expected.destination.account !== destination.account
    || expected.destination.chat_id !== destination.chat_id
    || expected.content.mode !== "text") {
    throw new TelegramOperationError(
      "TELEGRAM_SCOPE_MISMATCH",
      "read_receipt requires the exact configured readable Telegram chat and expected send",
    );
  }
  const chatId = rawChatId(destination.chat_id);
  const messageId = rawMessageId(receiptId, chatId);
  const expectedReplyMessageId = expected.reply === undefined
    ? null
    : rawMessageId(expected.reply.parent_id, chatId);
  return {
    chatId,
    messageId,
    expectedBody: expected.content.body,
    expectedReplyMessageId,
  };
}

export function createTelegramWorkerCore(options: TelegramWorkerCoreOptions): TelegramWorkerCore {
  const binding = validateBinding(options.binding);

  async function authenticatedSession(observedAt: number): Promise<AuthenticatedSession> {
    if (!options.port.availability.available) {
      throw new TelegramOperationError("TELEGRAM_RUNTIME_UNAVAILABLE", options.port.availability.reason);
    }
    const machine = new TelegramAuthStateMachine();
    let observation: TelegramAuthObservation;
    try {
      observation = machine.observe(await options.port.getAuthorizationState(), observedAt);
    } catch {
      throw new TelegramOperationError("TELEGRAM_AUTH_UNAVAILABLE", "TDLib authorization state is unavailable");
    }
    if (observation.phase !== "ready") {
      throw new TelegramOperationError("TELEGRAM_AUTH_REQUIRED", observation.auth.reason ?? "TDLib login is required");
    }
    let selfUserId: string;
    try {
      const me = await options.port.getMe();
      if (me["@type"] !== "user") throw new Error("getMe did not return user");
      selfUserId = canonicalInt53(me.id, "TDLib getMe user id", true);
    } catch {
      throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "TDLib account identity is unavailable");
    }
    if (selfUserId !== binding.self_user_id) {
      throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "TDLib session belongs to another account");
    }
    return { observation, selfUserId };
  }

  return {
    async health(request) {
      if (request.binding_id !== binding.binding_id) {
        return failure(
          request,
          "TELEGRAM_SCOPE_MISMATCH",
          "worker binding does not match the configured Telegram binding",
        );
      }

      const observedAt = finiteObservedAt(options.now);
      if (!options.port.availability.available) {
        return healthSuccess(request, "unavailable", {
          state: "unknown",
          reason: options.port.availability.reason,
          observed_at: observedAt,
        });
      }

      let observation: TelegramAuthObservation;
      try {
        const machine = new TelegramAuthStateMachine();
        observation = machine.observe(await options.port.getAuthorizationState(), observedAt);
      } catch {
        return healthSuccess(request, "unavailable", {
          state: "unknown",
          reason: "tdlib_authorization_unavailable",
          observed_at: observedAt,
        });
      }
      if (observation.phase !== "ready") {
        return healthSuccess(request, observation.health, observation.auth);
      }

      try {
        const me = await options.port.getMe();
        if (me["@type"] !== "user"
          || canonicalInt53(me.id, "TDLib getMe user id", true) !== binding.self_user_id) {
          return healthSuccess(request, "unavailable", {
            state: "unknown",
            reason: "tdlib_account_scope_mismatch",
            observed_at: observedAt,
          });
        }
      } catch {
        return healthSuccess(request, "unavailable", {
          state: "unknown",
          reason: "tdlib_account_scope_mismatch",
          observed_at: observedAt,
        });
      }

      return healthSuccess(request, "ready", observation.auth);
    },

    async readPage(request) {
      let expectedRawChatId: string;
      let cursor: TelegramReadCursorV1 | null;
      try {
        expectedRawChatId = assertReadScope(request, binding);
        cursor = request.operation.cursor === null
          ? null
          : decodeCursor(request.operation.cursor, request, binding);
      } catch (error) {
        return readFailure(request, error);
      }

      try {
        const observedAt = finiteObservedAt(options.now);
        const session = await authenticatedSession(observedAt);
        const chatResult = await options.port.getChat(expectedRawChatId);
        if (chatResult["@type"] !== "chat"
          || canonicalInt53(chatResult.id, "TDLib chat id", false) !== expectedRawChatId) {
          throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "TDLib getChat returned another chat");
        }
        if (!Number.isSafeInteger(chatResult.unread_count) || chatResult.unread_count < 0) {
          throw new TelegramOperationError("TELEGRAM_MALFORMED_RESPONSE", "TDLib unread_count is invalid");
        }

        const providerLimit = cursor === null
          ? request.operation.limit
          : Math.min(100, request.operation.limit + 1);
        const history = await options.port.getChatHistory({
          chat_id: expectedRawChatId,
          from_message_id: cursor?.from_message_id ?? "0",
          offset: 0,
          limit: providerLimit,
          only_local: false,
        });
        if (!Array.isArray(history)) {
          throw new TelegramOperationError("TELEGRAM_MALFORMED_PAGE", "TDLib history must be an array");
        }
        if (history.length > providerLimit) {
          throw new TelegramOperationError(
            "TELEGRAM_PAGE_BOUND_EXCEEDED",
            "TDLib history exceeded the requested provider item bound",
          );
        }

        const fields = history.map((message) => rawMessageFields(message, expectedRawChatId));
        for (let index = 1; index < fields.length; index += 1) {
          const newer = fields[index - 1]!;
          const older = fields[index]!;
          if (BigInt(older.id) >= BigInt(newer.id) || older.date > newer.date) {
            throw new TelegramOperationError(
              "TELEGRAM_MALFORMED_PAGE",
              "TDLib history must be strictly decreasing by message id and non-increasing by date",
            );
          }
        }
        if (cursor !== null && fields.length > 0 && BigInt(fields[0]!.id) > BigInt(cursor.from_message_id)) {
          throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "TDLib history continued from the wrong message");
        }

        const startsWithAnchor = cursor !== null
          && fields.length > 0
          && fields[0]!.id === cursor.from_message_id;
        const effective = startsWithAnchor ? fields.slice(1) : fields;
        const last = fields.at(-1);
        const terminal = fields.length === 0
          || (last !== undefined && last.date < request.operation.interval.from_ts);
        if (!terminal && cursor !== null
          && (last === undefined || BigInt(last.id) >= BigInt(cursor.from_message_id))) {
          throw new TelegramOperationError(
            "TELEGRAM_CURSOR_DID_NOT_ADVANCE",
            "TDLib history continuation did not advance",
          );
        }

        const messages = effective
          .filter(({ date }) => date >= request.operation.interval.from_ts && date < request.operation.interval.to_ts)
          .map(({ raw }) => messageEvent(raw, binding.account));
        if (messages.length > request.operation.limit) {
          throw new TelegramOperationError(
            "TELEGRAM_PAGE_BOUND_EXCEEDED",
            "normalized Telegram messages exceeded the requested item bound",
          );
        }
        if (messages.some((event) => {
          const message = event.message as { readonly key?: { readonly chat_id?: JsonValue } };
          return message.key?.chat_id !== request.operation.chat.chat_id;
        })) {
          throw new TelegramOperationError("TELEGRAM_SCOPE_MISMATCH", "normalized Telegram message scope mismatch");
        }

        const nextCursor = terminal
          ? null
          : encodeCursor({
            v: 1,
            binding_id: binding.binding_id,
            account: binding.account,
            chat_id: request.operation.chat.chat_id,
            from_ts: request.operation.interval.from_ts,
            to_ts: request.operation.interval.to_ts,
            from_message_id: last!.id,
          });
        const chatKey = {
          platform: "telegram",
          account: binding.account,
          chat_id: request.operation.chat.chat_id,
        };
        const coverage = terminal ? [{
          chat: chatKey,
          interval: request.operation.interval,
          kind: "backfill",
          collected_at: observedAt,
          // History traversal supplies no deletion reconciliation evidence.
          mutations_verified_at: null,
        }] : [];
        const page = {
          v: 1,
          mode: "bounded_history",
          chat: request.operation.chat,
          interval: request.operation.interval,
          messages,
          tombstones: [],
          identity: {
            chat: chatKey,
            status: "known",
            self_id: `telegram:user:${session.selfUserId}`,
            source: "authenticated_adapter",
            observed_at: observedAt,
          },
          unread: {
            chat: chatKey,
            status: "known",
            source: "platform",
            count: chatResult.unread_count,
            observed_at: observedAt,
          },
          coverage,
          limits: [],
          next_cursor: nextCursor,
          authoritative: terminal,
          observed_at: observedAt,
        } as unknown as { readonly [key: string]: JsonValue };

        return {
          v: 1,
          type: "worker_response",
          request_id: request.request_id,
          generation: request.generation,
          operation: "read_page",
          ok: true,
          result: { items: [page], next_cursor: nextCursor, authoritative: terminal },
        };
      } catch (error) {
        return readFailure(request, error);
      }
    },

    async send(request) {
      let scope: ReturnType<typeof assertSendScope>;
      try {
        scope = assertSendScope(request, binding);
      } catch (error) {
        if (error instanceof TelegramOperationError) {
          return failure(request, error.code, error.message, error.retryable);
        }
        return failure(request, "TELEGRAM_SEND_INVALID", "Telegram send request is invalid");
      }

      let session: AuthenticatedSession;
      try {
        session = await authenticatedSession(finiteObservedAt(options.now));
      } catch (error) {
        if (error instanceof TelegramOperationError) {
          return failure(request, error.code, error.message, error.retryable);
        }
        return failure(request, "TELEGRAM_AUTH_UNAVAILABLE", "TDLib authentication failed");
      }

      try {
        const acknowledgement = await options.port.sendTextMessage({
          chat_id: scope.chatId,
          text: scope.body,
          reply_to_message_id: scope.replyMessageId,
          timeout_ms: request.limits.timeout_ms,
        });
        const receiptId = validateSentAcknowledgement({
          raw: acknowledgement,
          expectedRawChatId: scope.chatId,
          expectedBody: scope.body,
          expectedReplyMessageId: scope.replyMessageId,
          selfUserId: session.selfUserId,
        });
        return {
          v: 1,
          type: "worker_response",
          request_id: request.request_id,
          generation: request.generation,
          operation: "send",
          ok: true,
          result: { outcome: "sent", receipt_id: receiptId },
        };
      } catch (error) {
        if (error instanceof TdlibCallError && error.code === 429 && !error.mayHaveSent) {
          return failure(request, "TELEGRAM_FLOOD_WAIT", error.message, true, false);
        }
        if (error instanceof TdlibCallError && !error.mayHaveSent) {
          return {
            v: 1,
            type: "worker_response",
            request_id: request.request_id,
            generation: request.generation,
            operation: "send",
            ok: true,
            result: { outcome: "failed", reason: error.message },
          };
        }
        return failure(
          request,
          "TELEGRAM_SEND_AMBIGUOUS",
          "TDLib send may have completed; automatic retry is forbidden",
          false,
          true,
        );
      }
    },

    async readReceipt(request) {
      let scope: ReturnType<typeof assertReceiptScope>;
      try {
        scope = assertReceiptScope(request, binding);
      } catch (error) {
        if (error instanceof TelegramOperationError) {
          return failure(request, error.code, error.message, error.retryable);
        }
        return failure(request, "TELEGRAM_RECEIPT_INVALID", "Telegram receipt request is invalid");
      }

      let session: AuthenticatedSession;
      try {
        session = await authenticatedSession(finiteObservedAt(options.now));
      } catch (error) {
        if (error instanceof TelegramOperationError) {
          return failure(request, error.code, error.message, error.retryable);
        }
        return failure(request, "TELEGRAM_AUTH_UNAVAILABLE", "TDLib authentication failed");
      }

      let message: TdlibMessage;
      try {
        message = await options.port.getMessage(scope.chatId, scope.messageId);
      } catch (error) {
        if (error instanceof TdlibCallError && error.code === 404 && !error.mayHaveSent) {
          return {
            v: 1,
            type: "worker_response",
            request_id: request.request_id,
            generation: request.generation,
            operation: "read_receipt",
            ok: true,
            result: { outcome: "not_found" },
          };
        }
        return {
          v: 1,
          type: "worker_response",
          request_id: request.request_id,
          generation: request.generation,
          operation: "read_receipt",
          ok: true,
          result: { outcome: "unavailable", reason: "tdlib_readback_failed" },
        };
      }

      try {
        const readbackReceiptId = validateSentAcknowledgement({
          raw: message,
          expectedRawChatId: scope.chatId,
          expectedBody: scope.expectedBody,
          expectedReplyMessageId: scope.expectedReplyMessageId,
          selfUserId: session.selfUserId,
        });
        if (readbackReceiptId !== request.operation.receipt_id) {
          throw new TelegramOperationError("TELEGRAM_RECEIPT_MISMATCH", "TDLib receipt id did not match");
        }
      } catch {
        return {
          v: 1,
          type: "worker_response",
          request_id: request.request_id,
          generation: request.generation,
          operation: "read_receipt",
          ok: true,
          result: { outcome: "unavailable", reason: "receipt_mismatch" },
        };
      }

      return {
        v: 1,
        type: "worker_response",
        request_id: request.request_id,
        generation: request.generation,
        operation: "read_receipt",
        ok: true,
        result: {
          outcome: "verified",
          evidence: {
            destination: request.operation.destination,
            receipt_id: request.operation.receipt_id,
            content: request.operation.expected.content,
            ...(request.operation.expected.reply === undefined
              ? {}
              : { reply: request.operation.expected.reply }),
          },
        },
      };
    },
  };
}
