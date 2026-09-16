import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { ProtocolMessage, ProtocolTransport } from "../../protocol/src/index.ts";

import {
  MCP_TOOL_NAMES,
  McpDaemonError,
  McpInputError,
  McpSecretResponseError,
  createAgentProtocolRequester,
  createMcpServer,
  createToolHandlers,
  serveMcpStdio,
  type ProtocolRequester,
} from "../src/index.ts";

const chat = { platform: "slack", account: "a", chat_id: "c" };
const interval = { from_ts: 0, to_ts: 10 };

class FakeRequester implements ProtocolRequester {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  result: Record<string, unknown> = {};
  failure: unknown;

  async request(method: "message.search" | "safety.intent.create", params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params });
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
}

class FakeProtocolTransport implements ProtocolTransport {
  readonly sent: ProtocolMessage[] = [];
  private listener: ((message: ProtocolMessage) => void) | undefined;

  send(message: ProtocolMessage): void { this.sent.push(message); }
  onMessage(listener: (message: ProtocolMessage) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  onClose(): () => void { return () => {}; }
  close(): void {}
  respond(request: Extract<ProtocolMessage, { type: "request" }>, result: Record<string, unknown>): void {
    this.listener?.({ type: "response", id: request.id, method: request.method, ok: true, result });
  }
}

async function nextRequest(transport: FakeProtocolTransport, index: number): Promise<Extract<ProtocolMessage, { type: "request" }>> {
  for (let turn = 0; turn < 20 && transport.sent.length <= index; turn += 1) await Promise.resolve();
  const request = transport.sent[index];
  if (request?.type !== "request") throw new Error("expected protocol request");
  return request;
}

describe("inboxd MCP agent server", () => {
  test("exposes exactly the three permitted tools", () => {
    expect(MCP_TOOL_NAMES).toEqual(["inbox_search", "inbox_list", "send_propose"]);
    const requester = new FakeRequester();
    const handlers = createToolHandlers(requester);
    const server = createMcpServer(requester) as unknown as { _registeredTools: Record<string, unknown> };
    expect(Object.keys(handlers).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(Object.keys(server._registeredTools).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(Object.keys(handlers)).not.toContain("send_approve");
    expect(Object.keys(handlers)).not.toContain("send_direct");
    expect(Object.keys(handlers)).not.toContain("approval_list");
  });

  test("search validates Zod-shaped input before any protocol request", async () => {
    const requester = new FakeRequester();
    const handlers = createToolHandlers(requester);
    await expect(handlers.inbox_search({ chat, interval, query: "" })).rejects.toBeInstanceOf(McpInputError);
    await expect(handlers.send_propose({ actor: "agent", scope: chat, body: "draft", code: "123456" })).rejects.toBeInstanceOf(McpInputError);
    expect(requester.calls).toEqual([]);
  });

  test("search and list use only daemon protocol requests and preserve zero-hit coverage", async () => {
    const requester = new FakeRequester();
    requester.result = {
      messages: [],
      coverage: {
        covered: [],
        gaps: [{ interval, reason: "unknown" }],
        limits: [{ reason: "unsupported_history", detail: "provider", interval }],
      },
    };
    const handlers = createToolHandlers(requester);

    await expect(handlers.inbox_search({ chat, interval, query: "find me" })).resolves.toEqual(requester.result);
    await expect(handlers.inbox_list({ chat, interval })).resolves.toEqual(requester.result);
    expect(requester.calls).toEqual([
      { method: "message.search", params: { chat, interval, query: "find me" } },
      { method: "message.search", params: { chat, interval, query: "" } },
    ]);
  });

  test("live requester handshakes only as an agent and uses the protocol boundary", async () => {
    const transport = new FakeProtocolTransport();
    const requester = createAgentProtocolRequester(async () => transport);
    const pending = requester.request("message.search", { chat, interval, query: "find" });
    const hello = await nextRequest(transport, 0);
    expect(hello).toMatchObject({ method: "system.hello", params: { role: "agent" } });
    transport.respond(hello, { ready: true });
    const subscribe = await nextRequest(transport, 1);
    expect(subscribe).toMatchObject({ method: "subscribe", params: { topics: [] } });
    transport.respond(subscribe, { subscribed: [] });
    const search = await nextRequest(transport, 2);
    expect(search).toMatchObject({ method: "message.search", params: { chat, interval, query: "find" } });
    transport.respond(search, { messages: [], coverage: { covered: [], gaps: [], limits: [] } });
    await expect(pending).resolves.toEqual({ messages: [], coverage: { covered: [], gaps: [], limits: [] } });
    requester.stop();
  });

  test("propose returns a non-secret receipt and never echoes a body", async () => {
    const requester = new FakeRequester();
    requester.result = {
      intent_id: "intent-1",
      expires_at: 123,
      body: "draft that must not leave the daemon boundary",
      actor: "agent",
      scope: chat,
    };
    const handlers = createToolHandlers(requester);

    await expect(handlers.send_propose({ actor: "agent", scope: chat, body: "draft that must not leave the daemon boundary" }))
      .resolves.toEqual({ intent_id: "intent-1", expires_at: 123 });
    expect(requester.calls).toEqual([{
      method: "safety.intent.create",
      params: { actor: "agent", scope: chat, body: "draft that must not leave the daemon boundary" },
    }]);
  });

  test("deeply rejects approval codes or secrets from every daemon result", async () => {
    const requester = new FakeRequester();
    requester.result = { messages: [], coverage: { covered: [], gaps: [], limits: [] }, nested: { approvals: [{ approval_code: "123456" }] } };
    const handlers = createToolHandlers(requester);
    await expect(handlers.inbox_search({ chat, interval, query: "find" })).rejects.toBeInstanceOf(McpSecretResponseError);

    requester.result = { intent_id: "intent-1", expires_at: 123, metadata: { code: "123456" } };
    await expect(handlers.send_propose({ actor: "agent", scope: chat, body: "draft" })).rejects.toBeInstanceOf(McpSecretResponseError);
  });

  test("wraps a daemon failure with its method and a typed code", async () => {
    const requester = new FakeRequester();
    requester.failure = Object.assign(new Error("daemon locked"), { code: "LOCKED" });
    const handlers = createToolHandlers(requester);
    await expect(handlers.inbox_list({ chat, interval })).rejects.toMatchObject({
      name: "McpDaemonError",
      code: "LOCKED",
      method: "message.search",
    } satisfies Partial<McpDaemonError>);
  });

  test("does not import databases, platforms, or daemon implementation", async () => {
    const text = await Bun.file(`${import.meta.dir}/../src/index.ts`).text();
    expect(text).not.toMatch(/\b(?:import|export)\b[^\n]*(?:store|sqlite|platforms|daemon\/src|safety\/src)/i);
  });

  test("constructs an official MCP server and stdio transport without hanging", async () => {
    const requester = new FakeRequester();
    const server = createMcpServer(requester);
    expect(server).toBeInstanceOf(McpServer);

    const transport = new StdioServerTransport(new PassThrough(), new PassThrough());
    const handle = serveMcpStdio(requester, { transport });
    await expect(handle.close()).resolves.toBeUndefined();
  });
});
