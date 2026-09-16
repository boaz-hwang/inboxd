import type { Database } from "bun:sqlite";
import type { ChatKey } from "../../core/src/models.ts";
import type { CoverageLimit, CoverageSegment } from "../../core/src/coverage.ts";
import { coreCall } from "../../native/src/index.ts";

export interface SyncCursorUpdate { readonly chat: ChatKey; readonly cursor: string; readonly updated_at: number; }
export interface ApplySyncBatchInput {
  readonly events?: readonly unknown[];
  readonly sync?: SyncCursorUpdate;
  readonly coverage?: readonly CoverageSegment[];
  readonly limits?: readonly CoverageLimit[];
}

export function applySyncBatch(database: Database, input: ApplySyncBatchInput): void {
  coreCall("store.applySyncBatch", input, database);
}
export function readSyncState(database: Database, chat: ChatKey): SyncCursorUpdate | null {
  return coreCall("store.readSyncState", chat, database);
}
