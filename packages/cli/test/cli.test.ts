import { afterEach, describe, expect, test } from "bun:test";
import type { JsonObject, ProtocolMessage, ProtocolTransport } from "../../protocol/src/index.ts";
import {
  ApproverTTYRequiredError,
  CliProtocolError,
  UdsTransportError,
  createAgentHandlers,
  createCliHandlers,
  formatCliResult,
} from "../src/index.ts";

class FakeTransport implements ProtocolTransport {
  readonly sent: ProtocolMessage[] = [];
  private messageListener: ((message: ProtocolMessage) => void) | undefined;
  private closeListener: (() => void) | undefined;
  closed = false;

  send(message: ProtocolMessage): void { this.sent.push(message); }
  onMessage(listener: (message: ProtocolMessage) => void): () => void {
    this.messageListener = listener;
    return () => { this.messageListener = undefined; };
  }
  onClose(listener: () => void): () => void {
    this.closeListener = listener;
    return () => { this.closeListener = undefined; };
  }
  close(): void { this.closed = true; this.closeListener?.(); }
  respond(request: ProtocolMessage, result: JsonObject = {}): void {
    if (request.type !== "request") throw new TypeError("only requests can receive responses");
    this.messageListener?.({ type: "response", id: request.id, method: request.method, ok: true, result });
  }
  fail(request: ProtocolMessage, code = "DAEMON_ERROR", message = "daemon refused request"): void {
    if (request.type !== "request") throw new TypeError("only requests can receive responses");
    this.messageListener?.({ type: "response", id: request.id, method: request.method, ok: false, error: { code, message } });
  }
}

const clients: ReturnType<typeof createCliHandlers>[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.stop(); });

async function ready(transport: FakeTransport): Promise<void> {
  for (let index = 0; index < 8 && transport.sent.length < 1; index += 1) await Promise.resolve();
  transport.respond(transport.sent[0]!);
  for (let index = 0; index < 8 && transport.sent.length < 2; index += 1) await Promise.resolve();
  transport.respond(transport.sent[1]!);
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function started(transport: FakeTransport, options: { role?: "reader" | "agent" | "approver"; isTTY?: boolean; launchDaemon?: () => Promise<void> } = {}) {
  const handlers = createCliHandlers({
    connect: async () => transport,
    role: options.role ?? "reader",
    isTTY: () => options.isTTY ?? true,
    launchDaemon: options.launchDaemon,
  });
  clients.push(handlers);
  const connecting = handlers.connect();
  await ready(transport);
  await connecting;
  return handlers;
}

function lastRequest(transport: FakeTransport): Extract<ProtocolMessage, { type: "request" }> {
  const request = transport.sent.at(-1);
  if (request?.type !== "request") throw new Error("expected a request");
  return request;
}

async function respondToCall<T>(transport: FakeTransport, call: Promise<T>, result: JsonObject): Promise<T> {
  // Handler calls cross an async connect boundary even when already ready.
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  transport.respond(lastRequest(transport), result);
  return call;
}

describe("protocol-only CLI handlers", () => {
  const approval = {
    intent_id: "i",
    code: "123456",
    actor: "agent:alpha",
    scope: { platform: "slack", account: "a", chat_id: "c" },
  };

  test("has no store, sqlite, or database-path dependency", async () => {
    const sources = ["handlers.ts", "index.ts", "transport.ts"];
    const text = await Promise.all(sources.map((name) => Bun.file(`${import.meta.dir}/../src/${name}`).text()));
    expect(text.join("\n")).not.toMatch(/\b(?:import|export)\b[^\n]*(?:store|sqlite)|\bdatabasePath\b/i);
  });

  test("routes every reader command through its protocol method", async () => {
    const transport = new FakeTransport();
    const cli = await started(transport);

    await respondToCall(transport, cli.daemonStatus(), { ready: true });
    expect(lastRequest(transport)).toMatchObject({ method: "system.status", params: {} });
    await respondToCall(transport, cli.chatList(), { chats: [] });
    expect(lastRequest(transport)).toMatchObject({ method: "chat.list", params: {} });
    await respondToCall(transport, cli.inbox({ platform: "slack", account: "a", chat_id: "c" }), { messages: [] });
    expect(lastRequest(transport)).toMatchObject({ method: "message.inbox" });
    await respondToCall(transport, cli.get({ platform: "slack", account: "a", chat_id: "c", msg_id: "m" }), { message: null });
    expect(lastRequest(transport)).toMatchObject({ method: "message.get" });
    await respondToCall(transport, cli.search({ chat: { platform: "slack", account: "a", chat_id: "c" }, interval: { from_ts: 0, to_ts: 1 }, query: "hello" }), { messages: [], coverage: { covered: [], gaps: [], limits: [] } });
    expect(lastRequest(transport)).toMatchObject({ method: "message.search" });
    await respondToCall(transport, cli.syncStatus(), { state: "idle" });
    expect(lastRequest(transport)).toMatchObject({ method: "sync.status" });
    await respondToCall(transport, cli.backfill({ platform: "slack", account: "a", chat_id: "c", from_ts: 0, to_ts: 1 }), { queued: true });
    expect(lastRequest(transport)).toMatchObject({ method: "sync.backfill" });
    await respondToCall(transport, cli.authStatus(), { authenticated: false });
    expect(lastRequest(transport)).toMatchObject({ method: "auth.status" });
    await respondToCall(transport, cli.sendStatus("send-1"), { state: "queued" });
    expect(lastRequest(transport)).toMatchObject({ method: "send.status", params: { id: "send-1" } });
  });

  test("prints coverage and limits even for zero-hit searches", () => {
    const output = formatCliResult({ messages: [], coverage: { covered: [], gaps: [], limits: [] } });
    expect(JSON.parse(output)).toEqual({ messages: [], coverage: { covered: [], gaps: [], limits: [] } });
  });

  test("rejects all approver commands before connecting without a stdin TTY", async () => {
    const transport = new FakeTransport();
    const cli = createCliHandlers({ connect: async () => transport, role: "approver", isTTY: () => false });
    clients.push(cli);
    await expect(cli.listPending()).rejects.toBeInstanceOf(ApproverTTYRequiredError);
    await expect(cli.approve(approval)).rejects.toBeInstanceOf(ApproverTTYRequiredError);
    await expect(cli.reject({ intent_id: "i", reason: "no" })).rejects.toBeInstanceOf(ApproverTTYRequiredError);
    expect(transport.sent).toEqual([]);
  });

  test("uses approver protocol methods only after the TTY gate", async () => {
    const transport = new FakeTransport();
    const cli = await started(transport, { role: "approver", isTTY: true });
    await respondToCall(transport, cli.listPending(), { intents: [] });
    expect(lastRequest(transport).method).toBe("safety.intent.listPending");
    await respondToCall(transport, cli.approve(approval), { state: "approved" });
    expect(lastRequest(transport)).toMatchObject({ method: "safety.intent.approve", params: approval });
    await respondToCall(transport, cli.reject({ intent_id: "i", reason: "no" }), { state: "rejected" });
    expect(lastRequest(transport).method).toBe("safety.intent.reject");
  });

  test("agent surface cannot list or print approval codes", async () => {
    const transport = new FakeTransport();
    const agent = createAgentHandlers({ connect: async () => transport, isTTY: () => false });
    expect("listPending" in agent).toBe(false);
    expect(() => formatCliResult({ approval_code: "123456" }, "agent")).toThrow(/approval code/i);
    const connecting = agent.connect();
    await ready(transport);
    await connecting;
    expect(transport.sent[0]).toMatchObject({ type: "request", method: "system.hello", params: { role: "agent" } });
    agent.stop();
  });

  test("reconnects after a close and surfaces typed daemon failures", async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const cli = createCliHandlers({ connect: async () => transports.shift()!, role: "reader", isTTY: () => true });
    clients.push(cli);
    const connecting = cli.connect();
    await ready(first);
    await connecting;
    const pending = cli.daemonStatus();
    await Promise.resolve();
    first.close();
    await expect(pending).rejects.toBeInstanceOf(CliProtocolError);
    await ready(second);
    const next = cli.daemonStatus();
    await respondToCall(second, next, { ready: true });
    await expect(next).resolves.toEqual({ ready: true });
    expect(cli.requeryRequired).toBe(true);

    const failure = cli.daemonStatus();
    await Promise.resolve();
    second.fail(lastRequest(second), "LOCKED", "daemon locked");
    await expect(failure).rejects.toMatchObject({ code: "DAEMON_ERROR", method: "system.status" });
    const failedConnect = createCliHandlers({
      connect: async () => { throw new UdsTransportError("CONNECT_FAILED", "unreachable"); },
      role: "reader",
      isTTY: () => true,
    });
    clients.push(failedConnect);
    await expect(failedConnect.daemonStatus()).rejects.toMatchObject({ code: "CONNECT_FAILED", method: "system.status" });
  });

  test("doctor reads daemon and encryption health through system.status only", async () => {
    const transport = new FakeTransport();
    const cli = await started(transport);
    const doctor = cli.doctor();
    await respondToCall(transport, doctor, { ready: true, daemon: { reachable: true }, encryption: { ready: true, cipher_version: "4" } });
    await expect(doctor).resolves.toEqual({ ready: true, daemon: { reachable: true }, encryption: { ready: true, cipher_version: "4" } });
    expect(lastRequest(transport)).toMatchObject({ method: "system.status", params: {} });
  });

  test("daemon start invokes only its injected launcher then checks protocol status", async () => {
    const transport = new FakeTransport();
    let launches = 0;
    const cli = await started(transport, { launchDaemon: async () => { launches += 1; } });
    const starting = cli.daemonStart();
    await respondToCall(transport, starting, { ready: true });
    await expect(starting).resolves.toEqual({ ready: true });
    expect(launches).toBe(1);
    expect(lastRequest(transport).method).toBe("system.status");
  });
});
