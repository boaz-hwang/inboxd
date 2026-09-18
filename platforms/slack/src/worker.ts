import {
  parseWorkerRequest,
  parseWorkerResponse,
  type WorkerRequestV1,
  type WorkerResponseV1,
} from "../../../packages/protocol/src/schema.ts";

export type SlackApiMethod =
  | "auth.test"
  | "conversations.history"
  | "conversations.info"
  | "conversations.replies"
  | "chat.postMessage";

export interface SlackApiCall {
  readonly method: SlackApiMethod;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

export interface SlackApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface SlackApiTransport {
  call(call: SlackApiCall): Promise<SlackApiResponse>;
}

export interface SlackWorkerOptions {
  readonly bindingId: string;
  readonly account: string;
  readonly expectedTeamId: string;
  readonly allowedChatIds: readonly string[];
  readonly transport: SlackApiTransport;
  readonly now?: () => number;
}

export interface SlackWorker {
  handle(request: unknown): Promise<WorkerResponseV1>;
}

const AUTH_FAILURES = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);
const DEFINITIVE_SEND_FAILURES = new Set(["missing_scope"]);
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedIdentifier(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a bounded non-empty identifier`);
  }
  return value;
}

function errorResponse(
  request: WorkerRequestV1,
  code: string,
  message: string,
  retryable = false,
  mayHaveSent = false,
): WorkerResponseV1 {
  return parseWorkerResponse({
    v: 1,
    type: "worker_response",
    request_id: request.request_id,
    generation: request.generation,
    operation: request.operation.op,
    ok: false,
    error: { code, message, retryable, may_have_sent: mayHaveSent },
  }, request);
}

function successResponse(request: WorkerRequestV1, result: unknown): WorkerResponseV1 {
  return parseWorkerResponse({
    v: 1,
    type: "worker_response",
    request_id: request.request_id,
    generation: request.generation,
    operation: request.operation.op,
    ok: true,
    result,
  }, request);
}

interface AuthObservation {
  readonly state: "authenticated" | "unauthenticated" | "unknown";
  readonly reason: string | null;
  readonly selfId?: string;
}

function validOpaqueCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && encoder.encode(value).byteLength <= 4_096;
}

function slackTimestamp(value: unknown): { readonly raw: string; readonly seconds: number } | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,15})\.\d{1,6}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && Math.abs(seconds) <= Number.MAX_SAFE_INTEGER ? { raw: value, seconds } : null;
}

function inclusiveSlackTimestampBelow(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const rounded = value.toFixed(6);
  const match = /^(\d{1,16})\.(\d{6})$/.exec(rounded);
  if (match === null) return null;
  let microseconds = BigInt(match[1]!) * 1_000_000n + BigInt(match[2]!);
  if (Number(rounded) >= value) microseconds -= 1n;
  if (microseconds < 0n) return null;
  const seconds = microseconds / 1_000_000n;
  const fraction = String(microseconds % 1_000_000n).padStart(6, "0");
  return `${seconds}.${fraction}`;
}

function retryAfterSeconds(response: SlackApiResponse): string | null {
  const value = response.headers["retry-after"];
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? value : null;
}

export function createSlackWorker(options: SlackWorkerOptions): SlackWorker {
  const bindingId = boundedIdentifier(options.bindingId, "Slack binding id");
  const account = boundedIdentifier(options.account, "Slack account");
  const expectedTeamId = options.expectedTeamId;
  if (!/^T[A-Z0-9]{1,255}$/.test(expectedTeamId)) {
    throw new TypeError("Slack expected team id is invalid");
  }
  if (!Array.isArray(options.allowedChatIds) || options.allowedChatIds.length < 1 || options.allowedChatIds.length > 100) {
    throw new TypeError("Slack chat allowlist must contain 1 to 100 entries");
  }
  const allowedChatIds = new Set<string>();
  for (const chatId of options.allowedChatIds) {
    if (!/^[CGD][A-Z0-9]{1,255}$/.test(chatId) || allowedChatIds.has(chatId)) {
      throw new TypeError("Slack chat allowlist must contain unique canonical chat ids");
    }
    allowedChatIds.add(chatId);
  }
  const now = options.now ?? (() => Date.now() / 1_000);

  async function observeAuth(signal: AbortSignal): Promise<AuthObservation> {
    let response: SlackApiResponse;
    try {
      response = await options.transport.call({ method: "auth.test", payload: {}, signal });
    } catch {
      return { state: "unknown", reason: "transport_unavailable" };
    }
    if (!isRecord(response.body)) return { state: "unknown", reason: "malformed_auth_response" };
    if (response.body.ok !== true) {
      const providerReason = typeof response.body.error === "string" ? response.body.error : "auth_unavailable";
      return AUTH_FAILURES.has(providerReason)
        ? { state: "unauthenticated", reason: providerReason }
        : { state: "unknown", reason: providerReason === "ratelimited" || response.status === 429 ? "rate_limited" : "auth_unavailable" };
    }
    if (response.body.team_id !== expectedTeamId) {
      return { state: "unauthenticated", reason: "account_scope_mismatch" };
    }
    try {
      const selfId = boundedIdentifier(response.body.user_id, "Slack authenticated user id", 256);
      return { state: "authenticated", reason: null, selfId };
    } catch {
      return { state: "unknown", reason: "malformed_auth_response" };
    }
  }

  return {
    async handle(requestValue: unknown): Promise<WorkerResponseV1> {
      const request = parseWorkerRequest(requestValue);
      if (request.binding_id !== bindingId) {
        return errorResponse(request, "binding_mismatch", "worker binding does not match the fixed Slack binding");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.limits.timeout_ms);
      try {
        if (request.operation.op === "health") {
          const observedAt = now();
          if (!Number.isFinite(observedAt) || observedAt < 0) {
            return errorResponse(request, "invalid_clock", "Slack worker clock is invalid");
          }
          const auth = await observeAuth(controller.signal);
          const state = auth.state === "authenticated" ? "ready" : auth.state === "unauthenticated" ? "unavailable" : "degraded";
          return successResponse(request, {
            state,
            auth: { state: auth.state, reason: auth.reason, observed_at: observedAt },
          });
        }
        if (request.operation.op === "read_page") {
          const { chat, interval, limit, cursor } = request.operation;
          if (chat.platform !== "slack" || chat.account !== account || !allowedChatIds.has(chat.chat_id)) {
            return errorResponse(request, "scope_mismatch", "Slack read requires the exact configured account and chat");
          }
          const latest = inclusiveSlackTimestampBelow(interval.to_ts);
          if (latest === null) {
            return errorResponse(request, "invalid_interval", "Slack read interval cannot be represented safely");
          }
          const auth = await observeAuth(controller.signal);
          if (auth.state !== "authenticated" || auth.selfId === undefined) {
            return errorResponse(
              request,
              auth.state === "unauthenticated" ? "authentication_failed" : "authentication_unavailable",
              `Slack authentication is ${auth.state}`,
              auth.state === "unknown",
            );
          }
          let historyResponse: SlackApiResponse;
          try {
            historyResponse = await options.transport.call({
              method: "conversations.history",
              payload: {
                channel: chat.chat_id,
                oldest: String(interval.from_ts),
                latest,
                inclusive: true,
                limit,
                ...(cursor === null ? {} : { cursor }),
              },
              signal: controller.signal,
            });
          } catch {
            return errorResponse(request, "slack_transport", "Slack history transport failed", true);
          }
          if (historyResponse.status === 429 || (isRecord(historyResponse.body) && historyResponse.body.error === "ratelimited")) {
            const retryAfter = retryAfterSeconds(historyResponse);
            return retryAfter === null
              ? errorResponse(request, "malformed_provider_response", "Slack rate limit omitted a valid retry delay")
              : errorResponse(request, "slack_rate_limited", `Slack API rate limited the read for ${retryAfter} seconds`, true);
          }
          if (!isRecord(historyResponse.body)) {
            return errorResponse(request, "malformed_provider_response", "Slack history response was not an object");
          }
          if (historyResponse.body.ok !== true) {
            const providerCode = typeof historyResponse.body.error === "string" ? historyResponse.body.error : "unknown_error";
            return errorResponse(
              request,
              providerCode === "missing_scope" ? "slack_missing_scope" : "slack_read_failed",
              `Slack history rejected the read: ${providerCode}`,
              false,
            );
          }
          if (!Array.isArray(historyResponse.body.messages) || historyResponse.body.messages.length > limit
            || typeof historyResponse.body.has_more !== "boolean") {
            return errorResponse(request, "malformed_provider_response", "Slack history exceeded or omitted the requested page bound");
          }
          const metadata = historyResponse.body.response_metadata;
          if (metadata !== undefined && !isRecord(metadata)) {
            return errorResponse(request, "malformed_provider_response", "Slack pagination metadata was malformed");
          }
          const rawNextCursor = isRecord(metadata) ? metadata.next_cursor : undefined;
          let nextCursor: string | null = null;
          if (rawNextCursor !== undefined && rawNextCursor !== "") {
            if (!validOpaqueCursor(rawNextCursor) || rawNextCursor === cursor) {
              return errorResponse(request, "malformed_provider_response", "Slack pagination cursor was invalid or did not advance");
            }
            nextCursor = rawNextCursor;
          } else if (historyResponse.body.has_more) {
            return errorResponse(request, "malformed_provider_response", "Slack history claimed another page without a cursor");
          }

          const messages: Record<string, unknown>[] = [];
          const seenMessageIds = new Set<string>();
          try {
            for (const raw of historyResponse.body.messages) {
              if (!isRecord(raw) || raw.type !== "message") throw new TypeError("message shape");
              if (raw.channel_id !== undefined && raw.channel_id !== chat.chat_id) throw new TypeError("message scope");
              const timestamp = slackTimestamp(raw.ts);
              if (timestamp !== null && timestamp.seconds === interval.to_ts) continue;
              if (timestamp === null || timestamp.seconds < interval.from_ts || timestamp.seconds > interval.to_ts
                || seenMessageIds.has(timestamp.raw)) throw new TypeError("message timestamp");
              seenMessageIds.add(timestamp.raw);
              const authorId = boundedIdentifier(raw.user ?? raw.bot_id, "Slack message author", 256);
              if (typeof raw.text !== "string" || encoder.encode(raw.text).byteLength > 65_536) throw new TypeError("message text");
              let editedAt: number | undefined;
              let revision = timestamp.raw;
              if (raw.edited !== undefined) {
                if (!isRecord(raw.edited)) throw new TypeError("message edit");
                const edited = slackTimestamp(raw.edited.ts);
                if (edited === null) throw new TypeError("message edit timestamp");
                editedAt = edited.seconds;
                revision = edited.raw;
              }
              let parentId: Record<string, string> | undefined;
              if (raw.thread_ts !== undefined && raw.thread_ts !== timestamp.raw) {
                const parent = slackTimestamp(raw.thread_ts);
                if (parent === null) throw new TypeError("message thread");
                parentId = { platform: "slack", account, chat_id: chat.chat_id, msg_id: parent.raw };
              }
              messages.push({
                kind: "create",
                message: {
                  key: { platform: "slack", account, chat_id: chat.chat_id, msg_id: timestamp.raw },
                  author_id: authorId,
                  ts: timestamp.seconds,
                  body: raw.text,
                  ...(parentId === undefined ? {} : { parent_id: parentId }),
                  attachments: [],
                  ...(editedAt === undefined ? {} : { edited_at: editedAt }),
                },
                revision: { source: "adapter", value: revision },
              });
            }
          } catch {
            return errorResponse(request, "malformed_provider_response", "Slack history contained an unscoped or malformed message");
          }
          messages.sort((left, right) => {
            const leftMessage = left.message as { ts: number; key: { msg_id: string } };
            const rightMessage = right.message as { ts: number; key: { msg_id: string } };
            return leftMessage.ts - rightMessage.ts || leftMessage.key.msg_id.localeCompare(rightMessage.key.msg_id);
          });

          let infoResponse: SlackApiResponse;
          try {
            infoResponse = await options.transport.call({
              method: "conversations.info",
              payload: { channel: chat.chat_id },
              signal: controller.signal,
            });
          } catch {
            infoResponse = { status: 0, headers: {}, body: null };
          }
          let unread: Record<string, unknown>;
          if (isRecord(infoResponse.body) && infoResponse.body.ok === true) {
            if (!isRecord(infoResponse.body.channel) || infoResponse.body.channel.id !== chat.chat_id) {
              return errorResponse(request, "scope_mismatch", "Slack conversation info did not match the requested chat");
            }
            const count = infoResponse.body.channel.unread_count;
            unread = Number.isSafeInteger(count) && (count as number) >= 0
              ? { chat: { platform: "slack", account, chat_id: chat.chat_id }, status: "known", source: "platform", count, observed_at: now() }
              : { chat: { platform: "slack", account, chat_id: chat.chat_id }, status: "unknown", source: "unknown", count: null, reason: "unavailable", observed_at: now() };
          } else {
            unread = { chat: { platform: "slack", account, chat_id: chat.chat_id }, status: "unknown", source: "unknown", count: null, reason: "unavailable", observed_at: now() };
          }
          const observedAt = now();
          if (!Number.isFinite(observedAt) || observedAt < 0) {
            return errorResponse(request, "invalid_clock", "Slack worker clock is invalid");
          }
          unread.observed_at = observedAt;
          const chatKey = { platform: "slack", account, chat_id: chat.chat_id };
          const page = {
            v: 1,
            mode: "bounded_history",
            chat,
            interval,
            messages,
            tombstones: [],
            identity: { chat: chatKey, status: "known", source: "authenticated_adapter", self_id: auth.selfId, observed_at: observedAt },
            unread,
            coverage: [],
            limits: [{ chat: chatKey, interval, reason: "unsupported", observed_at: observedAt }],
            next_cursor: nextCursor,
            authoritative: false,
            observed_at: observedAt,
          };
          return successResponse(request, { items: [page], next_cursor: nextCursor, authoritative: false });
        }
        if (request.operation.op === "send") {
          const { envelope, idempotency_key: idempotencyKey } = request.operation;
          const destination = envelope.destination;
          if (destination.kind !== "chat" || destination.platform !== "slack" || destination.account !== account
            || !allowedChatIds.has(destination.chat_id) || envelope.content.mode !== "text") {
            return errorResponse(request, "scope_mismatch", "Slack send requires the exact configured text chat");
          }
          if (envelope.reply !== undefined && slackTimestamp(envelope.reply.parent_id) === null) {
            return errorResponse(request, "invalid_thread", "Slack reply parent id must be a Slack timestamp");
          }
          const auth = await observeAuth(controller.signal);
          if (auth.state !== "authenticated") {
            return errorResponse(
              request,
              auth.state === "unauthenticated" ? "authentication_failed" : "authentication_unavailable",
              `Slack authentication is ${auth.state}`,
              auth.state === "unknown",
            );
          }
          let postResponse: SlackApiResponse;
          try {
            postResponse = await options.transport.call({
              method: "chat.postMessage",
              payload: {
                channel: destination.chat_id,
                text: envelope.content.body,
                ...(envelope.reply === undefined ? {} : { thread_ts: envelope.reply.parent_id }),
                client_msg_id: idempotencyKey,
                mrkdwn: false,
                unfurl_links: false,
                unfurl_media: false,
              },
              signal: controller.signal,
            });
          } catch {
            return errorResponse(request, "slack_send_uncertain", "Slack send transport ended after dispatch", false, true);
          }
          if (!isRecord(postResponse.body)) {
            return errorResponse(request, "slack_send_uncertain", "Slack send returned a malformed response after dispatch", false, true);
          }
          if (postResponse.body.ok !== true) {
            const providerCode = typeof postResponse.body.error === "string"
              && postResponse.body.error.length > 0 && postResponse.body.error.length <= 256
              ? postResponse.body.error
              : "unknown_error";
            if (postResponse.body.ok === false && DEFINITIVE_SEND_FAILURES.has(providerCode)) {
              return successResponse(request, { outcome: "failed", reason: `Slack send rejected: ${providerCode}` });
            }
            return errorResponse(request, "slack_send_uncertain", "Slack send returned an ambiguous error after dispatch", false, true);
          }
          if (postResponse.body.channel !== destination.chat_id) {
            return errorResponse(request, "slack_send_uncertain", "Slack send acknowledgement scope did not match", false, true);
          }
          const receipt = slackTimestamp(postResponse.body.ts);
          if (receipt === null || !isRecord(postResponse.body.message)
            || postResponse.body.message.ts !== receipt.raw
            || postResponse.body.message.text !== envelope.content.body
            || (envelope.reply === undefined
              ? postResponse.body.message.thread_ts !== undefined && postResponse.body.message.thread_ts !== receipt.raw
              : postResponse.body.message.thread_ts !== envelope.reply.parent_id)
            || (postResponse.body.message.client_msg_id !== undefined && postResponse.body.message.client_msg_id !== idempotencyKey)) {
            return errorResponse(request, "slack_send_uncertain", "Slack send acknowledgement did not match the exact send", false, true);
          }
          return successResponse(request, { outcome: "sent", receipt_id: receipt.raw });
        }
        if (request.operation.op === "read_receipt") {
          const { destination, receipt_id: receiptId, expected } = request.operation;
          if (destination.platform !== "slack" || destination.account !== account || !allowedChatIds.has(destination.chat_id)) {
            return errorResponse(request, "scope_mismatch", "Slack receipt requires the exact configured account and chat");
          }
          if (slackTimestamp(receiptId) === null
            || (expected.reply !== undefined && slackTimestamp(expected.reply.parent_id) === null)) {
            return errorResponse(request, "invalid_receipt", "Slack receipt and thread ids must be Slack timestamps");
          }
          const auth = await observeAuth(controller.signal);
          if (auth.state !== "authenticated" || auth.selfId === undefined) {
            return errorResponse(
              request,
              auth.state === "unauthenticated" ? "authentication_failed" : "authentication_unavailable",
              `Slack authentication is ${auth.state}`,
              auth.state === "unknown",
            );
          }
          const threaded = expected.reply !== undefined;
          let receiptResponse: SlackApiResponse;
          try {
            receiptResponse = await options.transport.call({
              method: threaded ? "conversations.replies" : "conversations.history",
              payload: {
                channel: destination.chat_id,
                ...(threaded ? { ts: expected.reply!.parent_id } : {}),
                oldest: receiptId,
                latest: receiptId,
                inclusive: true,
                limit: 100,
              },
              signal: controller.signal,
            });
          } catch {
            return successResponse(request, { outcome: "unavailable", reason: "Slack receipt transport unavailable" });
          }
          if (receiptResponse.status === 429 || (isRecord(receiptResponse.body) && receiptResponse.body.error === "ratelimited")) {
            const retryAfter = retryAfterSeconds(receiptResponse);
            return successResponse(request, {
              outcome: "unavailable",
              reason: retryAfter === null
                ? "Slack receipt rate limit omitted a valid retry delay"
                : `Slack receipt rate limited for ${retryAfter} seconds`,
            });
          }
          if (!isRecord(receiptResponse.body) || receiptResponse.body.ok !== true
            || !Array.isArray(receiptResponse.body.messages) || receiptResponse.body.messages.length > 100) {
            return successResponse(request, { outcome: "unavailable", reason: "Slack receipt read unavailable" });
          }
          const exact = receiptResponse.body.messages.find((candidate) => {
            if (!isRecord(candidate) || candidate.type !== "message" || candidate.ts !== receiptId
              || candidate.text !== expected.content.body || candidate.user !== auth.selfId) return false;
            return threaded
              ? candidate.thread_ts === expected.reply!.parent_id
              : candidate.thread_ts === undefined || candidate.thread_ts === receiptId;
          });
          if (exact === undefined) return successResponse(request, { outcome: "not_found" });
          return successResponse(request, {
            outcome: "verified",
            evidence: {
              destination,
              receipt_id: receiptId,
              content: expected.content,
              ...(expected.reply === undefined ? {} : { reply: expected.reply }),
            },
          });
        }
        return errorResponse(request, "unsupported_operation", "Slack worker operation is not implemented");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
