import { afterEach, describe, expect, test } from "bun:test";

import { createLocalSlackBackfill } from "../src/local-slack.ts";
import { readSyncState } from "../../store/src/apply.ts";
import { recentMessages } from "../../store/src/queries.ts";
import type { SlackPageRequest } from "../../../platforms/slack/src/index.ts";
import { createDaemon } from "../src/main.ts";
import { recoverInterruptedSends } from "../src/recovery.ts";
import { migrateDatabase, openSqlCipherDatabase } from "../../store/src/index.ts";
import { createDaemonFixture, connectJsonLines } from "./fixtures/daemon-fixture.ts";

const fixtures: ReturnType<typeof createDaemonFixture>[] = [];
const daemons: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

test("startup marks persisted Sending rows and intents Uncertain without remote resend", async () => {
  const state = createDaemonFixture();
  fixtures.push(state);
  const database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
  migrateDatabase(database);
  database.run("INSERT INTO intents (id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)", ["i1", "send", JSON.stringify({ state: "Sending" }), 1]);
  database.run("INSERT INTO sends (id, intent_id, idempotency_key, state, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", ["s1", "i1", "key1", "Sending", "{}", 1]);
  database.close();
  let remoteResends = 0;
  const daemon = await createDaemon({
    socketPath: state.socketPath,
    databasePath: state.databasePath,
    keyProvider: state.keyProvider,
    resendPersistedSends: async () => { remoteResends++; },
  });
  daemons.push(daemon);
  const client = await connectJsonLines(state.socketPath);
  await client.request("system.hello", { role: "reader" });
  const status = await client.request("send.status", { id: "s1" });
  expect(status.state).toBe("Uncertain");
  expect(remoteResends).toBe(0);
  client.close();

  await daemon.stop();
  const recovered = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
  expect(JSON.parse((recovered.query("SELECT payload_json FROM intents WHERE id = 'i1'").get() as { payload_json: string }).payload_json)).toMatchObject({ state: "Uncertain" });
  recovered.close();
});

test("interrupted Slack fetch resumes only the committed provider position after database reopen", async () => {
  const state = createDaemonFixture();
  fixtures.push(state);
  const chat = { platform: "slack", account: "stable:account", chat_id: "stable:chat" };
  const interval = { from_ts: 10, to_ts: 90 };
  const requests: SlackPageRequest[] = [];
  let interrupted = true;
  const runner = async (request: SlackPageRequest) => {
    requests.push(request);
    if (request.provider_cursor && interrupted) throw new Error("private transport details");
    return { status: "ok" as const, account: chat.account, chat_id: chat.chat_id, self_id: "self", unread_count: 0,
      next_cursor: request.provider_cursor ? null : "page-2",
      events: (request.provider_cursor ? ["one", "two"] : ["one"]).map((id) => ({ channel_id: chat.chat_id, message_id: id, author_id: "self", ts: 20, body: id })) };
  };
  let database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
  try {
    migrateDatabase(database);
    const config = { allowedChats: [chat], now: () => 100, authenticatedRunner: runner };
    const backfill = createLocalSlackBackfill(database, config);
    const first = await backfill({ chat, interval });
    const checkpoint = readSyncState(database, chat)!.cursor;
    expect(first).not.toHaveProperty("cursor");
    await expect(backfill({ chat, interval })).rejects.toThrow("Slack transport read failed");
    expect(readSyncState(database, chat)?.cursor).toBe(checkpoint);
    database.close();
    database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    interrupted = false;
    const restarted = createLocalSlackBackfill(database, config);
    const last = await restarted({ chat, interval });
    expect(requests.map((request) => request.provider_cursor ?? null)).toEqual([null, "page-2", "page-2"]);
    expect(JSON.parse(readSyncState(database, chat)!.cursor).exhausted).toBe(true);
    expect(last).not.toHaveProperty("cursor");
    const recent = recentMessages(database, { chats: [chat], interval, sender: "self" });
    expect(recent.messages.map((message) => message.msg_id).sort()).toEqual(["one", "two"]);
    expect(recent.identities[0]?.status).toBe("known");
    expect(recent.unread[0]).toMatchObject({ count: 0, source: "platform" });
    await restarted({ chat, interval });
    expect(requests).toHaveLength(4);
    expect(requests[3]?.provider_cursor).toBeUndefined();
  } finally { database.close(); }
});

test.each(["page", "rate_limit"] as const)("failed Slack %s commit keeps the previous durable cursor for replay after reopen", async (mode) => {
  const state = createDaemonFixture();
  fixtures.push(state);
  const chat = { platform: "slack", account: "stable:account", chat_id: "stable:chat" };
  const interval = { from_ts: 10, to_ts: 90 };
  const positions: (string | undefined)[] = [];
  let failWithRateLimit = mode === "rate_limit";
  let now = 100;
  const config = { allowedChats: [chat], now: () => now, authenticatedRunner: async (request: SlackPageRequest) => {
    positions.push(request.provider_cursor);
    if (request.provider_cursor && failWithRateLimit) return { status: "rate_limited" as const, retry_after_ms: 50 };
    return { status: "ok" as const, account: chat.account, chat_id: chat.chat_id, self_id: request.provider_cursor ? "new-self" : "self", unread_count: request.provider_cursor ? 3 : null,
      next_cursor: request.provider_cursor ? null : "page-2",
      events: [{ channel_id: chat.chat_id, message_id: request.provider_cursor ? "two" : "one", author_id: "self", ts: 20, body: "text" }] };
  } };
  let database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
  try {
    migrateDatabase(database);
    const backfill = createLocalSlackBackfill(database, config);
    const first = await backfill({ chat, interval });
    const checkpoint = readSyncState(database, chat)!.cursor;
    const original = recentMessages(database, { chats: [chat], interval });
    const originalSync = readSyncState(database, chat);
    now = 101;
    database.run("CREATE TRIGGER reject_slack_cursor BEFORE INSERT ON sync_state BEGIN SELECT RAISE(ABORT, 'cursor commit interrupted'); END");
    await expect(backfill({ chat, interval })).rejects.toThrow("cursor commit interrupted");
    expect(readSyncState(database, chat)?.cursor).toBe(checkpoint);
    const before = recentMessages(database, { chats: [chat], interval });
    expect(before).toEqual(original);
    expect(readSyncState(database, chat)).toEqual(originalSync);
    expect(before.messages.map((message) => message.msg_id)).toEqual(["one"]);
    expect(before.coverage[0]?.limits.some((limit) => limit.reason === "rate_limit")).toBe(false);
    database.close();
    database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    expect(recentMessages(database, { chats: [chat], interval })).toEqual(original);
    expect(readSyncState(database, chat)).toEqual(originalSync);
    expect(readSyncState(database, chat)?.cursor).toBe(checkpoint);
    database.run("DROP TRIGGER reject_slack_cursor");
    failWithRateLimit = false;
    const result = await createLocalSlackBackfill(database, config)({ chat, interval });
    expect(positions).toEqual([undefined, "page-2", "page-2"]);
    expect(JSON.parse(readSyncState(database, chat)!.cursor).exhausted).toBe(true);
    expect(result).not.toHaveProperty("cursor");
    expect(recentMessages(database, { chats: [chat], interval }).messages.map((message) => message.msg_id).sort()).toEqual(["one", "two"]);
  } finally { database.close(); }
});

test("persisted Slack retry-after suppresses provider I/O after database reopen", async () => {
  const state = createDaemonFixture();
  fixtures.push(state);
  const chat = { platform: "slack", account: "stable:account", chat_id: "stable:chat" };
  const interval = { from_ts: 10, to_ts: 90 };
  let now = 100;
  let calls = 0;
  const config = { allowedChats: [chat], now: () => now, authenticatedRunner: async () => {
    calls++;
    if (calls > 1) return { status: "ok" as const, account: chat.account, chat_id: chat.chat_id, self_id: "self", unread_count: 0, events: [], next_cursor: null };
    return { status: "rate_limited" as const, retry_after_ms: 50 };
  } };
  let database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
  try {
    migrateDatabase(database);
    const first = await createLocalSlackBackfill(database, config)({ chat, interval });
    const checkpoint = readSyncState(database, chat)!.cursor;
    expect(first).toMatchObject({ retry_at: 100.05, page_status: "rate_limited", degraded: true, incomplete: true });
    expect(readSyncState(database, chat)?.cursor).toBe(checkpoint);
    database.close();
    database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    now = 100.049;
    const restarted = createLocalSlackBackfill(database, config);
    const paused = await restarted({ chat, interval });
    expect(paused).not.toHaveProperty("cursor");
    expect(readSyncState(database, chat)?.cursor).toBe(checkpoint);
    expect(calls).toBe(1);
    const evidence = recentMessages(database, { chats: [chat], interval });
    expect(evidence.coverage[0]?.limits.map((limit) => limit.reason)).toEqual(["rate_limit"]);
    expect(evidence.coverage[0]?.covered).toEqual([]);
    expect(evidence.unread[0]?.count).toBe(null);
    now = 100.05;
    const originalSync = readSyncState(database, chat);
    database.run("CREATE TRIGGER reject_resolution BEFORE UPDATE ON sync_limits WHEN NEW.resolved_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'resolution interrupted'); END");
    await expect(restarted({ chat, interval })).rejects.toThrow("resolution interrupted");
    expect(readSyncState(database, chat)).toEqual(originalSync);
    expect(recentMessages(database, { chats: [chat], interval })).toEqual(evidence);
    database.close();
    database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    expect(readSyncState(database, chat)).toEqual(originalSync);
    expect(recentMessages(database, { chats: [chat], interval })).toEqual(evidence);
    database.run("DROP TRIGGER reject_resolution");
    await createLocalSlackBackfill(database, config)({ chat, interval });
    expect(calls).toBe(3);
    const resolved = recentMessages(database, { chats: [chat], interval }).coverage[0]!.limits;
    expect(resolved.find((limit) => limit.reason === "rate_limit")).toEqual({ chat, interval, reason: "rate_limit", observed_at: 100, resolved_at: 100.05 });
    expect(resolved.find((limit) => limit.reason === "unsupported")).toBeDefined();
    database.close();
    database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    expect(recentMessages(database, { chats: [chat], interval }).coverage[0]!.limits).toEqual(resolved);
  } finally { database.close(); }
});



test("v2 encrypted stores migrate page sequences without changing existing evidence or cursors", async () => {
  const state = createDaemonFixture();
  fixtures.push(state);
  const chat = { platform: "slack", account: "stable:account", chat_id: "stable:chat" };
  const interval = { from_ts: 10, to_ts: 90 };
  const config = { allowedChats: [chat], now: () => 100, authenticatedRunner: async (request: SlackPageRequest) => ({
    status: "ok" as const, account: chat.account, chat_id: chat.chat_id,
    self_id: request.provider_cursor ? "new-self" : "self", unread_count: request.provider_cursor ? 2 : 1,
    next_cursor: request.provider_cursor ? null : "next", events: [],
  }) };
  let database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
  try {
    migrateDatabase(database);
    await createLocalSlackBackfill(database, config)({ chat, interval });
    const oldEvidence = recentMessages(database, { chats: [chat], interval });
    const oldCursor = readSyncState(database, chat)!.cursor;
    // v2 has all evidence tables but no committed-page sequence table.
    database.run("DROP TABLE sync_page_sequence");
    database.run("PRAGMA user_version = 2");
    database.close();
    database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    expect(migrateDatabase(database)).toBe(3);
    expect(migrateDatabase(database)).toBe(3);
    expect(recentMessages(database, { chats: [chat], interval })).toEqual(oldEvidence);
    expect(readSyncState(database, chat)).toEqual({ chat, cursor: oldCursor, updated_at: 100 });
    await createLocalSlackBackfill(database, config)({ chat, interval });
    expect(readSyncState(database, chat)).toMatchObject({ page_sequence: 1 });
    expect(recentMessages(database, { chats: [chat], interval }).identities[0]).toMatchObject({ self_id: "new-self", observed_at: 100 });
  } finally { database.close(); }
});

test("rolls back send recovery when the paired intent transition cannot commit", () => {
  const state = createDaemonFixture();
  fixtures.push(state);
  const database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
  migrateDatabase(database);
  database.run("INSERT INTO intents (id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)", ["i1", "send", JSON.stringify({ state: "Sending" }), 1]);
  database.run("INSERT INTO sends (id, intent_id, idempotency_key, state, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", ["s1", "i1", "key1", "Sending", "{}", 1]);
  database.run("CREATE TRIGGER reject_intent_recovery BEFORE UPDATE OF payload_json ON intents WHEN NEW.id = 'i1' BEGIN SELECT RAISE(ABORT, 'intent recovery rejected'); END");

  expect(() => recoverInterruptedSends(database)).toThrow("intent recovery rejected");
  expect(database.query("SELECT state FROM sends WHERE id = 's1'").get()).toEqual({ state: "Sending" });
  expect(JSON.parse((database.query("SELECT payload_json FROM intents WHERE id = 'i1'").get() as { payload_json: string }).payload_json)).toMatchObject({ state: "Sending" });
  database.close();
});
