import type { ChatKey, Timestamp } from "./models.ts";

export interface HalfOpenInterval {
  readonly from_ts: Timestamp;
  readonly to_ts: Timestamp;
}

export type CoverageKind = "backfill" | "watch" | "verified_empty";
export type CoverageLimitReason = "retention" | "permission" | "rate_limit" | "unsupported" | "unknown";

export interface CoverageSegment {
  readonly chat: ChatKey;
  readonly interval: HalfOpenInterval;
  readonly kind: CoverageKind;
  readonly collected_at: Timestamp;
  /** null is deliberately distinct from an old verification time. */
  readonly mutations_verified_at: Timestamp | null;
}

export interface CoverageLimit {
  readonly chat: ChatKey;
  readonly interval: HalfOpenInterval;
  readonly reason: CoverageLimitReason;
  readonly observed_at: Timestamp;
  readonly resolved_at?: Timestamp;
}

export interface CoverageTarget {
  readonly chat: ChatKey;
  readonly interval: HalfOpenInterval;
}

export interface CoverageGap {
  readonly interval: HalfOpenInterval;
  readonly reason: "unknown";
}

export interface CoverageFreshness {
  readonly interval: HalfOpenInterval;
  readonly collected_at: Timestamp;
  readonly mutations_verified_at: Timestamp | null;
}

/** Coverage never has a boolean `complete`: gaps preserve where knowledge ends. */
export interface Coverage {
  readonly target: CoverageTarget;
  readonly covered: readonly CoverageSegment[];
  readonly gaps: readonly CoverageGap[];
  readonly freshness: readonly CoverageFreshness[];
  readonly limits: readonly CoverageLimit[];
}

function finiteTimestamp(value: number, field: string): Timestamp {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite`);
  return value;
}

function sameChat(left: ChatKey, right: ChatKey): boolean {
  return left.platform === right.platform
    && left.account === right.account
    && left.chat_id === right.chat_id;
}

function intersect(left: HalfOpenInterval, right: HalfOpenInterval): HalfOpenInterval | null {
  const from_ts = Math.max(left.from_ts, right.from_ts);
  const to_ts = Math.min(left.to_ts, right.to_ts);
  return from_ts < to_ts ? { from_ts, to_ts } : null;
}

export function halfOpenInterval(from_ts: number, to_ts: number): HalfOpenInterval {
  finiteTimestamp(from_ts, "from_ts");
  finiteTimestamp(to_ts, "to_ts");
  if (from_ts >= to_ts) {
    throw new RangeError("half-open interval must satisfy from_ts < to_ts");
  }
  return { from_ts, to_ts };
}

export function coverageSegment(value: CoverageSegment): CoverageSegment {
  const interval = halfOpenInterval(value.interval.from_ts, value.interval.to_ts);
  if (value.kind !== "backfill" && value.kind !== "watch" && value.kind !== "verified_empty") {
    throw new TypeError("coverage kind must be backfill, watch, or verified_empty");
  }
  finiteTimestamp(value.collected_at, "collected_at");
  if (value.mutations_verified_at !== null) {
    finiteTimestamp(value.mutations_verified_at, "mutations_verified_at");
  }
  return { ...value, interval };
}

function coverageLimit(value: CoverageLimit): CoverageLimit {
  const interval = halfOpenInterval(value.interval.from_ts, value.interval.to_ts);
  if (!["retention", "permission", "rate_limit", "unsupported", "unknown"].includes(value.reason)) {
    throw new TypeError("invalid coverage limit reason");
  }
  finiteTimestamp(value.observed_at, "observed_at");
  if (value.resolved_at !== undefined) finiteTimestamp(value.resolved_at, "resolved_at");
  return { ...value, interval };
}

/**
 * Intersects a request with verified segment evidence. Uncovered space is always
 * returned as an explicit unknown gap, including a chat that was never collected.
 */
export function buildCoverage(input: {
  readonly target: CoverageTarget;
  readonly covered: readonly CoverageSegment[];
  readonly limits: readonly CoverageLimit[];
}): Coverage {
  const target: CoverageTarget = {
    chat: { ...input.target.chat },
    interval: halfOpenInterval(input.target.interval.from_ts, input.target.interval.to_ts),
  };
  const covered = input.covered.flatMap((candidate) => {
    const segment = coverageSegment(candidate);
    if (!sameChat(target.chat, segment.chat)) throw new TypeError("coverage segment chat is outside target");
    const interval = intersect(target.interval, segment.interval);
    return interval === null ? [] : [{ ...segment, interval }];
  });
  const limits = input.limits.flatMap((candidate) => {
    const limit = coverageLimit(candidate);
    if (!sameChat(target.chat, limit.chat)) throw new TypeError("coverage limit chat is outside target");
    const interval = intersect(target.interval, limit.interval);
    return interval === null ? [] : [{ ...limit, interval }];
  });

  const known = covered
    .map((segment) => segment.interval)
    .sort((left, right) => left.from_ts - right.from_ts || left.to_ts - right.to_ts);
  const gaps: CoverageGap[] = [];
  let cursor = target.interval.from_ts;
  for (const interval of known) {
    if (interval.from_ts > cursor) {
      gaps.push({ interval: halfOpenInterval(cursor, interval.from_ts), reason: "unknown" });
    }
    cursor = Math.max(cursor, interval.to_ts);
  }
  if (cursor < target.interval.to_ts) {
    gaps.push({ interval: halfOpenInterval(cursor, target.interval.to_ts), reason: "unknown" });
  }

  return {
    target,
    covered,
    gaps,
    freshness: covered.map((segment) => ({
      interval: segment.interval,
      collected_at: segment.collected_at,
      mutations_verified_at: segment.mutations_verified_at,
    })),
    limits,
  };
}
