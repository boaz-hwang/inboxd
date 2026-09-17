import { accountIdentity, unreadState, normalizeMessageEvent, type AccountIdentity, type UnreadState, type ChatKey, type NormalizedMessageEvent } from "../../../packages/core/src/models.ts";
import type { GatewayCapabilities } from "../../../packages/core/src/capabilities.ts";
import type { HistoricalFetchResult, FetchHistoricalRequest, Gateway } from "../../../packages/core/src/ports.ts";
import type { CoverageLimit, HalfOpenInterval } from "../../../packages/core/src/coverage.ts";

export interface StableSlackChat {
  readonly account: string;
  readonly chat_id: string;
}

export interface SlackRunnerRequest {
  readonly account: string;
  readonly chat_id: string;
  readonly interval: HalfOpenInterval;
  readonly upper_bound_ts: number;
  /** The wrapper must never follow unseen pagination. */
  readonly max_pages: 1;
}

export type SlackReadRunner = (request: SlackRunnerRequest) => Promise<readonly unknown[]>;

export interface SlackPageRequest extends SlackRunnerRequest {
  readonly provider_cursor?: string;
  readonly limit: number;
}

/** Only a launcher-owned authenticated transport may produce this envelope. */
export interface SlackAuthenticatedPage {
  readonly status: "ok";
  readonly account: string;
  readonly chat_id: string;
  readonly self_id: string;
  readonly unread_count: number | null;
  readonly events: readonly unknown[];
  readonly next_cursor: string | null;
}

export interface CursorSlackReadAdapterOptions {
  readonly allowedChats: readonly StableSlackChat[];
  readonly now: () => number;
  readonly authenticatedRunner: (request: SlackPageRequest) => Promise<SlackAuthenticatedPage | { readonly status: "rate_limited"; readonly retry_after_ms: number }>;
}

export interface SlackPageFetchResult extends HistoricalFetchResult {
  readonly next_cursor: string;
  readonly degraded: true;
  readonly incomplete: true;
  readonly page_status: "more" | "exhausted" | "rate_limited";
  readonly retry_at?: number;
  readonly identity?: AccountIdentity;
  readonly unread?: UnreadState;
}

/** Bound opaque provider tokens before they can enter an encrypted checkpoint. */
function validProviderCursor(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length > 0
    && value.length <= 4096 && new TextEncoder().encode(value).byteLength <= 4096);
}

function safeSeconds(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

interface SlackContinuation {
  readonly version: 1;
  readonly chat: ChatKey;
  readonly requested: HalfOpenInterval;
  readonly upper_bound_ts: number;
  readonly provider_cursor: string | null;
  readonly exhausted: boolean;
  readonly retry_at?: number;
}

/** One provider page per call; only the store commit makes next_cursor durable. */
export function createCursorSlackReadAdapter(options: CursorSlackReadAdapterOptions) {
  const allowlist = options.allowedChats.map((entry) => ({ ...entry }));
  if (allowlist.length === 0 || allowlist.some((entry) => !stableIdentifier(entry.account) || !stableIdentifier(entry.chat_id))) {
    throw new TypeError("Slack read allowlist must contain stable account/chat identifiers");
  }
  return {
    capabilities,
    read_limits: { authoritative_backfill: false, pagination: "bounded", cursor: "provider_continuation", max_pages: 1 } as const,
    async fetchHistorical(request: FetchHistoricalRequest, newJobIfNeeded = false): Promise<SlackPageFetchResult> {
      const now = options.now();
      assertAllowedChat(request.chat, allowlist);
      if (!safeSeconds(now)) throw new TypeError("Slack read denied: current time must be finite and safe");
      const limit = request.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError("Slack page limit must be 1..200");
      let state: SlackContinuation = request.cursor === undefined
        ? { version: 1, chat: request.chat, requested: request.interval, upper_bound_ts: now, provider_cursor: null, exhausted: false }
        : JSON.parse(request.cursor);
      if (!state || state.version !== 1 || state.chat?.platform !== request.chat.platform
        || state.chat?.account !== request.chat.account || state.chat?.chat_id !== request.chat.chat_id
        || !state.requested || !safeSeconds(state.requested.from_ts) || !safeSeconds(state.requested.to_ts)
        || state.requested.from_ts >= state.requested.to_ts
        || !safeSeconds(state.upper_bound_ts) || state.upper_bound_ts > now
        || (state.retry_at !== undefined && (!safeSeconds(state.retry_at) || state.retry_at <= state.upper_bound_ts))
        || typeof state.exhausted !== "boolean"
        || !validProviderCursor(state.provider_cursor)
        || (state.exhausted && state.provider_cursor !== null)) throw new Error("Slack cursor scope or format mismatch");
      const recoveringCooldown = state.retry_at !== undefined;
      const sameInterval = state.requested.from_ts === request.interval.from_ts && state.requested.to_ts === request.interval.to_ts;
      if (!sameInterval && !newJobIfNeeded) throw new Error("Slack cursor scope or format mismatch");
      assertIntervalBeforeIo(state.requested, state.upper_bound_ts);
      // Only the trusted durable job owner may replace a prior job. Never carry
      // its provider token into a new interval or bypass its active cooldown.
      if (newJobIfNeeded && (!sameInterval || state.exhausted)) {
        const nextInterval = assertIntervalBeforeIo(request.interval, now);
        if (state.retry_at !== undefined && now < state.retry_at) {
          return { events: [], coverage: [], limits: [{ chat: request.chat, interval: nextInterval, reason: "rate_limit", observed_at: now }],
            next_cursor: JSON.stringify(state), retry_at: state.retry_at, degraded: true, incomplete: true, page_status: "rate_limited" };
        }
        state = { version: 1, chat: request.chat, requested: request.interval, upper_bound_ts: now, provider_cursor: null, exhausted: false };
      }
      const interval = assertIntervalBeforeIo(request.interval, state.upper_bound_ts);
      const limits: CoverageLimit[] = [{ chat: request.chat, interval, reason: "unsupported", observed_at: now }];
      if (state.exhausted) {
        return { events: [], coverage: [], limits, next_cursor: JSON.stringify(state), degraded: true, incomplete: true, page_status: "exhausted" };
      }
      const rateLimited = (retry_at: number): SlackPageFetchResult => ({
        events: [], coverage: [], limits: [{ chat: request.chat, interval, reason: "rate_limit", observed_at: now }],
        next_cursor: JSON.stringify({ ...state, retry_at }), retry_at,
        degraded: true, incomplete: true, page_status: "rate_limited",
      });
      if (state.retry_at !== undefined && now < state.retry_at) return rateLimited(state.retry_at);
      let page: Awaited<ReturnType<CursorSlackReadAdapterOptions["authenticatedRunner"]>>;
      try {
        page = await options.authenticatedRunner({
          account: request.chat.account, chat_id: request.chat.chat_id, interval,
          upper_bound_ts: state.upper_bound_ts, max_pages: 1, limit,
          ...(state.provider_cursor === null ? {} : { provider_cursor: state.provider_cursor }),
        });
      } catch {
        throw new Error("Slack transport read failed");
      }
      if (page.status === "rate_limited") {
        if (!Number.isSafeInteger(page.retry_after_ms) || page.retry_after_ms <= 0) throw new Error("Invalid Slack retry delay");
        // Provider durations are milliseconds; all persisted timestamps are seconds.
        const retry_at = now + page.retry_after_ms / 1_000;
        if (!safeSeconds(retry_at) || retry_at <= now) throw new Error("Invalid Slack retry deadline");
        return rateLimited(retry_at);
      }
      if (page.status !== "ok" || page.account !== request.chat.account || page.chat_id !== request.chat.chat_id
        || !validProviderCursor(page.next_cursor)) {
        throw new Error("Slack authenticated page scope or cursor mismatch");
      }
      if (!Array.isArray(page.events) || page.events.length > limit) throw new Error("Slack provider exceeded page bound");
      if (page.next_cursor !== null && page.next_cursor === state.provider_cursor) throw new Error("Slack provider cursor did not advance");
      const normalized = page.events.map((raw) => normalizeSlackFixtureEvent(raw, request.chat));
      if (normalized.some((event) => event === null)) throw new Error("Slack page contains malformed or unscoped messages");
      const events = normalized.filter((event): event is NormalizedMessageEvent => event !== null)
        .filter((event) => isWithinInvocation(interval, event, state.upper_bound_ts));
      if (recoveringCooldown) {
        // Only successful provider I/O resolves cooldown evidence; the store
        // commits this exact-interval resolution atomically with the page.
        limits.push({ chat: request.chat, interval, reason: "rate_limit", observed_at: now, resolved_at: now });
      }
      return {
        events, coverage: [], limits,
        identity: accountIdentity({ platform: "slack", account: request.chat.account, status: "known", source: "authenticated_adapter", self_id: page.self_id, observed_at: now }),
        unread: unreadState(page.unread_count === null
          ? { chat: request.chat, status: "unknown", source: "unknown", count: null, reason: "unavailable", observed_at: now }
          : { chat: request.chat, status: "known", source: "platform", count: page.unread_count, observed_at: now }),
        next_cursor: JSON.stringify({ ...state, provider_cursor: page.next_cursor, exhausted: page.next_cursor === null, retry_at: undefined }),
        degraded: true, incomplete: true, page_status: page.next_cursor === null ? "exhausted" : "more",
      };
    },
  };
}

export interface DegradedSlackReadLimits {
  readonly authoritative_backfill: false;
  readonly pagination: "unavailable";
  readonly cursor: "unavailable";
  readonly max_pages: 1;
}

export interface DegradedSlackReadAdapterOptions {
  readonly allowedChats: readonly StableSlackChat[];
  readonly runner: SlackReadRunner;
  readonly now: () => number;
}

export interface DegradedSlackReadAdapter extends Pick<Gateway, "capabilities" | "fetchHistorical"> {
  readonly read_limits: DegradedSlackReadLimits;
}

const capabilities: GatewayCapabilities = {
  list_chats: false,
  fetch_historical: true,
  send: false,
  watch: false,
  revision: "adapter",
  read_cursor_comparison: "none",
};

const read_limits: DegradedSlackReadLimits = {
  authoritative_backfill: false,
  pagination: "unavailable",
  cursor: "unavailable",
  max_pages: 1,
};

function stableIdentifier(value: string): boolean {
  return /^stable:[A-Za-z0-9_-]{1,128}$/.test(value);
}

function sameChat(left: StableSlackChat, right: ChatKey): boolean {
  return left.account === right.account && left.chat_id === right.chat_id;
}

function assertAllowedChat(chat: ChatKey, allowlist: readonly StableSlackChat[]): void {
  if (
    chat.platform !== "slack"
    || !stableIdentifier(chat.account)
    || !stableIdentifier(chat.chat_id)
    || !allowlist.some((entry) => sameChat(entry, chat))
  ) {
    throw new Error("Slack read denied: exact stable account/chat allowlist required");
  }
}

function assertIntervalBeforeIo(interval: HalfOpenInterval, upperBound: number): HalfOpenInterval {
  if (!Number.isFinite(interval.from_ts) || !Number.isFinite(interval.to_ts) || interval.from_ts >= interval.to_ts) {
    throw new RangeError("Slack read denied: invalid interval");
  }
  if (interval.from_ts >= upperBound) throw new RangeError("Slack read denied: future since");
  return { from_ts: interval.from_ts, to_ts: Math.min(interval.to_ts, upperBound) };
}

function stringField(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(input: Record<string, unknown>, field: string): number | null {
  const value = input[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeSlackFixtureEvent(raw: unknown, chat: ChatKey): NormalizedMessageEvent | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const channel_id = stringField(input, "channel_id");
  const message_id = stringField(input, "message_id");
  const author_id = stringField(input, "author_id");
  const ts = numberField(input, "ts");
  const body = stringField(input, "body");
  if (channel_id !== chat.chat_id || message_id === null || author_id === null || ts === null || body === null) return null;
  const edited_ts = numberField(input, "edited_ts");
  return normalizeMessageEvent({
    kind: "create",
    message: {
      key: { ...chat, msg_id: message_id },
      author_id,
      ts,
      body,
      attachments: [],
      ...(edited_ts === null ? {} : { edited_at: edited_ts }),
    },
    revision: { source: "adapter", value: edited_ts ?? ts },
  });
}

function isWithinInvocation(request: HalfOpenInterval, event: NormalizedMessageEvent, upperBound: number): boolean {
  if (event.kind !== "create") return false;
  return event.message.ts >= request.from_ts && event.message.ts < request.to_ts && event.message.ts < upperBound;
}

/**
 * A read-only wrapper adapter. It has no credential lookup, process spawning,
 * send, watch, or pagination-following path; all runner behavior is injected.
 */
export function createDegradedSlackReadAdapter(options: DegradedSlackReadAdapterOptions): DegradedSlackReadAdapter {
  const allowlist = options.allowedChats.map((entry) => ({ ...entry }));
  if (allowlist.length === 0 || allowlist.some((entry) => !stableIdentifier(entry.account) || !stableIdentifier(entry.chat_id))) {
    throw new TypeError("Slack read allowlist must contain stable account/chat identifiers");
  }

  return {
    capabilities,
    read_limits,
    async fetchHistorical(request: FetchHistoricalRequest): Promise<HistoricalFetchResult> {
      const upperBound = options.now();
      assertAllowedChat(request.chat, allowlist);
      if (request.cursor !== undefined) throw new Error("Slack read denied: degraded cursor resume is unavailable");
      const interval = assertIntervalBeforeIo(request.interval, upperBound);
      const rawEvents = await options.runner({
        account: request.chat.account,
        chat_id: request.chat.chat_id,
        interval,
        upper_bound_ts: upperBound,
        max_pages: read_limits.max_pages,
      });
      const events = rawEvents
        .map((raw) => normalizeSlackFixtureEvent(raw, request.chat))
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
