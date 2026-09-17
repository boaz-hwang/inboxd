import { expect, test } from "bun:test";
import { createConnectedTuiController } from "../src/main.ts";
import type { ProtocolMessage, ProtocolTransport } from "../../protocol/src/index.ts";

class Peer implements ProtocolTransport {
  message?: (message: ProtocolMessage) => void;
  closed?: () => void;
  methods: string[] = [];
  heldMethods = new Set<string>();
  send(message: ProtocolMessage) {
    if (message.type !== "request") return;
    this.methods.push(message.method);
    if (this.heldMethods.has(message.method)) return;
    queueMicrotask(() => this.message?.({ type: "response", id: message.id, method: message.method, ok: true,
      result: message.method === "safety.intent.claimApprovalCode" ? { code: "123456" } : message.method === "system.status" ? { send_capable: true } : message.method === "safety.intent.listPending" ? { intents: [{ intent_id: "p", actor: "operator", scope: { platform: "slack", account: "work", chat_id: "ops" }, state: "Proposed" }] } : {} }));
  }
  onMessage(listener: (message: ProtocolMessage) => void) { this.message = listener; return () => {}; }
  onClose(listener: () => void) { this.closed = listener; return () => {}; }
  close() { this.closed?.(); }
}

class RetryClock {
  pending = new Map<() => void, number>();
  delays: number[] = [];
  schedule = (retry: () => void, delay: number): (() => void) => {
    this.pending.set(retry, delay);
    this.delays.push(delay);
    return () => { this.pending.delete(retry); };
  };
  fire() {
    expect(this.pending.size).toBe(1);
    const retry = this.pending.keys().next().value!;
    this.pending.delete(retry);
    retry();
  }
}

async function settle() {
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
}

test("retries refused reconnects with capped exponential backoff then resubscribes before requery", async () => {
  const first = new Peer(); const recovered = new Peer(); const clock = new RetryClock();
  let connections = 0; let available = false;
  const controller = createConnectedTuiController({
    role: "approver", isTTY: () => true, scheduleReconnect: clock.schedule,
    connect: async () => {
      connections++;
      if (connections === 1) return first;
      if (!available) throw new Error("ECONNREFUSED");
      return recovered;
    },
  });
  try {
    await controller.start();
    first.close();
    await settle();
    expect(controller.state.connection.status).toBe("degraded");
    expect(controller.state.views.approvals.status).toBe("stale");
    expect(clock.delays).toEqual([250]);
    for (let attempt = 0; attempt < 7; attempt++) { clock.fire(); await settle(); }
    expect(clock.delays).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000, 8000]);
    available = true;
    clock.fire(); await settle();
    expect(controller.state.connection.status).toBe("connected");
    expect(controller.state.views.approvals.status).toBe("ready");
    expect(recovered.methods.slice(0, 3)).toEqual(["system.hello", "subscribe", "chat.list"]);
    expect(clock.pending.size).toBe(0);
    expect(connections).toBe(10);
    available = false;
    recovered.close(); await settle();
    expect(clock.delays.at(-1)).toBe(250);
  } finally { controller.stop(); }
});

test("stop cancels a pending reconnect timer and an already queued callback cannot restart", async () => {
  const first = new Peer(); const clock = new RetryClock();
  let connections = 0;
  const controller = createConnectedTuiController({
    role: "reader", scheduleReconnect: clock.schedule,
    connect: async () => {
      if (++connections === 1) return first;
      throw new Error("ECONNREFUSED");
    },
  });
  await controller.start();
  first.close(); await settle();
  expect(clock.pending.size).toBe(1);
  const queued = clock.pending.keys().next().value!;
  controller.stop();
  expect(clock.pending.size).toBe(0);
  queued(); await settle();
  expect(connections).toBe(2);
});

test("a stopped attempt cannot schedule retries after a new session has connected", async () => {
  const first = new Peer(); const recovered = new Peer(); const clock = new RetryClock();
  const refused = Promise.withResolvers<ProtocolTransport>();
  let connections = 0;
  const controller = createConnectedTuiController({
    role: "reader", scheduleReconnect: clock.schedule,
    connect: async () => ++connections === 1 ? first : connections === 2 ? refused.promise : recovered,
  });
  try {
    await controller.start();
    first.close(); await settle();
    controller.stop();
    await controller.start();
    refused.reject(new Error("late ECONNREFUSED")); await settle();
    expect(controller.state.connection.status).toBe("connected");
    expect(clock.pending.size).toBe(0);
    expect(connections).toBe(3);
  } finally { controller.stop(); }
});

test.each(["safety.intent.approve", "safety.intent.create", "sync.backfill"])("automatic retries never replay dispatched %s", async method => {
  const first = new Peer(); const recovered = new Peer(); const clock = new RetryClock();
  first.heldMethods.add(method);
  let connections = 0;
  const controller = createConnectedTuiController({
    role: "approver", isTTY: () => true, scheduleReconnect: clock.schedule,
    connect: async () => {
      connections++;
      if (connections === 1) return first;
      if (connections === 2) throw new Error("ECONNREFUSED");
      return recovered;
    },
  });
  try {
    await controller.start();
    controller.setActiveChat({ platform: "slack", account: "work", chat_id: "ops" });
    if (method === "safety.intent.approve") {
      await controller.dispatchKey("4"); await controller.dispatchKey("a");
      for (const key of "123456") await controller.dispatchKey(key);
    } else if (method === "safety.intent.create") {
      await controller.dispatchKey("3"); await controller.dispatchKey("c");
      await controller.dispatchKey("x");
    }
    const dispatching = controller.dispatchKey(method === "sync.backfill" ? "b" : "Enter");
    expect(first.methods.filter(call => call === method)).toHaveLength(1);
    first.close(); await settle(); await dispatching;
    clock.fire(); await settle();
    expect(controller.state.connection.status).toBe("connected");
    expect(recovered.methods.slice(0, 3)).toEqual(["system.hello", "subscribe", "chat.list"]);
    expect(recovered.methods.filter(call => ["safety.intent.approve", "safety.intent.create", "sync.backfill"].includes(call))).toEqual([]);
    expect(controller.state.approvalPrompt).toBe(false);
    expect(controller.state.draft).toBe("");
    expect(controller.state.codeBuffer).toBe("");
    if (method === "safety.intent.approve") expect(controller.state.views.approvals.data[0]?.state).toBe("Uncertain");
  } finally { controller.stop(); }
});

test("stop during an in-flight reconnect prevents late failure from rearming a timer", async () => {
  const first = new Peer(); const clock = new RetryClock();
  const pending = Promise.withResolvers<ProtocolTransport>();
  let connections = 0;
  const controller = createConnectedTuiController({
    role: "reader", scheduleReconnect: clock.schedule,
    connect: async () => ++connections === 1 ? first : pending.promise,
  });
  await controller.start();
  first.close(); await settle();
  controller.stop();
  pending.reject(new Error("ECONNREFUSED")); await settle();
  expect(clock.pending.size).toBe(0);
  expect(connections).toBe(2);
});

test("real reconnecting client loss marks retained views stale and resubscribes before requery", async () => {
  const first = new Peer(); const second = new Peer();
  const reconnect = Promise.withResolvers<ProtocolTransport>();
  let connections = 0;
  const controller = createConnectedTuiController({ role: "approver", isTTY: () => true, connect: async () => ++connections === 1 ? first : reconnect.promise });
  await controller.start();
  expect(controller.state.connection.status).toBe("connected");
  first.close();
  expect(controller.state.connection.status).toBe("reconnecting");
  expect(controller.state.connection.stale).toBe(true);
  expect(controller.state.views.approvals.status).toBe("stale");
  reconnect.resolve(second);
  for (let turn = 0; turn < 100 && controller.state.views.approvals.status !== "ready"; turn++) await Promise.resolve();
  expect(controller.state.connection.status).toBe("connected");
  expect(controller.state.connection.generation).toBe(2);
  expect(second.methods.slice(0, 3)).toEqual(["system.hello", "subscribe", "chat.list"]);
  expect(controller.state.views.approvals.status).toBe("ready");
  controller.stop();
  expect(connections).toBe(2);
});
