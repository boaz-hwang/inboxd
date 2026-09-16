import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { migrateDatabase, openSqlCipherDatabase } from "../../store/src/index.ts";
import {
  ApprovalRejectedError,
  createSafetyService,
  QuotaExceededError,
  type SendTransport,
  type SendScope,
} from "../src/index.ts";

const scope: SendScope = { platform: "slack", account: "account-1", chat_id: "chat-1" };
const fixtures: { database: ReturnType<typeof openSqlCipherDatabase>; directory: string }[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync("/tmp/inboxd-safety-");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const database = openSqlCipherDatabase({ filename: join(directory, "inboxd.db"), keyProvider: { getKey: () => key.slice() } });
  migrateDatabase(database);
  const value = { directory, database };
  fixtures.push(value);
  return value;
}

function proposal(service: ReturnType<typeof createSafetyService>, body = "private body that must never enter audit") {
  return service.propose({ actor: "agent:alpha", scope, body });
}

async function approve(service: ReturnType<typeof createSafetyService>, intentId: string, code = "654321") {
  return service.approve({ intentId, code, actor: "agent:alpha", scope });
}

describe("safety intent approval and outbox", () => {
  test("issues a code only at the safety boundary and omits body and code from audit metadata", () => {
    const { database } = fixture();
    const service = createSafetyService(database, { now: () => 1_000, approvalCode: () => "654321" });
    const created = proposal(service, "body never in audit 654321");

    expect(created).toEqual({ intent_id: expect.any(String), expires_at: 901_000 });
    expect(JSON.stringify(created)).not.toContain("654321");
    expect(service.listPending()).toEqual([expect.objectContaining({ intent_id: created.intent_id, approval_code: "654321" })]);
    const audit = database.query("SELECT payload_json FROM audit ORDER BY id").all() as { payload_json: string }[];
    expect(JSON.stringify(audit)).not.toContain("body never in audit");
    expect(JSON.stringify(audit)).not.toContain("654321");
  });

  test("binds approval to intent hash actor scope and expiry then consumes it exactly once", async () => {
    const { database } = fixture();
    let now = 1_000;
    const service = createSafetyService(database, { now: () => now, approvalCode: () => "654321" });
    const created = proposal(service);

    await expect(service.approve({ intentId: created.intent_id, code: "654321", actor: "agent:other", scope })).rejects.toBeInstanceOf(ApprovalRejectedError);
    await expect(service.approve({ intentId: created.intent_id, code: "654321", actor: "agent:alpha", scope: { ...scope, chat_id: "other" } })).rejects.toBeInstanceOf(ApprovalRejectedError);
    const row = database.query("SELECT payload_json FROM intents WHERE id = ?").get(created.intent_id) as { payload_json: string };
    database.run("UPDATE intents SET payload_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(row.payload_json), body: "tampered" }), created.intent_id]);
    await expect(approve(service, created.intent_id)).rejects.toBeInstanceOf(ApprovalRejectedError);

    const fresh = proposal(service, "fresh");
    await expect(approve(service, fresh.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Approved" }));
    await expect(approve(service, fresh.intent_id)).rejects.toBeInstanceOf(ApprovalRejectedError);

    const expiring = proposal(service, "expiring");
    now = 901_001;
    await expect(approve(service, expiring.intent_id)).rejects.toBeInstanceOf(ApprovalRejectedError);
    const expiredRow = database.query("SELECT payload_json FROM intents WHERE id = ?").get(expiring.intent_id) as { payload_json: string };
    expect(JSON.parse(expiredRow.payload_json).state).toBe("Expired");
    expect(service.getIntent(expiring.intent_id)?.state).toBe("Expired");
  });

  test("commits Sending before a fake transport and records sent, failed, and uncertain outcomes", async () => {
    const { database } = fixture();
    let observedState: string | undefined;
    const sentTransport: SendTransport = {
      capabilities: { send: true },
      async send() {
        observedState = (database.query("SELECT state FROM sends").get() as { state: string }).state;
        return { state: "sent", receipt: "platform-message-1" };
      },
    };
    const sent = createSafetyService(database, { now: () => 1_000, approvalCode: () => "654321", transport: sentTransport });
    const first = proposal(sent, "sent");
    await approve(sent, first.intent_id);
    await expect(sent.execute(first.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Sent", receipt: "platform-message-1" }));
    expect(observedState).toBe("Sending");

    const failed = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      transport: { capabilities: { send: true }, send: async () => ({ state: "failed", reason: "rejected before send" }) },
    });
    const second = proposal(failed, "failed");
    await approve(failed, second.intent_id);
    await expect(failed.execute(second.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Failed" }));

    let calls = 0;
    const uncertain = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      transport: { capabilities: { send: true }, send: async () => { calls++; throw new Error("connection lost after possible send"); } },
    });
    const third = proposal(uncertain, "uncertain");
    await approve(uncertain, third.intent_id);
    await expect(uncertain.execute(third.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Uncertain" }));
    await expect(uncertain.execute(third.intent_id)).rejects.toThrow(/Uncertain|eligible/i);
    expect(uncertain.listPending()).toContainEqual(expect.objectContaining({ intent_id: third.intent_id, state: "Uncertain" }));
    expect(calls).toBe(1);

    const timedOut = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      transportTimeoutMs: 1,
      transport: { capabilities: { send: true }, send: () => new Promise(() => {}) },
    });
    const fourth = proposal(timedOut, "timed-out");
    await approve(timedOut, fourth.intent_id);
    await expect(timedOut.execute(fourth.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Uncertain" }));

    const audit = database.query("SELECT payload_json FROM audit ORDER BY id").all() as { payload_json: string }[];
    expect(JSON.stringify(audit)).not.toContain("sent");
    expect(JSON.stringify(audit)).not.toContain("failed");
    expect(JSON.stringify(audit)).not.toContain("uncertain");
    expect(JSON.stringify(audit)).not.toContain("654321");
  });

  test("enforces quota and rejects a send:false transport before it is called", async () => {
    const { database } = fixture();
    let calls = 0;
    const service = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      quotaLimit: 1,
      transport: { capabilities: { send: true }, send: async () => { calls++; return { state: "sent", receipt: `r-${calls}` }; } },
    });
    const first = proposal(service, "first");
    const second = proposal(service, "second");
    await approve(service, first.intent_id);
    await approve(service, second.intent_id);
    await expect(service.execute(first.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Sent" }));
    await expect(service.execute(second.intent_id)).rejects.toThrow(/quota/i);
    expect(calls).toBe(1);

    let falseCalls = 0;
    const disabled = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      transport: { capabilities: { send: false }, send: async () => { falseCalls++; return { state: "sent", receipt: "never" }; } },
    });
    const blocked = proposal(disabled, "blocked");
    await approve(disabled, blocked.intent_id);
    await expect(disabled.execute(blocked.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Failed" }));
    expect(falseCalls).toBe(0);
  });

  test("reserves the per-scope quota before concurrent sends can reach the transport", async () => {
    const { database } = fixture();
    let calls = 0;
    const service = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      quotaLimit: 1,
      globalQuotaLimit: 3,
      transport: { capabilities: { send: true }, send: async () => { calls++; return { state: "sent", receipt: `r-${calls}` }; } },
    });
    const intents = [proposal(service, "first"), proposal(service, "second"), proposal(service, "third")];
    await Promise.all(intents.map(({ intent_id }) => approve(service, intent_id)));

    const results = await Promise.allSettled(intents.map(({ intent_id }) => service.execute(intent_id)));
    const rejected = results.filter((result) => result.status === "rejected");

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((result) => result.reason instanceof QuotaExceededError)).toBe(true);
    expect(calls).toBe(1);
  });

  test("reserves one global quota across concurrent sends to separate scopes", async () => {
    const { database } = fixture();
    const otherScope: SendScope = { ...scope, chat_id: "chat-2" };
    let calls = 0;
    const service = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      quotaLimit: 2,
      globalQuotaLimit: 1,
      transport: { capabilities: { send: true }, send: async () => { calls++; return { state: "sent", receipt: `r-${calls}` }; } },
    });
    const first = proposal(service, "first");
    const second = service.propose({ actor: "agent:alpha", scope: otherScope, body: "second" });
    await approve(service, first.intent_id);
    await service.approve({ intentId: second.intent_id, code: "654321", actor: "agent:alpha", scope: otherScope });

    const results = await Promise.allSettled([service.execute(first.intent_id), service.execute(second.intent_id)]);
    const rejected = results.filter((result) => result.status === "rejected");

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(QuotaExceededError);
    expect(calls).toBe(1);
  });
});
