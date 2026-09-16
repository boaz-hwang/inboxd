import type { ChatKey, Timestamp } from "./models.ts";
import { coreCall } from "../../native/src/index.ts";

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

export function halfOpenInterval(from_ts: number, to_ts: number): HalfOpenInterval {
  return coreCall("domain.halfOpenInterval", { from_ts, to_ts });
}

export function coverageSegment(value: CoverageSegment): CoverageSegment {
  return coreCall("domain.coverageSegment", value);
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
  return coreCall("domain.buildCoverage", input);
}
