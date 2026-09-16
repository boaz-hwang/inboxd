import type { Database } from "bun:sqlite";

import { schemaVersion } from "./schema.ts";

export interface StoreDiagnosis {
  readonly cipher_version: string;
  readonly schema_version: number;
  readonly ready: boolean;
}

/** Reports readiness only for an already-open SQLCipher connection. */
export function diagnoseStore(database: Database): StoreDiagnosis {
  const cipher = database.query("PRAGMA cipher_version").get() as Record<string, unknown> | null;
  const cipher_version = cipher ? Object.values(cipher)[0] : undefined;
  const version = database.query("PRAGMA user_version").get() as { user_version: number };
  return {
    cipher_version: typeof cipher_version === "string" ? cipher_version : "",
    schema_version: version.user_version,
    ready: typeof cipher_version === "string" && cipher_version.length > 0 && version.user_version === schemaVersion,
  };
}
