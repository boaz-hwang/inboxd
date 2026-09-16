import { createBlockedManifest } from "./probe.ts";

export interface MeasurementAuthorization {
  readonly explicitAuthorization: boolean;
  readonly stableChatAllowlist?: readonly string[];
}

export type AuthorizationOutcome<T> =
  | { readonly allowed: false; readonly reason: string }
  | { readonly allowed: true; readonly value: T };

function hasStableOpaqueIdentifiers(allowlist: readonly string[]): boolean {
  return allowlist.every((identifier) => /^stable:[A-Za-z0-9_-]{8,128}$/.test(identifier));
}

/**
 * Enforces authorization before a future read callback can begin.
 * This harness never supplies a callback that reads a live database.
 */
export async function requireStablePreIoAllowlist<T>(
  authorization: MeasurementAuthorization,
  readOnlyOperation: () => Promise<T>,
): Promise<AuthorizationOutcome<T>> {
  if (!authorization.explicitAuthorization) {
    return { allowed: false, reason: "explicit live authorization is required" };
  }
  const allowlist = authorization.stableChatAllowlist;
  if (!allowlist || allowlist.length === 0) {
    return { allowed: false, reason: "stable pre-I/O allowlist is required" };
  }
  if (!hasStableOpaqueIdentifiers(allowlist)) {
    return { allowed: false, reason: "stable allowlist identifiers are invalid" };
  }
  return { allowed: true, value: await readOnlyOperation() };
}

export const DB_MEASURE_HELP = `Usage: bun run spikes/B/db-measure.ts [--help]

Privacy-safe Kakao original DB/KDF/schema harness.
Default mode emits a BLOCKED/not_observed synthetic manifest.
It does not open databases, derive keys, inspect paths, read credentials, or send.`;

export function dbMeasurementManifest() {
  return createBlockedManifest("db");
}

if (import.meta.main) {
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log(DB_MEASURE_HELP);
  } else {
    console.log(JSON.stringify(dbMeasurementManifest(), null, 2));
  }
}
