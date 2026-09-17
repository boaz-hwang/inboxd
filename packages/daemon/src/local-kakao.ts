import type { Database } from "bun:sqlite";

import { createKakaoReadAdapter, type KakaoReadAdapterOptions } from "../../../contrib/kakao/src/index.ts";
import { recordAccountIdentity, recordUnreadState } from "../../store/src/apply.ts";
import { syncHistoricalIntoStore } from "../../sync/src/orchestrator.ts";

export type LocalKakaoBackfillConfig = KakaoReadAdapterOptions;

export interface LocalKakaoBackfillRequest {
  readonly chat: { readonly platform: string; readonly account: string; readonly chat_id: string };
  readonly interval: { readonly from_ts: number; readonly to_ts: number };
}

/** Production-shaped local Kakao read composition with measurement and exact stable allowlisting. */
export function createLocalKakaoBackfill(database: Database, config: LocalKakaoBackfillConfig) {
  const adapter = createKakaoReadAdapter(config);
  const fetchHistorical = adapter.fetchHistorical;
  if (fetchHistorical === undefined) throw new Error("local Kakao adapter does not support historical reads");
  const queues = new Map<string, Promise<void>>();
  return async (request: LocalKakaoBackfillRequest): Promise<Record<string, unknown>> => {
    const key = `${request.chat.platform}\0${request.chat.account}\0${request.chat.chat_id}`;
    const previous = queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const result = await syncHistoricalIntoStore({
        database,
        adapter: { fetchHistorical: async (input) => {
          const fetched = await fetchHistorical(input);
          const observed_at = config.now();
          recordAccountIdentity(database, { platform: input.chat.platform, account: input.chat.account, status: "unknown", source: "unknown", reason: "unsupported", observed_at });
          recordUnreadState(database, { chat: input.chat, status: "unknown", source: "unknown", count: null, reason: "unsupported", observed_at });
          return fetched;
        } },
        chat: request.chat,
        interval: request.interval,
        now: config.now,
      });
      return { ...result, authoritative: false, read_limits: adapter.read_limits };
    });
    const settled = operation.then(() => {}, () => {});
    queues.set(key, settled);
    try {
      return await operation;
    } finally {
      if (queues.get(key) === settled) queues.delete(key);
    }
  };
}
