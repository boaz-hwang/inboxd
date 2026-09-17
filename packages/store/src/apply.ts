import type { Database } from "bun:sqlite";
import type { AccountIdentity, ChatKey, UnreadState } from "../../core/src/models.ts";
import type { CoverageLimit, CoverageSegment } from "../../core/src/coverage.ts";
import { coreCall } from "../../native/src/index.ts";

export interface SyncCursorUpdate { readonly chat: ChatKey; readonly cursor: string; readonly updated_at: number; readonly page_sequence?: number; }
export interface ApplySyncBatchInput {
  /** CAS against the last committed page (0 before the first page).
   * Metadata orders by observed_at, then successful serialized page commit;
   * standalone observations cannot replace timestamp ties. Never supplied by RPC. */
  readonly expected_page_sequence?: number;
  readonly identity?: AccountIdentity;
  readonly unread?: UnreadState;
  readonly events?: readonly unknown[];
  readonly sync?: SyncCursorUpdate;
  readonly coverage?: readonly CoverageSegment[];
  readonly limits?: readonly CoverageLimit[];
}

/** Trusted adapter ingestion only; do not expose this as a caller-asserted identity RPC. */
export function recordAccountIdentity(database: Database, evidence: AccountIdentity): void {
  coreCall("store.recordAccountIdentity", evidence, database);
}
export function recordUnreadState(database: Database, evidence: UnreadState): void {
  coreCall("store.recordUnreadState", evidence, database);
}

export function applySyncBatch(database: Database, input: ApplySyncBatchInput): void {
  coreCall("store.applySyncBatch", input, database);
}
export function readSyncState(database: Database, chat: ChatKey): SyncCursorUpdate | null {
  return coreCall("store.readSyncState", chat, database);
}
