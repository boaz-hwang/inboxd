import type { Database } from "bun:sqlite";

/**
 * A process death leaves the durable attempt and its intent in the same
 * indeterminate state.  Keep them in one transaction so startup never reports
 * an Uncertain attempt attached to an apparently Sending intent (or vice versa).
 */
export function recoverInterruptedSends(database: Database): number {
  database.run("BEGIN IMMEDIATE");
  try {
    const result = database.run("UPDATE sends SET state = 'Uncertain' WHERE state = 'Sending'");
    database.run("UPDATE intents SET payload_json = json_set(payload_json, '$.state', 'Uncertain') WHERE json_extract(payload_json, '$.state') = 'Sending'");
    database.run("COMMIT");
    return result.changes;
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}
