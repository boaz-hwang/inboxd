import type { Database } from "bun:sqlite";

import { createDegradedSlackReadAdapter, type SlackReadRunner, type StableSlackChat } from "../../../platforms/slack/src/index.ts";
import { syncHistoricalIntoStore } from "../../sync/src/orchestrator.ts";

export interface LocalSlackBackfillConfig {
  readonly allowedChats: readonly StableSlackChat[];
  /** Injected by the local launcher; this module does not discover credentials or execute processes. */
  readonly runner: SlackReadRunner;
  readonly now: () => number;
}

export interface LocalSlackBackfillRequest {
  readonly chat: { readonly platform: string; readonly account: string; readonly chat_id: string };
  readonly interval: { readonly from_ts: number; readonly to_ts: number };
}

/** Production-shaped local read composition with an injected, stable allowlisted runner only. */
export function createLocalSlackBackfill(database: Database, config: LocalSlackBackfillConfig) {
  const adapter = createDegradedSlackReadAdapter(config);
  const fetchHistorical = adapter.fetchHistorical;
  if (fetchHistorical === undefined) throw new Error("local Slack adapter does not support historical reads");
  return async (request: LocalSlackBackfillRequest): Promise<Record<string, unknown>> => {
    const result = await syncHistoricalIntoStore({ database, adapter: { fetchHistorical }, chat: request.chat, interval: request.interval, now: config.now });
    return { ...result, authoritative: false, read_limits: adapter.read_limits };
  };
}
