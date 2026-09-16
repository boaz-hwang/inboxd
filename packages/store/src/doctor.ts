import type { Database } from "bun:sqlite";
import { coreCall } from "../../native/src/index.ts";
export interface StoreDiagnosis { readonly cipher_version: string; readonly schema_version: number; readonly ready: boolean; }
export function diagnoseStore(database: Database): StoreDiagnosis {
  return coreCall("store.diagnose", null, database);
}
