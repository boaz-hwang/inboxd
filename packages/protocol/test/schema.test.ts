import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createHandshake,
  EVENT_METHODS,
  HOST_OPERATIONS,
  LEGACY_EVENT_METHODS,
  LEGACY_REQUEST_METHODS,
  parseEvent,
  parseRequest,
  parseResponse,
  parseSendEnvelopeV2,
  REQUEST_METHODS,
  TIME_UNITS_V1,
} from "../src/index.ts";

const compat = await Bun.file(new URL("../../../test/fixtures/protocol/compat-v1.json", import.meta.url)).json();

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

describe("protocol schemas", () => {
  test("aggregate reads require explicit bounded scope and reject caller ingestion fields", () => {
    const chat = { platform: "slack", account: "work", chat_id: "ops" };
    const input = { chats: [chat], interval: { from_ts: 0, to_ts: 100 }, sender: "self", limit: 100, cursor: "opaque_-123" };
    for (const method of ["message.recent", "message.evidence"] as const) {
      const request = (params: unknown) => ({ type: "request", id: "aggregate", method, params });
      expect(parseRequest(request(input), "agent").params).toEqual(input);
      expect(parseRequest(request({ chats: [chat], interval: input.interval }), "reader").method).toBe(method);
      for (const params of [
        {}, { interval: input.interval }, { chats: [chat] }, { ...input, chats: [] },
        { ...input, chats: Array.from({ length: 101 }, () => chat) },
        { ...input, chats: [{ ...chat, account: "" }] },
        { ...input, chats: [{ ...chat, self_id: "spoofed" }] },
        { ...input, interval: { from_ts: 10, to_ts: 10 } },
        { ...input, interval: { from_ts: 11, to_ts: 10 } },
        { ...input, interval: { from_ts: NaN, to_ts: Infinity } },
        { ...input, interval: { from_ts: 0, to_ts: 10, extra: true } },
        { ...input, sender: "guess" }, { ...input, sender: null },
        { ...input, limit: 0 }, { ...input, limit: 101 }, { ...input, limit: 1.5 },
        { ...input, cursor: "" }, { ...input, cursor: "x".repeat(4097) }, { ...input, cursor: "not a cursor" },
        { ...input, identities: [] }, { ...input, unread: [] }, { ...input, scope_codec: "override" },
      ]) expect(() => parseRequest(request(params), "agent")).toThrow();
    }
    for (const method of ["store.recordAccountIdentity", "store.recordUnreadState", "identity.record", "unread.record"]) {
      expect(() => parseRequest({ type: "request", id: "ingest", method, params: {} }, "agent")).toThrow(/unknown request method/);
    }
  });
  test("validates the complete request method surface and rejects unknown methods", () => {
    const methods = [
      "system.ping", "system.status", "chat.list", "message.inbox", "message.get",
      "message.search", "sync.status", "sync.backfill", "auth.status",
      "safety.intent.listPending",
      "safety.intent.reject", "send.status", "settings.get", "settings.update", "capability.list",
    ] as const;

    for (const method of methods) {
      expect(parseRequest({ type: "request", id: `r-${method}`, method, params: {} }).method).toBe(method);
    }
    expect(() => parseRequest({ type: "request", id: "bad", method: "send.now", params: {} })).toThrow(/method/i);
  });

  test("validates response and event method names", () => {
    expect(parseResponse({ type: "response", id: "1", method: "system.ping", ok: true, result: {} }).method).toBe("system.ping");
    expect(parseEvent({ type: "event", method: "message.upserted", params: {} }).method).toBe("message.upserted");
    expect(() => parseResponse({ type: "response", id: "1", method: "unknown", ok: true, result: {} })).toThrow(/method/i);
    expect(() => parseEvent({ type: "event", method: "message.deleted", params: {} })).toThrow(/method/i);
  });

  test("historical records require owner access and retired execution methods are unknown", () => {
    for (const role of ["agent", "mcp"] as const) {
      for (const method of ["safety.intent.listPending", "safety.intent.reject"]) {
        expect(() => parseRequest({ type: "request", id: "history", method, params: {} }, role)).toThrow(/sender or approver/);
      }
    }
    for (const method of ["safety.intent.create", "safety.intent.claimApprovalCode", "safety.intent.approve", "account.send"]) {
      expect(() => parseRequest({ type: "request", id: "retired", method, params: {} }, "sender")).toThrow(/unknown request method/);
    }
  });

  test("requires a local TTY before declaring an approver handshake", () => {
    expect(() => createHandshake("approver", () => false)).toThrow(/TTY/i);
    expect(createHandshake("approver", () => true)).toEqual({ role: "approver" });
  });

  test("requires a handshake to declare a known role", () => {
    expect(() => parseRequest({ type: "request", id: "hello", method: "system.hello", params: {} })).toThrow(/role/i);
    expect(parseRequest({ type: "request", id: "hello", method: "system.hello", params: { role: "reader" } }).params).toEqual({ role: "reader" });
  });
});

describe("versioned send envelopes", () => {
  test("binds approved template identifiers, arguments, and previews in v2", () => {
    const envelope = {
      v: 2,
      destination: { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" },
      content: { mode: "approved_template", template_id: "notice-7", arguments: { amount: 1000, label: "승인" }, preview: "승인: 1000" },
    };
    const parsed = parseSendEnvelopeV2(envelope);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(envelope));
    expect(() => parseSendEnvelopeV2({ ...envelope, content: { ...envelope.content, arguments: { bad: NaN } } })).toThrow(/JSON/i);
    expect(() => parseSendEnvelopeV2({ ...envelope, reply: { parent_id: "not-supported" } })).toThrow(/repl/i);
  });

  test("preserves prototype-sensitive JSON keys as inert own properties", () => {
    const argumentsValue = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"safe":1},"prototype":{"safe":2}}');
    const parsed = parseSendEnvelopeV2({
      v: 2,
      destination: { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" },
      content: { mode: "approved_template", template_id: "notice-7", arguments: argumentsValue, preview: "safe" },
    });
    if (parsed.content.mode !== "approved_template") throw new Error("expected template content");
    const output = parsed.content.arguments;
    expect(Object.getPrototypeOf(output)).toBeNull();
    expect(Object.keys(output)).toEqual(["__proto__", "constructor", "prototype"]);
    for (const key of ["__proto__", "constructor", "prototype"]) expect(Object.hasOwn(output, key)).toBe(true);
    expect(output.__proto__).toEqual({ polluted: true });
    expect(output["constructor"]).toEqual({ safe: 1 });
    expect(output["prototype"]).toEqual({ safe: 2 });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe("v1 wire golden bytes", () => {
  test("pins all 19 current host operations and time-unit boundaries", () => {
    expect(HOST_OPERATIONS).toEqual(compat.host_operations.filter((operation: string) => !["host.approvalCode", "host.allowSend"].includes(operation)));
    expect(HOST_OPERATIONS).toHaveLength(19);
    expect(new Set(HOST_OPERATIONS).size).toBe(19);
    expect(TIME_UNITS_V1).toEqual(compat.time_units);
    expect(TIME_UNITS_V1.safety_deadline).toBe("milliseconds");
    expect(TIME_UNITS_V1.adapter_timestamp).toBe("seconds");
    expect(TIME_UNITS_V1.adapter_retry_at).toBe("seconds");
    expect(TIME_UNITS_V1.worker_timeout).toBe("milliseconds");
  });

  test("pins every existing method and event including unsupported settings", () => {
    expect(LEGACY_REQUEST_METHODS).toEqual(compat.request_methods);
    expect(LEGACY_EVENT_METHODS).toEqual(compat.event_methods);
    expect([...REQUEST_METHODS]).toEqual([...compat.request_methods.filter((method: string) => !["safety.intent.create", "safety.intent.claimApprovalCode", "safety.intent.approve"].includes(method)), "capability.list", "account.list", "account.messages", "account.search", "message.send"]);
    expect([...EVENT_METHODS]).toEqual([...compat.event_methods, "capability.changed", "account.changed"]);
    expect(compat.unsupported_methods).toEqual(["settings.get", "settings.update"]);
    for (const method of compat.unsupported_methods) expect(REQUEST_METHODS).toContain(method);
  });

  test("pins approval, idempotency, quota, cursor, number, UTF-16, and null bytes", () => {
    const legacy = compat.legacy_slack;
    const boundInput = {
      intent_id: "intent-😀",
      actor: legacy.actor,
      scope: legacy.input.scope,
      payload_hash: legacy.payload_hash,
      expires_at: 901234.75,
    };
    const idempotencyInput = {
      intent_id: "intent-😀",
      scope: legacy.input.scope,
      payload_hash: legacy.payload_hash,
      expires_at: 901234.75,
    };
    expect(canonical(boundInput)).toBe(legacy.bound_hash_input_canonical);
    expect(canonicalHash(boundInput)).toBe(legacy.bound_hash);
    expect(canonical(idempotencyInput)).toBe(legacy.idempotency_input_canonical);
    expect(canonicalHash(idempotencyInput)).toBe(legacy.idempotency_key);
    expect(canonical(legacy.input.scope)).toBe(legacy.quota_scope_bytes);

    expect(JSON.stringify([-0, 1e21, 1e-7, 1e-6, 333333333.3333333])).toBe(compat.wire_bytes.number_json);
    expect(JSON.stringify({ lone: "\ud800", pua: "\ue000", emoji: "😀" })).toBe(compat.wire_bytes.utf16_json);
    expect(JSON.stringify({ body: "x" })).toBe(compat.wire_bytes.absent_json);
    expect(JSON.stringify({ body: "x", parent_id: null })).toBe(compat.wire_bytes.null_json);
    expect(Buffer.from(compat.wire_bytes.cursor_json, "utf8").toString("base64url")).toBe(compat.wire_bytes.cursor_base64url);
  });
});

test("delegated send requires an authenticated sender handshake and stable strict payload", () => {
  expect(createHandshake("sender", () => false, undefined, "owner-secret")).toEqual({ role: "sender", sender_token: "owner-secret" });
  expect(() => createHandshake("sender", () => false)).toThrow(/sender token/);
  expect(() => createHandshake("agent", () => false, undefined, "owner-secret")).toThrow(/sender/);
  const params = { request_id: "stable-request-0001", chat: { platform: "slack", account: "a", chat_id: "c" }, body: "hello" };
  const request = { type: "request", id: "wire-1", method: "message.send", params };
  expect(parseRequest(request, "sender").params).toEqual(params);
  for (const role of ["reader", "agent", "mcp"] as const) expect(() => parseRequest(request, role)).toThrow(/sender/);
  for (const bad of [{ ...params, request_id: "" }, { chat: params.chat, body: "hello" }, { ...params, sender_token: "secret" }, { ...params, envelope: {} }, { ...params, body: "x".repeat(65537) }]) {
    expect(() => parseRequest({ ...request, params: bad }, "sender")).toThrow();
  }
  expect(() => parseRequest({ type: "request", id: "h", method: "system.hello", params: { role: "sender" } })).toThrow(/sender token/);
  expect(() => parseRequest({ type: "request", id: "h", method: "system.hello", params: { role: "agent", sender_token: "secret" } })).toThrow(/sender token/);
});

test("file sends require an exact bounded descriptor and cannot mix text or reply fields", async () => {
  const { parseMessageSendParams } = await import("../src/schema.ts");
  const value = { request_id: "file-request-0001", chat: { platform: "slack", account: "work", chat_id: "1" }, file: { path: "/tmp/test.pdf", name: "test.pdf", size: 3, sha256: "a".repeat(64) } };
  expect(parseMessageSendParams(value)).toEqual(value);
  for (const file of [{ ...value.file, name: "../test" }, { ...value.file, path: "relative" }, { ...value.file, size: 104857601 }, { ...value.file, sha256: "wrong" }]) expect(() => parseMessageSendParams({ ...value, file })).toThrow();
  for (const extra of [{ body: "caption" }, { parent_id: "reply" }, { envelope: {} }]) expect(() => parseMessageSendParams({ ...value, ...extra })).toThrow();
});
