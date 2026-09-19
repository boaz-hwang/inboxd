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
  type DaemonMethod,
} from "../src/index.ts";

const chat = { platform: "slack", account: "a", chat_id: "c" };
const interval = { from_ts: 0, to_ts: 10 };

class FakeRequester implements ProtocolRequester {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  result: Record<string, unknown> = {};
  failure: unknown;

  async request(method: DaemonMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
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
  test("exposes read tools and delegated direct sends", () => {
    expect(MCP_TOOL_NAMES).toEqual(["inbox_search", "inbox_list", "inbox_recent", "inbox_evidence", "message_send", "send_status"]);
    const requester = new FakeRequester();
    const handlers = createToolHandlers(requester);
    const server = createMcpServer(requester) as unknown as { _registeredTools: Record<string, unknown> };
    expect(Object.keys(handlers).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(Object.keys(server._registeredTools).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(Object.keys(handlers)).not.toContain("send_approve");
    expect(Object.keys(handlers)).not.toContain("send_direct");
    expect(Object.keys(handlers)).not.toContain("approval_list");
  });

  test("aggregate tools reject malformed scope before any protocol request", async () => {
    const requester = new FakeRequester();
    const tools = createToolHandlers(requester);
    const input = { chats: [chat], interval };
    for (const tool of [tools.inbox_recent, tools.inbox_evidence]) {
      for (const invalid of [
        {}, { chats: [chat] }, { interval }, { ...input, chats: [] },
        { ...input, interval: { from_ts: 10, to_ts: 10 } },
        { ...input, cursor: "not a cursor" }, { ...input, cursor: "x".repeat(4097) },
        { ...input, sender: "guess" }, { ...input, limit: 101 },
        { ...input, identities: [] }, { ...input, unread: [] },
        { ...input, chats: [{ ...chat, self_id: "spoof" }] },
      ]) await expect(tool(invalid)).rejects.toBeInstanceOf(McpInputError);
    }
    expect(requester.calls).toEqual([]);
  });

  test("search validates Zod-shaped input before any protocol request", async () => {
    const requester = new FakeRequester();
    const handlers = createToolHandlers(requester);
    await expect(handlers.inbox_search({ chat, interval, query: "" })).rejects.toBeInstanceOf(McpInputError);
    await expect(handlers.message_send({ request_id: "stable-send-request-0001", chat, body: "draft", code: "123456" })).rejects.toBeInstanceOf(McpInputError);
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
      { method: "message.inbox", params: { chat, interval } },
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

  test("direct sends preserve the caller's request ID and uncertain outcomes", async () => {
    const requester = new FakeRequester();
    requester.result = { request_id: "stable-send-request-0001", state: "uncertain" };
    const handlers = createToolHandlers(requester);
    const input = { request_id: "stable-send-request-0001", chat, body: "draft" };
    await expect(handlers.message_send(input)).resolves.toEqual(requester.result);
    await expect(handlers.message_send(input)).resolves.toEqual(requester.result);
    expect(requester.calls).toEqual([{ method: "message.send", params: input }, { method: "message.send", params: input }]);
    await expect(handlers.message_send({ chat, body: "draft" })).rejects.toBeInstanceOf(McpInputError);
    await expect(handlers.message_send({ ...input, sender_token: "secret" })).rejects.toBeInstanceOf(McpInputError);
    await handlers.send_status({ id: "stable-send-request-0001" });
    expect(requester.calls.at(-1)).toEqual({ method: "send.status", params: { id: "stable-send-request-0001" } });
  });

  test("deeply rejects credentials from every daemon result", async () => {
    const requester = new FakeRequester();
    requester.result = { messages: [], coverage: { covered: [], gaps: [], limits: [] }, nested: { credentials: [{ access_token: "secret" }] } };
    const handlers = createToolHandlers(requester);
    await expect(handlers.inbox_search({ chat, interval, query: "find" })).rejects.toBeInstanceOf(McpSecretResponseError);

    requester.result = { intent_id: "intent-1", expires_at: 123, metadata: { sender_token: "secret" } };
    await expect(handlers.message_send({ request_id: "stable-send-request-0001", chat, body: "draft" })).rejects.toBeInstanceOf(McpSecretResponseError);
  });

  test("wraps a daemon failure with its method and a typed code", async () => {
    const requester = new FakeRequester();
    requester.failure = Object.assign(new Error("daemon locked"), { code: "LOCKED" });
    const handlers = createToolHandlers(requester);
    await expect(handlers.inbox_list({ chat, interval })).rejects.toMatchObject({
      name: "McpDaemonError",
      code: "LOCKED",
      method: "message.inbox",
    } satisfies Partial<McpDaemonError>);
  });

  test("does not import databases, platforms, or daemon implementation", async () => {
    const text = await Bun.file(`${import.meta.dir}/../src/index.ts`).text();
    expect(text).not.toMatch(/\b(?:import|export)\b[^\n]*(?:store|sqlite|platforms|daemon\/src|safety\/src)/i);
  });

  // @modelcontextprotocol/server@2.0.0 exports only the server-side stdio transport;
  // @modelcontextprotocol/client is not installed and manifest changes are out of scope.
  // This is construction coverage, not a claimed MCP stdio client round trip.
  test("constructs an official MCP server and server-side stdio transport", async () => {
    const requester = new FakeRequester();
    const server = createMcpServer(requester);
    expect(server).toBeInstanceOf(McpServer);

    const transport = new StdioServerTransport(new PassThrough(), new PassThrough());
    const handle = serveMcpStdio(requester, { transport });
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

test("MCP delegated sender credential is handshake-only and non-TTY", async () => {
  const transport = new FakeProtocolTransport();
  const requester = createAgentProtocolRequester(async () => transport, "private-owner-secret");
  const params = { request_id: "stable-mcp-request-0001", chat, body: "hello" };
  const pending = requester.request("message.send", params);
  const hello = await nextRequest(transport, 0);
  expect(hello.params).toEqual({ role: "sender", sender_token: "private-owner-secret" });
  transport.respond(hello, { ready: true });
  const subscribe = await nextRequest(transport, 1);
  transport.respond(subscribe, { subscribed: [] });
  const send = await nextRequest(transport, 2);
  expect(send).toMatchObject({ method: "message.send", params });
  expect(JSON.stringify(send)).not.toContain("private-owner-secret");
  transport.respond(send, { request_id: "stable-mcp-request-0001", state: "sent" });
  await expect(pending).resolves.toEqual({ request_id: "stable-mcp-request-0001", state: "sent" });
  requester.stop();
});

test("common account search exposes modes and preserves refresh evidence without treating failure as empty history", async () => {
  const requester = new FakeRequester();
  requester.result = { messages: [], source: "local", coverage: { covered: [], gaps: [{ reason: "unknown" }], limits: [] }, refresh: { id: "refresh-1", state: "failed" } };
  const tools = createToolHandlers(requester);
  const params = { platform: "slack", account: "a", query: "needle", mode: "refresh", refresh_id: "refresh-1" };
  expect(await tools.inbox_search(params)).toEqual(requester.result);
  expect(requester.calls).toEqual([{ method: "message.search", params }]);
  for (const invalid of [
    { ...params, account: undefined },
    { ...params, chat: { platform: "slack", account: "a", chat_id: "r" } },
    { ...params, mode: "local" },
    { ...params, cursor: "remote-cursor" },
  ]) await expect(tools.inbox_search(invalid)).rejects.toBeInstanceOf(McpInputError);
  expect(requester.calls).toHaveLength(1);
});
