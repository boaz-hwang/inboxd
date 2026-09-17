import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { readLocalApproverToken } from "../src/approver-token.ts";
import { openSqlCipherDatabase } from "../../store/src/index.ts";
import { connectJsonLines, createDaemonFixture, type JsonLineClient } from "./fixtures/daemon-fixture.ts";

const scope = { platform: "slack", account: "crash-account", chat_id: "crash-chat" };
const actor = "agent:crash-regression";
const timeoutMs = 10_000;

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function startChild(state: ReturnType<typeof createDaemonFixture>, journalPath: string, stage = "transport-entered") {
  const child = spawn(process.execPath, [join(import.meta.dir, "fixtures/outbox-crash-child.ts"), state.socketPath, state.databasePath, journalPath, stage], {
    env: { ...process.env, NODE_ENV: "test", INBOXD_CRASH_TEST_KEY: Buffer.from(state.keyProvider.getKey() as Uint8Array).toString("hex") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const lines = createInterface({ input: child.stdout });
  const events: string[] = [];
  let notify: (() => void) | undefined;
  lines.on("line", (line) => { events.push(line); notify?.(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // Observe spawn errors even if setup fails before the first readiness wait.
  void exited.catch(() => {});
  return {
    child,
    exited,
    async waitFor(event: string) {
      const observed = new Promise<void>((resolve) => {
        notify = () => {
          if (events.some((line) => JSON.parse(line).event === event)) resolve();
        };
        notify();
      });
      try {
        await bounded(Promise.race([
          observed,
          exited.then(({ code, signal }) => { throw new Error(`child exited before ${event}: ${code ?? signal}; ${stderr}`); }),
        ]), `child ${event}; ${stderr}`);
      } finally {
        notify = undefined;
      }
    },
    async stop(signal: NodeJS.Signals) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      const result = await bounded(exited, `child exit after ${signal}`);
      lines.close();
      return result;
    },
  };
}

function snapshot(state: ReturnType<typeof createDaemonFixture>, intentId: string) {
  // This is an independent encrypted connection, not fabricated Sending rows.
  const database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
  try {
    return {
      intent: database.query("SELECT json_extract(payload_json, '$.state') AS state FROM intents WHERE id = ?").get(intentId),
      sends: database.query("SELECT id, intent_id, idempotency_key, state FROM sends ORDER BY id").all() as { id: string; intent_id: string; idempotency_key: string; state: string }[],
      quota: database.query("SELECT scope, used FROM quota ORDER BY scope").all(),
    };
  } finally {
    database.close();
  }
}

// A real SIGKILL must land inside the fake transport, after the actual claim
// transaction and before any outcome can finalize. No live sender is configured.
test.each(["transport-entered", "remote-succeeded"])("SIGKILL at %s recovers the durable outbox as Uncertain without resend or quota release", async (stage) => {
  const state = createDaemonFixture();
  const journalPath = join(state.directory, "transport-calls.jsonl");
  const children: ReturnType<typeof startChild>[] = [];
  const clients: JsonLineClient[] = [];
  const calls = () => existsSync(journalPath)
    ? readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
  async function connect(role: "agent" | "approver") {
    const client = await bounded(connectJsonLines(state.socketPath), "UDS connect");
    clients.push(client);
    await bounded(client.request("system.hello", { role, ...(role === "approver" ? { approver_token: readLocalApproverToken(state.socketPath) } : {}) }), "UDS hello");
    return client;
  }
  const request = (client: JsonLineClient, method: string, params?: Record<string, unknown>) => bounded(client.request(method, params), method);
  async function createApprovedRequest(agent: JsonLineClient, approver: JsonLineClient, destination = scope) {
    const created = await request(agent, "safety.intent.create", { actor, scope: destination, body: "synthetic crash-test body" });
    const pending = await request(approver, "safety.intent.listPending");
    expect(JSON.stringify(pending)).not.toContain("approval_code");
    const claimed = await request(approver, "safety.intent.claimApprovalCode", { intent_id: created.intent_id });
    expect(typeof claimed.code).toBe("string");
    return { intent_id: created.intent_id as string, code: claimed.code as string, actor, scope: destination };
  }
  try {
    const first = startChild(state, journalPath, stage);
    children.push(first);
    await first.waitFor("ready");
    const agent = await connect("agent");
    const approver = await connect("approver");
    const approval = await createApprovedRequest(agent, approver);
    // Approval executes the transport before responding. Race against socket
    // closure because the shared fixture deliberately has no request cancellation.
    const inFlight = Promise.race([
      approver.request("safety.intent.approve", approval).then(() => "response", () => "error"),
      approver.closed.then(() => "closed"),
    ]);
    await first.waitFor(stage);
    const expectedJournal = [{ event: "transport-entered", pid: first.child.pid, idempotency_key: calls()[0].idempotency_key },
      ...(stage === "remote-succeeded" ? [{ event: "remote-succeeded", pid: first.child.pid, idempotency_key: calls()[0].idempotency_key,
        receipt: "fake-remote-message", scope, body: "synthetic crash-test body" }] : [])];
    expect(calls()).toEqual(expectedJournal);
    expect(calls().filter((event) => event.event === "transport-entered")).toHaveLength(1);
    expect(await first.stop("SIGKILL")).toEqual({ code: null, signal: "SIGKILL" });
    expect(await bounded(inFlight, "interrupted approval disconnect")).toBe("closed");
    expect(existsSync(state.socketPath)).toBe(true);
    expect(JSON.parse(readFileSync(join(state.directory, "state/inboxd.lock"), "utf8")).pid).toBe(first.child.pid);

    const crashed = snapshot(state, approval.intent_id);
    expect(crashed.intent).toEqual({ state: "Sending" });
    expect(crashed.sends).toEqual([{
      id: expect.any(String), intent_id: approval.intent_id,
      idempotency_key: calls()[0].idempotency_key, state: "Sending",
    }]);
    expect(crashed.quota).toEqual([
      { scope: "__global__", used: 1 },
      { scope: '{"account":"crash-account","chat_id":"crash-chat","platform":"slack"}', used: 1 },
    ]);

    // Two fresh owners prove recovery persists and is idempotent. Both use the
    // same instrumented transport, so a startup resend cannot hide in a new PID.
    for (let boot = 0; boot < 2; boot++) {
      const restarted = startChild(state, journalPath);
      children.push(restarted);
      await restarted.waitFor("ready");
      expect(restarted.child.pid).not.toBe(first.child.pid);
      const reader = await connect("agent");
      const trusted = await connect("approver");
      expect(await request(reader, "send.status", { id: crashed.sends[0]!.id })).toMatchObject({ state: "Uncertain" });
      const pending = await request(trusted, "safety.intent.listPending");
      expect(pending.intents).toContainEqual(expect.objectContaining({ intent_id: approval.intent_id, state: "Uncertain" }));
      await expect(request(trusted, "safety.intent.approve", approval)).rejects.toThrow(/approval|consumed|Uncertain|Proposed/i);

      if (boot === 0) {
        // Same-scope and cross-scope sends must both stay blocked: uncertainty
        // cannot restore either the per-destination or global reservation.
        for (const destination of [scope, { ...scope, chat_id: "other-chat" }]) {
          const next = await createApprovedRequest(reader, trusted, destination);
          await expect(request(trusted, "safety.intent.approve", next)).rejects.toThrow(/quota/i);
        }
      }
      expect(calls()).toEqual(expectedJournal);
      reader.close();
      trusted.close();
      expect(await restarted.stop("SIGTERM")).toEqual({ code: 0, signal: null });
      const recovered = snapshot(state, approval.intent_id);
      expect(recovered.intent).toEqual({ state: "Uncertain" });
      expect(recovered.sends).toEqual(crashed.sends.map((send) => ({ ...send, state: "Uncertain" })));
      expect(recovered.quota).toEqual(crashed.quota);
      expect(calls()).toEqual(expectedJournal);
    }
  } finally {
    for (const client of clients) client.close();
    await Promise.all(children.map((child) => child.stop("SIGKILL")));
    state.dispose();
  }
}, 45_000);
