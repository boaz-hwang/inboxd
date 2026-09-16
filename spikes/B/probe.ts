import { redactionLabelForKey } from "./redaction.ts";

export const MANIFEST_SCHEMA_VERSION = "kakao-original-spike-b/v1" as const;

type MeasurementKind = "probe" | "db" | "ax";

export interface MeasurementManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly kind: "kakao-original-measurement";
  readonly status: "BLOCKED";
  readonly observation: "not_observed";
  readonly send: false;
  readonly scope: {
    readonly mode: "synthetic-only";
    readonly stableChatAllowlist: readonly [];
  };
  readonly redaction: {
    readonly bodies: "redacted";
    readonly secrets: "redacted";
    readonly paths: "redacted";
  };
  readonly measurements: readonly [{
    readonly name: MeasurementKind;
    readonly source: "synthetic";
    readonly result: "not_observed";
    readonly reason: string;
  }];
}

/** Creates a manifest that records no private observation and never permits sending. */
export function createBlockedManifest(name: MeasurementKind): MeasurementManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: "kakao-original-measurement",
    status: "BLOCKED",
    observation: "not_observed",
    send: false,
    scope: { mode: "synthetic-only", stableChatAllowlist: [] },
    redaction: { bodies: "redacted", secrets: "redacted", paths: "redacted" },
    measurements: [{
      name,
      source: "synthetic",
      result: "not_observed",
      reason: "No authorized live input is available; private data access is disabled.",
    }],
  };
}

const REQUIRED_FIELDS = [
  "schemaVersion",
  "kind",
  "status",
  "observation",
  "send",
  "scope",
  "redaction",
  "measurements",
] as const;

/** Validates the boundary-critical manifest fields without loading external JSON schema tooling. */
export function validateManifest(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return ["manifest must be an object"];
  }
  const manifest = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined) errors.push(`${field} is required`);
  }
  if (manifest.send !== false) errors.push("send must be false");
  if (manifest.status !== "BLOCKED") errors.push("status must be BLOCKED");
  if (manifest.observation !== "not_observed") errors.push("observation must be not_observed");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) errors.push("schemaVersion is invalid");
  if (manifest.kind !== "kakao-original-measurement") errors.push("kind is invalid");
  if (!isSyntheticOnlyScope(manifest.scope)) errors.push("scope must be synthetic-only with an empty allowlist");
  if (!hasRequiredRedaction(manifest.redaction)) errors.push("redaction policy is invalid");
  if (!isSafeMeasurementList(manifest.measurements)) errors.push("measurements must be synthetic and not_observed");
  if (containsForbiddenField(manifest)) errors.push("manifest contains a forbidden secret, body, or path field");
  return errors;
}

function isSyntheticOnlyScope(scope: unknown): boolean {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return false;
  const record = scope as Record<string, unknown>;
  return record.mode === "synthetic-only" && Array.isArray(record.stableChatAllowlist) && record.stableChatAllowlist.length === 0;
}

function hasRequiredRedaction(redaction: unknown): boolean {
  if (redaction === null || typeof redaction !== "object" || Array.isArray(redaction)) return false;
  const record = redaction as Record<string, unknown>;
  return record.bodies === "redacted" && record.secrets === "redacted" && record.paths === "redacted";
}

function isSafeMeasurementList(measurements: unknown): boolean {
  return Array.isArray(measurements) && measurements.every((measurement) => {
    if (measurement === null || typeof measurement !== "object" || Array.isArray(measurement)) return false;
    const record = measurement as Record<string, unknown>;
    return record.source === "synthetic" && record.result === "not_observed" && typeof record.name === "string";
  });
}

function containsForbiddenField(value: unknown, isRedactionPolicy = false): boolean {
  if (value === null || typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value)) {
    const isRedactionDeclaration = isRedactionPolicy && ["bodies", "secrets", "paths"].includes(key);
    if (!isRedactionDeclaration && key !== "redaction" && redactionLabelForKey(key) !== undefined) return true;
    if (containsForbiddenField(nested, key === "redaction")) return true;
  }
  return false;
}

if (import.meta.main) {
  console.log(JSON.stringify(createBlockedManifest("probe"), null, 2));
}
