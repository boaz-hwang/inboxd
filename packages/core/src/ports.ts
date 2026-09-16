import type { GatewayCapabilities } from "./capabilities.ts";
import type { CoverageLimit, CoverageSegment, HalfOpenInterval } from "./coverage.ts";
import type { ChatKey, NormalizedMessageEvent } from "./models.ts";

export interface Chat {
  readonly key: ChatKey;
  readonly display_name: string;
}

export interface ListChatsRequest {
  readonly platform?: string;
  readonly account?: string;
}

export interface FetchHistoricalRequest {
  readonly chat: ChatKey;
  readonly interval: HalfOpenInterval;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Fetch is a backfill seed, not the product's search interface. */
export interface HistoricalFetchResult {
  readonly events: readonly NormalizedMessageEvent[];
  readonly coverage: readonly CoverageSegment[];
  readonly limits: readonly CoverageLimit[];
  readonly next_cursor?: string;
}

export interface SendRequest {
  readonly chat: ChatKey;
  readonly body: string;
  readonly parent_id?: string;
  readonly idempotency_key: string;
}

export interface SendReceipt {
  readonly platform_message_id: string;
}

export type WatchListener = (event: NormalizedMessageEvent) => void | Promise<void>;
export type StopWatching = () => void | Promise<void>;

/** Core adapter ports. Each optional port is enabled only by its capability. */
export interface Gateway {
  readonly capabilities: GatewayCapabilities;
  readonly listChats?: (request?: ListChatsRequest) => Promise<readonly Chat[]>;
  readonly fetchHistorical?: (request: FetchHistoricalRequest) => Promise<HistoricalFetchResult>;
  readonly send?: (request: SendRequest) => Promise<SendReceipt>;
  readonly watch?: (listener: WatchListener) => Promise<StopWatching>;
}
