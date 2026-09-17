import { afterEach, describe, expect, test } from "bun:test";

import { createDaemon } from "../src/main.ts";
import { openSqlCipherDatabase } from "../../store/src/index.ts";
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
  test("reports Verified over UDS only after the independent receipt reader matches", async () => {
    const state = fixture();
    let sends = 0;
    let reads = 0;
    daemons.push(await createDaemon({
      socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider,
      approvalCode: () => "654321", isTrustedApproverSession: () => true,
      quotaLimit: 1, globalQuotaLimit: 1, allowSend: () => true,
      sendTransport: { capabilities: { send: true }, send: async () => { sends++; return { state: "sent", receipt: "remote-id" }; } },
      receiptReader: { read: async (request) => { reads++; return { ...request, body: proposal.body }; } },
    }));
    const client = await connectJsonLines(state.socketPath);
    try {
      await client.request("system.hello", { role: "approver" });
      const created = await client.request("safety.intent.create", proposal);
      expect(await client.request("safety.intent.approve", { intent_id: created.intent_id, code: "654321", actor: proposal.actor, scope })).toMatchObject({ state: "Verified", receipt: "remote-id" });
      expect(sends).toBe(1);
      expect(reads).toBe(1);
      const database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
      let sendId: string;
      try { sendId = (database.query("SELECT id FROM sends WHERE intent_id = ?").get(created.intent_id as string) as { id: string }).id; }
      finally { database.close(); }
      expect(await client.request("send.status", { id: sendId })).toMatchObject({ state: "Verified" });
      client.close();
      await daemons[0]!.stop();
      daemons.push(await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider }));
      const restarted = await connectJsonLines(state.socketPath);
      try {
        await restarted.request("system.hello", { role: "reader" });
        expect(await restarted.request("send.status", { id: sendId })).toMatchObject({ state: "Verified" });
        expect(sends).toBe(1);
        expect(reads).toBe(1);
      } finally { restarted.close(); }
    } finally { client.close(); }
  });

  test("normal composition refuses Kakao sends even with a permissive injected sender", async () => {
    const state = fixture();
    let calls = 0;
    daemons.push(await createDaemon({
      socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider,
      approvalCode: () => "654321", isTrustedApproverSession: () => true,
      quotaLimit: 1, globalQuotaLimit: 1, allowSend: () => true,
      sendTransport: { capabilities: { send: true }, send: async () => { calls++; return { state: "sent", receipt: "must-not-send" }; } },
    }));
    const client = await connectJsonLines(state.socketPath);
    try {
      await client.request("system.hello", { role: "approver" });
      const kakao = { ...scope, platform: "kakao" };
      const created = await client.request("safety.intent.create", { ...proposal, scope: kakao });
      expect(await client.request("safety.intent.approve", { intent_id: created.intent_id, code: "654321", actor: proposal.actor, scope: kakao })).toMatchObject({ state: "Failed" });
      expect(calls).toBe(0);
    } finally { client.close(); }
  });

  test.each(["Kakao", "kakao ", "unknown"])("normal composition rejects noncanonical send platform %s before transport", async (platform) => {
    const state = fixture();
    let calls = 0;
    daemons.push(await createDaemon({
      socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider,
      approvalCode: () => "654321", isTrustedApproverSession: () => true,
      quotaLimit: 1, globalQuotaLimit: 1, allowSend: () => true,
      sendTransport: { capabilities: { send: true }, send: async () => { calls++; return { state: "sent", receipt: "must-not-send" }; } },
    }));
    const client = await connectJsonLines(state.socketPath);
    try {
      await client.request("system.hello", { role: "approver" });
      const unbound = { ...scope, platform };
      const created = await client.request("safety.intent.create", { ...proposal, scope: unbound });
      expect(await client.request("safety.intent.approve", { intent_id: created.intent_id, code: "654321", actor: proposal.actor, scope: unbound })).toMatchObject({ state: "Failed" });
      expect(calls).toBe(0);
    } finally { client.close(); }
  });

  test("never gives agent or MCP sessions an approval code", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider, approvalCode: () => "654321" });
    daemons.push(daemon);

    for (const role of ["reader", "agent", "mcp"] as const) {
      const client = await connectJsonLines(state.socketPath);
      await client.request("system.hello", { role });
      const created = await client.request("safety.intent.create", proposal);
      expect(JSON.stringify(created)).not.toContain("654321");
      await expect(client.request("safety.intent.listPending")).rejects.toThrow(/approver/i);
      await expect(client.request("safety.intent.claimApprovalCode", { intent_id: created.intent_id })).rejects.toThrow(/approver/i);
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
    expect(pending.intents).toEqual([expect.objectContaining({ intent_id: allowedCreated.intent_id })]);
    expect(JSON.stringify(pending)).not.toContain("654321");
    expect(await approver.request("safety.intent.claimApprovalCode", { intent_id: allowedCreated.intent_id })).toEqual({ code: "654321" });
    await expect(approver.request("safety.intent.approve", { intent_id: allowedCreated.intent_id, code: "654321", actor: proposal.actor, scope })).resolves.toEqual(expect.objectContaining({ state: "Approved" }));
    approver.close();
  });
});
