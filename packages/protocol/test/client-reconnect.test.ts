import { describe, expect, test } from "bun:test";
import { ReconnectingProtocolClient, type JsonObject, type ProtocolMessage, type ProtocolTransport } from "../src/index.ts";

class FakeTransport implements ProtocolTransport {
  readonly sent: ProtocolMessage[] = [];
  private messageListener: ((message: ProtocolMessage) => void) | undefined;
  private closeListener: (() => void) | undefined;
  closed = false;
  respondSynchronously = false;

  send(message: ProtocolMessage): void {
    this.sent.push(message);
    if (this.respondSynchronously && message.type === "request") this.emit(responseFor(message));
  }
  onMessage(listener: (message: ProtocolMessage) => void): () => void { this.messageListener = listener; return () => { this.messageListener = undefined; }; }
  onClose(listener: () => void): () => void { this.closeListener = listener; return () => { this.closeListener = undefined; }; }
  emit(message: ProtocolMessage): void { this.messageListener?.(message); }
  close(): void { this.closed = true; this.closeListener?.(); }
}

const responseFor = (request: ProtocolMessage, result: JsonObject = {}): ProtocolMessage => {
  if (request.type !== "request") throw new Error("responses require requests");
  return { type: "response", id: request.id, method: request.method, ok: true, result };
};

async function settleSetup(transport: FakeTransport): Promise<void> {
  const hello = transport.sent[0]!;
  transport.emit(responseFor(hello));
  await Promise.resolve();
  const subscribe = transport.sent[1]!;
  transport.emit(responseFor(subscribe));
  await Promise.resolve();
}

describe("reconnecting protocol client", () => {
  test("records a pending request before a synchronous transport response", async () => {
    const transport = new FakeTransport();
    transport.respondSynchronously = true;
    const client = new ReconnectingProtocolClient({ connect: async () => transport, role: "reader" });
    const started = client.start(["message.upserted"]);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.sent.map((message) => (message as { method?: string }).method)).toEqual(["system.hello", "subscribe"]);
    await started;
    expect(client.ready).toBe(true);
    client.stop();
  });

  test("enforces the approver boundary before sending agent requests", async () => {
    const transport = new FakeTransport();
    const client = new ReconnectingProtocolClient({ connect: async () => transport, role: "agent" });
    const started = client.start(["message.upserted"]);
    await Promise.resolve();
    await settleSetup(transport);
    await started;

    const denied = client.request("safety.intent.listPending", {});
    await Promise.resolve();
    const sentMethod = (transport.sent.at(-1) as { method: string }).method;
    client.stop();
    await expect(denied).rejects.toThrow(/approver|stopped/i);
    expect(sentMethod).toBe("subscribe");
  });

  test("registers subscriptions before it becomes ready", async () => {
    const transport = new FakeTransport();
    const client = new ReconnectingProtocolClient({ connect: async () => transport, role: "reader" });
    const starting = client.start(["message.upserted"]);

    await Promise.resolve();
    expect(client.ready).toBe(false);
    expect((transport.sent[0] as { method: string }).method).toBe("system.hello");
    transport.emit(responseFor(transport.sent[0]!));
    await Promise.resolve();
    expect((transport.sent[1] as { method: string }).method).toBe("subscribe");
    expect(client.ready).toBe(false);
    transport.emit(responseFor(transport.sent[1]!));
    await starting;
    expect(client.ready).toBe(true);
  });

  test("discards stale-generation responses and marks reconnects for re-query", async () => {
    const first = new FakeTransport();
    const second = new FakeTransport();
    const transports = [first, second];
    const client = new ReconnectingProtocolClient({ connect: async () => transports.shift()!, role: "reader" });
    const started = client.start(["message.upserted"]);
    await Promise.resolve();
    await settleSetup(first);
    await started;

    const stale = client.request("system.status", {});
    const staleRequest = first.sent.at(-1)!;
    first.close();
    await expect(stale).rejects.toThrow(/connection/i);
    await Promise.resolve();
    await settleSetup(second);
    expect(client.requeryRequired).toBe(true);

    const fresh = client.request("system.status", {});
    const freshRequest = second.sent.at(-1)!;
    first.emit(responseFor(staleRequest, { stale: true }));
    second.emit(responseFor(freshRequest, { fresh: true }));
    await expect(fresh).resolves.toEqual({ fresh: true });
  });

  test("closes an overflowing subscription stream and requires re-query", async () => {
    const transport = new FakeTransport();
    const client = new ReconnectingProtocolClient({
      connect: async () => transport, role: "reader", maxQueuedEvents: 1,
      onEvent: () => {},
    });
    const started = client.start(["message.upserted"]);
    await Promise.resolve();
    await settleSetup(transport);
    await started;

    transport.emit({ type: "event", method: "message.upserted", params: {} });
    transport.emit({ type: "event", method: "message.upserted", params: {} });
    expect(transport.closed).toBe(true);
    expect(client.requeryRequired).toBe(true);
  });
});
