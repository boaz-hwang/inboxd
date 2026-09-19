import type {
  TdlibAuthorizationState,
  TdlibChat,
  TdlibHistoryRequest,
  TdlibMessage,
  TdlibSendTextRequest,
  TdlibUser,
  TdlibUserClientPort,
} from "./tdlib-port.ts";
import { TdlibCallError } from "./tdlib-port.ts";
import * as packagedTdl from "tdl";

export const MISSING_TDLIB_PRODUCTION_PACK_REASON =
  "missing_tdlib_production_pack: tdl plus prebuilt-tdlib or system libtdjson is required";
export const TDLIB_PRODUCTION_INITIALIZATION_FAILED_REASON =
  "tdlib_production_adapter_initialization_failed";

export type TdlibModuleLoader = (specifier: "tdl" | "prebuilt-tdlib") => Promise<unknown>;

export interface ProductionTdlibOptions {
  readonly apiId: number;
  readonly apiHash: string;
  readonly databaseDirectory?: string;
  readonly filesDirectory?: string;
  readonly databaseEncryptionKey?: string;
  readonly tdjsonPath?: string;
  readonly loadModule?: TdlibModuleLoader;
}

interface TdlClient {
  invoke(query: Record<string, unknown>): Promise<unknown>;
  on?: (event: "update" | "error", listener: (value: unknown) => void) => unknown;
  off?: (event: "update" | "error", listener: (value: unknown) => void) => unknown;
  removeListener?: (event: "update" | "error", listener: (value: unknown) => void) => unknown;
  close?: () => Promise<void> | void;
}

type UnknownRecord = Record<string, unknown>;
const encoder = new TextEncoder();
const SEND_COMPLETION_CACHE_LIMIT = 256;
// TDLib error codes can change. Keep definitive send failures limited to its
// known request, authorization, and rate-limit rejections.
const PROVEN_NOT_SENT_SEND_ERROR_CODES = new Set([400, 401, 429]);

type SendCompletion =
  | { readonly outcome: "succeeded"; readonly message: TdlibMessage }
  | { readonly outcome: "failed"; readonly code: number };

interface PendingSendWaiter {
  readonly resolve: (completion: SendCompletion) => void;
  readonly reject: (error: TdlibCallError) => void;
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function moduleRecord(value: unknown): UnknownRecord | null {
  const namespace = record(value);
  if (namespace === null) return null;
  const defaultExport = record(namespace.default);
  return defaultExport === null ? namespace : { ...defaultExport, ...namespace };
}

function boundedPrivateString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.includes("\0")
    || encoder.encode(value).byteLength > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validatedOptions(options: ProductionTdlibOptions): Omit<
  ProductionTdlibOptions,
  "loadModule" | "tdjsonPath"
> {
  if (!Number.isSafeInteger(options.apiId) || options.apiId < 1 || options.apiId > 2_147_483_647) {
    throw new TypeError("Telegram apiId is invalid");
  }
  if (typeof options.apiHash !== "string" || !/^[0-9a-f]{32}$/.test(options.apiHash)) {
    throw new TypeError("Telegram apiHash is invalid");
  }
  const databaseDirectory = options.databaseDirectory === undefined
    ? undefined
    : boundedPrivateString(options.databaseDirectory, "Telegram databaseDirectory", 4_096);
  const filesDirectory = options.filesDirectory === undefined
    ? undefined
    : boundedPrivateString(options.filesDirectory, "Telegram filesDirectory", 4_096);
  const databaseEncryptionKey = options.databaseEncryptionKey === undefined
    ? undefined
    : boundedPrivateString(options.databaseEncryptionKey, "Telegram databaseEncryptionKey", 4_096, true);
  return {
    apiId: options.apiId,
    apiHash: options.apiHash,
    ...(databaseDirectory === undefined ? {} : { databaseDirectory }),
    ...(filesDirectory === undefined ? {} : { filesDirectory }),
    ...(databaseEncryptionKey === undefined ? {} : { databaseEncryptionKey }),
  };
}

async function defaultModuleLoader(specifier: "tdl" | "prebuilt-tdlib"): Promise<unknown> {
  if (specifier === "tdl") return packagedTdl;
  return import(specifier);
}

export function unavailablePort(reason: string): TdlibUserClientPort {
  const reject = async (): Promise<never> => {
    throw new TdlibCallError(503, reason, false);
  };
  return {
    availability: { available: false, reason },
    getAuthorizationState: reject,
    getMe: reject,
    getChat: reject,
    getChatHistory: reject,
    sendTextMessage: reject,
    sendDocumentMessage: reject,
    getMessage: reject,
    async close() {},
  };
}

function toTdlibJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toTdlibJson);
  const input = record(value);
  if (input === null) return value;
  const output: UnknownRecord = {};
  for (const [key, entry] of Object.entries(input)) {
    if (key !== "_") output[key] = toTdlibJson(entry);
  }
  if (typeof input._ === "string") output["@type"] = input._;
  return output;
}

function typedTdlibObject(value: unknown, expectedType?: string): UnknownRecord {
  const converted = record(toTdlibJson(value));
  if (converted === null || typeof converted["@type"] !== "string"
    || (expectedType !== undefined && converted["@type"] !== expectedType)) {
    throw new TdlibCallError(500, "TDLib returned a malformed response", false);
  }
  return converted;
}

function canonicalInt53(value: unknown, label: string, allowZero = false): string {
  const canonical = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)
      ? value
      : null;
  if (canonical === null) throw new TypeError(`${label} is invalid`);
  const parsed = Number(canonical);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed === 0)) {
    throw new TypeError(`${label} is invalid`);
  }
  return canonical;
}

function int53(value: string, label: string, allowZero = false): number {
  const parsed = Number(canonicalInt53(value, label, allowZero));
  return parsed;
}

function errorCode(error: unknown): number | null {
  const input = record(error);
  return input !== null && Number.isSafeInteger(input.code) ? input.code as number : null;
}

function createAvailablePort(client: TdlClient): TdlibUserClientPort {
  const accountListeners = new Set<(update: Record<string, unknown>) => void>();
  let connectionUpdate: Record<string, unknown> | undefined;
  const completionCache = new Map<string, SendCompletion>();
  const pendingSendWaiters = new Map<string, Set<PendingSendWaiter>>();

  const completionKey = (chatId: unknown, oldMessageId: unknown): string | null => {
    try {
      return JSON.stringify([
        canonicalInt53(chatId, "TDLib send update chat id"),
        canonicalInt53(oldMessageId, "TDLib send update old message id"),
      ]);
    } catch {
      return null;
    }
  };

  const sendCompletion = (update: unknown): { readonly key: string; readonly value: SendCompletion } | null => {
    try {
      const converted = typedTdlibObject(update);
      if (converted["@type"] !== "updateMessageSendSucceeded"
        && converted["@type"] !== "updateMessageSendFailed") return null;
      const message = typedTdlibObject(converted.message, "message") as unknown as TdlibMessage;
      const key = completionKey(message.chat_id, converted.old_message_id);
      if (key === null) return null;
      if (converted["@type"] === "updateMessageSendSucceeded") {
        return { key, value: { outcome: "succeeded", message } };
      }
      const code = errorCode(converted.error);
      if (code === null) return null;
      return { key, value: { outcome: "failed", code } };
    } catch {
      return null;
    }
  };

  const updateListener = (update: unknown): void => {
    const object = record(toTdlibJson(update));
    if (object?.["@type"] === "updateConnectionState") connectionUpdate = object;
    if (object) for (const listener of accountListeners) listener(object);
    const completion = sendCompletion(update);
    if (completion === null) return;
    const waiters = pendingSendWaiters.get(completion.key);
    if (waiters !== undefined) {
      pendingSendWaiters.delete(completion.key);
      for (const waiter of waiters) waiter.resolve(completion.value);
      return;
    }
    completionCache.delete(completion.key);
    completionCache.set(completion.key, completion.value);
    while (completionCache.size > SEND_COMPLETION_CACHE_LIMIT) {
      const oldest = completionCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      completionCache.delete(oldest);
    }
  };

  const canObserveUpdates = typeof client.on === "function"
    && (typeof client.off === "function" || typeof client.removeListener === "function");
  const backgroundErrorListener = (): void => {};
  if (canObserveUpdates) {
    client.on?.("update", updateListener);
    // tdl deliberately creates an unhandled rejection when no error listener
    // exists. Request failures are still reported by invoke(); consume only
    // this duplicate background channel without logging provider data.
    client.on?.("error", backgroundErrorListener);
  }

  const waitForSendCompletion = (key: string): {
    readonly promise: Promise<SendCompletion>;
    readonly cancel: () => void;
  } => {
    const cached = completionCache.get(key);
    if (cached !== undefined) {
      completionCache.delete(key);
      return { promise: Promise.resolve(cached), cancel() {} };
    }
    let waiter: PendingSendWaiter;
    const promise = new Promise<SendCompletion>((resolve, reject) => {
      waiter = { resolve, reject };
      const existing = pendingSendWaiters.get(key);
      if (existing === undefined) pendingSendWaiters.set(key, new Set([waiter]));
      else existing.add(waiter);
    });
    return {
      promise,
      cancel() {
        const existing = pendingSendWaiters.get(key);
        existing?.delete(waiter);
        if (existing?.size === 0) pendingSendWaiters.delete(key);
      },
    };
  };

  async function invoke(query: Record<string, unknown>, mayHaveSentOnUnknown = false): Promise<unknown> {
    try {
      return await client.invoke(query);
    } catch (error) {
      const code = errorCode(error);
      if (code !== null) {
        const mayHaveSent = mayHaveSentOnUnknown && !PROVEN_NOT_SENT_SEND_ERROR_CODES.has(code);
        throw new TdlibCallError(code, "TDLib rejected the request", mayHaveSent);
      }
      throw new TdlibCallError(500, "TDLib request transport failed", mayHaveSentOnUnknown);
    }
  }

  async function sendContent(request: Omit<TdlibSendTextRequest, "text">, content: Record<string, unknown>): Promise<TdlibMessage> {
      if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms < 1) {
        throw new TypeError("Telegram send timeout is invalid");
      }
      const expectedChatId = canonicalInt53(request.chat_id, "Telegram chat id");
      const replyTo = request.reply_to_message_id === null
        ? null
        : {
          _: "inputMessageReplyToMessage",
          message_id: int53(request.reply_to_message_id, "Telegram reply message id"),
          quote: null,
          checklist_task_id: 0,
        };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TdlibCallError(504, "TDLib send confirmation timed out", true));
        }, request.timeout_ms);
      });
      let pending: ReturnType<typeof waitForSendCompletion> | undefined;
      try {
        const rawResponse = await Promise.race([invoke({
          _: "sendMessage",
          chat_id: Number(expectedChatId),
          topic_id: null,
          reply_to: replyTo,
          options: null,
          reply_markup: null,
          input_message_content: content,
        }, true), timeout]);
        let response: TdlibMessage;
        try {
          response = typedTdlibObject(rawResponse, "message") as unknown as TdlibMessage;
        } catch {
          throw new TdlibCallError(500, "TDLib returned a malformed send response", true);
        }
        const sendingState = record(response.sending_state);
        if (sendingState?.["@type"] !== "messageSendingStatePending") return response;
        if (canonicalInt53(response.chat_id, "TDLib pending send chat id") !== expectedChatId) {
          throw new TypeError("TDLib pending send chat id is invalid");
        }
        const key = completionKey(response.chat_id, response.id);
        if (key === null || !canObserveUpdates) {
          throw new TdlibCallError(500, "TDLib send confirmation is unavailable", true);
        }
        pending = waitForSendCompletion(key);
        const completion = await Promise.race([pending.promise, timeout]);
        if (completion.outcome === "failed") {
          throw new TdlibCallError(completion.code, "TDLib reported that the send failed", false);
        }
        return completion.message;
      } catch (error) {
        if (error instanceof TdlibCallError) throw error;
        throw new TdlibCallError(500, "TDLib returned a malformed send response", true);
      } finally {
        pending?.cancel();
        if (timer !== undefined) clearTimeout(timer);
      }
  }

  return {
    onAccountUpdate(listener) { accountListeners.add(listener); if (connectionUpdate) listener(connectionUpdate); return () => { accountListeners.delete(listener); }; },
    availability: { available: true },
    async accountQuery(query) { return typedTdlibObject(await invoke(query)); },

    async getAuthorizationState(): Promise<TdlibAuthorizationState> {
      return typedTdlibObject(await invoke({ _: "getAuthorizationState" })) as unknown as TdlibAuthorizationState;
    },

    async getMe(): Promise<TdlibUser> {
      return typedTdlibObject(await invoke({ _: "getMe" }), "user") as unknown as TdlibUser;
    },

    async getChat(chatId: string): Promise<TdlibChat> {
      return typedTdlibObject(await invoke({
        _: "getChat",
        chat_id: int53(chatId, "Telegram chat id"),
      }), "chat") as unknown as TdlibChat;
    },

    async getChatHistory(request: TdlibHistoryRequest): Promise<readonly TdlibMessage[]> {
      if (request.offset !== 0 || request.only_local !== false
        || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw new TypeError("Telegram history request is invalid");
      }
      const response = typedTdlibObject(await invoke({
        _: "getChatHistory",
        chat_id: int53(request.chat_id, "Telegram chat id"),
        from_message_id: int53(request.from_message_id, "Telegram history message id", true),
        offset: 0,
        limit: request.limit,
        only_local: false,
      }), "messages");
      if (!Array.isArray(response.messages)) {
        throw new TdlibCallError(500, "TDLib returned a malformed history response", false);
      }
      return response.messages.map((message) => typedTdlibObject(message, "message") as unknown as TdlibMessage);
    },

    async sendTextMessage(request: TdlibSendTextRequest): Promise<TdlibMessage> {
      if (typeof request.text !== "string" || request.text.length === 0 || encoder.encode(request.text).byteLength > 65_536) throw new TypeError("Telegram text is invalid");
      return sendContent(request, { _: "inputMessageText", text: { _: "formattedText", text: request.text, entities: [] }, link_preview_options: null, clear_draft: false });
    },
    async sendDocumentMessage(request): Promise<TdlibMessage> {
      if (!request.path.startsWith("/") || request.path.includes("\0")) throw new TypeError("Telegram file path is invalid");
      return sendContent({ ...request, reply_to_message_id: null }, { _: "inputMessageDocument", document: { _: "inputFileLocal", path: request.path }, thumbnail: null, disable_content_type_detection: true, caption: { _: "formattedText", text: "", entities: [] } });
    },

    async getMessage(chatId: string, messageId: string): Promise<TdlibMessage> {
      return typedTdlibObject(await invoke({
        _: "getMessage",
        chat_id: int53(chatId, "Telegram chat id"),
        message_id: int53(messageId, "Telegram message id"),
      }), "message") as unknown as TdlibMessage;
    },

    async close(): Promise<void> {
      accountListeners.clear();
      if (canObserveUpdates) {
        if (typeof client.off === "function") client.off("update", updateListener);
        else client.removeListener?.("update", updateListener);
        if (typeof client.off === "function") client.off("error", backgroundErrorListener);
        else client.removeListener?.("error", backgroundErrorListener);
      }
      const closeError = new TdlibCallError(500, "TDLib client closed before send confirmation", true);
      for (const waiters of pendingSendWaiters.values()) {
        for (const waiter of waiters) waiter.reject(closeError);
      }
      pendingSendWaiters.clear();
      completionCache.clear();
      await client.close?.();
    },
  };
}

/**
 * Loads the user-session TDLib runtime without a static dependency. Absence or
 * initialization failure is represented by an unavailable port and never falls
 * back to Telegram's Bot API.
 */
export async function createProductionTdlibPort(options: ProductionTdlibOptions): Promise<TdlibUserClientPort> {
  const clientOptions = validatedOptions(options);
  const loadModule = options.loadModule ?? defaultModuleLoader;
  let tdl: UnknownRecord;
  try {
    const loaded = moduleRecord(await loadModule("tdl"));
    if (loaded === null || typeof loaded.createClient !== "function") {
      return unavailablePort(MISSING_TDLIB_PRODUCTION_PACK_REASON);
    }
    tdl = loaded;
  } catch {
    return unavailablePort(MISSING_TDLIB_PRODUCTION_PACK_REASON);
  }

  let prebuiltLoaded = false;
  try {
    const prebuilt = moduleRecord(await loadModule("prebuilt-tdlib"));
    if (prebuilt !== null && typeof prebuilt.getTdjson === "function") {
      if (typeof tdl.configure !== "function") return unavailablePort(MISSING_TDLIB_PRODUCTION_PACK_REASON);
      const tdjson = options.tdjsonPath === undefined
        ? prebuilt.getTdjson()
        : boundedPrivateString(options.tdjsonPath, "Telegram tdjsonPath", 4_096);
      if (typeof tdjson !== "string" || tdjson.length === 0) {
        return unavailablePort(MISSING_TDLIB_PRODUCTION_PACK_REASON);
      }
      tdl.configure({ tdjson });
      prebuiltLoaded = true;
    }
  } catch {
    // A system libtdjson may still be available to tdl.
  }

  try {
    if (options.tdjsonPath !== undefined && !prebuiltLoaded) {
      if (typeof tdl.configure !== "function") return unavailablePort(MISSING_TDLIB_PRODUCTION_PACK_REASON);
      tdl.configure({ tdjson: boundedPrivateString(options.tdjsonPath, "Telegram tdjsonPath", 4_096) });
    }
    const created = (tdl.createClient as (value: unknown) => TdlClient | Promise<TdlClient>)(clientOptions);
    if (record(created) !== null && typeof (created as TdlClient).invoke === "function") {
      return createAvailablePort(created as TdlClient);
    }
    const candidate = await created;
    if (record(candidate) === null || typeof candidate.invoke !== "function") {
      return unavailablePort(TDLIB_PRODUCTION_INITIALIZATION_FAILED_REASON);
    }
    return createAvailablePort(candidate);
  } catch {
    return unavailablePort(prebuiltLoaded || options.tdjsonPath !== undefined
      ? TDLIB_PRODUCTION_INITIALIZATION_FAILED_REASON
      : MISSING_TDLIB_PRODUCTION_PACK_REASON);
  }
}
