import type { Database } from "bun:sqlite";
import { coreCall } from "../../native/src/index.ts";
export { schemaVersion } from "./schema.ts";

export function migrateDatabase(database: Database): number {
  return coreCall("store.migrate", null, database);
}
