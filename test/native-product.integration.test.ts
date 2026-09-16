import { afterEach, describe, expect, test } from "bun:test";

import { createUdsCliHandlers, readCliApproverToken, runCli } from "../packages/cli/src/index.ts";
import { connectUdsTransport } from "../packages/cli/src/transport.ts";
import { createDaemon, type DaemonController } from "../packages/daemon/src/main.ts";
import { createDaemonFixture } from "../packages/daemon/test/fixtures/daemon-fixture.ts";
import { createAgentProtocolRequester, createToolHandlers } from "../packages/mcp/src/index.ts";
import { ReconnectingProtocolClient } from "../packages/protocol/src/index.ts";
import { createTuiController, renderScreen, type TuiController } from "../packages/tui/src/index.ts";
import { readTuiApproverToken } from "../packages/tui/src/main.ts";
import { connectTuiUdsTransport } from "../packages/tui/src/transport.ts";

const fixtures: ReturnType<typeof createDaemonFixture>[] = [];
const daemons: DaemonController[] = [];
const clients: { stop(): void }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.stop();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

describe("native-backed offline product smoke", () => {
  test("serves the same encrypted data through real UDS CLI, MCP, and TUI flows", async () => {
    const state = createDaemonFixture();
    fixtures.push(state);
    const chat = { platform: "slack", account: "offline", chat_id: "ops" };
    const interval = { from_ts: 0, to_ts: 100 };
    const backfills: unknown[] = [];
    const sends: unknown[] = [];
    const daemonOptions = {
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: state.keyProvider,
      approvalCode: () => "654321",
      quotaLimit: 2,
      globalQuotaLimit: 2,
      allowSend: (proposal: { body: string }) => proposal.body !== "blocked",
      sendTransport: {
        capabilities: { send: true },
        async send(request: unknown) {
          sends.push(request);
          return { state: "sent" as const, receipt: `offline-${sends.length}` };
        },
      },
      backfill: async (request: unknown) => {
        backfills.push(request);
        return { accepted: true, authoritative: false };
      },
    };
    let daemon = await createDaemon(daemonOptions);
    daemons.push(daemon);
    daemon.apply({
      events: [
        { kind: "create", message: { key: { ...chat, msg_id: "m1" }, author_id: "alice", ts: 10, body: "native needle one", attachments: [] }, revision: { source: "adapter", value: 1 } },
        { kind: "create", message: { key: { ...chat, msg_id: "m2" }, author_id: "bob", ts: 20, body: "native needle two", attachments: [] }, revision: { source: "adapter", value: 1 } },
      ],
      coverage: [{ chat, interval, kind: "backfill", collected_at: 100, mutations_verified_at: 100 }],
    });

    const output: string[] = [];
    const reader = createUdsCliHandlers({ socketPath: state.socketPath, role: "reader", isTTY: () => true });
    clients.push(reader);
    expect(await runCli(["daemon", "status"], { handlers: reader, write: (line) => output.push(line) })).toMatchObject({ ready: true });
    expect((await runCli(["chat", "list"], { handlers: reader, write: (line) => output.push(line) }).then((result) => result.chats)) as unknown[]).toHaveLength(1);
    expect((await runCli(["message", "inbox", JSON.stringify(chat)], { handlers: reader, write: (line) => output.push(line) }).then((result) => result.messages)) as unknown[]).toHaveLength(2);
    expect(await runCli(["message", "get", JSON.stringify({ ...chat, msg_id: "m1" })], { handlers: reader, write: (line) => output.push(line) })).toMatchObject({ message: { msg_id: "m1", body: "native needle one" } });
    const cliSearch = await runCli(["message", "search", JSON.stringify({ chat, interval, query: "needle" })], { handlers: reader, write: (line) => output.push(line) });
    expect(cliSearch).toMatchObject({ coverage: { gaps: [], limits: [] } });
    expect(cliSearch.messages as unknown[]).toHaveLength(2);
    expect(await runCli(["sync", "backfill", JSON.stringify({ ...chat, ...interval })], { handlers: reader, write: (line) => output.push(line) })).toEqual({ accepted: true, authoritative: false });
    expect(await runCli(["sync", "status"], { handlers: reader, write: (line) => output.push(line) })).toEqual({ state: "idle" });
    expect(backfills).toEqual([{ chat, interval }]);
    expect(output.every((line) => !line.includes(state.databasePath))).toBeTrue();

    const requester = createAgentProtocolRequester(() => connectUdsTransport(state.socketPath));
    clients.push(requester);
    const tools = createToolHandlers(requester);
    const mcpList = await tools.inbox_list({ chat, interval });
    const mcpSearch = await tools.inbox_search({ chat, interval, query: "needle" });
    expect(mcpList.messages as unknown[]).toHaveLength(2);
    expect(mcpSearch.messages as unknown[]).toHaveLength(2);
    const proposal = await tools.send_propose({ actor: "agent:smoke", scope: chat, body: "approved offline send" });
    expect(proposal).toEqual({ intent_id: expect.any(String), expires_at: expect.any(Number) });
    expect(JSON.stringify(proposal)).not.toContain("654321");
    expect(JSON.stringify(proposal)).not.toContain("approved offline send");

    const approver = createUdsCliHandlers({
      socketPath: state.socketPath,
      role: "approver",
      isTTY: () => true,
      approverToken: readCliApproverToken(state.socketPath),
    });
    clients.push(approver);
    expect((await runCli(["safety", "list"], { handlers: approver, write: () => {} }).then((result) => result.intents)) as unknown[]).toHaveLength(1);
    const approved = await runCli(["safety", "approve", JSON.stringify({ intent_id: proposal.intent_id, code: "654321", actor: "agent:smoke", scope: chat })], { handlers: approver, write: () => {} });
    expect(approved).toMatchObject({ state: "Sent", receipt: "offline-1" });
    expect(sends).toHaveLength(1);

    let controller!: TuiController;
    const tuiClient = new ReconnectingProtocolClient({
      connect: () => connectTuiUdsTransport(state.socketPath),
      role: "approver",
      isTTY: () => true,
      approverToken: readTuiApproverToken(state.socketPath),
      onEvent: (event) => { void controller.receiveEvent(event.method); },
    });
    controller = createTuiController({ client: tuiClient, actor: "tui:smoke" });
    clients.push(controller);
    controller.setActiveChat(chat);
    controller.setSearch({ chat, interval, query: "needle" });
    await controller.start();
    expect(controller.state.connection.status).toBe("connected");
    expect(controller.state.views.inbox.data).toHaveLength(1);
    await controller.dispatchKey("2");
    expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("native needle one");
    await controller.dispatchKey("3");
    await controller.dispatchKey("c");
    for (const character of "tui offline send") await controller.dispatchKey(character);
    await controller.dispatchKey("Enter");
    expect(controller.state.notice).toContain("proposal created");
    await controller.dispatchKey("4");
    expect(controller.currentApprovalCode()).toBe("654321");
    expect(JSON.stringify(controller.state)).not.toContain("654321");
    await controller.dispatchKey("a");
    for (const character of "654321") await controller.dispatchKey(character);
    await controller.dispatchKey("Enter");
    expect(controller.currentApprovalCode()).toBeUndefined();
    expect(sends).toHaveLength(2);

    // Re-open the same encrypted database and make the TUI client perform a
    // fresh real UDS handshake/subscription before querying persisted state.
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
    await Bun.sleep(10);
    daemon = await createDaemon(daemonOptions);
    daemons.push(daemon);
    await controller.start();
    await controller.dispatchKey("2");
    expect(controller.state.connection.status).toBe("connected");
    expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("native needle two");
    expect(sends).toHaveLength(2);
  });
});
