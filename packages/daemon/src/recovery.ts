import type { Database } from "bun:sqlite";
import { coreCall } from "../../native/src/index.ts";
export function recoverInterruptedSends(database: Database): number {
  return coreCall("daemon.recoverInterruptedSends", null, database);
}
