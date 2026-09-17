import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createLocalSlackBackfill } from "../src/local-slack.ts";
import { createLocalKakaoBackfill } from "../src/local-kakao.ts";
import { migrateDatabase, openSqlCipherDatabase } from "../../store/src/index.ts";
import { recentMessages } from "../../store/src/queries.ts";
import { readSyncState } from "../../store/src/apply.ts";
import { createDaemon, readLocalApproverToken } from "../src/main.ts";
import { createDaemonFixture, connectJsonLines } from "./fixtures/daemon-fixture.ts";



test("UDS backfill never exposes secret provider or durable continuations in any page status", async () => {
  const fixture = createDaemonFixture();
  const secret = "secret-provider-token-never-on-uds";
  let now = 100;
  let calls = 0;
  const daemon = await createDaemon({ socketPath: fixture.socketPath, databasePath: fixture.databasePath, keyProvider: fixture.keyProvider,
    localSlack: { allowedChats: [chat], now: () => now, authenticatedRunner: async (request) => {
      calls++;
      if (calls === 1) return { ...page(0), next_cursor: secret };
      expect(request.provider_cursor).toBe(calls < 4 ? secret : undefined);
      if (calls === 2) return { status: "rate_limited", retry_after_ms: 50 };
      return page(0);
    } },
  });
  try {
    const client = await connectJsonLines(fixture.socketPath);
    try {
      await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(fixture.socketPath) });
      for (const [time, status] of [[100, "more"], [100, "rate_limited"], [100.049, "rate_limited"], [100.05, "exhausted"], [101, "exhausted"]] as const) {
        now = time;
        const result = await client.request("sync.backfill", { ...chat, ...interval });
        expect(result.page_status).toBe(status);
        expect(result).not.toHaveProperty("cursor");
        const serialized = JSON.stringify(result);
        for (const forbidden of [secret, "provider_cursor", "next_cursor", "upper_bound_ts"]) expect(serialized).not.toContain(forbidden);
      }
      expect(calls).toBe(4);
    } finally { client.close(); }
  } finally { await daemon.stop(); fixture.dispose(); }
});



test("same-timestamp Slack pages refresh trusted metadata in committed page order", async () => {
  const database = setup();
  let calls = 0;
  const backfill = createLocalSlackBackfill(database, { allowedChats: [chat], now: () => 100,
    authenticatedRunner: async () => {
      calls++;
      return { ...page(calls), self_id: `self-${calls}`, next_cursor: calls === 1 ? "next" : null };
    },
  });
  await backfill({ chat, interval });
  await backfill({ chat, interval });
  const result = recentMessages(database, { chats: [chat], interval });
  expect(result.identities[0]).toMatchObject({ self_id: "self-2", observed_at: 100 });
  expect(result.unread[0]).toMatchObject({ count: 2, observed_at: 100 });
});



test("a later rate limit reopens resolved evidence until its own successful retry", async () => {
  const database = setup();
  let now = 100;
  let calls = 0;
  const backfill = createLocalSlackBackfill(database, { allowedChats: [chat], now: () => now,
    authenticatedRunner: async () => {
      calls++;
      if (calls === 1 || calls === 3) return { status: "rate_limited", retry_after_ms: 50 };
      return { ...page(0), next_cursor: calls === 2 ? "next" : null };
    },
  });
  const limit = () => recentMessages(database, { chats: [chat], interval }).coverage[0]!.limits.find((entry) => entry.reason === "rate_limit")!;
  await backfill({ chat, interval });
  expect(limit().resolved_at).toBeUndefined();
  now = 100.05;
  await backfill({ chat, interval });
  expect(limit().resolved_at).toBe(now);
  await backfill({ chat, interval });
  expect(limit().resolved_at).toBeUndefined();
  now = 100.1;
  await backfill({ chat, interval });
  expect(limit()).toMatchObject({ observed_at: 100, resolved_at: now });
});



test("independent Slack workers cannot overwrite a newer committed page with a stale fetch", async () => {
  const database = setup();
  const options = { allowedChats: [chat], now: () => 100 };
  await createLocalSlackBackfill(database, { ...options, authenticatedRunner: async () => ({ ...page(0), next_cursor: "next" }) })({ chat, interval });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const slow = createLocalSlackBackfill(database, { ...options, authenticatedRunner: async () => {
    started(); await gate; return { ...page(9), self_id: "stale-self" };
  } })({ chat, interval });
  try {
    await ready;
    await createLocalSlackBackfill(database, { ...options, authenticatedRunner: async () => ({ ...page(2), self_id: "new-self" }) })({ chat, interval });
  } finally { release(); }
  await expect(slow).rejects.toThrow("Stale sync page");
  const evidence = recentMessages(database, { chats: [chat], interval });
  expect(evidence.identities[0]).toMatchObject({ self_id: "new-self", observed_at: 100 });
  expect(evidence.unread[0]).toMatchObject({ count: 2, observed_at: 100 });
  expect(readSyncState(database, chat)).toMatchObject({ page_sequence: 2 });
});

test("restarted daemon diagnostics retain authenticated ingestion and durable cooldown without provider I/O", async () => {
  const fixture = createDaemonFixture();
  let calls = 0;
  const config = { socketPath: fixture.socketPath, databasePath: fixture.databasePath, keyProvider: fixture.keyProvider,
    localSlack: { allowedChats: [chat], now: () => 100, authenticatedRunner: async () => {
      calls++;
      return calls === 1 ? { ...page(0), next_cursor: "private-next" } : { status: "rate_limited" as const, retry_after_ms: 1000 };
    } },
  };
  let daemon = await createDaemon(config);
  let client = await connectJsonLines(fixture.socketPath);
  try {
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(fixture.socketPath) });
    await client.request("sync.backfill", { ...chat, ...interval });
    await client.request("sync.backfill", { ...chat, ...interval });
    client.close(); await daemon.stop();
    daemon = await createDaemon(config);
    client = await connectJsonLines(fixture.socketPath);
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(fixture.socketPath) });
    const status = await client.request("system.status");
    expect(status).toMatchObject({ auth: { slack: "authenticated" }, sync: { slack: { state: "cooldown", retry_at: 101 } } });
    expect(JSON.stringify(status)).not.toContain("private-next");
    expect(calls).toBe(2);
  } finally { client.close(); await daemon.stop(); fixture.dispose(); }
});

test("UDS diagnostics track authenticated ingestion, running, cooldown, failure and recovery", async () => {
  const fixture = createDaemonFixture();
  let now = 100;
  let mode: "ok" | "rate" | "fail" | "wait" = "wait";
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const daemon = await createDaemon({ socketPath: fixture.socketPath, databasePath: fixture.databasePath, keyProvider: fixture.keyProvider,
    localSlack: { allowedChats: [chat], now: () => now, authenticatedRunner: async () => {
      if (mode === "wait") { started(); await gate; }
      if (mode === "rate") return { status: "rate_limited", retry_after_ms: 1000 };
      if (mode === "fail") throw new Error("provider-private-error");
      return page(0);
    } },
  });
  const client = await connectJsonLines(fixture.socketPath);
  const observer = await connectJsonLines(fixture.socketPath);
  try {
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(fixture.socketPath) });
    await observer.request("system.hello", { role: "reader" });
    expect(await observer.request("system.status")).toMatchObject({ auth: { slack: "unknown" }, sync: { slack: { state: "idle" } } });
    const pending = client.request("sync.backfill", { ...chat, ...interval });
    try {
      await ready;
      expect(await observer.request("sync.status")).toMatchObject({ state: "running", platforms: { slack: { state: "running" } } });
      expect(await observer.request("system.status")).toMatchObject({ sync: { slack: { state: "running" } } });
    } finally { release(); await pending; }
    expect(await observer.request("auth.status")).toMatchObject({ authenticated: true, platforms: { slack: "authenticated" } });
    expect(await observer.request("system.status")).toMatchObject({ auth: { slack: "authenticated" }, sync: { slack: { state: "success" } } });
    await expect(client.request("sync.backfill", { ...chat, chat_id: "stable:not-allowed", ...interval })).rejects.toThrow("allowlist");
    expect(await observer.request("system.status")).toMatchObject({ auth: { slack: "authenticated" }, sync: { slack: { state: "success" } } });
    mode = "rate";
    await client.request("sync.backfill", { ...chat, ...interval });
    expect(await observer.request("sync.status")).toMatchObject({ state: "cooldown", platforms: { slack: { state: "cooldown", retry_at: 101 } } });
    now = 101;
    expect(await observer.request("sync.status")).toMatchObject({ state: "retry_due", platforms: { slack: { state: "retry_due" } } });
    mode = "fail";
    await expect(client.request("sync.backfill", { ...chat, ...interval })).rejects.toThrow("read failed");
    const failed = await observer.request("system.status");
    expect(failed).toMatchObject({ auth: { slack: "unknown" }, sync: { slack: { state: "failed" } } });
    expect(JSON.stringify(failed)).not.toContain("provider-private-error");
    mode = "ok";
    await client.request("sync.backfill", { ...chat, ...interval });
    expect(await observer.request("auth.status")).toMatchObject({ authenticated: true });
    expect(await observer.request("sync.status")).toMatchObject({ state: "success" });
  } finally { release(); client.close(); observer.close(); await daemon.stop(); fixture.dispose(); }
});

test("a disjoint Slack job cannot bypass cooldown and resolves its blocked interval only after success", async () => {
  const database = setup();
  let now = 200;
  let calls = 0;
  const later = { from_ts: 110, to_ts: 190 };
  const options = { allowedChats: [chat], now: () => now, authenticatedRunner: async (request: import("../../../platforms/slack/src/index.ts").SlackPageRequest) => {
    calls++;
    if (calls === 1) return { status: "rate_limited" as const, retry_after_ms: 1000 };
    expect(request.provider_cursor).toBeUndefined();
    expect(request.interval).toEqual(later);
    return page(0);
  } };
  await createLocalSlackBackfill(database, options)({ chat, interval });
  const blocked = await createLocalSlackBackfill(database, options)({ chat, interval: later });
  expect(blocked).toMatchObject({ page_status: "rate_limited", retry_at: 201 });
  expect(calls).toBe(1);
  now = 201;
  await createLocalSlackBackfill(database, options)({ chat, interval: later });
  expect(calls).toBe(2);
  expect(recentMessages(database, { chats: [chat], interval: later }).coverage[0]?.limits.find((limit) => limit.reason === "rate_limit")?.resolved_at).toBe(201);
});

test("durable Slack jobs accept disjoint intervals and restart completed bounded jobs", async () => {
  const database = setup();
  const requests: { interval: { from_ts: number; to_ts: number }; provider_cursor?: string }[] = [];
  const options = { allowedChats: [chat], now: () => 200, authenticatedRunner: async (request: import("../../../platforms/slack/src/index.ts").SlackPageRequest) => {
    requests.push(request);
    return { ...page(0), next_cursor: requests.length === 1 ? "old-job-page" : null };
  } };
  await createLocalSlackBackfill(database, options)({ chat, interval });
  const later = { from_ts: 110, to_ts: 190 };
  await createLocalSlackBackfill(database, options)({ chat, interval: later });
  await createLocalSlackBackfill(database, options)({ chat, interval: later });
  expect(requests.map((request) => [request.interval, request.provider_cursor])).toEqual([[interval, undefined], [later, undefined], [later, undefined]]);
  expect(readSyncState(database, chat)?.page_sequence).toBe(3);
});

const resources: { fixture: ReturnType<typeof createDaemonFixture>; database: Database }[] = [];
afterEach(() => { for (const { fixture, database } of resources.splice(0)) { database.close(); fixture.dispose(); } });
function setup() {
  const fixture = createDaemonFixture();
  const database = openSqlCipherDatabase({ filename: fixture.databasePath, keyProvider: fixture.keyProvider });
  migrateDatabase(database);
  resources.push({ fixture, database });
  return database;
}
const chat = { platform: "slack", account: "stable:account", chat_id: "stable:chat" };
const interval = { from_ts: 10, to_ts: 90 };
const page = (unread_count: number | null) => ({
  status: "ok" as const, account: chat.account, chat_id: chat.chat_id,
  self_id: "actual-self", unread_count, next_cursor: null,
  events: [{ channel_id: chat.chat_id, message_id: "mine", author_id: "actual-self", ts: 20, body: "mine" },
    { channel_id: chat.chat_id, message_id: "theirs", author_id: "not-self", ts: 21, body: "theirs" }],
});

test("trusted Slack ingestion persists authenticated self identity and platform zero, not inferred authors", async () => {
  const database = setup();
  const backfill = createLocalSlackBackfill(database, { allowedChats: [chat], now: () => 100, authenticatedRunner: async () => page(0) });
  const result = await backfill({ chat, interval });
  const recent = recentMessages(database, { chats: [chat], interval, sender: "self" });
  expect(recent.identities).toEqual([{ platform: "slack", account: chat.account, status: "known", source: "authenticated_adapter", self_id: "actual-self", observed_at: 100 }]);
  expect(recent.messages.map((message) => message.msg_id)).toEqual(["mine"]);
  expect(recent.unread).toEqual([{ chat, status: "known", source: "platform", count: 0, observed_at: 100 }]);
  expect(result).toMatchObject({ authoritative: false, degraded: true, incomplete: true, page_status: "exhausted" });
  expect(JSON.parse(readSyncState(database, chat)!.cursor).exhausted).toBe(true);
  expect(result).not.toHaveProperty("cursor");
});

test.each([
  ["wrong authenticated account", { account: "stable:other" }],
  ["wrong authenticated chat", { chat_id: "stable:other" }],
  ["missing authenticated self", { self_id: "" }],
  ["invalid unread", { unread_count: -1 }],
  ["malformed message", { events: [{ channel_id: chat.chat_id, ts: 20 }] }],
  ["empty continuation", { next_cursor: "" }],
  ["oversized continuation", { next_cursor: "a".repeat(4097) }],
])("rejects %s without persisting identity, unread, messages or cursor", async (_label, invalid) => {
  const database = setup();
  const backfill = createLocalSlackBackfill(database, { allowedChats: [chat], now: () => 100, authenticatedRunner: async () => ({ ...page(0), ...invalid }) });
  await expect(backfill({ chat, interval })).rejects.toThrow();
  const evidence = recentMessages(database, { chats: [chat], interval });
  expect(evidence.messages).toEqual([]);
  expect(evidence.identities[0]?.status).toBe("unknown");
  expect(evidence.unread[0]?.count).toBe(null);
  expect(readSyncState(database, chat)).toBe(null);
});

test("Kakao persists unsupported identity/unread explicitly without promoting author IDs to self", async () => {
  const database = setup();
  const kakao = { ...chat, platform: "kakao" };
  const backfill = createLocalKakaoBackfill(database, {
    allowedChats: [kakao], now: () => 100, max_measurement_age: 10,
    measurement: { schema_version: "kakao-contrib-read-measurement/v1", kind: "kakao-read-field-measurement", status: "VALIDATED", observation: "observed", source: "authorized-live-measurement", observed_at: 100, send: false, supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body"] },
    reader: async () => [{ account_id: kakao.account, chat_id: kakao.chat_id, message_id: "k1", author_id: kakao.account, ts: 20, body: "not identity proof" }],
  });
  await backfill({ chat: kakao, interval });
  const recent = recentMessages(database, { chats: [kakao], interval, sender: "self" });
  expect(recent.identities).toEqual([{ platform: "kakao", account: kakao.account, status: "unknown", source: "unknown", reason: "unsupported", observed_at: 100 }]);
  expect(recent.unread).toEqual([{ chat: kakao, status: "unknown", source: "unknown", count: null, reason: "unsupported", observed_at: 100 }]);
  expect(recent.messages).toEqual([]);
  expect(readSyncState(database, kakao)).toBe(null);
});

test("concurrent Slack backfills serialize reading and committing each durable continuation", async () => {
  const database = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cursors: (string | undefined)[] = [];
  const backfill = createLocalSlackBackfill(database, { allowedChats: [chat], now: () => 100,
    authenticatedRunner: async (request) => {
      cursors.push(request.provider_cursor);
      await gate;
      return { ...page(0), next_cursor: request.provider_cursor ? null : "page-2" };
    },
  });
  const first = backfill({ chat, interval });
  const second = backfill({ chat, interval });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cursors).toEqual([undefined]);
  } finally { release(); await Promise.allSettled([first, second]); }
  const results = await Promise.all([first, second]);
  expect(cursors).toEqual([undefined, "page-2"]);
  expect(JSON.parse(readSyncState(database, chat)!.cursor).exhausted).toBe(true);
  expect(results.every((result) => !("cursor" in result))).toBe(true);
  expect(recentMessages(database, { chats: [chat], interval }).messages).toHaveLength(2);
});

test("local daemon UDS exposes trusted Slack self/unread evidence and degraded cursor results", async () => {
  const fixture = createDaemonFixture();
  const daemon = await createDaemon({ socketPath: fixture.socketPath, databasePath: fixture.databasePath, keyProvider: fixture.keyProvider,
    localSlack: { allowedChats: [chat], now: () => 100, authenticatedRunner: async () => page(2) },
  });
  try {
    const client = await connectJsonLines(fixture.socketPath);
    try {
      await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(fixture.socketPath) });
      const result = await client.request("sync.backfill", { ...chat, ...interval });
      expect(result).toMatchObject({ event_count: 2, authoritative: false, degraded: true, incomplete: true, page_status: "exhausted" });
      const evidence = await client.request("message.recent", { chats: [chat], interval, sender: "self" });
      expect(evidence.messages).toMatchObject([{ msg_id: "mine" }]);
      expect(evidence.identities).toMatchObject([{ self_id: "actual-self", source: "authenticated_adapter" }]);
      expect(evidence.unread).toMatchObject([{ count: 2, source: "platform" }]);
    } finally { client.close(); }
  } finally { await daemon.stop(); fixture.dispose(); }
});

test("missing provider unread is persisted as unknown rather than platform zero", async () => {
  const database = setup();
  const backfill = createLocalSlackBackfill(database, { allowedChats: [chat], now: () => 100, authenticatedRunner: async () => page(null) });
  await backfill({ chat, interval });
  expect(recentMessages(database, { chats: [chat], interval }).unread).toEqual([
    { chat, status: "unknown", source: "unknown", count: null, reason: "unavailable", observed_at: 100 },
  ]);
});
