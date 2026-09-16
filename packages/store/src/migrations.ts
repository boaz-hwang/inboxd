import type { Database } from "bun:sqlite";

import { initialSchema, schemaVersion } from "./schema.ts";

export { schemaVersion } from "./schema.ts";

/** Applies the versioned encrypted-store schema without opening any database itself. */
export function migrateDatabase(database: Database): number {
  const current = database.query("PRAGMA user_version").get() as { user_version: number };
  if (current.user_version > schemaVersion) {
    throw new Error(`Store schema ${current.user_version} is newer than this application`);
  }
  if (current.user_version === schemaVersion) return schemaVersion;

  database.run("BEGIN IMMEDIATE");
  try {
    database.exec(initialSchema);
    database.run(`PRAGMA user_version = ${schemaVersion}`);
    database.run("COMMIT");
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
  return schemaVersion;
}
