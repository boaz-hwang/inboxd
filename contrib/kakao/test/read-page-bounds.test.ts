import { expect, test } from "bun:test";

import { validateKakaoMeasuredReadPage } from "../src/read-page-bounds.ts";

const chat = {
  v: 1,
  kind: "chat",
  platform: "kakao",
  account: "local",
  chat_id: "room-7",
} as const;

const interval = { from_ts: 10, to_ts: 20 };

function validInput() {
  return {
    policy: {
      mode: "measured_local",
      allowed_chat: chat,
      max_pages: 1,
      max_items: 2,
      max_bytes: 4_096,
      cursor: "none",
    },
    request: {
      chat,
      interval,
      limit: 2,
      cursor: null,
    },
    page: {
      mode: "measured_local",
      chat,
      interval,
      page_number: 1,
      items: [{ msg_id: "m1", author_id: "u1", ts: 11, body: "hello" }],
      next_cursor: null,
      authoritative: false,
    },
  };
}

test("accepts one bounded allowlisted measured page without authority or continuation", () => {
  const result = validateKakaoMeasuredReadPage(validInput());

  expect(result).toEqual({
    mode: "measured_local",
    chat,
    interval,
    page_number: 1,
    items: [{ msg_id: "m1", author_id: "u1", ts: 11, body: "hello" }],
    item_count: 1,
    page_bytes: expect.any(Number),
    authoritative: false,
    incomplete: true,
    coverage: [],
    continuation: "none",
  });
  expect(result.page_bytes).toBeGreaterThan(0);
  expect("next_cursor" in result).toBe(false);
});

test("requires a one-page measured-local policy for one exact Kakao chat", () => {
  const input = validInput();
  const invalidPolicies = [
    { ...input.policy, mode: "general_history" },
    { ...input.policy, max_pages: 2 },
    { ...input.policy, max_items: 0 },
    { ...input.policy, max_items: 101 },
    { ...input.policy, max_bytes: 0 },
    { ...input.policy, max_bytes: 16_777_217 },
    { ...input.policy, cursor: "opaque" },
    { ...input.policy, allowed_chat: { ...chat, platform: "slack" } },
    { ...input.policy, allowed_chat: { ...chat, account: "" } },
    { ...input.policy, allowed_chat: { ...chat, chat_id: "" } },
  ];

  for (const policy of invalidPolicies) {
    expect(() => validateKakaoMeasuredReadPage({ ...input, policy })).toThrow(/policy/i);
  }
});

test("rejects non-finite, empty, and reversed request intervals", () => {
  for (const interval of [
    { from_ts: Number.NaN, to_ts: 20 },
    { from_ts: 10, to_ts: Number.POSITIVE_INFINITY },
    { from_ts: 10, to_ts: 10 },
    { from_ts: 20, to_ts: 10 },
  ]) {
    const input = validInput();
    expect(() => validateKakaoMeasuredReadPage({
      ...input,
      request: { ...input.request, interval },
      page: { ...input.page, interval },
    })).toThrow(/interval/i);
  }
});

test("rejects request scope, item-limit, cursor, and shape overclaims", () => {
  const input = validInput();
  const invalidRequests = [
    { ...input.request, chat: { ...chat, platform: "slack" } },
    { ...input.request, chat: { ...chat, account: "other" } },
    { ...input.request, chat: { ...chat, chat_id: "other" } },
    { ...input.request, limit: 0 },
    { ...input.request, limit: 1.5 },
    { ...input.request, limit: 3 },
    { ...input.request, cursor: "continuation" },
    { ...input.request, cursor: undefined },
    { ...input.request, max_pages: 1 },
  ];

  for (const request of invalidRequests) {
    expect(() => validateKakaoMeasuredReadPage({ ...input, request })).toThrow(/request/i);
  }
});

test("rejects page scope, page-count, authority, coverage, and continuation overclaims", () => {
  const input = validInput();
  const invalidPages = [
    { ...input.page, mode: "general_history" },
    { ...input.page, chat: { ...chat, account: "other" } },
    { ...input.page, interval: { from_ts: 11, to_ts: 20 } },
    { ...input.page, page_number: 2 },
    { ...input.page, next_cursor: "continuation" },
    { ...input.page, next_cursor: undefined },
    { ...input.page, authoritative: true },
    { ...input.page, complete: true },
    { ...input.page, coverage: [interval] },
  ];

  for (const page of invalidPages) {
    expect(() => validateKakaoMeasuredReadPage({ ...input, page })).toThrow(/page/i);
  }
});

test("rejects item-count overflow and non-JSON page items", () => {
  const input = validInput();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const invalidItems: unknown[][] = [
    [input.page.items[0], input.page.items[0], input.page.items[0]],
    [null],
    [["nested-array-is-not-an-item"]],
    [undefined],
    [{ body: Number.NaN }],
    [{ body: undefined }],
    [{ body: 1n }],
    [cyclic],
    [new Date(0)],
  ];

  for (const items of invalidItems) {
    expect(() => validateKakaoMeasuredReadPage({
      ...input,
      page: { ...input.page, items },
    })).toThrow(/items/i);
  }
});

test("enforces the measured page ceiling in encoded UTF-8 bytes", () => {
  const input = validInput();
  const page = {
    ...input.page,
    items: [{ msg_id: "m1", author_id: "u1", ts: 11, body: "한".repeat(100) }],
  };
  const pageBytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;

  const atLimit = validateKakaoMeasuredReadPage({
    ...input,
    policy: { ...input.policy, max_bytes: pageBytes },
    page,
  });
  expect(atLimit.page_bytes).toBe(pageBytes);
  expect(() => validateKakaoMeasuredReadPage({
    ...input,
    policy: { ...input.policy, max_bytes: pageBytes - 1 },
    page,
  })).toThrow(/byte/i);
});

test("rejects malformed or widened validation envelopes", () => {
  const input = validInput();
  const invalidInputs: unknown[] = [
    null,
    [],
    {},
    { ...input, extra: true },
    { ...input, policy: undefined },
    { ...input, request: null },
    { ...input, page: null },
  ];

  for (const candidate of invalidInputs) {
    expect(() => validateKakaoMeasuredReadPage(candidate)).toThrow(/input|policy|request|page/i);
  }
});
