import { afterEach, describe, expect, test } from "bun:test";

import { migrateDatabase, schemaVersion } from "../src/migrations.ts";
import { openSqlCipherDatabase } from "../src/sqlcipher.ts";
import { createEncryptedFixture, type EncryptedFixture } from "./fixtures/encrypted-fixture.ts";

describe("store migrations", () => {
  const fixtures: EncryptedFixture[] = [];
  afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.dispose()));

  test("creates all encrypted store tables and is idempotent", () => {
    const fixture = createEncryptedFixture();
    fixtures.push(fixture);
    const database = openSqlCipherDatabase({ filename: fixture.databasePath, keyProvider: fixture.keyProvider });

    expect(migrateDatabase(database)).toBe(schemaVersion);
    expect(migrateDatabase(database)).toBe(schemaVersion);
    const names = database.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all() as { name: string }[];

    expect(names.map((row) => row.name)).toEqual(expect.arrayContaining([
      "messages", "messages_fts", "chats", "identities", "read_cursors", "sync_state",
      "sync_coverage", "sync_limits", "intents", "approvals", "sends", "quota", "audit",
    ]));
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: schemaVersion });
    database.close();
  });
});
