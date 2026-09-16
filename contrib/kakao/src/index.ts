import { normalizeMessageEvent, type ChatKey, type NormalizedMessageEvent } from "../../../packages/core/src/models.ts";
import type { GatewayCapabilities } from "../../../packages/core/src/capabilities.ts";
import type { FetchHistoricalRequest, Gateway, HistoricalFetchResult } from "../../../packages/core/src/ports.ts";
import type { CoverageLimit, HalfOpenInterval } from "../../../packages/core/src/coverage.ts";

export interface StableKakaoChat {
  readonly account: string;
  readonly chat_id: string;
}

/**
 * This shape is deliberately strict: only a future, authorized live measurement
 * may prove the raw fields required by this adapter. Test fixtures model the
 * shape, not an actual product enablement.
 */
export interface KakaoMeasurementEvidence {
  readonly schema_version: "kakao-contrib-read-measurement/v1";
  readonly kind: "kakao-read-field-measurement";
  readonly status: "VALIDATED";
  readonly observation: "observed";
  readonly source: "authorized-live-measurement";
  readonly observed_at: number;
  readonly send: false;
  readonly supported_read_fields: readonly KakaoSupportedReadField[];
}

export type KakaoSupportedReadField =
  | "account_id"
  | "chat_id"
  | "message_id"
  | "author_id"
  | "ts"
  | "body"
  | "revision";

export interface KakaoReaderRequest {
  readonly account: string;
  readonly chat_id: string;
  readonly interval: HalfOpenInterval;
  readonly upper_bound_ts: number;
  /** Pagination is never followed unless future measured evidence proves it. */
  readonly max_pages: 1;
}

export type KakaoReadReader = (request: KakaoReaderRequest) => Promise<readonly unknown[]>;

export interface KakaoReadLimits {
  readonly authoritative_backfill: false;
  readonly pagination: "unavailable";
  readonly cursor: "unverified";
  readonly max_pages: 1;
}

export interface KakaoReadAdapterOptions {
  readonly allowedChats: readonly StableKakaoChat[];
  readonly measurement: unknown;
  readonly max_measurement_age: number;
  readonly now: () => number;
  readonly reader: KakaoReadReader;
}

export interface KakaoReadAdapter extends Pick<Gateway, "capabilities" | "fetchHistorical"> {
  readonly read_limits: KakaoReadLimits;
}

const REQUIRED_READ_FIELDS: readonly KakaoSupportedReadField[] = [
  "account_id",
  "chat_id",
  "message_id",
  "author_id",
  "ts",
  "body",
];

const capabilities: GatewayCapabilities = {
  list_chats: false,
  fetch_historical: true,
  send: false,
  watch: false,
  revision: "none",
  read_cursor_comparison: "none",
};

const read_limits: KakaoReadLimits = {
  authoritative_backfill: false,
  pagination: "unavailable",
  cursor: "unverified",
  max_pages: 1,
};

function stableIdentifier(value: string): boolean {
  return /^stable:[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameChat(left: StableKakaoChat, right: ChatKey): boolean {
  return left.account === right.account && left.chat_id === right.chat_id;
}

function assertAllowedChat(chat: ChatKey, allowlist: readonly StableKakaoChat[]): void {
  if (
    chat.platform !== "kakao"
    || !stableIdentifier(chat.account)
    || !stableIdentifier(chat.chat_id)
    || !allowlist.some((entry) => sameChat(entry, chat))
  ) {
    throw new Error("Kakao read denied: exact stable account/chat allowlist required");
  }
}

function assertMeasurementEvidence(input: unknown, now: number, maxAge: number): asserts input is KakaoMeasurementEvidence {
  if (!isRecord(input)) throw new Error("Kakao read denied: measurement evidence is required");
  if (input.status !== "VALIDATED") throw new Error("Kakao read denied: measurement status must be VALIDATED");
  if (input.observation !== "observed") throw new Error("Kakao read denied: measurement observation must be observed");
  if (input.schema_version !== "kakao-contrib-read-measurement/v1" || input.kind !== "kakao-read-field-measurement") {
    throw new Error("Kakao read denied: measurement evidence is invalid");
  }
  if (input.source !== "authorized-live-measurement" || input.send !== false) {
    throw new Error("Kakao read denied: measurement evidence is invalid");
  }
  if (typeof input.observed_at !== "number" || !Number.isFinite(input.observed_at) || input.observed_at > now) {
    throw new Error("Kakao read denied: measurement evidence is invalid");
  }
  if (now - input.observed_at > maxAge) throw new Error("Kakao read denied: measurement evidence is stale");
  const supportedReadFields = input.supported_read_fields;
  if (
    !Array.isArray(supportedReadFields)
    || !REQUIRED_READ_FIELDS.every((field) => supportedReadFields.includes(field))
  ) {
    throw new Error("Kakao read denied: measurement evidence does not prove required live read fields");
  }
}

function assertInvocationInterval(interval: HalfOpenInterval, upperBound: number): HalfOpenInterval {
  if (!Number.isFinite(interval.from_ts) || !Number.isFinite(interval.to_ts) || interval.from_ts >= interval.to_ts) {
    throw new RangeError("Kakao read denied: invalid interval");
  }
  if (interval.from_ts >= upperBound) throw new RangeError("Kakao read denied: future since");
  return { from_ts: interval.from_ts, to_ts: Math.min(interval.to_ts, upperBound) };
}

function stringField(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberField(input: Record<string, unknown>, field: string): number | null {
  const value = input[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeKakaoFixtureEvent(raw: unknown, chat: ChatKey): NormalizedMessageEvent | null {
  if (!isRecord(raw)) return null;
  const account_id = stringField(raw, "account_id");
  const chat_id = stringField(raw, "chat_id");
  const message_id = stringField(raw, "message_id");
  const author_id = stringField(raw, "author_id");
  const ts = numberField(raw, "ts");
  const body = stringField(raw, "body");
  if (
    account_id !== chat.account
    || chat_id !== chat.chat_id
    || message_id === null
    || author_id === null
    || ts === null
    || body === null
  ) {
    return null;
  }
  return normalizeMessageEvent({
    kind: "create",
    message: {
      key: { ...chat, msg_id: message_id },
      author_id,
      ts,
      body,
      attachments: [],
    },
    revision: { source: "observation", value: "unversioned" },
  });
}

function isWithinInvocation(interval: HalfOpenInterval, event: NormalizedMessageEvent, upperBound: number): boolean {
  return event.kind === "create"
    && event.message.ts >= interval.from_ts
    && event.message.ts < interval.to_ts
    && event.message.ts < upperBound;
}

/**
 * A dependency-injected, read-only adapter. It has no credential, database,
 * AX, process, discovery, send, watch, pagination, or cursor-resume path.
 */
export function createKakaoReadAdapter(options: KakaoReadAdapterOptions): KakaoReadAdapter {
  const allowlist = options.allowedChats.map((entry) => ({ ...entry }));
  if (
    allowlist.length === 0
    || allowlist.some((entry) => !stableIdentifier(entry.account) || !stableIdentifier(entry.chat_id))
  ) {
    throw new TypeError("Kakao read allowlist must contain stable account/chat identifiers");
  }
  if (!Number.isFinite(options.max_measurement_age) || options.max_measurement_age < 0) {
    throw new TypeError("Kakao max_measurement_age must be a non-negative finite number");
  }

  return {
    capabilities,
    read_limits,
    async fetchHistorical(request: FetchHistoricalRequest): Promise<HistoricalFetchResult> {
      const upperBound = options.now();
      if (!Number.isFinite(upperBound)) throw new TypeError("Kakao read denied: current time must be finite");
      assertMeasurementEvidence(options.measurement, upperBound, options.max_measurement_age);
      assertAllowedChat(request.chat, allowlist);
      if (request.cursor !== undefined) throw new Error("Kakao read denied: cursor resume is not measured");
      const interval = assertInvocationInterval(request.interval, upperBound);
      let rawEvents: readonly unknown[];
      try {
        rawEvents = await options.reader({
          account: request.chat.account,
          chat_id: request.chat.chat_id,
          interval,
          upper_bound_ts: upperBound,
          max_pages: read_limits.max_pages,
        });
      } catch {
        throw new Error("Kakao transport read failed");
      }
      const events = rawEvents
        .map((raw) => normalizeKakaoFixtureEvent(raw, request.chat))
        .filter((event): event is NormalizedMessageEvent => event !== null)
        .filter((event) => isWithinInvocation(interval, event, upperBound));
      const limits: readonly CoverageLimit[] = [{
        chat: request.chat,
        interval,
        reason: "unsupported",
        observed_at: upperBound,
      }];
      return { events, coverage: [], limits };
    },
  };
}
