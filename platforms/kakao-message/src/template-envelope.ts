export const KAKAO_TEMPLATE_LIMITS = Object.freeze({
  template_id_bytes: 1_024,
  preview_bytes: 65_536,
  arguments_bytes: 65_536,
  json_depth: 32,
  json_nodes: 10_000,
  json_object_keys: 256,
  json_total_keys: 4_096,
  json_array_items: 1_000,
  json_key_bytes: 256,
  json_string_bytes: 65_536,
  json_total_string_bytes: 1_048_576,
});

export type KakaoJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly KakaoJsonValue[]
  | { readonly [key: string]: KakaoJsonValue };

export interface KakaoOfficialDestination {
  readonly v: 1;
  readonly kind: "destination";
  readonly platform: "kakao";
  readonly account: string;
  readonly destination_id: string;
}

export interface KakaoTemplateEnvelope {
  readonly v: 2;
  readonly destination: KakaoOfficialDestination;
  readonly content: {
    readonly mode: "approved_template";
    readonly template_id: string;
    readonly arguments: { readonly [key: string]: KakaoJsonValue };
    readonly preview: string;
  };
}

export interface KakaoTemplateExpectation {
  readonly destination: KakaoOfficialDestination;
  readonly approved_template_id: string;
}

export type KakaoTemplateSendOutcome =
  | { readonly outcome: "sent"; readonly receipt_id: string }
  | { readonly outcome: "failed" | "uncertain"; readonly reason: string };

const utf8Encoder = new TextEncoder();

function boundedUtf8String(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (utf8Encoder.encode(value).byteLength > maximumBytes) {
    throw new RangeError(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function exactObject(
  value: unknown,
  expectedFields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const fields = Reflect.ownKeys(value);
  if (
    fields.length !== expectedFields.length
    || !fields.every((field) => typeof field === "string" && expectedFields.includes(field))
  ) {
    throw new TypeError(`${label} contains an unsupported field`);
  }
  return value as Record<string, unknown>;
}

interface JsonBudget {
  nodes: number;
  keys: number;
  stringBytes: number;
}

function cloneJsonValue(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
  budget: JsonBudget = { nodes: 0, keys: 0, stringBytes: 0 },
): KakaoJsonValue {
  if (depth > KAKAO_TEMPLATE_LIMITS.json_depth) {
    throw new RangeError("Kakao template arguments exceed the JSON depth limit");
  }
  budget.nodes += 1;
  if (budget.nodes > KAKAO_TEMPLATE_LIMITS.json_nodes) {
    throw new RangeError("Kakao template arguments exceed the aggregate JSON node limit");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const bytes = utf8Encoder.encode(value).byteLength;
    if (bytes > KAKAO_TEMPLATE_LIMITS.json_string_bytes) {
      throw new RangeError("Kakao template argument string exceeds the JSON string byte limit");
    }
    budget.stringBytes += bytes;
    if (budget.stringBytes > KAKAO_TEMPLATE_LIMITS.json_total_string_bytes) {
      throw new RangeError("Kakao template arguments exceed the aggregate JSON string byte limit");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Kakao template arguments contain a non-JSON number");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Kakao template arguments must contain only JSON values");
  if (seen.has(value)) throw new TypeError("Kakao template arguments must not be cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > KAKAO_TEMPLATE_LIMITS.json_array_items) {
        throw new RangeError("Kakao template argument array exceeds the JSON item limit");
      }
      return Array.from(value, (entry) => cloneJsonValue(entry, seen, depth + 1, budget));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Kakao template arguments must contain only JSON objects");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > KAKAO_TEMPLATE_LIMITS.json_object_keys) {
      throw new RangeError("Kakao template argument object exceeds the JSON key limit");
    }
    budget.keys += keys.length;
    if (budget.keys > KAKAO_TEMPLATE_LIMITS.json_total_keys) {
      throw new RangeError("Kakao template arguments exceed the aggregate JSON key limit");
    }
    const parsed = Object.create(null) as Record<string, KakaoJsonValue>;
    for (const key of keys) {
      if (typeof key !== "string") throw new TypeError("Kakao template arguments contain a non-JSON key");
      if (utf8Encoder.encode(key).byteLength > KAKAO_TEMPLATE_LIMITS.json_key_bytes) {
        throw new RangeError("Kakao template argument key exceeds the JSON key byte limit");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("Kakao template arguments must contain enumerable JSON data properties");
      }
      Object.defineProperty(parsed, key, {
        value: cloneJsonValue(descriptor.value, seen, depth + 1, budget),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return parsed;
  } finally {
    seen.delete(value);
  }
}

export function validateKakaoTemplateEnvelope(
  value: unknown,
  expectation: KakaoTemplateExpectation,
): KakaoTemplateEnvelope {
  const envelopeRecord = exactObject(value, ["v", "destination", "content"], "Kakao template envelope");
  exactObject(
    envelopeRecord.destination,
    ["v", "kind", "platform", "account", "destination_id"],
    "Kakao destination",
  );
  const contentRecord = exactObject(
    envelopeRecord.content,
    ["mode", "template_id", "arguments", "preview"],
    "Kakao template content",
  );
  boundedUtf8String(
    contentRecord.template_id,
    "Kakao template ID",
    KAKAO_TEMPLATE_LIMITS.template_id_bytes,
  );
  boundedUtf8String(contentRecord.preview, "Kakao template preview", KAKAO_TEMPLATE_LIMITS.preview_bytes);
  const envelope = envelopeRecord as unknown as KakaoTemplateEnvelope;
  if (
    envelope.v !== 2
    || envelope.destination?.v !== expectation.destination.v
    || envelope.destination?.kind !== expectation.destination.kind
    || envelope.destination?.platform !== expectation.destination.platform
    || envelope.destination?.account !== expectation.destination.account
    || envelope.destination?.destination_id !== expectation.destination.destination_id
    || envelope.content?.mode !== "approved_template"
    || envelope.content?.template_id !== expectation.approved_template_id
  ) {
    throw new TypeError("Kakao template envelope does not match the expected destination and approved template");
  }
  const parsedArguments = cloneJsonValue(contentRecord.arguments);
  if (parsedArguments === null || typeof parsedArguments !== "object" || Array.isArray(parsedArguments)) {
    throw new TypeError("Kakao template arguments must be a JSON object");
  }
  const argumentObject = parsedArguments as { readonly [key: string]: KakaoJsonValue };
  const encodedArguments = JSON.stringify(argumentObject);
  if (utf8Encoder.encode(encodedArguments).byteLength > KAKAO_TEMPLATE_LIMITS.arguments_bytes) {
    throw new RangeError(
      `Kakao template arguments exceed ${KAKAO_TEMPLATE_LIMITS.arguments_bytes} encoded UTF-8 bytes`,
    );
  }
  return {
    v: 2,
    destination: { ...envelope.destination },
    content: {
      mode: "approved_template",
      template_id: envelope.content.template_id,
      arguments: argumentObject,
      preview: envelope.content.preview,
    },
  };
}

/** Official Kakao acknowledgement is Sent-only; this contract cannot express Verified. */
export function parseKakaoTemplateSendOutcome(value: unknown): KakaoTemplateSendOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Kakao template send outcome must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.outcome === "sent") {
    const outcome = exactObject(value, ["outcome", "receipt_id"], "Kakao template send outcome");
    return {
      outcome: "sent",
      receipt_id: boundedUtf8String(outcome.receipt_id, "Kakao receipt_id", 4_096),
    };
  }
  if (candidate.outcome === "failed" || candidate.outcome === "uncertain") {
    const outcome = exactObject(value, ["outcome", "reason"], "Kakao template send outcome");
    return {
      outcome: candidate.outcome,
      reason: boundedUtf8String(outcome.reason, "Kakao send outcome reason", 4_096),
    };
  }
  throw new TypeError("Kakao template send outcome is ack-only Sent, failed, or uncertain; Verified is unsupported");
}
