export type RedactedValue =
  | string
  | number
  | boolean
  | null
  | RedactedValue[]
  | { readonly [key: string]: RedactedValue };

const BODY_KEYS = new Set(["body", "content", "message", "text", "rawbody"]);
const SECRET_KEYS = new Set([
  "password",
  "passphrase",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "key",
  "kdfkey",
]);
const PATH_KEYS = new Set(["path", "dbpath", "filepath", "directory", "filename"]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

export function redactionLabelForKey(key: string): string | undefined {
  const normalized = normalizedKey(key);
  if (BODY_KEYS.has(normalized) || normalized.endsWith("body") || normalized.endsWith("content")) {
    return "[REDACTED:body]";
  }
  if (
    SECRET_KEYS.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized.endsWith("passphrase")
  ) {
    return "[REDACTED:secret]";
  }
  if (PATH_KEYS.has(normalized) || normalized.endsWith("path")) return "[REDACTED:path]";
  return undefined;
}

/** Redacts known sensitive fields without retaining their source values. */
export function redactRecord(value: unknown): RedactedValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(redactRecord);
  if (typeof value !== "object") return "[REDACTED:unknown]";

  const result: Record<string, RedactedValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = redactionLabelForKey(key) ?? redactRecord(nested);
  }
  return result;
}
