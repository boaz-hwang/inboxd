export const KAKAO_MEASURED_READ_HARD_CEILINGS = {
  max_pages: 1,
  max_items: 100,
  max_bytes: 16_777_216,
} as const;

export type KakaoMeasuredJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly KakaoMeasuredJsonValue[]
  | { readonly [key: string]: KakaoMeasuredJsonValue };

export interface ValidatedKakaoMeasuredReadPage {
  readonly mode: "measured_local";
  readonly chat: {
    readonly v: 1;
    readonly kind: "chat";
    readonly platform: "kakao";
    readonly account: string;
    readonly chat_id: string;
  };
  readonly interval: { readonly from_ts: number; readonly to_ts: number };
  readonly page_number: 1;
  readonly items: readonly { readonly [key: string]: KakaoMeasuredJsonValue }[];
  readonly item_count: number;
  readonly page_bytes: number;
  readonly authoritative: false;
  readonly incomplete: true;
  readonly coverage: readonly [];
  readonly continuation: "none";
}

export interface KakaoMeasuredReadPolicy {
  readonly mode: "measured_local";
  readonly allowed_chat: ValidatedKakaoMeasuredReadPage["chat"];
  readonly max_pages: 1;
  readonly max_items: number;
  readonly max_bytes: number;
  readonly cursor: "none";
}

interface KakaoMeasuredPageCandidate {
  readonly mode: "measured_local";
  readonly chat: ValidatedKakaoMeasuredReadPage["chat"];
  readonly interval: ValidatedKakaoMeasuredReadPage["interval"];
  readonly page_number: 1;
  readonly items: readonly unknown[];
  readonly next_cursor: null;
  readonly authoritative: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isPositiveIntegerAtMost(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function assertMeasuredPolicy(input: unknown): asserts input is KakaoMeasuredReadPolicy {
  if (
    !isRecord(input)
    || !hasExactKeys(input, ["mode", "allowed_chat", "max_pages", "max_items", "max_bytes", "cursor"])
    || input.mode !== "measured_local"
    || input.max_pages !== KAKAO_MEASURED_READ_HARD_CEILINGS.max_pages
    || !isPositiveIntegerAtMost(input.max_items, KAKAO_MEASURED_READ_HARD_CEILINGS.max_items)
    || !isPositiveIntegerAtMost(input.max_bytes, KAKAO_MEASURED_READ_HARD_CEILINGS.max_bytes)
    || input.cursor !== "none"
    || !isRecord(input.allowed_chat)
    || !hasExactKeys(input.allowed_chat, ["v", "kind", "platform", "account", "chat_id"])
    || input.allowed_chat.v !== 1
    || input.allowed_chat.kind !== "chat"
    || input.allowed_chat.platform !== "kakao"
    || typeof input.allowed_chat.account !== "string"
    || input.allowed_chat.account.trim().length === 0
    || typeof input.allowed_chat.chat_id !== "string"
    || input.allowed_chat.chat_id.trim().length === 0
  ) {
    throw new TypeError("Kakao measured read policy must allow one bounded page for one exact Kakao chat");
  }
}

function assertFiniteInterval(input: unknown): void {
  if (
    !isRecord(input)
    || !hasExactKeys(input, ["from_ts", "to_ts"])
    || typeof input.from_ts !== "number"
    || typeof input.to_ts !== "number"
    || !Number.isFinite(input.from_ts)
    || !Number.isFinite(input.to_ts)
    || input.from_ts >= input.to_ts
  ) {
    throw new RangeError("Kakao measured read interval must be finite with from_ts before to_ts");
  }
}

function sameChat(left: unknown, right: KakaoMeasuredReadPolicy["allowed_chat"]): boolean {
  return isRecord(left)
    && hasExactKeys(left, ["v", "kind", "platform", "account", "chat_id"])
    && left.v === right.v
    && left.kind === right.kind
    && left.platform === right.platform
    && left.account === right.account
    && left.chat_id === right.chat_id;
}

function assertRequest(input: unknown, policy: KakaoMeasuredReadPolicy): asserts input is Record<string, unknown> {
  if (
    !isRecord(input)
    || !hasExactKeys(input, ["chat", "interval", "limit", "cursor"])
    || !sameChat(input.chat, policy.allowed_chat)
    || !isPositiveIntegerAtMost(input.limit, policy.max_items)
    || input.cursor !== null
  ) {
    throw new Error("Kakao measured read request exceeds its exact scope or item/cursor bounds");
  }
  assertFiniteInterval(input.interval);
}

function sameInterval(left: unknown, right: unknown): boolean {
  return isRecord(left)
    && isRecord(right)
    && hasExactKeys(left, ["from_ts", "to_ts"])
    && left.from_ts === right.from_ts
    && left.to_ts === right.to_ts;
}

function assertPage(input: unknown, request: Record<string, unknown>): asserts input is KakaoMeasuredPageCandidate {
  if (
    !isRecord(input)
    || !hasExactKeys(input, ["mode", "chat", "interval", "page_number", "items", "next_cursor", "authoritative"])
    || input.mode !== "measured_local"
    || !sameChat(input.chat, request.chat as KakaoMeasuredReadPolicy["allowed_chat"])
    || !sameInterval(input.interval, request.interval)
    || input.page_number !== 1
    || !Array.isArray(input.items)
    || input.next_cursor !== null
    || input.authoritative !== false
  ) {
    throw new Error("Kakao measured read page must remain one scoped non-authoritative page without continuation");
  }
}

function invalidItems(): never {
  throw new TypeError("Kakao measured read items must be bounded JSON objects");
}

function normalizeJsonValue(value: unknown, ancestors: Set<object>): KakaoMeasuredJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : invalidItems();
  if (typeof value !== "object") return invalidItems();
  if (ancestors.has(value)) return invalidItems();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) return invalidItems();
      const output: KakaoMeasuredJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return invalidItems();
        output.push(normalizeJsonValue(value[index], ancestors));
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidItems();
    const output: Record<string, KakaoMeasuredJsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return invalidItems();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return invalidItems();
      Object.defineProperty(output, key, {
        value: normalizeJsonValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeItems(items: readonly unknown[], limit: number): ValidatedKakaoMeasuredReadPage["items"] {
  if (items.length > limit) return invalidItems();
  return items.map((item) => {
    if (!isRecord(item)) return invalidItems();
    return normalizeJsonValue(item, new Set()) as { readonly [key: string]: KakaoMeasuredJsonValue };
  });
}

/** Pure validation for a single locally measured Kakao read page. */
export function validateKakaoMeasuredReadPage(input: unknown): ValidatedKakaoMeasuredReadPage {
  if (!isRecord(input) || !hasExactKeys(input, ["policy", "request", "page"])) {
    throw new TypeError("Kakao measured read input must be an exact policy/request/page envelope");
  }
  assertMeasuredPolicy(input.policy);
  assertRequest(input.request, input.policy);
  assertPage(input.page, input.request);
  const page = input.page;
  const items = normalizeItems(page.items, input.request.limit as number);
  const pageBytes = new TextEncoder().encode(JSON.stringify({ ...page, items })).byteLength;
  if (pageBytes > input.policy.max_bytes) {
    throw new RangeError(`Kakao measured read page exceeds the ${input.policy.max_bytes} byte ceiling`);
  }
  return {
    mode: "measured_local",
    chat: page.chat,
    interval: page.interval,
    page_number: 1,
    items,
    item_count: items.length,
    page_bytes: pageBytes,
    authoritative: false,
    incomplete: true,
    coverage: [],
    continuation: "none",
  };
}
