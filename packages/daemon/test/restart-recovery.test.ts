import { afterEach, describe, expect, test } from "bun:test";

import { createDaemon } from "../src/main.ts";
import { migrateDatabase, openSqlCipherDatabase } from "../../store/src/index.ts";
import { createDaemonFixture, connectJsonLines } from "./fixtures/daemon-fixture.ts";

const fixtures: ReturnType<typeof createDaemonFixture>[] = [];
const daemons: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

test("startup marks persisted Sending rows Uncertain without remote resend", async () => {
  const state = createDaemonFixture();
  fixtures.push(state);
  const database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
  migrateDatabase(database);
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
});
