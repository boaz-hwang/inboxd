import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { migrateDatabase, openSqlCipherDatabase } from "../../store/src/index.ts";
import { createSafetyService } from "../src/index.ts";

const scope = { platform: "test", account: "account", chat_id: "chat" };
const proposal = { actor: "agent:test", scope, body: "exact private body", parent_id: "parent" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const directory = mkdtempSync("/tmp/inboxd-receipt-");
  const database = openSqlCipherDatabase({ filename: join(directory, "inboxd.db"), keyProvider: { getKey: () => new Uint8Array(32).fill(7) } });
  migrateDatabase(database);
  cleanups.push(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  return database;
}
async function approved(service: ReturnType<typeof createSafetyService>) {
  const { intent_id } = service.propose(proposal);
  await service.approve({ intentId: intent_id, code: "654321", actor: proposal.actor, scope });
  return intent_id;
}

test.each(["missing", "throw", "receipt", "body", "platform", "account", "chat_id", "parent_id"])(
  "read-back %s cannot promote Sent or release its quota", async (mismatch) => {
    const database = fixture();
    let sends = 0;
    const service = createSafetyService(database, {
      approvalCode: () => "654321",
      transport: { capabilities: { send: true }, send: async () => { sends++; return { state: "sent", receipt: "receipt-1" }; } },
      receiptReader: { async read() {
        if (mismatch === "missing") return undefined;
        if (mismatch === "throw") throw new Error("private remote error");
        const evidence = { ...proposal, scope: { ...scope }, receipt: "receipt-1" };
        if (mismatch === "platform" || mismatch === "account" || mismatch === "chat_id") evidence.scope[mismatch] = "wrong";
        else if (mismatch === "receipt" || mismatch === "body" || mismatch === "parent_id") evidence[mismatch] = "wrong";
        return evidence;
      } },
    });
    const id = await approved(service);
    expect(await service.execute(id)).toMatchObject({ state: "Sent" });
    expect(service.getIntent(id)).toMatchObject({ state: "Sent" });
    await expect(service.execute(id)).rejects.toThrow(/Sent|eligible/i);
    expect(database.query("SELECT state FROM sends").get()).toEqual({ state: "Sent" });
    expect(database.query("SELECT used FROM quota ORDER BY scope").all()).toEqual([{ used: 1 }, { used: 1 }]);
    expect(sends).toBe(1);
    expect(JSON.stringify(database.query("SELECT payload_json FROM audit").all())).not.toContain("private remote error");
  },
);

test("transport acknowledgement alone is Sent even when the sender claims verification", async () => {
  const database = fixture();
  const service = createSafetyService(database, {
    approvalCode: () => "654321",
    transport: { capabilities: { send: true }, send: async () => ({ state: "sent", receipt: "receipt-1", verified: true, body: proposal.body }) },
  });
  const id = await approved(service);
  expect(await service.execute(id)).toMatchObject({ state: "Sent" });
  expect(database.query("SELECT state FROM sends").get()).toEqual({ state: "Sent" });
});

test.each([
  { state: "verified", receipt: "receipt-1" },
  { state: "unknown" },
  { state: "sent", receipt: "" },
  { state: "sent" },
])("malformed transport outcome %j retains quota as Uncertain without read-back", async (outcome) => {
  const database = fixture();
  let sends = 0;
  let reads = 0;
  const service = createSafetyService(database, {
    approvalCode: () => "654321",
    transport: { capabilities: { send: true }, send: async () => { sends++; return outcome as never; } },
    receiptReader: { read: async () => { reads++; return { ...proposal, receipt: "receipt-1" }; } },
  });
  const id = await approved(service);
  expect(await service.execute(id)).toMatchObject({ state: "Uncertain" });
  await expect(service.execute(id)).rejects.toThrow(/Uncertain|eligible/i);
  expect(database.query("SELECT used FROM quota ORDER BY scope").all()).toEqual([{ used: 1 }, { used: 1 }]);
  expect(reads).toBe(0);
  expect(sends).toBe(1);
});

test("a stalled read-back stays Sent within the I/O deadline even if matching evidence arrives late", async () => {
  const database = fixture();
  let release!: (value: typeof proposal & { receipt: string }) => void;
  const service = createSafetyService(database, {
    approvalCode: () => "654321", transportTimeoutMs: 5,
    transport: { capabilities: { send: true }, send: async () => ({ state: "sent", receipt: "receipt-1" }) },
    receiptReader: { read: () => new Promise((resolve) => { release = resolve; }) },
  });
  const id = await approved(service);
  const execution = service.execute(id);
  const result = await Promise.race([execution, Bun.sleep(100).then(() => "hung")]);
  release({ ...proposal, receipt: "receipt-1" });
  await execution;
  expect(result).toMatchObject({ state: "Sent" });
  expect(service.getIntent(id)).toMatchObject({ state: "Sent" });
  expect(database.query("SELECT state FROM sends").get()).toEqual({ state: "Sent" });
});

test("Sent becomes durably Verified only after exact destination receipt/body read-back", async () => {
  const database = fixture();
  let sends = 0;
  let reads = 0;
  const remote = new Map<string, { scope: typeof scope; receipt: string; body: string; parent_id: string }>();
  const service = createSafetyService(database, {
    approvalCode: () => "654321",
    transport: { capabilities: { send: true }, async send(request) {
      sends++;
      remote.set("receipt-1", { scope: request.scope, receipt: "receipt-1", body: request.body, parent_id: request.parent_id! });
      return { state: "sent", receipt: "receipt-1" };
    } },
    receiptReader: { async read(request) {
      reads++;
      expect(request).toEqual({ scope, receipt: "receipt-1" });
      expect(database.query("SELECT state FROM sends").get()).toEqual({ state: "Sent" });
      return remote.get(request.receipt);
    } },
  });
  const id = await approved(service);
  expect(await service.execute(id)).toMatchObject({ state: "Verified", receipt: "receipt-1" });
  expect(createSafetyService(database).getIntent(id)).toMatchObject({ state: "Verified" });
  expect(database.query("SELECT state FROM sends").get()).toEqual({ state: "Verified" });
  expect(database.query("SELECT used FROM quota ORDER BY scope").all()).toEqual([{ used: 1 }, { used: 1 }]);
  expect(sends).toBe(1);
  expect(reads).toBe(1);
  const audit = JSON.stringify(database.query("SELECT payload_json FROM audit").all());
  expect(audit).not.toContain(proposal.body);
  expect(audit).not.toContain("receipt-1");
});
