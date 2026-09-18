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
