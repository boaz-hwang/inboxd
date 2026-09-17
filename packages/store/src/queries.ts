import type { Database } from "bun:sqlite";
import type { AggregateCoverageTarget, Coverage, CoverageTarget } from "../../core/src/coverage.ts";
import type { AccountIdentity, MessageKey, UnreadState } from "../../core/src/models.ts";
import { coreCall } from "../../native/src/index.ts";

export interface StoredMessage {
  readonly platform: string; readonly account: string; readonly chat_id: string; readonly msg_id: string;
  readonly author_id: string | null; readonly ts: number; readonly body: string | null;
  readonly edited_at: number | null; readonly deleted_at: number | null; readonly revision: string | number;
}
export interface PageInput { readonly limit?: number; readonly cursor?: string; }
export interface SearchMessagesInput extends CoverageTarget, PageInput { readonly query: string; }
export interface SearchMessagesResult { readonly messages: readonly StoredMessage[]; readonly coverage: Coverage; readonly next_cursor?: string; }
export interface InboxMessagesInput extends CoverageTarget, PageInput {}
export interface InboxMessagesResult { readonly messages: readonly StoredMessage[]; readonly coverage: Coverage; readonly next_cursor?: string; }

export interface RecentMessagesInput extends AggregateCoverageTarget, PageInput {
  readonly sender?: "all" | "self";
}
export interface RecentMessagesResult {
  readonly messages: readonly StoredMessage[];
  readonly coverage: readonly Coverage[];
  readonly identities: readonly AccountIdentity[];
  readonly unread: readonly UnreadState[];
  readonly next_cursor?: string;
}
export interface RecentEvidencePacket extends Omit<RecentMessagesResult, "messages"> {
  readonly kind: "recent_messages_evidence";
  readonly query: AggregateCoverageTarget & { readonly sender: "all" | "self"; readonly order: "latest"; readonly limit: number };
  readonly evidence: readonly {
    readonly source: { readonly operation: "store.getMessage"; readonly key: MessageKey };
    readonly message: StoredMessage;
  }[];
}

/** Latest-first, then binary platform/account/chat/message key; never a global implicit scope. */
export function recentMessages(database: Database, input: RecentMessagesInput): RecentMessagesResult {
  return coreCall("store.recentMessages", input, database);
}
/** Q1 is local, deterministic evidence retrieval, not a hosted-model summary. */
export function recentEvidence(database: Database, input: RecentMessagesInput): RecentEvidencePacket {
  return coreCall("store.recentEvidence", input, database);
}

export function getMessage(database: Database, key: MessageKey): StoredMessage | null {
  return coreCall("store.getMessage", key, database);
}
export function inboxMessages(database: Database, input: InboxMessagesInput): InboxMessagesResult {
  const scope_codec = JSON.stringify({ chat: input.chat, interval: input.interval });
  return coreCall("store.inboxMessages", { ...input, scope_codec }, database);
}
export function searchMessages(database: Database, input: SearchMessagesInput): SearchMessagesResult {
  const scope_codec = JSON.stringify({ chat: input.chat, interval: input.interval, query: input.query });
  return coreCall("store.searchMessages", { ...input, scope_codec }, database);
}
