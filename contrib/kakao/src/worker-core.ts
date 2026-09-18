import {
  parseWorkerRequest,
  parseWorkerResponse,
  type ChatRefV1,
  type WorkerRequestV1,
  type WorkerResponseV1,
} from "../../../packages/protocol/src/schema.ts";
import type { KakaoReadReader } from "./index.ts";

export interface KakaoLocalReadWorkerOptions {
  readonly binding_id: string;
  readonly allowed_chat: ChatRefV1 & { readonly platform: "kakao" };
  readonly measurement: unknown;
  readonly max_measurement_age: number;
  readonly max_items: number;
  readonly max_raw_bytes: number;
  readonly now: () => number;
  readonly reader: KakaoReadReader;
}

export interface KakaoLocalReadWorker {
  handle(request: unknown): Promise<WorkerResponseV1>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const REQUIRED_MEASURED_FIELDS = [
  "account_id",
  "chat_id",
  "message_id",
  "author_id",
  "ts",
  "body",
] as const;

const MAX_ITEMS = 100;
const MAX_RAW_BYTES = 16_777_216;

function measuredAt(value: unknown, now: number, maxAge: number): number | null {
  const evidence = record(value);
  const supportedFields = evidence?.supported_read_fields;
  if (
    evidence?.schema_version !== "kakao-contrib-read-measurement/v1"
    || evidence.kind !== "kakao-read-field-measurement"
    || evidence.status !== "VALIDATED"
    || evidence.observation !== "observed"
    || evidence.source !== "authorized-live-measurement"
    || evidence.send !== false
    || typeof evidence.observed_at !== "number"
    || !Number.isFinite(evidence.observed_at)
    || evidence.observed_at < 0
    || evidence.observed_at > now
    || now - evidence.observed_at > maxAge
    || !Array.isArray(supportedFields)
    || !REQUIRED_MEASURED_FIELDS.every((field) => supportedFields.includes(field))
  ) return null;
  return evidence.observed_at;
}

function responseBase(request: WorkerRequestV1) {
  return {
    v: 1 as const,
    type: "worker_response" as const,
    request_id: request.request_id,
    generation: request.generation,
    operation: request.operation.op,
  };
}

function failureValue(request: WorkerRequestV1, code: string, message: string, retryable: boolean) {
  return {
    ...responseBase(request),
    ok: false,
    error: { code, message, retryable, may_have_sent: false },
  } as const;
}

function failed(
  request: WorkerRequestV1,
  code: string,
  message: string,
  retryable = false,
): WorkerResponseV1 {
  return parseWorkerResponse(failureValue(request, code, message, retryable), request);
}

function encodedJsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Kakao local worker response is not JSON serializable");
  return new TextEncoder().encode(encoded).byteLength;
}

function succeeded(request: WorkerRequestV1, result: unknown): WorkerResponseV1 {
  const candidate = {
    ...responseBase(request),
    ok: true,
    result,
  } as const;
  if (encodedJsonBytes(candidate) > request.limits.max_response_bytes) {
    return failed(request, "bounds_exceeded", "Kakao local worker response exceeds the encoded UTF-8 byte limit");
  }
  return parseWorkerResponse(candidate, request);
}

function sameChat(left: ChatRefV1, right: ChatRefV1): boolean {
  return left.v === right.v
    && left.kind === right.kind
    && left.platform === right.platform
    && left.account === right.account
    && left.chat_id === right.chat_id;
}

function safeTimestamp(value: number): boolean {
  return Number.isFinite(value) && Number.isSafeInteger(value);
}

interface MeasuredRecord {
  readonly account_id: string;
  readonly chat_id: string;
  readonly message_id: string;
  readonly author_id: string;
  readonly ts: number;
  readonly body: string;
  readonly revision: string | number;
}

const MEASURED_RECORD_KEYS = [
  "account_id", "chat_id", "message_id", "author_id", "ts", "body", "revision",
] as const;

function measuredRecord(
  value: unknown,
  request: Extract<WorkerRequestV1["operation"], { readonly op: "read_page" }>,
  observedToTs: number,
): MeasuredRecord | null {
  const item = record(value);
  const keys = item === null ? [] : Object.keys(item);
  const revision = item?.revision;
  if (
    item === null
    || keys.length !== MEASURED_RECORD_KEYS.length
    || !MEASURED_RECORD_KEYS.every((key) => Object.hasOwn(item, key))
    || item.account_id !== request.chat.account
    || item.chat_id !== request.chat.chat_id
    || typeof item.message_id !== "string"
    || item.message_id.length === 0
    || typeof item.author_id !== "string"
    || item.author_id.length === 0
    || typeof item.ts !== "number"
    || !safeTimestamp(item.ts)
    || item.ts < request.interval.from_ts
    || item.ts >= request.interval.to_ts
    || typeof item.body !== "string"
    || !((typeof revision === "string" && revision.length > 0)
      || (typeof revision === "number" && safeTimestamp(revision)))
  ) throw new TypeError("invalid measured Kakao record");
  if (item.ts >= observedToTs) return null;
  return item as unknown as MeasuredRecord;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeMeasuredRecords(
  raw: unknown,
  request: Extract<WorkerRequestV1["operation"], { readonly op: "read_page" }>,
  observedToTs: number,
) {
  if (!Array.isArray(raw)) throw new TypeError("measured Kakao page must be an array");
  const items = raw
    .map((value) => measuredRecord(value, request, observedToTs))
    .filter((item): item is MeasuredRecord => item !== null);
  if (new Set(items.map((item) => item.message_id)).size !== items.length) {
    throw new TypeError("measured Kakao message identifiers must be unique");
  }
  const chat = { platform: "kakao", account: request.chat.account, chat_id: request.chat.chat_id } as const;
  return items
    .sort((left, right) => left.ts - right.ts || compareCodeUnits(left.message_id, right.message_id))
    .map((value) => ({
      kind: "create" as const,
      revision: { source: "observation" as const, value: "unversioned" },
      message: {
        key: { ...chat, msg_id: value.message_id },
        author_id: value.author_id,
        ts: value.ts,
        body: value.body,
        attachments: [] as const,
      },
    }));
}

export function createKakaoLocalReadWorker(options: KakaoLocalReadWorkerOptions): KakaoLocalReadWorker {
  if (
    !Number.isFinite(options.max_measurement_age)
    || options.max_measurement_age <= 0
    || !Number.isSafeInteger(options.max_items)
    || options.max_items <= 0
    || options.max_items > MAX_ITEMS
    || !Number.isSafeInteger(options.max_raw_bytes)
    || options.max_raw_bytes <= 0
    || options.max_raw_bytes > MAX_RAW_BYTES
  ) {
    throw new TypeError("Kakao local worker bounds must be finite positive values");
  }
  return {
    async handle(input: unknown): Promise<WorkerResponseV1> {
      const request = parseWorkerRequest(input);
      if (request.binding_id !== options.binding_id) {
        return failed(request, "binding_mismatch", "Kakao local worker binding does not match its fixed binding");
      }
      if (request.operation.op === "read_page") {
        if (!sameChat(request.operation.chat, options.allowed_chat)) {
          return failed(request, "scope_denied", "Kakao local read requires one exact allowlisted account and chat");
        }
        if (
          request.operation.cursor !== null
          || request.operation.limit > options.max_items
          || !safeTimestamp(request.operation.interval.from_ts)
          || !safeTimestamp(request.operation.interval.to_ts)
        ) {
          return failed(request, "bounds_exceeded", "Kakao local read exceeds cursor, item, or time bounds");
        }
      }
      if (request.operation.op === "send" || request.operation.op === "read_receipt") {
        return failed(request, "unsupported", "Kakao local worker is read-only");
      }
      const now = options.now();
      if (!Number.isSafeInteger(now) || now <= 0) {
        return failed(request, "invalid_clock", "Kakao local worker clock must be a finite positive safe integer");
      }
      const observedAt = measuredAt(options.measurement, now, options.max_measurement_age);
      if (request.operation.op === "read_page") {
        if (observedAt === null) {
          return failed(request, "measurement_unavailable", "Kakao local measurement is unavailable");
        }
        const observedInterval = {
          from_ts: request.operation.interval.from_ts,
          to_ts: Math.min(request.operation.interval.to_ts, now),
        };
        if (observedInterval.from_ts >= observedInterval.to_ts) {
          return failed(request, "bounds_exceeded", "Kakao local read interval is empty at the invocation clock");
        }
        let raw: readonly unknown[];
        try {
          raw = await options.reader({
            account: request.operation.chat.account,
            chat_id: request.operation.chat.chat_id,
            interval: observedInterval,
            upper_bound_ts: observedInterval.to_ts,
            limit: request.operation.limit,
            max_pages: 1,
          });
        } catch {
          return failed(request, "reader_unavailable", "Kakao local reader is unavailable", true);
        }
        if (Array.isArray(raw) && raw.length > request.operation.limit) {
          return failed(request, "bounds_exceeded", "Kakao local reader exceeded the requested item limit");
        }
        let rawBytes: number;
        try {
          const encoded = JSON.stringify(raw);
          if (encoded === undefined) throw new TypeError("not JSON");
          rawBytes = new TextEncoder().encode(encoded).byteLength;
        } catch {
          return failed(request, "malformed_measurement", "Kakao local reader returned non-JSON measurements");
        }
        if (rawBytes > options.max_raw_bytes) {
          return failed(request, "bounds_exceeded", "Kakao local reader exceeded the raw UTF-8 byte limit");
        }
        let messages: ReturnType<typeof normalizeMeasuredRecords>;
        try {
          messages = normalizeMeasuredRecords(raw, request.operation, observedInterval.to_ts);
        } catch {
          return failed(request, "malformed_measurement", "Kakao local reader returned malformed or unscoped measurements");
        }
        const chatKey = {
          platform: "kakao" as const,
          account: request.operation.chat.account,
          chat_id: request.operation.chat.chat_id,
        };
        const page = {
          v: 1 as const,
          mode: "bounded_history" as const,
          chat: request.operation.chat,
          interval: request.operation.interval,
          messages,
          tombstones: [] as const,
          identity: {
            chat: chatKey,
            status: "unknown" as const,
            source: "unknown" as const,
            reason: "unsupported" as const,
            observed_at: now,
          },
          unread: {
            chat: chatKey,
            status: "unknown" as const,
            source: "unknown" as const,
            count: null,
            reason: "unsupported" as const,
            observed_at: now,
          },
          coverage: [] as const,
          limits: [{ chat: chatKey, interval: request.operation.interval, reason: "unsupported" as const, observed_at: now }],
          next_cursor: null,
          authoritative: false,
          observed_at: now,
        };
        return succeeded(request, { items: [page], next_cursor: null, authoritative: false });
      }
      if (request.operation.op !== "health") throw new Error("Kakao local worker operation is not implemented");
      return succeeded(request, observedAt === null
          ? {
              state: "unavailable",
              auth: { state: "unknown", reason: "measurement_unavailable", observed_at: now },
            }
          : {
              state: "degraded",
              auth: { state: "unknown", reason: "measured_local_read_only", observed_at: observedAt },
            });
    },
  };
}
