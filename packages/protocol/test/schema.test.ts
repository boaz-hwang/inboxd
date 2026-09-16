import { describe, expect, test } from "bun:test";
import {
  createHandshake,
  parseEvent,
  parseRequest,
  parseResponse,
} from "../src/index.ts";

describe("protocol schemas", () => {
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
