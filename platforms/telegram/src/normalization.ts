export const MAX_TELEGRAM_PAGE_SIZE = 100;

export type TelegramNormalizationErrorCode =
  | "MALFORMED_MESSAGE"
  | "UNSUPPORTED_CONTENT"
  | "INVALID_PAGE_LIMIT"
  | "PAGE_BOUND_EXCEEDED";

export class TelegramNormalizationError extends Error {
  readonly name = "TelegramNormalizationError";

  constructor(readonly code: TelegramNormalizationErrorCode, message: string) {
    super(message);
  }
}

export interface NormalizedTelegramSender {
  readonly kind: "user" | "chat";
  readonly id: string;
}

export interface NormalizedTelegramReply {
  readonly chat_id: string;
  readonly message_id: string;
}

export interface NormalizedTelegramMessage {
  readonly chat_id: string;
  readonly message_id: string;
  readonly sender: NormalizedTelegramSender;
  readonly body: string;
  /** Unix time in seconds, as supplied by TDLib's message.date. */
  readonly timestamp: number;
  readonly reply_to: NormalizedTelegramReply | null;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function int53(value: unknown, label: string, positive: boolean): string {
  let canonical: string;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    canonical = String(value);
  } else if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) {
    canonical = value;
  } else {
    throw new TypeError(`${label} must be a canonical TDLib int53`);
  }

  const parsed = BigInt(canonical);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new TypeError(`${label} exceeds TDLib int53 bounds`);
  }
  if (positive ? parsed <= 0n : parsed === 0n) {
    throw new TypeError(`${label} must be non-zero`);
  }
  return canonical;
}

function stableChatId(chatId: string): string {
  return `telegram:chat:${chatId}`;
}

function stableMessageId(chatId: string, messageId: string): string {
  return `telegram:message:${chatId}:${messageId}`;
}

/** Purely normalizes fields present in a TDLib message; it makes no identity or read-state claim. */
function normalizeTelegramMessageUnchecked(raw: unknown): NormalizedTelegramMessage {
  const message = record(raw, "TDLib message");
  if (message["@type"] !== "message") throw new TypeError("TDLib object must be a message");

  const chatId = int53(message.chat_id, "message.chat_id", false);
  const messageId = int53(message.id, "message.id", true);
  const sender = record(message.sender_id, "message.sender_id");
  let normalizedSender: NormalizedTelegramSender;
  if (sender["@type"] === "messageSenderUser") {
    const senderId = int53(sender.user_id, "message.sender_id.user_id", true);
    normalizedSender = { kind: "user", id: `telegram:user:${senderId}` };
  } else if (sender["@type"] === "messageSenderChat") {
    const senderId = int53(sender.chat_id, "message.sender_id.chat_id", false);
    normalizedSender = { kind: "chat", id: stableChatId(senderId) };
  } else {
    throw new TypeError("unsupported TDLib sender");
  }

  if (!Number.isInteger(message.date) || typeof message.date !== "number" || message.date < 0 || message.date > 2_147_483_647) {
    throw new TypeError("message.date must be a TDLib Unix timestamp");
  }

  const content = record(message.content, "message.content");
  if (content["@type"] !== "messageText") {
    throw new TelegramNormalizationError("UNSUPPORTED_CONTENT", "unsupported TDLib message content");
  }
  const formattedText = record(content.text, "message.content.text");
  if (formattedText["@type"] !== "formattedText" || typeof formattedText.text !== "string" || formattedText.text.length === 0) {
    throw new TypeError("messageText must contain non-empty formatted text");
  }

  let replyTo: NormalizedTelegramReply | null = null;
  if (message.reply_to !== undefined && message.reply_to !== null) {
    const reply = record(message.reply_to, "message.reply_to");
    if (reply["@type"] !== "messageReplyToMessage") throw new TypeError("unsupported TDLib reply target");
    const replyChatId = int53(reply.chat_id, "message.reply_to.chat_id", false);
    const replyMessageId = int53(reply.message_id, "message.reply_to.message_id", true);
    replyTo = {
      chat_id: stableChatId(replyChatId),
      message_id: stableMessageId(replyChatId, replyMessageId),
    };
  }

  return {
    chat_id: stableChatId(chatId),
    message_id: stableMessageId(chatId, messageId),
    sender: normalizedSender,
    body: formattedText.text,
    timestamp: message.date,
    reply_to: replyTo,
  };
}

/** Rejects malformed data atomically instead of returning a partial message. */
export function normalizeTelegramMessage(raw: unknown): NormalizedTelegramMessage {
  try {
    return normalizeTelegramMessageUnchecked(raw);
  } catch (error) {
    if (error instanceof TelegramNormalizationError) throw error;
    const message = error instanceof Error ? error.message : "malformed TDLib message";
    throw new TelegramNormalizationError("MALFORMED_MESSAGE", message);
  }
}

export interface NormalizedTelegramPage {
  readonly messages: readonly NormalizedTelegramMessage[];
  readonly continuation: string | null;
}

export interface NormalizeTelegramPageOptions {
  readonly limit: number;
  readonly continuation: string | null;
}

/** Page output contains normalized messages and caller-supplied continuation only. */
export function normalizeTelegramPage(
  raw: unknown,
  options: NormalizeTelegramPageOptions,
): NormalizedTelegramPage {
  const page = record(raw, "TDLib messages page");
  if (page["@type"] !== "messages" || !Array.isArray(page.messages)) {
    throw new TypeError("TDLib messages page is malformed");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_TELEGRAM_PAGE_SIZE) {
    throw new TelegramNormalizationError("INVALID_PAGE_LIMIT", "Telegram page limit must be an integer from 1 to 100");
  }
  if (page.messages.length > options.limit) {
    throw new TelegramNormalizationError("PAGE_BOUND_EXCEEDED", "TDLib page exceeds requested item limit");
  }
  if (options.continuation !== null && typeof options.continuation !== "string") {
    throw new TypeError("opaque continuation must be a string or null");
  }
  return {
    messages: page.messages.map((message) => normalizeTelegramMessage(message)),
    continuation: options.continuation,
  };
}
