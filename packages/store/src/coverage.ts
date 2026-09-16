import type { Database } from "bun:sqlite";

import { buildCoverage, type Coverage, type CoverageLimit, type CoverageTarget } from "../../core/src/coverage.ts";

interface SegmentRow {
  platform: string; account: string; chat_id: string; from_ts: number; to_ts: number;
  kind: "backfill" | "watch" | "verified_empty"; collected_at: number; mutations_verified_at: number | null;
}
interface LimitRow {
  platform: string; account: string; chat_id: string; from_ts: number; to_ts: number;
  reason: CoverageLimit["reason"]; observed_at: number; resolved_at: number | null;
}

/** Reads persisted interval evidence; absence is deliberately returned as an unknown gap. */
export function coverageFor(database: Database, target: CoverageTarget): Coverage {
  const chat = target.chat;
  const args = [chat.platform, chat.account, chat.chat_id, target.interval.to_ts, target.interval.from_ts];
  const covered = (database.query(`SELECT platform, account, chat_id, from_ts, to_ts, kind, collected_at, mutations_verified_at
    FROM sync_coverage WHERE platform = ? AND account = ? AND chat_id = ? AND from_ts < ? AND to_ts > ?
    ORDER BY from_ts, to_ts, id`).all(...args) as SegmentRow[]).map((row) => ({
      chat: { platform: row.platform, account: row.account, chat_id: row.chat_id },
      interval: { from_ts: row.from_ts, to_ts: row.to_ts }, kind: row.kind,
      collected_at: row.collected_at, mutations_verified_at: row.mutations_verified_at,
    }));
  const limits = (database.query(`SELECT platform, account, chat_id, from_ts, to_ts, reason, observed_at, resolved_at
    FROM sync_limits WHERE platform = ? AND account = ? AND chat_id = ? AND from_ts < ? AND to_ts > ?
    ORDER BY from_ts, to_ts, id`).all(...args) as LimitRow[]).map((row) => ({
      chat: { platform: row.platform, account: row.account, chat_id: row.chat_id },
      interval: { from_ts: row.from_ts, to_ts: row.to_ts }, reason: row.reason,
      observed_at: row.observed_at, ...(row.resolved_at === null ? {} : { resolved_at: row.resolved_at }),
    }));
  return buildCoverage({ target, covered, limits });
}
