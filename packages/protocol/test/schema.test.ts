import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createHandshake,
  EVENT_METHODS,
  HOST_OPERATIONS,
  LEGACY_EVENT_METHODS,
  LEGACY_REQUEST_METHODS,
  normalizeSendEnvelope,
  parseEvent,
  parseRequest,
  parseResponse,
  parseSendEnvelopeV2,
  REQUEST_METHODS,
  sendApprovalPayload,
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
  test("only the dedicated approver claim response can carry a code", () => {
    for (const role of [undefined, "reader", "agent", "mcp", "approver"] as const) {
      for (const method of ["safety.intent.create", "safety.intent.listPending", "system.status"] as const) {
        expect(() => parseResponse({ type: "response", id: "x", method, ok: true, result: { nested: { code: "123456" } } }, role)).toThrow(/approval code/i);
      }
    }
    for (const role of ["reader", "agent", "mcp"] as const) {
      expect(() => parseRequest({ type: "request", id: "x", method: "safety.intent.claimApprovalCode", params: { intent_id: "i" } }, role)).toThrow(/approver/i);
    }
    expect(parseResponse({ type: "response", id: "x", method: "safety.intent.claimApprovalCode", ok: true, result: { code: "123456" } }).result).toEqual({ code: "123456" });
    expect(parseResponse({ type: "response", id: "x", method: "safety.intent.claimApprovalCode", ok: true, result: { code: "123456" } }, "approver").result).toEqual({ code: "123456" });
  });
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
      "safety.intent.create", "safety.intent.listPending", "safety.intent.approve",
      "safety.intent.reject", "send.status", "settings.get", "settings.update", "capability.list",
    ] as const;

    for (const method of methods) {
      expect(parseRequest({ type: "request", id: `r-${method}`, method, params: {} }).method).toBe(method);
    }
    expect(() => parseRequest({ type: "request", id: "bad", method: "send.now", params: {} })).toThrow(/method/i);
  });

  test("validates response and event method names", () => {
    expect(parseResponse({ type: "response", id: "1", method: "system.ping", ok: true, result: {} }, "reader").method).toBe("system.ping");
    expect(parseEvent({ type: "event", method: "message.upserted", params: {} }).method).toBe("message.upserted");
    expect(() => parseResponse({ type: "response", id: "1", method: "unknown", ok: true, result: {} }, "reader")).toThrow(/method/i);
    expect(() => parseEvent({ type: "event", method: "message.deleted", params: {} })).toThrow(/method/i);
  });

  test("does not permit agent or MCP sessions to request or receive approval codes", () => {
    for (const role of ["agent", "mcp"] as const) {
      expect(() => parseRequest({ type: "request", id: "pending", method: "safety.intent.listPending", params: {} }, role)).toThrow(/approver/i);
      expect(() => parseRequest({ type: "request", id: "approve", method: "safety.intent.approve", params: { code: "123456" } }, role)).toThrow(/approver/i);
      expect(() => parseRequest({ type: "request", id: "reject", method: "safety.intent.reject", params: { intent_id: "i1" } }, role)).toThrow(/approver/i);
      expect(() => parseResponse({
        type: "response", id: "pending", method: "safety.intent.listPending", ok: true,
        result: { intents: [{ intent_id: "i1", approval_code: "123456" }] },
      }, role)).toThrow(/approval code/i);
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
  test("normalizes a v1 Slack send while preserving its approval bytes", () => {
    const normalized = normalizeSendEnvelope(compat.legacy_slack.input);
    expect(normalized).toEqual(compat.legacy_slack.normalized);
    const approvalPayload = sendApprovalPayload(compat.legacy_slack.actor, normalized);
    expect(approvalPayload).toEqual(compat.legacy_slack.approval_payload);
    expect(JSON.stringify(approvalPayload)).toBe(compat.legacy_slack.approval_payload_json);
    expect(canonical(approvalPayload)).toBe(compat.legacy_slack.approval_payload_canonical);
    expect(canonicalHash(approvalPayload)).toBe(compat.legacy_slack.payload_hash);

    const withoutParent = normalizeSendEnvelope({ scope: compat.legacy_slack.input.scope, body: "no reply" });
    expect(withoutParent.envelope).not.toHaveProperty("reply");
    expect(withoutParent.approval.payload).not.toHaveProperty("parent_id");
    expect(() => normalizeSendEnvelope({ ...compat.legacy_slack.input, parent_id: null })).toThrow(/parent_id/i);
  });

  test("binds approved template identifiers, arguments, and previews in v2", () => {
    const envelope = {
      v: 2,
      destination: { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" },
      content: { mode: "approved_template", template_id: "notice-7", arguments: { amount: 1000, label: "승인" }, preview: "승인: 1000" },
    };
    const parsed = parseSendEnvelopeV2(envelope);
    const normalized = normalizeSendEnvelope(envelope);
    expect(normalized).toEqual({ envelope: parsed, approval: { v: 2, payload: parsed } });
    expect(canonical(sendApprovalPayload("agent:fixture", normalized))).toContain('"template_id":"notice-7"');
    expect(canonical(sendApprovalPayload("agent:fixture", normalized))).toContain('"arguments":{"amount":1000,"label":"승인"}');
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
  test("pins all 21 host operations and time-unit boundaries", () => {
    expect(HOST_OPERATIONS).toEqual(compat.host_operations);
    expect(HOST_OPERATIONS).toHaveLength(21);
    expect(new Set(HOST_OPERATIONS).size).toBe(21);
    expect(TIME_UNITS_V1).toEqual(compat.time_units);
    expect(TIME_UNITS_V1.safety_deadline).toBe("milliseconds");
    expect(TIME_UNITS_V1.adapter_timestamp).toBe("seconds");
    expect(TIME_UNITS_V1.adapter_retry_at).toBe("seconds");
    expect(TIME_UNITS_V1.worker_timeout).toBe("milliseconds");
  });

  test("pins every existing method and event including unsupported settings", () => {
    expect(LEGACY_REQUEST_METHODS).toEqual(compat.request_methods);
    expect(LEGACY_EVENT_METHODS).toEqual(compat.event_methods);
    expect([...REQUEST_METHODS]).toEqual([...compat.request_methods, "capability.list", "account.list", "account.messages", "account.search", "account.send"]);
    expect([...EVENT_METHODS]).toEqual([...compat.event_methods, "capability.changed"]);
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
