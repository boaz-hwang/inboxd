import { afterEach, describe, expect, test } from "bun:test";

import { createDaemon } from "../src/main.ts";
import { createDaemonFixture, connectJsonLines } from "./fixtures/daemon-fixture.ts";

const fixtures: ReturnType<typeof createDaemonFixture>[] = [];
const daemons: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});
function fixture() { const value = createDaemonFixture(); fixtures.push(value); return value; }

describe("UDS JSON-lines API", () => {
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

  test("rejects unsupported mutations with a typed protocol error", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider });
    daemons.push(daemon);
    const client = await connectJsonLines(state.socketPath);
    await client.request("system.hello", { role: "reader" });
    await expect(client.request("sync.backfill")).rejects.toThrow("unsupported");
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
