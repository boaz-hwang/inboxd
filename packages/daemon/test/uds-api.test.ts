import { afterEach, describe, expect, test } from "bun:test";

import { createDaemon, readLocalApproverToken } from "../src/main.ts";
import { createDaemonFixture, connectJsonLines } from "./fixtures/daemon-fixture.ts";
import { openSqlCipherDatabase } from "../../store/src/sqlcipher.ts";

const fixtures: ReturnType<typeof createDaemonFixture>[] = [];
const daemons: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function fixture() { const value = createDaemonFixture(); fixtures.push(value); return value; }

describe("UDS JSON-lines API", () => {
  test("denies backfill before adapter invocation unless independently authorized as owner", async () => {
    const state = fixture();
    let calls = 0;
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider,
      isTrustedApproverSession: session => session.approverToken === "test-owner",
      backfill: async () => { calls++; return { accepted: true }; },
    });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    const request = { platform: "test", account: "one", chat_id: "room", from_ts: 0, to_ts: 20 };
    try {
      for (const role of ["reader", "agent", "mcp", "approver"]) {
        await client.request("system.hello", { role });
        await expect(client.request("sync.backfill", request)).rejects.toThrow(/approver/i);
        expect(calls).toBe(0);
      }
      await client.request("system.hello", { role: "approver", approver_token: "test-owner" });
      expect(await client.request("sync.backfill", request)).toEqual({ accepted: true });
      expect(calls).toBe(1);
    } finally { client.close(); }
  });
  test("aggregate UDS rejects invalid scope and mismatched opaque cursors as BAD_REQUEST", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider });
    daemons.push(daemon);
    const chat = { platform: "test", account: "one", chat_id: "room" };
    const interval = { from_ts: 0, to_ts: 100 };
    daemon.apply({ events: ["a", "b"].map(msg_id => ({ kind: "create", message: { key: { ...chat, msg_id }, author_id: "a", ts: 10, body: "synthetic", attachments: [] }, revision: { source: "adapter", value: 1 } })) });
    const client = await connectJsonLines(state.socketPath);
    try {
      await client.request("system.hello", { role: "agent" });
      for (const method of ["message.recent", "message.evidence"]) {
        const input = { chats: [chat], interval, limit: 1 };
        const first = await client.request(method, input);
        expect(first.next_cursor).toEqual(expect.any(String));
        for (const params of [{}, { chats: [chat] }, { ...input, chats: [] }, { ...input, identities: [] }, { ...input, unread: [] }, { ...input, limit: 101 }]) {
          await expect(client.request(method, params)).rejects.toMatchObject({ code: "BAD_REQUEST" });
        }
        for (const params of [
          { ...input, cursor: "garbage" },
          { ...input, cursor: first.next_cursor, interval: { from_ts: 1, to_ts: 100 } },
          { ...input, cursor: first.next_cursor, chats: [{ ...chat, account: "other" }] },
          { ...input, cursor: first.next_cursor, sender: "self" },
        ]) await expect(client.request(method, params)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      for (const method of ["store.recordAccountIdentity", "store.recordUnreadState"]) {
        await expect(client.request(method, {})).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(await client.request("message.inbox", { chat })).toMatchObject({ messages: [{ msg_id: "a" }, { msg_id: "b" }] });
    } finally { client.close(); }
  });
  test("serves inbox, search, and status without exposing database ownership", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider });
    daemons.push(daemon);
    const chat = { platform: "test", account: "one", chat_id: "room" };
    daemon.apply({ events: [{
      kind: "create", message: { key: { ...chat, msg_id: "m1" }, author_id: "a", ts: 10, body: "find me", attachments: [] }, revision: { source: "adapter", value: 1 },
    }] });
    const client = await connectJsonLines(state.socketPath);
    const hello = await client.request("system.hello", { role: "reader" });
    const inbox = await client.request("message.inbox", { chat });
    const search = await client.request("message.search", { chat, interval: { from_ts: 0, to_ts: 20 }, query: "find" });
    const status = await client.request("system.status");
    const serialized = JSON.stringify({ hello, inbox, search, status });
    expect((inbox.messages as unknown[])).toHaveLength(1);
    expect((search.messages as unknown[])).toHaveLength(1);
    expect(status.ready).toBe(true);
    expect(serialized).not.toContain(state.databasePath);
    expect(serialized).not.toContain("database");
    client.close();
  });

  test("returns chat messages with interval coverage evidence", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider });
    daemons.push(daemon);
    const chat = { platform: "test", account: "one", chat_id: "room" };
    daemon.apply({
      events: [{ kind: "create", message: { key: { ...chat, msg_id: "m1" }, author_id: "a", ts: 10, body: "covered", attachments: [] }, revision: { source: "adapter", value: 1 } }],
      coverage: [{ chat, interval: { from_ts: 0, to_ts: 20 }, kind: "backfill", collected_at: 20, mutations_verified_at: 20 }],
    });
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "reader" });

    const inbox = await client.request("message.inbox", { chat, interval: { from_ts: 0, to_ts: 20 } });

    expect((inbox.messages as { msg_id: string }[]).map((message) => message.msg_id)).toEqual(["m1"]);
    expect(inbox.coverage).toMatchObject({
      target: { chat, interval: { from_ts: 0, to_ts: 20 } },
      gaps: [],
      covered: [{ interval: { from_ts: 0, to_ts: 20 }, kind: "backfill" }],
    });
    client.close();
  });

  test("forwards bounded cursor pagination for inbox and search", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider });
    daemons.push(daemon);
    const chat = { platform: "test", account: "one", chat_id: "room" };
    daemon.apply({ events: [
      { kind: "create", message: { key: { ...chat, msg_id: "a" }, author_id: "a", ts: 10, body: "needle first", attachments: [] }, revision: { source: "adapter", value: 1 } },
      { kind: "create", message: { key: { ...chat, msg_id: "b" }, author_id: "a", ts: 10, body: "needle second", attachments: [] }, revision: { source: "adapter", value: 1 } },
      { kind: "create", message: { key: { ...chat, msg_id: "c" }, author_id: "a", ts: 11, body: "needle third", attachments: [] }, revision: { source: "adapter", value: 1 } },
    ] });
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "reader" });

    const firstInbox = await client.request("message.inbox", { chat, interval: { from_ts: 0, to_ts: 20 }, limit: 2 });
    expect((firstInbox.messages as { msg_id: string }[]).map((message) => message.msg_id)).toEqual(["a", "b"]);
    const nextCursor = firstInbox.next_cursor as string;
    expect(nextCursor).toEqual(expect.any(String));
    const secondInbox = await client.request("message.inbox", { chat, interval: { from_ts: 0, to_ts: 20 }, limit: 2, cursor: nextCursor });
    expect((secondInbox.messages as { msg_id: string }[]).map((message) => message.msg_id)).toEqual(["c"]);

    const firstSearch = await client.request("message.search", { chat, interval: { from_ts: 0, to_ts: 20 }, query: "needle", limit: 2 });
    expect((firstSearch.messages as { msg_id: string }[]).map((message) => message.msg_id)).toEqual(["a", "b"]);
    expect(firstSearch.next_cursor).toEqual(expect.any(String));
    client.close();
  });

  test("runs only an explicitly configured scoped backfill and audits reads without content", async () => {
    const state = fixture();
    const calls: unknown[] = [];
    const daemon = await createDaemon({
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: state.keyProvider,
      backfill: async (request) => { calls.push(request); return { accepted: true, authoritative: false }; },
    });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(state.socketPath) });
    const chat = { platform: "test", account: "one", chat_id: "room" };
    await client.request("message.inbox", { chat, interval: { from_ts: 0, to_ts: 20 } });
    const accepted = await client.request("sync.backfill", { ...chat, from_ts: 0, to_ts: 20 });
    expect(accepted).toEqual({ accepted: true, authoritative: false });
    expect(calls).toEqual([{ chat, interval: { from_ts: 0, to_ts: 20 } }]);
    client.close();
    await daemon.stop();
    const db = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    const audit = db.query("SELECT action, subject, payload_json FROM audit WHERE action = 'read.inbox'").get() as { action: string; subject: string; payload_json: string };
    expect(audit.subject).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.payload_json).not.toContain("room");
    expect(audit.payload_json).not.toContain("body");
    db.close();
  });

  test("rejects backfill when no adapter is configured", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "approver", approver_token: readLocalApproverToken(state.socketPath) });
    await expect(client.request("sync.backfill", { platform: "test", account: "one", chat_id: "room", from_ts: 0, to_ts: 20 })).rejects.toThrow("no adapter");
    client.close();
  });

  test("emits change events only after their database transaction commits", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider });
    daemons.push(daemon);
    const chat = { platform: "test", account: "one", chat_id: "room" };
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "reader" });
    await client.request("subscribe", { topics: ["message.upserted"] });
    daemon.apply({ events: [{
      kind: "create", message: { key: { ...chat, msg_id: "m1" }, author_id: "a", ts: 10, body: "committed", attachments: [] }, revision: { source: "adapter", value: 1 },
    }] });
    const event = await client.nextFrame();
    expect(event.type).toBe("event");
    expect(event.method).toBe("message.upserted");
    const inbox = await client.request("message.inbox", { chat });
    expect((inbox.messages as unknown[])).toHaveLength(1);
    client.close();
  });

  test("closes an overflowing subscription and requires the client to re-query", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider, maxQueuedEvents: 1 });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "reader" });
    await client.request("subscribe", { topics: ["message.upserted"] });
    daemon.publish({ type: "event", method: "message.upserted", params: { sequence: 1 } });
    daemon.publish({ type: "event", method: "message.upserted", params: { sequence: 2 } });
    await client.closed;
  });
});
