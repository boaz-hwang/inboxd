import type { Database } from "bun:sqlite";

import { createCursorSlackReadAdapter, createDegradedSlackReadAdapter, type CursorSlackReadAdapterOptions, type DegradedSlackReadAdapterOptions } from "../../../platforms/slack/src/index.ts";
import { applySyncBatch, readSyncState } from "../../store/src/apply.ts";
import { syncHistoricalIntoStore } from "../../sync/src/orchestrator.ts";

/** Both transports are injected by the trusted local launcher, never supplied by RPC. */
export type LocalSlackBackfillConfig = DegradedSlackReadAdapterOptions | CursorSlackReadAdapterOptions;

export interface LocalSlackBackfillRequest {
  readonly chat: { readonly platform: string; readonly account: string; readonly chat_id: string };
  readonly interval: { readonly from_ts: number; readonly to_ts: number };
}

export interface LocalSlackBackfillResult extends Record<string, unknown> {
  readonly event_count: number;
  readonly authoritative: false;
}

/** Continuations are internal store state, never part of the RPC result. */
export function createLocalSlackBackfill(database: Database, config: LocalSlackBackfillConfig) {
  if ("authenticatedRunner" in config) {
    const adapter = createCursorSlackReadAdapter(config);
    const run = async (request: LocalSlackBackfillRequest): Promise<LocalSlackBackfillResult> => {
      const previous = readSyncState(database, request.chat);
      const fetched = await adapter.fetchHistorical({ ...request, ...(previous === null ? {} : { cursor: previous.cursor }) }, true);
      applySyncBatch(database, {
        expected_page_sequence: previous?.page_sequence ?? 0,
        ...(fetched.identity ? { identity: fetched.identity } : {}),
        ...(fetched.unread ? { unread: fetched.unread } : {}),
        events: fetched.events, coverage: fetched.coverage, limits: fetched.limits,
        sync: { chat: request.chat, cursor: fetched.next_cursor, updated_at: config.now() },
      });
      return { event_count: fetched.events.length, authoritative: false, authenticated: fetched.identity?.status === "known",
        degraded: fetched.degraded, incomplete: fetched.incomplete, page_status: fetched.page_status,
        ...(fetched.retry_at === undefined ? {} : { retry_at: fetched.retry_at }), read_limits: adapter.read_limits };
    };
    const queues = new Map<string, Promise<void>>();
    return async (request: LocalSlackBackfillRequest): Promise<LocalSlackBackfillResult> => {
      const key = JSON.stringify([request.chat.platform, request.chat.account, request.chat.chat_id]);
      const operation = (queues.get(key) ?? Promise.resolve()).then(() => run(request));
      const settled = operation.then(() => {}, () => {});
      queues.set(key, settled);
      try { return await operation; }
      finally { if (queues.get(key) === settled) queues.delete(key); }
    };
  }
  const adapter = createDegradedSlackReadAdapter(config);
  const fetchHistorical = adapter.fetchHistorical;
  if (fetchHistorical === undefined) throw new Error("local Slack adapter does not support historical reads");
  return async (request: LocalSlackBackfillRequest): Promise<LocalSlackBackfillResult> => {
    const result = await syncHistoricalIntoStore({ database, adapter: { fetchHistorical }, chat: request.chat, interval: request.interval, now: config.now });
    return { ...result, authoritative: false, read_limits: adapter.read_limits };
  };
}
