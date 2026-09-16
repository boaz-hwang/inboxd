import type { Database } from "bun:sqlite";

/** A send interrupted by process death is deliberately not retried: user reconciliation is required. */
export function recoverInterruptedSends(database: Database): number {
  const result = database.run("UPDATE sends SET state = 'Uncertain' WHERE state = 'Sending'");
  return result.changes;
}
