import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";

import { createDaemon, createLocalKakaoDaemon, createLocalSlackDaemon, defaultApproverTokenPath, readLocalApproverToken } from "../src/main.ts";
import { openSqlCipherDatabase } from "../../store/src/sqlcipher.ts";
import { createDaemonFixture, connectJsonLines } from "./fixtures/daemon-fixture.ts";

const fixtures: ReturnType<typeof createDaemonFixture>[] = [];
const daemons: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function fixture() { const value = createDaemonFixture(); fixtures.push(value); return value; }

async function trustedApprover(socketPath: string, token: string) {
  const client = await connectJsonLines(socketPath);
  await client.request("system.hello", { role: "approver", approver_token: token });
  return client;
}

describe("daemon closure findings", () => {
  test("chat.list is default-bounded, max-100, and uses a scope-bound stable cursor", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider });
    daemons.push(daemon);
    for (let index = 0; index < 101; index++) {
      daemon.apply({ events: [{
        kind: "create",
        message: { key: { platform: "test", account: `account-${String(index).padStart(3, "0")}`, chat_id: "room", msg_id: "m" }, author_id: "a", ts: index, body: "body", attachments: [] },
        revision: { source: "adapter", value: index },
      }] });
    }
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "reader" });

    const defaultPage = await client.request("chat.list");
    expect(defaultPage.chats as unknown[]).toHaveLength(50);
    const first = await client.request("chat.list", { limit: 100 });
    expect(first.chats as unknown[]).toHaveLength(100);
    const cursor = first.next_cursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await client.request("chat.list", { limit: 100, cursor });
    expect(second.chats as { account: string }[]).toEqual([expect.objectContaining({ account: "account-100" })]);
    const malformedScope = Buffer.from(JSON.stringify({ v: 1, scope: "other", platform: "test", account: "account-099", chat_id: "room" })).toString("base64url");
    await expect(client.request("chat.list", { cursor: malformedScope })).rejects.toThrow(/cursor/i);
    await expect(client.request("chat.list", { limit: 101 })).rejects.toThrow(/100/);
    client.close();
  });

  test("refuses a send-capable daemon unless both finite positive quotas are explicitly configured", async () => {
    const state = fixture();
    const sender = { capabilities: { send: true as const }, send: async () => ({ state: "sent" as const, receipt: "never" }) };
    await expect(createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider, sendTransport: sender })).rejects.toThrow(/quota/i);
    await expect(createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider, sendTransport: sender, quotaLimit: Infinity, globalQuotaLimit: 1 })).rejects.toThrow(/finite positive/i);
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider, sendTransport: sender, quotaLimit: 1, globalQuotaLimit: 2, allowSend: () => true });
    daemons.push(daemon);
  });

  test("refuses a send-capable daemon without an explicit allowlist policy", async () => {
    const state = fixture();
    const sender = { capabilities: { send: true as const }, send: async () => ({ state: "sent" as const, receipt: "never" }) };
    await expect(createDaemon({
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: state.keyProvider,
      sendTransport: sender,
      quotaLimit: 1,
      globalQuotaLimit: 1,
    })).rejects.toThrow(/allowlist policy/i);
  });

  test("creates an owner-only local approver token and requires it without exposing it to agents", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider, approvalCode: () => "654321" });
    daemons.push(daemon);
    const tokenPath = defaultApproverTokenPath(state.socketPath);
    expect(existsSync(tokenPath)).toBe(true);
    expect(statSync(state.directory + "/state").mode & 0o777).toBe(0o700);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const token = readLocalApproverToken(state.socketPath);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const agent = await connectJsonLines(state.socketPath);
    await agent.request("system.hello", { role: "agent" });
    const tokenBearingAgent = await connectJsonLines(state.socketPath);
    await expect(tokenBearingAgent.request("system.hello", { role: "agent", approver_token: token })).rejects.toThrow(/approver token/i);
    tokenBearingAgent.close();
    const created = await agent.request("safety.intent.create", { actor: "agent:alpha", scope: { platform: "slack", account: "stable:account", chat_id: "stable:chat" }, body: "never audit this body" });
    await expect(agent.request("safety.intent.listPending")).rejects.toThrow(/approver/i);
    agent.close();

    const denied = await connectJsonLines(state.socketPath);
    await denied.request("system.hello", { role: "approver", approver_token: "wrong-token" });
    await expect(denied.request("safety.intent.listPending")).rejects.toThrow(/trusted local approver/i);
    await expect(denied.request("safety.intent.claimApprovalCode", { intent_id: created.intent_id })).rejects.toThrow(/trusted local approver/i);
    denied.close();

    const approver = await trustedApprover(state.socketPath, token);
    const pending = await approver.request("safety.intent.listPending", { limit: 1 });
    expect(pending.intents).toEqual([expect.objectContaining({ intent_id: created.intent_id })]);
    expect(JSON.stringify(pending)).not.toContain("654321");
    expect(await approver.request("safety.intent.claimApprovalCode", { intent_id: created.intent_id })).toEqual({ code: "654321" });
    expect(await approver.request("safety.intent.claimApprovalCode", { intent_id: created.intent_id })).toEqual({ unavailable: true });
    expect((await approver.request("safety.intent.listPending")).intents).toEqual([]);
    approver.close();

    await daemon.stop();
    const database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    const audit = database.query("SELECT subject, payload_json FROM audit WHERE action = 'read.safety_intent_list'").get() as { subject: string; payload_json: string };
    expect(audit.subject).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.payload_json).toContain('"role":"approver"');
    expect(audit.payload_json).toContain('"result_count":1');
    expect(audit.payload_json).not.toContain("never audit this body");
    expect(audit.payload_json).not.toContain("654321");
    expect(audit.payload_json).not.toContain(token);
    database.close();
  });

  test("wires configured local Slack reads through an atomic store backfill and keeps unconfigured backfill blocked", async () => {
    const state = fixture();
    const account = "stable:account_alpha";
    const chat = { platform: "slack", account, chat_id: "stable:chat_alpha" };
    const calls: unknown[] = [];
    const daemon = await createLocalSlackDaemon({
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: state.keyProvider,
      slack: {
        allowedChats: [{ account, chat_id: chat.chat_id }],
        now: () => 100,
        runner: async (request) => {
          calls.push(request);
          return [{ channel_id: chat.chat_id, message_id: "m1", author_id: "u1", ts: 20, body: "synthetic only" }];
        },
      },
    });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(state.socketPath) });
    await expect(client.request("sync.backfill", { platform: "slack", account: "stable:other", chat_id: chat.chat_id, from_ts: 10, to_ts: 50 })).rejects.toThrow(/allowlist/i);
    const result = await client.request("sync.backfill", { ...chat, from_ts: 10, to_ts: 150 });
    expect(result).toMatchObject({ event_count: 1, authoritative: false });
    expect(calls).toEqual([{ account, chat_id: chat.chat_id, interval: { from_ts: 10, to_ts: 100 }, upper_bound_ts: 100, max_pages: 1 }]);
    client.close();

    await daemon.stop();
    const database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    expect((database.query("SELECT count(*) AS count FROM messages").get() as { count: number }).count).toBe(1);
    expect(database.query("SELECT from_ts, to_ts, reason FROM sync_limits").all()).toEqual([{ from_ts: 10, to_ts: 100, reason: "unsupported" }]);
    database.close();

    const unconfigured = fixture();
    const plain = await createDaemon({ socketPath: unconfigured.socketPath, databasePath: unconfigured.databasePath, keyProvider: unconfigured.keyProvider });
    daemons.push(plain);
    const blocked = await connectJsonLines(unconfigured.socketPath);
    await blocked.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(unconfigured.socketPath) });
    await expect(blocked.request("sync.backfill", { ...chat, from_ts: 10, to_ts: 20 })).rejects.toThrow(/no adapter/i);
    blocked.close();
  });

  test("wires a measured local Kakao read through the encrypted-store backfill", async () => {
    const state = fixture();
    const account = "stable:kakao_account_alpha";
    const chat = { platform: "kakao", account, chat_id: "stable:kakao_chat_alpha" };
    const calls: unknown[] = [];
    const daemon = await createLocalKakaoDaemon({
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: state.keyProvider,
      kakao: {
        allowedChats: [{ account, chat_id: chat.chat_id }],
        measurement: {
          schema_version: "kakao-contrib-read-measurement/v1",
          kind: "kakao-read-field-measurement",
          status: "VALIDATED",
          observation: "observed",
          source: "authorized-live-measurement",
          observed_at: 100,
          send: false,
          supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body", "revision"],
        },
        max_measurement_age: 100,
        now: () => 100,
        reader: async (request) => {
          calls.push(request);
          return [{ account_id: account, chat_id: chat.chat_id, message_id: "m1", author_id: "u1", ts: 20, body: "synthetic only", revision: "m1" }];
        },
      },
    });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(state.socketPath) });

    await expect(client.request("sync.backfill", { platform: "kakao", account: "stable:other", chat_id: chat.chat_id, from_ts: 10, to_ts: 50 })).rejects.toThrow(/allowlist/i);
    const result = await client.request("sync.backfill", { ...chat, from_ts: 10, to_ts: 150 });
    expect(result).toMatchObject({ event_count: 1, authoritative: false });
    expect(calls).toEqual([{ account, chat_id: chat.chat_id, interval: { from_ts: 10, to_ts: 100 }, upper_bound_ts: 100, max_pages: 1 }]);
    client.close();

    await daemon.stop();
    const database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    expect((database.query("SELECT count(*) AS count FROM messages").get() as { count: number }).count).toBe(1);
    expect(database.query("SELECT from_ts, to_ts, reason FROM sync_limits").all()).toEqual([{ from_ts: 10, to_ts: 100, reason: "unsupported" }]);
    database.close();
  });

  test("composes Slack and Kakao readers in one owner and reports observed diagnostics", async () => {
    const state = fixture();
    const slack = { platform: "slack", account: "stable:slack_account", chat_id: "stable:slack_chat" };
    const kakao = { platform: "kakao", account: "stable:kakao_account", chat_id: "stable:kakao_chat" };
    let slackCalls = 0;
    let kakaoCalls = 0;
    const daemon = await createDaemon({
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: state.keyProvider,
      localSlack: {
        allowedChats: [{ account: slack.account, chat_id: slack.chat_id }],
        now: () => 100,
        runner: async () => { slackCalls++; return []; },
      },
      localKakao: {
        allowedChats: [{ account: kakao.account, chat_id: kakao.chat_id }],
        measurement: {
          schema_version: "kakao-contrib-read-measurement/v1",
          kind: "kakao-read-field-measurement",
          status: "VALIDATED",
          observation: "observed",
          source: "authorized-live-measurement",
          observed_at: 100,
          send: false,
          supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body"],
        },
        max_measurement_age: 100,
        now: () => 100,
        reader: async () => { kakaoCalls++; return []; },
      },
    });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(state.socketPath) });

    await client.request("sync.backfill", { ...slack, from_ts: 10, to_ts: 90 });
    await client.request("sync.backfill", { ...kakao, from_ts: 10, to_ts: 90 });
    await expect(client.request("sync.backfill", { platform: "other", account: slack.account, chat_id: slack.chat_id, from_ts: 10, to_ts: 90 })).rejects.toThrow(/configured adapter/i);
    expect({ slackCalls, kakaoCalls }).toEqual({ slackCalls: 1, kakaoCalls: 1 });

    const status = await client.request("system.status");
    expect(status).toMatchObject({
      ready: true,
      owner: "daemon",
      configured_platforms: ["slack", "kakao"],
      encryption: { ready: true },
      endpoint: { kind: "uds", permissions: "owner-only" },
      isolation: { grade: "b", protected: false },
    });
    expect(status.auth).toEqual({ slack: "unknown", kakao: "unknown" });
    expect(status.sync).toEqual({ slack: { state: "success", active_jobs: 0 }, kakao: { state: "success", active_jobs: 0 } });
    expect(await client.request("auth.status")).toEqual({ authenticated: false, platforms: status.auth });
    expect(await client.request("sync.status")).toEqual({ state: "success", platforms: status.sync });
    client.close();
  });

  test("serializes concurrent local Kakao backfills for the same stable chat", async () => {
    const state = fixture();
    const account = "stable:kakao_account_alpha";
    const chat = { platform: "kakao", account, chat_id: "stable:kakao_chat_alpha" };
    let active = 0;
    let maxActive = 0;
    const daemon = await createLocalKakaoDaemon({
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: state.keyProvider,
      kakao: {
        allowedChats: [{ account, chat_id: chat.chat_id }],
        measurement: {
          schema_version: "kakao-contrib-read-measurement/v1",
          kind: "kakao-read-field-measurement",
          status: "VALIDATED",
          observation: "observed",
          source: "authorized-live-measurement",
          observed_at: 100,
          send: false,
          supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body", "revision"],
        },
        max_measurement_age: 100,
        now: () => 100,
        reader: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Bun.sleep(10);
          active -= 1;
          return [];
        },
      },
    });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(state.socketPath) });
    await Promise.all([
      client.request("sync.backfill", { ...chat, from_ts: 10, to_ts: 90 }),
      client.request("sync.backfill", { ...chat, from_ts: 10, to_ts: 90 }),
    ]);
    expect(maxActive).toBe(1);
    client.close();
  });

  test("returns a fixed public Kakao error without exposing connector details over UDS", async () => {
    const state = fixture();
    const account = "stable:kakao_account_alpha";
    const chat = { platform: "kakao", account, chat_id: "stable:kakao_chat_alpha" };
    const daemon = await createLocalKakaoDaemon({
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: state.keyProvider,
      kakao: {
        allowedChats: [{ account, chat_id: chat.chat_id }],
        measurement: {
          schema_version: "kakao-contrib-read-measurement/v1",
          kind: "kakao-read-field-measurement",
          status: "VALIDATED",
          observation: "observed",
          source: "authorized-live-measurement",
          observed_at: 100,
          send: false,
          supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body"],
        },
        max_measurement_age: 100,
        now: () => 100,
        reader: async () => { throw new Error("private connector marker"); },
      },
    });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(state.socketPath) });
    await expect(client.request("sync.backfill", { ...chat, from_ts: 10, to_ts: 90 }))
      .rejects.toThrow("Kakao transport read failed");
    await expect(client.request("sync.backfill", { ...chat, from_ts: 10, to_ts: 90 }))
      .rejects.not.toThrow("private connector marker");
    client.close();
  });
});
