import { expect, test } from "bun:test";
import { createDaemon, readLocalApproverToken } from "../src/main.ts";
import { createDaemonFixture, connectJsonLines } from "./fixtures/daemon-fixture.ts";
import { openSqlCipherDatabase } from "../../store/src/index.ts";
import { createConnectedTuiController } from "../../tui/src/main.ts";
import { connectTuiUdsTransport } from "../../tui/src/transport.ts";

const scope = { platform: "slack", account: "test-account", chat_id: "test-chat" };
const proposal = { actor: "operator", scope, body: "synthetic delivery test" };

test("real owner TUI claims once, retains on refresh, discards on stop, and approves only a re-proposal after loss", async () => {
  const fixture = createDaemonFixture();
  const daemon = await createDaemon({ socketPath: fixture.socketPath, databasePath: fixture.databasePath, keyProvider: fixture.keyProvider, approvalCode: () => "654321" });
  const owner = await connectJsonLines(fixture.socketPath);
  const controller = createConnectedTuiController({ role: "approver", isTTY: () => true,
    approverToken: readLocalApproverToken(fixture.socketPath), connect: () => connectTuiUdsTransport(fixture.socketPath, "approver"),
  });
  try {
    await owner.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(fixture.socketPath) });
    const created = await owner.request("safety.intent.create", proposal);
    await controller.start();
    expect(controller.currentApprovalCode()).toBe("654321");
    await controller.receiveEvent("safety.intent.changed");
    expect(controller.currentApprovalCode()).toBe("654321");
    expect(JSON.stringify(controller.state)).not.toContain("654321");
    expect(JSON.stringify(await owner.request("safety.intent.listPending"))).not.toContain("654321");
    controller.stop();
    expect(controller.currentApprovalCode()).toBeUndefined();
    expect(await owner.request("safety.intent.claimApprovalCode", { intent_id: created.intent_id })).toEqual({ unavailable: true });
    await expect(owner.request("safety.intent.approve", { intent_id: created.intent_id, code: "654321", actor: proposal.actor, scope })).rejects.toThrow(/expired/i);
    const fresh = await owner.request("safety.intent.create", proposal);
    await controller.start();
    expect(controller.currentApprovalCode()).toBe("654321");
    await controller.dispatchKey("4"); await controller.dispatchKey("a");
    for (const key of "654321") await controller.dispatchKey(key);
    await controller.dispatchKey("Enter");
    expect(controller.currentApprovalCode()).toBeUndefined();
    expect((await owner.request("safety.intent.listPending")).intents).toContainEqual(expect.objectContaining({ intent_id: fresh.intent_id, state: "Approved" }));
    await expect(owner.request("safety.intent.approve", { intent_id: fresh.intent_id, code: "654321", actor: proposal.actor, scope })).rejects.toThrow(/available/i);
  } finally { controller.stop(); owner.close(); await daemon.stop(); fixture.dispose(); }
});

test("real daemon reopen scrubs legacy approval plaintext before exposing any API and expires orphan proposals", async () => {
  const fixture = createDaemonFixture();
  const options = { socketPath: fixture.socketPath, databasePath: fixture.databasePath, keyProvider: fixture.keyProvider, approvalCode: () => "654321" };
  let daemon = await createDaemon(options);
  let client = await connectJsonLines(fixture.socketPath);
  try {
    await client.request("system.hello", { role: "agent" });
    const created = await client.request("safety.intent.create", proposal);
    client.close(); await daemon.stop();
    const legacy = openSqlCipherDatabase({ filename: fixture.databasePath, keyProvider: fixture.keyProvider });
    try { legacy.run("UPDATE approvals SET payload_json = json_set(payload_json, '$.code', '654321')"); }
    finally { legacy.close(); }
    daemon = await createDaemon(options);
    client = await connectJsonLines(fixture.socketPath);
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(fixture.socketPath) });
    expect((await client.request("safety.intent.listPending")).intents).toEqual([]);
    expect(await client.request("safety.intent.claimApprovalCode", { intent_id: created.intent_id })).toEqual({ unavailable: true });
    await expect(client.request("safety.intent.approve", { intent_id: created.intent_id, code: "654321", actor: proposal.actor, scope })).rejects.toThrow(/expired/i);
    const database = openSqlCipherDatabase({ filename: fixture.databasePath, keyProvider: fixture.keyProvider });
    try {
      expect(JSON.stringify(database.query("SELECT payload_json FROM approvals").all())).not.toContain("654321");
      expect(database.query("SELECT json_extract(payload_json, '$.state') AS state FROM intents WHERE id = ?").get(created.intent_id as string)).toEqual({ state: "Expired" });
    } finally { database.close(); }
  } finally { client.close(); await daemon.stop(); fixture.dispose(); }
});
