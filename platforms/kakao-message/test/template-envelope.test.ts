import { expect, test } from "bun:test";

import {
  KAKAO_TEMPLATE_LIMITS,
  parseKakaoTemplateSendOutcome,
  validateKakaoTemplateEnvelope,
  type KakaoOfficialDestination,
  type KakaoTemplateSendOutcome,
  type KakaoTemplateEnvelope,
  type KakaoTemplateExpectation,
} from "../src/template-envelope.ts";

const sentOutcome: KakaoTemplateSendOutcome = { outcome: "sent", receipt_id: "receipt-1" };
void sentOutcome;
// @ts-expect-error Official Kakao acknowledgement cannot represent independent verification.
const verifiedOutcome: KakaoTemplateSendOutcome = { outcome: "verified", receipt_id: "receipt-1" };
void verifiedOutcome;

const destination: KakaoOfficialDestination = {
  v: 1,
  kind: "destination",
  platform: "kakao",
  account: "official-app",
  destination_id: "friend-uuid",
};

const expectation: KakaoTemplateExpectation = {
  destination,
  approved_template_id: "notice-7",
};

function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    v: 2,
    destination: { ...destination },
    content: {
      mode: "approved_template",
      template_id: "notice-7",
      arguments: { amount: 1000, label: "승인" },
      preview: "승인: 1000",
    },
    ...overrides,
  };
}

test("accepts an exact Kakao destination and approved template envelope", () => {
  const parsed: KakaoTemplateEnvelope = validateKakaoTemplateEnvelope(envelope(), expectation);

  expect(parsed).toEqual(envelope() as KakaoTemplateEnvelope);
});

test("rejects reply metadata instead of expressing a reply mode", () => {
  expect(() => validateKakaoTemplateEnvelope(
    envelope({ reply: { parent_id: "message-1" } }),
    expectation,
  )).toThrow(/reply|field/i);
});

test("rejects a free-text body even when template fields are also present", () => {
  const value = envelope() as { content: Record<string, unknown> };
  value.content.body = "unapproved free text";

  expect(() => validateKakaoTemplateEnvelope(value, expectation)).toThrow(/body|field|text/i);
});

test("rejects destination aliases rather than trusting a display identity", () => {
  const value = envelope() as { destination: Record<string, unknown> };
  value.destination.display_name = "Friend";

  expect(() => validateKakaoTemplateEnvelope(value, expectation)).toThrow(/destination.*field/i);
});

test("bounds the rendered preview by UTF-8 bytes", () => {
  const boundary = envelope() as { content: Record<string, unknown> };
  boundary.content.preview = "a".repeat(KAKAO_TEMPLATE_LIMITS.preview_bytes);
  expect(validateKakaoTemplateEnvelope(boundary, expectation).content.preview).toHaveLength(
    KAKAO_TEMPLATE_LIMITS.preview_bytes,
  );

  const oversized = envelope() as { content: Record<string, unknown> };
  oversized.content.preview = "한".repeat(Math.floor(KAKAO_TEMPLATE_LIMITS.preview_bytes / 3) + 1);
  let rejected = false;
  try {
    validateKakaoTemplateEnvelope(oversized, expectation);
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
});

test("reconstructs prototype-named template arguments as inert own data", () => {
  const objectPrototype = Object.prototype as Record<string, unknown>;
  const before = objectPrototype.polluted;
  const value = envelope() as { content: Record<string, unknown> };
  value.content.arguments = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":"data"},"prototype":{"nested":1}}',
  );

  const parsed = validateKakaoTemplateEnvelope(value, expectation);
  expect(Object.getPrototypeOf(parsed.content.arguments)).toBeNull();
  expect(Object.keys(parsed.content.arguments)).toEqual(["__proto__", "constructor", "prototype"]);
  expect(Object.prototype.hasOwnProperty.call(parsed.content.arguments, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(parsed.content.arguments.__proto__)).toBeNull();
  expect(parsed.content.arguments.__proto__).toEqual({ polluted: true });
  expect(objectPrototype.polluted).toBe(before);
});

test("bounds the complete encoded template arguments", () => {
  const jsonOverhead = new TextEncoder().encode('{"blob":""}').byteLength;
  const boundary = envelope() as { content: Record<string, unknown> };
  boundary.content.arguments = { blob: "x".repeat(KAKAO_TEMPLATE_LIMITS.arguments_bytes - jsonOverhead) };
  expect(() => validateKakaoTemplateEnvelope(boundary, expectation)).not.toThrow();

  const oversized = envelope() as { content: Record<string, unknown> };
  oversized.content.arguments = {
    blob: "x".repeat(KAKAO_TEMPLATE_LIMITS.arguments_bytes - jsonOverhead + 1),
  };
  let rejected = false;
  try {
    validateKakaoTemplateEnvelope(oversized, expectation);
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
});

test("rejects template arguments deeper than the JSON depth limit", () => {
  let nested: unknown = null;
  for (let index = 0; index <= KAKAO_TEMPLATE_LIMITS.json_depth; index += 1) nested = { nested };
  const value = envelope() as { content: Record<string, unknown> };
  value.content.arguments = { nested };

  expect(() => validateKakaoTemplateEnvelope(value, expectation)).toThrow(/depth/i);
});

test("enforces aggregate JSON breadth budgets", () => {
  const wideObject = envelope() as { content: Record<string, unknown> };
  wideObject.content.arguments = Object.fromEntries(
    Array.from({ length: KAKAO_TEMPLATE_LIMITS.json_object_keys + 1 }, (_, index) => [`k${index}`, index]),
  );
  expect(() => validateKakaoTemplateEnvelope(wideObject, expectation)).toThrow(/object|key|limit/i);

  const wideArray = envelope() as { content: Record<string, unknown> };
  wideArray.content.arguments = { values: Array.from({ length: KAKAO_TEMPLATE_LIMITS.json_array_items + 1 }, () => 0) };
  expect(() => validateKakaoTemplateEnvelope(wideArray, expectation)).toThrow(/array|item|limit/i);
});

test("accepts only ack-level Sent, failed, or uncertain outcomes", () => {
  expect(parseKakaoTemplateSendOutcome({ outcome: "sent", receipt_id: "receipt-1" })).toEqual({
    outcome: "sent",
    receipt_id: "receipt-1",
  });
  expect(parseKakaoTemplateSendOutcome({ outcome: "failed", reason: "provider_rejected" })).toEqual({
    outcome: "failed",
    reason: "provider_rejected",
  });
  expect(() => parseKakaoTemplateSendOutcome({ outcome: "verified", receipt_id: "receipt-1" })).toThrow(/outcome|verified|ack/i);
  expect(() => parseKakaoTemplateSendOutcome({ outcome: "sent", receipt_id: "receipt-1", verified: true })).toThrow(/field|verified/i);
});

test("bounds template IDs by UTF-8 bytes even when the expectation repeats the oversized value", () => {
  const boundaryId = "t".repeat(KAKAO_TEMPLATE_LIMITS.template_id_bytes);
  const boundary = envelope() as { content: Record<string, unknown> };
  boundary.content.template_id = boundaryId;
  expect(() => validateKakaoTemplateEnvelope(boundary, {
    ...expectation,
    approved_template_id: boundaryId,
  })).not.toThrow();

  const oversizedId = "한".repeat(Math.floor(KAKAO_TEMPLATE_LIMITS.template_id_bytes / 3) + 1);
  const oversized = envelope() as { content: Record<string, unknown> };
  oversized.content.template_id = oversizedId;
  expect(() => validateKakaoTemplateEnvelope(oversized, {
    ...expectation,
    approved_template_id: oversizedId,
  })).toThrow(/template.*UTF-8|template.*byte/i);
});

test("accepts the exact JSON depth boundary and rejects one level beyond it", () => {
  function nestedArguments(levels: number): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index < levels; index += 1) {
      if (index === levels - 1) cursor.value = null;
      else {
        const next: Record<string, unknown> = {};
        cursor.value = next;
        cursor = next;
      }
    }
    return root;
  }

  const boundary = envelope() as { content: Record<string, unknown> };
  boundary.content.arguments = nestedArguments(KAKAO_TEMPLATE_LIMITS.json_depth);
  expect(() => validateKakaoTemplateEnvelope(boundary, expectation)).not.toThrow();

  const oversized = envelope() as { content: Record<string, unknown> };
  oversized.content.arguments = nestedArguments(KAKAO_TEMPLATE_LIMITS.json_depth + 1);
  expect(() => validateKakaoTemplateEnvelope(oversized, expectation)).toThrow(/depth/i);
});

test("enforces exact and one-over aggregate JSON node limits before encoding", () => {
  function nodeArguments(lastArrayItems: number): Record<string, unknown> {
    return Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `group${index}`,
      Array.from({ length: index === 9 ? lastArrayItems : 999 }, () => null),
    ]));
  }

  const boundary = envelope() as { content: Record<string, unknown> };
  boundary.content.arguments = nodeArguments(998);
  expect(() => validateKakaoTemplateEnvelope(boundary, expectation)).not.toThrow();

  const oversized = envelope() as { content: Record<string, unknown> };
  oversized.content.arguments = nodeArguments(999);
  expect(() => validateKakaoTemplateEnvelope(oversized, expectation)).toThrow(/aggregate JSON node/i);
});

test("enforces per-object and aggregate JSON key limits at their boundaries", () => {
  const exactObject = envelope() as { content: Record<string, unknown> };
  exactObject.content.arguments = Object.fromEntries(
    Array.from({ length: KAKAO_TEMPLATE_LIMITS.json_object_keys }, (_, index) => [`k${index}`, index]),
  );
  expect(() => validateKakaoTemplateEnvelope(exactObject, expectation)).not.toThrow();

  const aggregate = Object.fromEntries(Array.from({ length: 16 }, (_, group) => [
    `group${group}`,
    Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`k${index}`, index])),
  ]));
  const exactAggregate = envelope() as { content: Record<string, unknown> };
  exactAggregate.content.arguments = aggregate;
  expect(() => validateKakaoTemplateEnvelope(exactAggregate, expectation)).not.toThrow();

  (aggregate.group0 as Record<string, unknown>).extra = true;
  const oversizedAggregate = envelope() as { content: Record<string, unknown> };
  oversizedAggregate.content.arguments = aggregate;
  expect(() => validateKakaoTemplateEnvelope(oversizedAggregate, expectation)).toThrow(/aggregate JSON key/i);
});

test("enforces JSON key and string UTF-8 byte limits before the encoded-object ceiling", () => {
  const boundaryKey = "k".repeat(KAKAO_TEMPLATE_LIMITS.json_key_bytes);
  const exactKey = envelope() as { content: Record<string, unknown> };
  exactKey.content.arguments = { [boundaryKey]: null };
  expect(() => validateKakaoTemplateEnvelope(exactKey, expectation)).not.toThrow();

  const oversizedKey = envelope() as { content: Record<string, unknown> };
  oversizedKey.content.arguments = { ["한".repeat(Math.floor(KAKAO_TEMPLATE_LIMITS.json_key_bytes / 3) + 1)]: null };
  expect(() => validateKakaoTemplateEnvelope(oversizedKey, expectation)).toThrow(/key.*byte/i);

  const exactString = envelope() as { content: Record<string, unknown> };
  exactString.content.arguments = { values: ["x".repeat(KAKAO_TEMPLATE_LIMITS.json_string_bytes)] };
  expect(() => validateKakaoTemplateEnvelope(exactString, expectation)).toThrow(/encoded UTF-8 bytes/i);

  const oversizedString = envelope() as { content: Record<string, unknown> };
  oversizedString.content.arguments = { values: ["한".repeat(Math.floor(KAKAO_TEMPLATE_LIMITS.json_string_bytes / 3) + 1)] };
  expect(() => validateKakaoTemplateEnvelope(oversizedString, expectation)).toThrow(/string byte/i);
});

test("distinguishes the aggregate JSON string budget from the smaller encoded-object ceiling", () => {
  const exactTotal = envelope() as { content: Record<string, unknown> };
  exactTotal.content.arguments = {
    values: Array.from({ length: 16 }, () => "x".repeat(KAKAO_TEMPLATE_LIMITS.json_string_bytes)),
  };
  expect(() => validateKakaoTemplateEnvelope(exactTotal, expectation)).toThrow(/encoded UTF-8 bytes/i);

  const oversizedTotal = envelope() as { content: Record<string, unknown> };
  oversizedTotal.content.arguments = {
    values: [
      ...Array.from({ length: 16 }, () => "x".repeat(KAKAO_TEMPLATE_LIMITS.json_string_bytes)),
      "x",
    ],
  };
  expect(() => validateKakaoTemplateEnvelope(oversizedTotal, expectation)).toThrow(/aggregate JSON string/i);
});

test("keeps the Kakao destination write-only and the acknowledgement ceiling Sent-only", () => {
  const chatEnvelope = envelope() as { destination: Record<string, unknown> };
  chatEnvelope.destination = {
    v: 1,
    kind: "chat",
    platform: "kakao",
    account: "official-app",
    chat_id: "room-7",
  };
  expect(() => validateKakaoTemplateEnvelope(chatEnvelope, expectation)).toThrow(/destination|field|match/i);
  expect(() => parseKakaoTemplateSendOutcome({
    outcome: "verified",
    evidence: { destination, receipt_id: "receipt-1" },
  })).toThrow(/verified|unsupported|outcome/i);
});
