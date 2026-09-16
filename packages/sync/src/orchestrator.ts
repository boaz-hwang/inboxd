import type { Database } from "bun:sqlite";

import type { HalfOpenInterval } from "../../core/src/coverage.ts";
import type { ChatKey } from "../../core/src/models.ts";
import type { FetchHistoricalRequest, HistoricalFetchResult } from "../../core/src/ports.ts";
import { applySyncBatch, readSyncState, type ApplySyncBatchInput, type SyncCursorUpdate } from "../../store/src/apply.ts";

export interface HistoricalReadAdapter {
  readonly fetchHistorical: (request: FetchHistoricalRequest) => Promise<HistoricalFetchResult>;
}

/** Store boundary: apply must commit every member of a batch or none of them. */
export interface AtomicSyncStore {
  readonly readSyncState: (chat: ChatKey) => SyncCursorUpdate | null;
  readonly apply: (batch: ApplySyncBatchInput) => void;
}

export interface SyncHistoricalOptions {
  readonly chat: ChatKey;
  readonly interval: HalfOpenInterval;
  readonly adapter: HistoricalReadAdapter;
  readonly store: AtomicSyncStore;
  readonly now: () => number;
  readonly limit?: number;
}

export interface SyncHistoricalResult {
  readonly cursor?: string;
  readonly event_count: number;
}

/**
 * Fetches once and delegates every resulting mutation to the store's existing
 * atomic batch. A thrown runner or store operation leaves sync state unchanged.
 */
export async function syncHistorical(options: SyncHistoricalOptions): Promise<SyncHistoricalResult> {
  const previous = options.store.readSyncState(options.chat);
  const fetched = await options.adapter.fetchHistorical({
    chat: options.chat,
    interval: options.interval,
    ...(previous === null ? {} : { cursor: previous.cursor }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  const updated_at = options.now();
  options.store.apply({
    events: fetched.events,
    coverage: fetched.coverage,
    limits: fetched.limits,
    ...(fetched.next_cursor === undefined
      ? {}
      : { sync: { chat: options.chat, cursor: fetched.next_cursor, updated_at } }),
  });
  return { event_count: fetched.events.length, ...(fetched.next_cursor === undefined ? {} : { cursor: fetched.next_cursor }) };
}

/** Production composition over the store's proven applySyncBatch transaction. */
export function atomicSyncStore(database: Database): AtomicSyncStore {
  return {
    readSyncState: (chat) => readSyncState(database, chat),
    apply: (batch) => applySyncBatch(database, batch),
  };
}

export async function syncHistoricalIntoStore(options: Omit<SyncHistoricalOptions, "store"> & { readonly database: Database }): Promise<SyncHistoricalResult> {
  return syncHistorical({ ...options, store: atomicSyncStore(options.database) });
}
