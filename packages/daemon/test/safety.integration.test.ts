import { afterEach, describe, expect, test } from "bun:test";

import { createDaemon } from "../src/main.ts";
import { createDaemonFixture, connectJsonLines } from "./fixtures/daemon-fixture.ts";

const fixtures: ReturnType<typeof createDaemonFixture>[] = [];
const daemons: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function fixture() { const value = createDaemonFixture(); fixtures.push(value); return value; }
const scope = { platform: "slack", account: "account-1", chat_id: "chat-1" };
const proposal = { actor: "agent:alpha", scope, body: "agent body is never an approval code" };

describe("daemon safety protocol integration", () => {
  test("never gives agent or MCP sessions an approval code", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider, approvalCode: () => "654321" });
    daemons.push(daemon);

    for (const role of ["agent", "mcp"] as const) {
      const client = await connectJsonLines(state.socketPath);
      await client.request("system.hello", { role });
      const created = await client.request("safety.intent.create", proposal);
      expect(JSON.stringify(created)).not.toContain("654321");
      await expect(client.request("safety.intent.listPending")).rejects.toThrow(/approver/i);
      await expect(client.request("safety.intent.approve", { intent_id: created.intent_id, code: "654321", actor: proposal.actor, scope })).rejects.toThrow(/approver/i);
      await expect(client.request("safety.intent.reject", { intent_id: created.intent_id })).rejects.toThrow(/approver/i);
      client.close();
    }
  });

  test("default-denies code-bearing approver operations until a trusted local session is authorized", async () => {
    const deniedState = fixture();
    const deniedDaemon = await createDaemon({ socketPath: deniedState.socketPath, databasePath: deniedState.databasePath, keyProvider: deniedState.keyProvider, approvalCode: () => "654321" });
    daemons.push(deniedDaemon);
    const agent = await connectJsonLines(deniedState.socketPath);
    await agent.request("system.hello", { role: "agent" });
    const created = await agent.request("safety.intent.create", proposal);
    agent.close();
    const deniedApprover = await connectJsonLines(deniedState.socketPath);
    await deniedApprover.request("system.hello", { role: "approver" });
    await expect(deniedApprover.request("safety.intent.listPending")).rejects.toThrow(/trusted local approver/i);
    await expect(deniedApprover.request("safety.intent.approve", { intent_id: created.intent_id, code: "654321", actor: proposal.actor, scope })).rejects.toThrow(/trusted local approver/i);
    await expect(deniedApprover.request("safety.intent.reject", { intent_id: created.intent_id })).rejects.toThrow(/trusted local approver/i);
    deniedApprover.close();

    const allowedState = fixture();
    const allowedDaemon = await createDaemon({
      socketPath: allowedState.socketPath,
      databasePath: allowedState.databasePath,
      keyProvider: allowedState.keyProvider,
      approvalCode: () => "654321",
      isTrustedApproverSession: () => true,
    });
    daemons.push(allowedDaemon);
    const proposer = await connectJsonLines(allowedState.socketPath);
    await proposer.request("system.hello", { role: "agent" });
    const allowedCreated = await proposer.request("safety.intent.create", proposal);
    proposer.close();
    const approver = await connectJsonLines(allowedState.socketPath);
    await approver.request("system.hello", { role: "approver" });
    const pending = await approver.request("safety.intent.listPending");
    expect(pending.intents).toEqual([expect.objectContaining({ intent_id: allowedCreated.intent_id, approval_code: "654321" })]);
    await expect(approver.request("safety.intent.approve", { intent_id: allowedCreated.intent_id, code: "654321", actor: proposal.actor, scope })).resolves.toEqual(expect.objectContaining({ state: "Approved" }));
    approver.close();
  });
});
