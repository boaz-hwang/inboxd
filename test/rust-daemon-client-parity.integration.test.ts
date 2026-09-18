import { afterEach, describe, expect, test } from "bun:test";

import { createUdsCliHandlers, runCli } from "../packages/cli/src/index.ts";
import { connectUdsTransport } from "../packages/cli/src/transport.ts";
import { createAgentProtocolRequester, createToolHandlers } from "../packages/mcp/src/index.ts";
import { ReconnectingProtocolClient } from "../packages/protocol/src/index.ts";
import { createConnectedTuiController, readTuiApproverToken } from "../packages/tui/src/main.ts";
import { connectTuiUdsTransport } from "../packages/tui/src/transport.ts";
import {
  FIXTURE_CHAT,
  FIXTURE_INTERVAL,
  RawUdsConnection,
  RustDaemonHarness,
} from "./helpers/rust-daemon-harness.ts";

const harnesses: RustDaemonHarness[] = [];
const clients: Array<{ stop(): void }> = [];
const describeWithRustDaemon = process.env.INBOXD_DAEMON_BIN ? describe : describe.skip;

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.stop();
  while (harnesses.length > 0) await harnesses.pop()!.dispose();
});

async function fixture(seed = false): Promise<RustDaemonHarness> {
  const harness = new RustDaemonHarness();
  harnesses.push(harness);
  if (seed) harness.seed();
  await harness.start();
  return harness;
}

function request(id: string, method: string, params: Record<string, unknown>) {
  return { type: "request", id, method, params };
}

describeWithRustDaemon("release Rust daemon UDS parity", () => {
  test("handles fragmented UTF-8, all roles, correlated batches, malformed frames, and the 64 KiB ceiling", async () => {
    const harness = await fixture();

    for (const role of ["reader", "agent", "mcp", "approver"] as const) {
      const connection = await RawUdsConnection.connect(harness.socketPath);
      const response = await connection.request(`hello-${role}`, "system.hello", {
        role,
        ...(role === "approver" ? { approver_token: harness.token() } : {}),
      });
      expect(response).toMatchObject({ id: `hello-${role}`, method: "system.hello", ok: true, result: { protocol: "inboxd", ready: true } });
      connection.close();
    }

    const fragmented = await RawUdsConnection.connect(harness.socketPath);
    const hello = Buffer.from(`${JSON.stringify(request("fragmented", "system.hello", { role: "reader", label: "한🙂" }))}\n`);
    const split = hello.indexOf(Buffer.from("한")) + 1;
    fragmented.sendBytes(hello.subarray(0, split));
    fragmented.sendBytes(hello.subarray(split));
    expect(await fragmented.nextJson()).toMatchObject({ id: "fragmented", method: "system.hello", ok: true });

    fragmented.sendBytes(Buffer.from(
      `${JSON.stringify(request("status", "system.status", {}))}\n${JSON.stringify(request("ping", "system.ping", {}))}\n`,
    ));
    const correlated = new Map([await fragmented.nextJson(), await fragmented.nextJson()].map((frame) => [frame!.id, frame]));
    expect(correlated.get("status")).toMatchObject({ method: "system.status", ok: true });
    expect(correlated.get("ping")).toMatchObject({ method: "system.ping", ok: true });
    fragmented.close();

    for (const bytes of [Buffer.from("not-json\n"), Buffer.alloc(65_537, 0x78)]) {
      const invalid = await RawUdsConnection.connect(harness.socketPath);
      invalid.sendBytes(bytes);
      expect(await invalid.nextJson()).toMatchObject({ type: "response", ok: false, error: { code: "BAD_REQUEST" } });
      expect(await invalid.nextLine()).toBeNull();
    }

    const survivor = await RawUdsConnection.connect(harness.socketPath);
    await survivor.request("hello", "system.hello", { role: "reader" });
    expect(await survivor.request("still-alive", "system.ping", {})).toMatchObject({ ok: true, result: { pong: true } });
    survivor.close();
  });

  test("serves frozen reads, safety, settings, capabilities, and replacement subscriptions", async () => {
    const harness = await fixture(true);
    const reader = new ReconnectingProtocolClient({ role: "reader", connect: () => connectUdsTransport(harness.socketPath) });
    clients.push(reader);
    await reader.start([]);

    expect(await reader.request("system.ping", {})).toEqual({ pong: true });
    expect(await reader.request("system.status", {})).toMatchObject({ ready: true, owner: "daemon" });
    expect(await reader.request("chat.list", {})).toMatchObject({ chats: [{ ...FIXTURE_CHAT }] });
    expect(await reader.request("message.inbox", { chat: FIXTURE_CHAT, interval: FIXTURE_INTERVAL })).toMatchObject({
      messages: [{ msg_id: "m1" }, { msg_id: "m2" }],
      coverage: { gaps: [], limits: [] },
    });
    expect(await reader.request("message.recent", { chats: [FIXTURE_CHAT], interval: FIXTURE_INTERVAL })).toMatchObject({
      messages: [{ msg_id: "m2" }, { msg_id: "m1" }],
      identities: [{ status: "known", self_id: "self" }],
      unread: [{ status: "known", count: 1 }],
    });
    expect(await reader.request("message.evidence", { chats: [FIXTURE_CHAT], interval: FIXTURE_INTERVAL })).toMatchObject({
      evidence: [{ message: { msg_id: "m2" } }, { message: { msg_id: "m1" } }],
    });
    expect(await reader.request("message.get", { chat: FIXTURE_CHAT, msg_id: "m1" })).toMatchObject({ message: { body: "fixture first" } });
    expect(await reader.request("message.search", { chat: FIXTURE_CHAT, interval: FIXTURE_INTERVAL, query: "needle" })).toMatchObject({ messages: [{ msg_id: "m2" }] });
    expect(await reader.request("sync.status", {})).toEqual({ state: "idle" });
    expect(await reader.request("auth.status", {})).toEqual({ authenticated: false });
    expect(await reader.request("send.status", { id: "missing" })).toEqual({ state: "missing" });
    expect(await reader.request("capability.list", {})).toEqual({ v: 1, resources: [] });

    const subscriber = await RawUdsConnection.connect(harness.socketPath);
    await subscriber.request("sub-hello", "system.hello", { role: "reader" });
    expect(await subscriber.request("sub-safety", "subscribe", { topics: ["safety.intent.changed"] })).toMatchObject({
      result: { subscribed: ["safety.intent.changed"] },
    });

    const agent = new ReconnectingProtocolClient({ role: "agent", connect: () => connectUdsTransport(harness.socketPath) });
    clients.push(agent);
    await agent.start([]);
    const first = await agent.request("safety.intent.create", { actor: "agent:parity", scope: FIXTURE_CHAT, body: "approve fixture" });
    expect(typeof first.intent_id).toBe("string");
    expect(typeof first.expires_at).toBe("number");
    const firstIntentId = first.intent_id as string;
    expect(await subscriber.nextJson()).toMatchObject({ type: "event", method: "safety.intent.changed", params: { intent_id: firstIntentId, state: "Proposed" } });

    expect(await subscriber.request("sub-replace", "subscribe", { topics: ["coverage.changed"] })).toMatchObject({
      result: { subscribed: ["coverage.changed"] },
    });
    const second = await agent.request("safety.intent.create", { actor: "agent:parity", scope: FIXTURE_CHAT, body: "reject fixture" });
    expect(typeof second.intent_id).toBe("string");
    const secondIntentId = second.intent_id as string;
    await expect(subscriber.nextJson(150)).rejects.toThrow(/timed out/i);

    const approver = new ReconnectingProtocolClient({
      role: "approver",
      isTTY: () => true,
      approverToken: harness.token(),
      connect: () => connectUdsTransport(harness.socketPath),
    });
    clients.push(approver);
    await approver.start(["safety.intent.changed"]);
    expect(await approver.request("safety.intent.listPending", {})).toMatchObject({ intents: expect.arrayContaining([
      expect.objectContaining({ intent_id: firstIntentId }),
      expect.objectContaining({ intent_id: secondIntentId }),
    ]) });
    const claimed = await approver.request("safety.intent.claimApprovalCode", { intent_id: firstIntentId });
    expect(claimed.code).toMatch(/^\d{6}$/);
    expect(await approver.request("safety.intent.approve", {
      intent_id: firstIntentId,
      code: claimed.code,
      actor: "agent:parity",
      scope: FIXTURE_CHAT,
    })).toMatchObject({ state: "Approved" });
    expect(await approver.request("safety.intent.claimApprovalCode", { intent_id: firstIntentId })).toEqual({ unavailable: true });
    expect(await approver.request("safety.intent.reject", { intent_id: secondIntentId, reason: "fixture" })).toMatchObject({ state: "Expired" });
    await expect(approver.request("sync.backfill", { ...FIXTURE_CHAT, ...FIXTURE_INTERVAL })).rejects.toThrow(/unavailable/i);

    const raw = await RawUdsConnection.connect(harness.socketPath);
    await raw.request("raw-hello", "system.hello", { role: "reader" });
    for (const method of ["settings.get", "settings.update"]) {
      expect(await raw.request(method, method, {})).toMatchObject({ method, ok: false, error: { code: "UNSUPPORTED" } });
    }
    raw.close();
    subscriber.close();
  });

  test("real CLI, MCP, and TUI consumers use the injected Rust lifecycle without a launcher cutover", async () => {
    const harness = await fixture(true);

    const cli = createUdsCliHandlers({ socketPath: harness.socketPath, role: "reader" });
    clients.push(cli);
    const output: string[] = [];
    expect(await runCli(["daemon", "status"], { handlers: cli, write: (line) => output.push(line) })).toMatchObject({ ready: true, owner: "daemon" });
    expect(await runCli(["message", "recent", JSON.stringify({ chats: [FIXTURE_CHAT], interval: FIXTURE_INTERVAL })], {
      handlers: cli,
      write: (line) => output.push(line),
    })).toMatchObject({ messages: [{ msg_id: "m2" }, { msg_id: "m1" }] });
    expect(output.every((line) => !line.includes(harness.databasePath))).toBeTrue();

    const requester = createAgentProtocolRequester(() => connectUdsTransport(harness.socketPath));
    clients.push(requester);
    const tools = createToolHandlers(requester);
    expect(await tools.inbox_list({ chat: FIXTURE_CHAT, interval: FIXTURE_INTERVAL })).toMatchObject({ messages: [{ msg_id: "m1" }, { msg_id: "m2" }] });
    expect(await tools.inbox_search({ chat: FIXTURE_CHAT, interval: FIXTURE_INTERVAL, query: "needle" })).toMatchObject({ messages: [{ msg_id: "m2" }] });
    expect(await tools.inbox_recent({ chats: [FIXTURE_CHAT], interval: FIXTURE_INTERVAL })).toMatchObject({ messages: [{ msg_id: "m2" }, { msg_id: "m1" }] });
    expect(await tools.inbox_evidence({ chats: [FIXTURE_CHAT], interval: FIXTURE_INTERVAL })).toMatchObject({ evidence: [{ message: { msg_id: "m2" } }, { message: { msg_id: "m1" } }] });

    const controller = createConnectedTuiController({
      role: "approver",
      isTTY: () => true,
      approverToken: readTuiApproverToken(harness.socketPath),
      connect: () => connectTuiUdsTransport(harness.socketPath, "approver"),
    });
    clients.push(controller);
    controller.setActiveChat(FIXTURE_CHAT);
    controller.setSearch({ chat: FIXTURE_CHAT, interval: FIXTURE_INTERVAL, query: "needle" });
    await controller.start();
    expect(controller.state.connection.status).toBe("connected");
    expect(controller.state.views.inbox.status).toBe("ready");
    expect(controller.state.views.inbox.data).toMatchObject([
      { id: "m2", body: "fixture second needle" },
      { id: "m1", body: "fixture first" },
    ]);
    await controller.dispatchKey("2");
    expect(controller.state.views.search.data).toMatchObject([{ id: "m2", body: "fixture second needle" }]);
  });
});
