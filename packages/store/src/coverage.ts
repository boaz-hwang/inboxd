import type { Database } from "bun:sqlite";
import type { Coverage, CoverageTarget } from "../../core/src/coverage.ts";
import { coreCall } from "../../native/src/index.ts";

export function coverageFor(database: Database, target: CoverageTarget): Coverage {
  return coreCall("store.coverageFor", target, database);
}
