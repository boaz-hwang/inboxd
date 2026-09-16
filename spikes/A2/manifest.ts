export const A2_MANIFEST_SCHEMA_VERSION = "slack-wrapper-spike-a2/v1" as const;

export interface A2Manifest {
  readonly schemaVersion: typeof A2_MANIFEST_SCHEMA_VERSION;
  readonly kind: "slack-wrapper-read";
  readonly status: "BLOCKED";
  readonly observation: "not_observed";
  readonly send: false;
  readonly scope: { readonly mode: "fixture-only" | "live-requested"; readonly approved_ids: "redacted" };
  readonly redaction: { readonly bodies: "redacted"; readonly secrets: "redacted"; readonly identifiers: "redacted" };
  readonly result: "not_observed";
}

/** A2 deliberately records capability status, never Slack content or credentials. */
export function createA2Manifest(mode: "fixture-only" | "live-requested" = "fixture-only"): A2Manifest {
  return {
    schemaVersion: A2_MANIFEST_SCHEMA_VERSION,
    kind: "slack-wrapper-read",
    status: "BLOCKED",
    observation: "not_observed",
    send: false,
    scope: { mode, approved_ids: "redacted" },
    redaction: { bodies: "redacted", secrets: "redacted", identifiers: "redacted" },
    result: "not_observed",
  };
}
