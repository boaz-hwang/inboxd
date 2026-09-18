import { expect, test } from "bun:test";

import type { WorkerRequestV1 } from "../../../packages/protocol/src/schema.ts";
import type { KakaoReadReader } from "../src/index.ts";
import { createKakaoLocalReadWorker } from "../src/worker-core.ts";

const chat = {
  v: 1,
  kind: "chat",
  platform: "kakao",
  account: "stable:kakao_account_alpha",
  chat_id: "stable:kakao_chat_alpha",
} as const;

const measurement = {
  schema_version: "kakao-contrib-read-measurement/v1",
  kind: "kakao-read-field-measurement",
  status: "VALIDATED",
  observation: "observed",
  source: "authorized-live-measurement",
  observed_at: 900,
  send: false,
  supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body", "revision"],
} as const;

function request(operation: WorkerRequestV1["operation"]): WorkerRequestV1 {
  return {
    v: 1,
    type: "worker_request",
    request_id: "request-1",
    generation: 7,
    binding_id: "kakao-local-alpha",
    limits: { timeout_ms: 1_000, max_response_bytes: 1_048_576, max_queue_depth: 8 },
    operation,
  };
}

function worker(reader: KakaoReadReader = async () => [] as readonly unknown[]) {
  return createKakaoLocalReadWorker({
    binding_id: "kakao-local-alpha",
    allowed_chat: chat,
    measurement,
    max_measurement_age: 200,
    max_items: 100,
    max_raw_bytes: 65_536,
    now: () => 1_000,
    reader,
  });
}

test("rejects non-finite or non-positive worker bounds at construction", () => {
  const options = {
    binding_id: "kakao-local-alpha",
    allowed_chat: chat,
    measurement,
    max_measurement_age: 200,
    max_items: 100,
    max_raw_bytes: 65_536,
    now: () => 1_000,
    reader: async () => [] as readonly unknown[],
  };
  const invalidOptions: readonly Partial<typeof options>[] = [
    { max_measurement_age: 0 },
    { max_measurement_age: Number.POSITIVE_INFINITY },
    { max_items: 0 },
    { max_items: 1.5 },
    { max_items: 101 },
    { max_items: Number.POSITIVE_INFINITY },
    { max_raw_bytes: 0 },
    { max_raw_bytes: 1.5 },
    { max_raw_bytes: 16_777_217 },
    { max_raw_bytes: Number.POSITIVE_INFINITY },
  ];

  for (const invalid of invalidOptions) {
    expect(() => createKakaoLocalReadWorker({ ...options, ...invalid })).toThrow(/finite positive/i);
  }
});

test("returns a bounded failure when the worker clock is not a finite positive safe integer", async () => {
  for (const invalidNow of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    let readerCalls = 0;
    const kakao = createKakaoLocalReadWorker({
      binding_id: "kakao-local-alpha",
      allowed_chat: chat,
      measurement,
      max_measurement_age: 200,
      max_items: 100,
      max_raw_bytes: 65_536,
      now: () => invalidNow,
      reader: async () => { readerCalls += 1; return []; },
    });

    await expect(kakao.handle(request({ op: "health" }))).resolves.toMatchObject({
      operation: "health",
      ok: false,
      error: { code: "invalid_clock", retryable: false, may_have_sent: false },
    });
    expect(readerCalls).toBe(0);
  }
});

test("health reports a measured local reader as degraded without promoting authentication", async () => {
  let readerCalls = 0;
  const kakao = worker(async () => { readerCalls += 1; return []; });

  await expect(kakao.handle(request({ op: "health" }))).resolves.toEqual({
    v: 1,
    type: "worker_response",
    request_id: "request-1",
    generation: 7,
    operation: "health",
    ok: true,
    result: {
      state: "degraded",
      auth: { state: "unknown", reason: "measured_local_read_only", observed_at: 900 },
    },
  });
  expect(readerCalls).toBe(0);
});

test("health keeps malformed or stale measurement evidence unavailable and auth unknown", async () => {
  let readerCalls = 0;
  for (const invalidMeasurement of [
    { ...measurement, status: "BLOCKED" },
    { ...measurement, observed_at: 799 },
    { ...measurement, supported_read_fields: ["account_id", "chat_id"] },
  ]) {
    const kakao = createKakaoLocalReadWorker({
      binding_id: "kakao-local-alpha",
      allowed_chat: chat,
      measurement: invalidMeasurement,
      max_measurement_age: 200,
      max_items: 100,
      max_raw_bytes: 65_536,
      now: () => 1_000,
      reader: async () => { readerCalls += 1; return []; },
    });
    await expect(kakao.handle(request({ op: "health" }))).resolves.toMatchObject({
      ok: true,
      result: {
        state: "unavailable",
        auth: { state: "unknown", reason: "measurement_unavailable", observed_at: 1_000 },
      },
    });
  }
  expect(readerCalls).toBe(0);
});

test("read_page returns bounded measurement failures without reader I/O", async () => {
  let readerCalls = 0;
  for (const invalidMeasurement of [
    undefined,
    { ...measurement, observed_at: 799 },
  ]) {
    const kakao = createKakaoLocalReadWorker({
      binding_id: "kakao-local-alpha",
      allowed_chat: chat,
      measurement: invalidMeasurement,
      max_measurement_age: 200,
      max_items: 100,
      max_raw_bytes: 65_536,
      now: () => 1_000,
      reader: async () => { readerCalls += 1; return []; },
    });

    await expect(kakao.handle(request({
      op: "read_page", chat, interval: { from_ts: 10, to_ts: 20 }, limit: 1, cursor: null,
    }))).resolves.toEqual({
      v: 1,
      type: "worker_response",
      request_id: "request-1",
      generation: 7,
      operation: "read_page",
      ok: false,
      error: {
        code: "measurement_unavailable",
        message: "Kakao local measurement is unavailable",
        retryable: false,
        may_have_sent: false,
      },
    });
  }
  expect(readerCalls).toBe(0);
});

test("read_page returns a bounded retryable failure when the reader fails", async () => {
  const kakao = worker(async () => { throw new Error("private reader detail"); });

  await expect(kakao.handle(request({
    op: "read_page", chat, interval: { from_ts: 10, to_ts: 20 }, limit: 1, cursor: null,
  }))).resolves.toEqual({
    v: 1,
    type: "worker_response",
    request_id: "request-1",
    generation: 7,
    operation: "read_page",
    ok: false,
    error: {
      code: "reader_unavailable",
      message: "Kakao local reader is unavailable",
      retryable: true,
      may_have_sent: false,
    },
  });
});

test("send and read_receipt return fixed unsupported failures without reader I/O", async () => {
  let readerCalls = 0;
  const kakao = worker(async () => {
    readerCalls += 1;
    throw new Error("reader must not run");
  });
  const envelope = {
    v: 2,
    destination: chat,
    content: { mode: "text", body: "must not be sent" },
  } as const;
  const operations: readonly WorkerRequestV1["operation"][] = [
    { op: "send", envelope, idempotency_key: "a".repeat(64) },
    { op: "read_receipt", destination: chat, receipt_id: "receipt-1", expected: envelope },
  ];

  for (const operation of operations) {
    await expect(kakao.handle(request(operation))).resolves.toEqual({
      v: 1,
      type: "worker_response",
      request_id: "request-1",
      generation: 7,
      operation: operation.op,
      ok: false,
      error: {
        code: "unsupported",
        message: "Kakao local worker is read-only",
        retryable: false,
        may_have_sent: false,
      },
    });
  }
  expect(readerCalls).toBe(0);
});

test("read_page normalizes measured records deterministically with unknown evidence and no continuation", async () => {
  const readerRequests: unknown[] = [];
  const kakao = worker(async (readerRequest) => {
    readerRequests.push(readerRequest);
    return [
      { account_id: chat.account, chat_id: chat.chat_id, message_id: "later", author_id: "author-b", ts: 19, body: "later body", revision: "r2" },
      { account_id: chat.account, chat_id: chat.chat_id, message_id: "at-from", author_id: "author-a", ts: 10, body: "first body", revision: "r1" },
    ];
  });
  const read = request({ op: "read_page", chat, interval: { from_ts: 10, to_ts: 20 }, limit: 2, cursor: null });

  const first = await kakao.handle(read);
  const second = await kakao.handle(read);
  expect(second).toEqual(first);
  if (!first.ok || first.operation !== "read_page") throw new Error("expected successful read response");
  const page = first.result.items[0];
  if (page === undefined) throw new Error("expected read page");
  expect(first.result.next_cursor).toBeNull();
  expect(page.next_cursor).toBeNull();
  expect(readerRequests).toEqual([
    { account: chat.account, chat_id: chat.chat_id, interval: { from_ts: 10, to_ts: 20 }, upper_bound_ts: 20, limit: 2, max_pages: 1 },
    { account: chat.account, chat_id: chat.chat_id, interval: { from_ts: 10, to_ts: 20 }, upper_bound_ts: 20, limit: 2, max_pages: 1 },
  ]);
  expect(first).toMatchObject({
    operation: "read_page",
    ok: true,
    result: {
      items: [{
        v: 1,
        mode: "bounded_history",
        chat,
        interval: { from_ts: 10, to_ts: 20 },
        messages: [
          {
            kind: "create",
            revision: { source: "observation", value: "unversioned" },
            message: {
              key: { platform: "kakao", account: chat.account, chat_id: chat.chat_id, msg_id: "at-from" },
              author_id: "author-a", ts: 10, body: "first body", attachments: [],
            },
          },
          {
            kind: "create",
            revision: { source: "observation", value: "unversioned" },
            message: {
              key: { platform: "kakao", account: chat.account, chat_id: chat.chat_id, msg_id: "later" },
              author_id: "author-b", ts: 19, body: "later body", attachments: [],
            },
          },
        ],
        tombstones: [],
        identity: {
          chat: { platform: "kakao", account: chat.account, chat_id: chat.chat_id },
          status: "unknown", source: "unknown", reason: "unsupported", observed_at: 1_000,
        },
        unread: {
          chat: { platform: "kakao", account: chat.account, chat_id: chat.chat_id },
          status: "unknown", source: "unknown", count: null, reason: "unsupported", observed_at: 1_000,
        },
        coverage: [],
        limits: [{
          chat: { platform: "kakao", account: chat.account, chat_id: chat.chat_id },
          interval: { from_ts: 10, to_ts: 20 }, reason: "unsupported", observed_at: 1_000,
        }],
        next_cursor: null,
        authoritative: false,
        observed_at: 1_000,
      }],
      next_cursor: null,
      authoritative: false,
    },
  });
});

test("read_page preserves the exact requested interval while bounding I/O and filtering unobserved records", async () => {
  const readerRequests: unknown[] = [];
  const kakao = worker(async (readerRequest) => {
    readerRequests.push(readerRequest);
    return [
      {
        account_id: chat.account,
        chat_id: chat.chat_id,
        message_id: "before-now",
        author_id: "author",
        ts: 999,
        body: "observed",
        revision: "r1",
      },
      {
        account_id: chat.account,
        chat_id: chat.chat_id,
        message_id: "at-now",
        author_id: "author",
        ts: 1_000,
        body: "not observed in the bounded read",
        revision: "r2",
      },
      {
        account_id: chat.account,
        chat_id: chat.chat_id,
        message_id: "future",
        author_id: "author",
        ts: 1_200,
        body: "future",
        revision: "r3",
      },
    ];
  });

  const response = await kakao.handle(request({
    op: "read_page",
    chat,
    interval: { from_ts: 10, to_ts: 1_500 },
    limit: 3,
    cursor: null,
  }));

  expect(readerRequests).toEqual([{
    account: chat.account,
    chat_id: chat.chat_id,
    interval: { from_ts: 10, to_ts: 1_000 },
    upper_bound_ts: 1_000,
    limit: 3,
    max_pages: 1,
  }]);
  expect(response).toMatchObject({
    ok: true,
    result: {
      next_cursor: null,
      authoritative: false,
      items: [{
        interval: { from_ts: 10, to_ts: 1_500 },
        messages: [{ message: { key: { msg_id: "before-now" }, ts: 999 } }],
        coverage: [],
        limits: [{ interval: { from_ts: 10, to_ts: 1_500 }, reason: "unsupported" }],
        next_cursor: null,
        authoritative: false,
      }],
    },
  });
});

test("read_page rejects binding, exact chat, cursor, item and unsafe-time bounds before reader I/O", async () => {
  let readerCalls = 0;
  const kakao = createKakaoLocalReadWorker({
    binding_id: "kakao-local-alpha",
    allowed_chat: chat,
    measurement,
    max_measurement_age: 200,
    max_items: 2,
    max_raw_bytes: 65_536,
    now: () => 1_000,
    reader: async () => { readerCalls += 1; return []; },
  });
  const valid = request({ op: "read_page", chat, interval: { from_ts: 10, to_ts: 20 }, limit: 2, cursor: null });
  const invalid: readonly [unknown, string][] = [
    [{ ...valid, binding_id: "other-binding" }, "binding_mismatch"],
    [{ ...valid, operation: { ...valid.operation, chat: { ...chat, account: "stable:other" } } }, "scope_denied"],
    [{ ...valid, operation: { ...valid.operation, chat: { ...chat, chat_id: "stable:other" } } }, "scope_denied"],
    [{ ...valid, operation: { ...valid.operation, cursor: "unmeasured-cursor" } }, "bounds_exceeded"],
    [{ ...valid, operation: { ...valid.operation, limit: 3 } }, "bounds_exceeded"],
    [{ ...valid, operation: { ...valid.operation, interval: { from_ts: Number.MAX_SAFE_INTEGER, to_ts: Number.MAX_SAFE_INTEGER + 1 } } }, "bounds_exceeded"],
  ];

  for (const [candidate, code] of invalid) {
    await expect(kakao.handle(candidate)).resolves.toMatchObject({
      ok: false,
      error: { code, retryable: false, may_have_sent: false },
    });
  }
  expect(readerCalls).toBe(0);
});

test("read_page rejects malformed, unscoped, duplicate and out-of-interval measurements", async () => {
  const base = {
    account_id: chat.account,
    chat_id: chat.chat_id,
    message_id: "m1",
    author_id: "author",
    ts: 10,
    body: "body",
    revision: "r1",
  };
  const malformedPages: unknown[] = [
    null,
    [null],
    [{ ...base, account_id: "stable:other" }],
    [{ ...base, chat_id: "stable:other" }],
    [{ ...base, ts: 9 }],
    [{ ...base, ts: 20 }],
    [{ ...base, ts: Number.NaN }],
    [{ ...base, message_id: "" }],
    [{ ...base, author_id: 7 }],
    [{ ...base, body: 7 }],
    [{ ...base, revision: null }],
    [{ ...base }, { ...base, ts: 11 }],
  ];
  let readerCalls = 0;
  for (const raw of malformedPages) {
    const kakao = worker(async () => {
      readerCalls += 1;
      return raw as readonly unknown[];
    });
    await expect(kakao.handle(request({
      op: "read_page", chat, interval: { from_ts: 10, to_ts: 20 }, limit: 2, cursor: null,
    }))).resolves.toMatchObject({
      ok: false,
      error: { code: "malformed_measurement", retryable: false, may_have_sent: false },
    });
  }
  expect(readerCalls).toBe(malformedPages.length);
});

test("read_page enforces the negotiated encoded UTF-8 response ceiling", async () => {
  const raw = [{
    account_id: chat.account,
    chat_id: chat.chat_id,
    message_id: "m1",
    author_id: "author",
    ts: 10,
    body: "한🙂".repeat(8),
    revision: "r1",
  }];
  const operation = { op: "read_page", chat, interval: { from_ts: 10, to_ts: 20 }, limit: 1, cursor: null } as const;
  const unconstrained = request(operation);
  const expected = await worker(async () => raw).handle(unconstrained);
  const responseBytes = new TextEncoder().encode(JSON.stringify(expected)).byteLength;

  await expect(worker(async () => raw).handle({
    ...unconstrained,
    limits: { ...unconstrained.limits, max_response_bytes: responseBytes },
  })).resolves.toEqual(expected);
  await expect(worker(async () => raw).handle({
    ...unconstrained,
    limits: { ...unconstrained.limits, max_response_bytes: responseBytes - 1 },
  })).resolves.toMatchObject({
    ok: false,
    error: { code: "bounds_exceeded", retryable: false, may_have_sent: false },
  });
});

test("read_page enforces requested item count and raw measured UTF-8 bytes", async () => {
  const rawItem = {
    account_id: chat.account,
    chat_id: chat.chat_id,
    message_id: "m1",
    author_id: "author",
    ts: 10,
    body: "한🙂",
    revision: "r1",
  };
  const raw = [rawItem];
  const rawBytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
  const read = request({ op: "read_page", chat, interval: { from_ts: 10, to_ts: 20 }, limit: 1, cursor: null });
  const withLimits = (reader: KakaoReadReader, maxRawBytes: number) => createKakaoLocalReadWorker({
    binding_id: "kakao-local-alpha",
    allowed_chat: chat,
    measurement,
    max_measurement_age: 200,
    max_items: 2,
    max_raw_bytes: maxRawBytes,
    now: () => 1_000,
    reader,
  });

  await expect(withLimits(async () => raw, rawBytes).handle(read)).resolves.toMatchObject({ ok: true });
  await expect(withLimits(async () => raw, rawBytes - 1).handle(read)).resolves.toMatchObject({
    ok: false,
    error: { code: "bounds_exceeded", retryable: false, may_have_sent: false },
  });
  await expect(withLimits(async () => [rawItem, { ...rawItem, message_id: "m2", ts: 11 }], 65_536).handle(read))
    .resolves.toMatchObject({
      ok: false,
      error: { code: "bounds_exceeded", retryable: false, may_have_sent: false },
    });
});
