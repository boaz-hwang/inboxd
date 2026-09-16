import { normalizeMessageEvent, type ChatKey, type NormalizedMessageEvent } from "../../../packages/core/src/models.ts";
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
