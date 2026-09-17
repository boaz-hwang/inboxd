import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { migrateDatabase, openSqlCipherDatabase } from "../../store/src/index.ts";
import { coreCall } from "../../native/src/index.ts";
import {
  ApprovalRejectedError,
  createSafetyService,
  IntentNotEligibleError,
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
  test("startup scrubs legacy codes for every state and expires all orphan proposals", async () => {
    const { database } = fixture();
    const service = createSafetyService(database, { approvalCode: () => "654321" });
    const orphan = proposal(service);
    const approved = proposal(service);
    await approve(service, approved.intent_id);
    const modern = proposal(service);
    database.run("UPDATE approvals SET payload_json = json_set(payload_json, '$.code', ?) WHERE intent_id IN (?, ?)", ["654321", orphan.intent_id, approved.intent_id]);
    const restarted = createSafetyService(database);
    const stored = database.query("SELECT payload_json FROM approvals").all();
    expect(JSON.stringify(stored)).not.toContain("654321");
    expect(restarted.getIntent(orphan.intent_id)?.state).toBe("Expired");
    expect(restarted.getIntent(modern.intent_id)?.state).toBe("Expired");
    expect(restarted.getIntent(approved.intent_id)?.state).toBe("Approved");
    expect(restarted.claimApprovalCode(orphan.intent_id)).toEqual({ unavailable: true });
    await expect(approve(restarted, orphan.intent_id)).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(restarted.listPending().map(item => item.intent_id)).toEqual([approved.intent_id]);
  });
  test("claims an ephemeral code once and expires an orphan instead of recovering it", async () => {
    const { database } = fixture();
    const service = createSafetyService(database, { approvalCode: () => "654321" });
    const created = proposal(service);
    expect(service.claimApprovalCode(created.intent_id)).toEqual({ code: "654321" });
    expect(service.claimApprovalCode(created.intent_id)).toEqual({ unavailable: true });
    expect(service.getIntent(created.intent_id)?.state).toBe("Expired");
    await expect(approve(service, created.intent_id)).rejects.toBeInstanceOf(ApprovalRejectedError);
    const fresh = proposal(service);
    const claimed = service.claimApprovalCode(fresh.intent_id);
    expect(claimed).toEqual({ code: "654321" });
    await expect(approve(service, fresh.intent_id)).resolves.toMatchObject({ state: "Approved" });
    await expect(approve(service, fresh.intent_id)).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(service.claimApprovalCode(fresh.intent_id)).toEqual({ unavailable: true });
    expect(service.getIntent(fresh.intent_id)?.state).toBe("Approved");
  });
  test("rechecks send capability after the durable claim and never invokes a revoked sender", async () => {
    const { database } = fixture();
    let enabled = true;
    let calls = 0;
    const service = createSafetyService(database, {
      approvalCode: () => "654321",
      // A trusted policy refresh revokes the connector while the claim commits.
      allowSend: () => { enabled = false; return true; },
      transport: { capabilities: { get send() { return enabled; } }, send: async () => { calls++; return { state: "sent", receipt: "forbidden" }; } },
    });
    const created = proposal(service);
    await approve(service, created.intent_id);
    expect(await service.execute(created.intent_id)).toMatchObject({ state: "Failed" });
    expect(calls).toBe(0);
    expect(database.query("SELECT state FROM sends").all()).toEqual([{ state: "Failed" }]);
    expect(database.query("SELECT used FROM quota ORDER BY scope").all()).toEqual([{ used: 0 }, { used: 0 }]);
  });

  test("removing the allowlist entry after approval makes zero remote calls and reserves no quota", async () => {
    const { database } = fixture();
    let allowed = true;
    let calls = 0;
    const service = createSafetyService(database, {
      approvalCode: () => "654321", allowSend: () => allowed,
      transport: { capabilities: { send: true }, send: async () => { calls++; return { state: "sent", receipt: "forbidden" }; } },
    });
    const created = proposal(service);
    await approve(service, created.intent_id);
    expect(service.getIntent(created.intent_id)?.state).toBe("Approved");
    allowed = false;
    expect(await service.execute(created.intent_id)).toMatchObject({ state: "Failed" });
    expect(calls).toBe(0);
    expect(database.query("SELECT * FROM sends").all()).toEqual([]);
    expect(database.query("SELECT * FROM quota").all()).toEqual([]);
  });

  test("issues a code only at the safety boundary and omits body and code from audit metadata", () => {
    const { database } = fixture();
    const service = createSafetyService(database, { now: () => 1_000, approvalCode: () => "654321" });
    const created = proposal(service, "body never in audit 654321");

    expect(created).toEqual({ intent_id: expect.any(String), expires_at: 901_000 });
    expect(JSON.stringify(created)).not.toContain("654321");
    expect(service.listPending()).toEqual([expect.objectContaining({ intent_id: created.intent_id })]);
    expect(service.listPending()[0]).not.toHaveProperty("approval_code");
    const stored = database.query("SELECT payload_json FROM approvals").get() as { payload_json: string };
    expect(JSON.parse(stored.payload_json)).not.toHaveProperty("code");
    expect(stored.payload_json).not.toContain("654321");
    const audit = database.query("SELECT payload_json FROM audit ORDER BY id").all() as { payload_json: string }[];
    expect(JSON.stringify(audit)).not.toContain("body never in audit");
    expect(JSON.stringify(audit)).not.toContain("654321");
  });

  test("pages pending proposed, approved, sending, and uncertain intents with a scoped opaque cursor", async () => {
    const { database } = fixture();
    let sequence = 0;
    const service = createSafetyService(database, { now: () => 1_000, approvalCode: () => "654321", id: () => `id-${++sequence}` });
    const proposed = proposal(service, "proposed");
    const approved = proposal(service, "approved");
    const sending = proposal(service, "sending");
    const uncertain = proposal(service, "uncertain");
    await approve(service, approved.intent_id);
    for (const [intentId, state] of [[sending.intent_id, "Sending"], [uncertain.intent_id, "Uncertain"]] as const) {
      const row = database.query("SELECT payload_json FROM intents WHERE id = ?").get(intentId) as { payload_json: string };
      database.run("UPDATE intents SET payload_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(row.payload_json), state }), intentId]);
    }

    const first = service.listPendingPage({ limit: 2 });
    expect(first.intents.map((intent) => intent.state)).toEqual(["Proposed", "Approved"]);
    expect(first.next_cursor).toBe("eyJ2IjoxLCJzY29wZSI6InNhZmV0eS5pbnRlbnQubGlzdFBlbmRpbmc6djEiLCJjcmVhdGVkX2F0IjoxMDAwLCJpZCI6ImlkLTMifQ");
    expect(first.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = service.listPendingPage({ limit: 2, cursor: first.next_cursor });
    expect(second.intents.map((intent) => intent.state)).toEqual(["Sending", "Uncertain"]);
    const wrongScope = Buffer.from(JSON.stringify({ v: 1, scope: "other", created_at: 1_000, id: approved.intent_id })).toString("base64url");
    expect(() => service.listPendingPage({ cursor: wrongScope })).toThrow(/cursor/i);
    expect(() => service.listPendingPage({ limit: 101 })).toThrow(/100/);
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
    expect(database.query("SELECT used FROM quota WHERE scope = ?").get('{"account":"account-1","chat_id":"chat-1","platform":"slack"}')).toEqual({ used: 1 });

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

  test("claims an approved intent once and evaluates denial policy on the fresh transactional payload", async () => {
    const { database } = fixture();
    let calls = 0;
    let policyState: string | undefined;
    const service = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      allowSend(input) {
        policyState = (database.query("SELECT json_extract(payload_json, '$.state') AS state FROM intents WHERE json_extract(payload_json, '$.body') = ?").get(input.body) as { state: string }).state;
        return input.body !== "denied";
      },
      transport: { capabilities: { send: true }, send: async () => { calls++; return { state: "sent", receipt: `r-${calls}` }; } },
    });
    const allowed = proposal(service, "allowed");
    await approve(service, allowed.intent_id);
    const duplicate = await Promise.allSettled([service.execute(allowed.intent_id), service.execute(allowed.intent_id)]);
    expect(duplicate.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(duplicate.filter((result) => result.status === "rejected")[0]?.reason).toBeInstanceOf(IntentNotEligibleError);
    expect(policyState).toBe("Approved");
    expect(calls).toBe(1);

    const denied = proposal(service, "denied");
    await approve(service, denied.intent_id);
    await expect(service.execute(denied.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Failed" }));
    expect(calls).toBe(1);
  });

  test("releases both quota reservations after a definite failed send", async () => {
    const { database } = fixture();
    let calls = 0;
    const service = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      quotaLimit: 1,
      globalQuotaLimit: 1,
      transport: { capabilities: { send: true }, send: async () => ++calls === 1 ? { state: "failed", reason: "safe failure" } : { state: "sent", receipt: "second" } },
    });
    const first = proposal(service, "first");
    const second = proposal(service, "second");
    await approve(service, first.intent_id);
    await approve(service, second.intent_id);
    await expect(service.execute(first.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Failed" }));
    await expect(service.execute(second.intent_id)).resolves.toEqual(expect.objectContaining({ state: "Sent" }));
    expect(calls).toBe(2);
  });

  test("a stale finalization cannot overwrite recovered uncertainty or release quota", async () => {
    const { database } = fixture();
    let releaseTransport!: (result: { state: "failed"; reason: string }) => void;
    let transportStarted!: () => void;
    const started = new Promise<void>((resolve) => { transportStarted = resolve; });
    const service = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      quotaLimit: 1,
      globalQuotaLimit: 1,
      transport: {
        capabilities: { send: true },
        send: () => {
          transportStarted();
          return new Promise((resolve) => { releaseTransport = resolve; });
        },
      },
    });
    const created = proposal(service, "late transport result");
    await approve(service, created.intent_id);
    const execution = service.execute(created.intent_id);
    await started;

    expect(coreCall<number>("daemon.recoverInterruptedSends", null, database)).toBe(1);
    releaseTransport({ state: "failed", reason: "late definite failure" });
    await expect(execution).rejects.toBeInstanceOf(IntentNotEligibleError);
    expect(service.getIntent(created.intent_id)?.state).toBe("Uncertain");
    expect(database.query("SELECT state FROM sends WHERE intent_id = ?").get(created.intent_id)).toEqual({ state: "Uncertain" });
    expect(database.query("SELECT used FROM quota WHERE scope = '__global__'").get()).toEqual({ used: 1 });
    expect(database.query("SELECT used FROM quota WHERE scope = ?").get('{"account":"account-1","chat_id":"chat-1","platform":"slack"}')).toEqual({ used: 1 });
  });

  test("honors a preexisting v1 canonical scope counter atomically", async () => {
    const { database } = fixture();
    let calls = 0;
    const service = createSafetyService(database, {
      now: () => 1_000,
      approvalCode: () => "654321",
      quotaLimit: 1,
      globalQuotaLimit: 2,
      transport: { capabilities: { send: true }, send: async () => { calls++; return { state: "sent", receipt: "never" }; } },
    });
    const created = proposal(service, "legacy quota");
    await approve(service, created.intent_id);
    database.run("INSERT INTO quota (scope, used, updated_at) VALUES (?, 1, 999)", ['{"account":"account-1","chat_id":"chat-1","platform":"slack"}']);

    await expect(service.execute(created.intent_id)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(service.getIntent(created.intent_id)?.state).toBe("Approved");
    expect(database.query("SELECT used FROM quota WHERE scope = '__global__'").get()).toBeNull();
    expect(calls).toBe(0);
  });

  test("expires a persisted v1 proposal rather than recovering its legacy raw code", async () => {
    const { database } = fixture();
    database.run("INSERT INTO intents (id, kind, payload_json, created_at) VALUES (?, 'send', ?, ?)", [
      "legacy-1",
      '{"actor":"agent:alpha","scope":{"platform":"slack","account":"account-1","chat_id":"chat-1"},"body":"legacy body","parent_id":"p-1","state":"Proposed","expires_at":901234.75,"payload_hash":"e92a60968c05534ead736b1769a60c6b5ad0607a710c0b445b7aef645b07d3f9"}',
      1234.5,
    ]);
    database.run("INSERT INTO approvals (id, intent_id, approved_at, payload_json) VALUES ('legacy-2', 'legacy-1', NULL, ?)", [
      '{"code":"654321","code_hash":"64ded9f666f8e1078d7c21201aa6cad5b1bdad422b4c0f8c1e288175d905c5ad","bound_hash":"1bc0f40a3d34cac1ee3bae791761814ea6249ffbb787348c92b9d9db0c35bcf4","actor":"agent:alpha","scope":{"platform":"slack","account":"account-1","chat_id":"chat-1"},"expires_at":901234.75}',
    ]);
    const service = createSafetyService(database, { now: () => 1234.5 });
    await expect(service.approve({ intentId: "legacy-1", code: "654321", actor: "agent:alpha", scope })).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(service.getIntent("legacy-1")).toMatchObject({ state: "Expired", parent_id: "p-1" });
  });

  test("keeps v1 cursor bytes compatible for genuine private-use scalar IDs", () => {
    const { database } = fixture();
    const ids = ["a\u{F0000}", "approval-1", "z", "approval-2"];
    const service = createSafetyService(database, { now: () => 1_000, approvalCode: () => "654321", id: () => ids.shift()! });
    const first = proposal(service, "first-pua");
    const second = proposal(service, "second-pua");
    expect(first.intent_id).toBe("a\u{F0000}");
    const page = service.listPendingPage({ limit: 1 });
    const expected = Buffer.from(JSON.stringify({ v: 1, scope: "safety.intent.listPending:v1", created_at: 1_000, id: "a\u{F0000}" })).toString("base64url");
    expect(page.next_cursor).toBe(expected);
    expect(service.listPendingPage({ limit: 1, cursor: page.next_cursor }).intents[0]?.intent_id).toBe(second.intent_id);
  });
});
