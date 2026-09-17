import { describe, expect, test } from "bun:test";
import {
  createHandshake,
  parseEvent,
  parseRequest,
  parseResponse,
} from "../src/index.ts";

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
      "safety.intent.reject", "send.status", "settings.get", "settings.update",
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
