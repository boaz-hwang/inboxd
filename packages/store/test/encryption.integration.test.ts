import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  SqlCipherBootstrapError,
  openSqlCipherDatabase,
} from "../src/sqlcipher";
import {
  createEncryptedFixture,
  keyProviderFor,
  type EncryptedFixture,
} from "./fixtures/encrypted-fixture";

const sqlCipherPath = process.env.SQLCIPHER_PATH;
const fixtures: EncryptedFixture[] = [];

function fixture(): EncryptedFixture {
  const value = createEncryptedFixture();
  fixtures.push(value);
  return value;
}

function scalar<T extends Record<string, unknown>>(value: T): unknown {
  return Object.values(value)[0];
}

function runPlainBunSqlite(path: string): { exitCode: number; stderr: string } {
  const script = `
    import { Database } from "bun:sqlite";
    try {
      const database = new Database(${JSON.stringify(path)});
      database.query("SELECT name FROM sqlite_master").all();
      database.close();
      process.exit(23);
    } catch (error) {
      process.stderr.write(String(error));
      process.exit(0);
    }
  `;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function runBootstrapInChild(
  path: string,
  sqlCipherPath?: string,
  nodeEnv = "test",
): number {
  const modulePath = new URL("../src/sqlcipher.ts", import.meta.url).pathname;
  const script = `
    import { openSqlCipherDatabase, SqlCipherBootstrapError } from ${JSON.stringify(modulePath)};
    try {
      openSqlCipherDatabase({
        filename: ${JSON.stringify(path)},
        keyProvider: { getKey: () => new Uint8Array([1]) },
      }).close();
      process.exit(29);
    } catch (error) {
      process.exit(error instanceof SqlCipherBootstrapError ? 0 : 31);
    }
  `;
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: nodeEnv };
  if (sqlCipherPath === undefined) delete env.SQLCIPHER_PATH;
  else env.SQLCIPHER_PATH = sqlCipherPath;
  return Bun.spawnSync({ cmd: [process.execPath, "--eval", script], env }).exitCode;
}

describe("SQLCipher encrypted store bootstrap", () => {
  beforeAll(() => {
    expect(sqlCipherPath).toBeString();
    expect(existsSync(sqlCipherPath!)).toBe(true);
  });

  afterAll(() => {
    for (const value of fixtures) value.dispose();
  });

  test("fails closed when SQLCIPHER_PATH is unset or invalid", () => {
    const value = fixture();
    expect(runBootstrapInChild(value.databasePath)).toBe(0);
    expect(runBootstrapInChild(value.databasePath, "/missing/libsqlcipher.dylib")).toBe(0);
  });

  test("ignores ambient SQLCIPHER_PATH and opens the fixed production SQLCipher pack", () => {
    const value = fixture();
    expect(runBootstrapInChild(value.databasePath, "/missing/attacker-controlled-sqlcipher.dylib", "production")).toBe(29);
  });

  test("permits an explicit SQLCIPHER_PATH override in a test child", () => {
    const value = fixture();
    expect(runBootstrapInChild(value.databasePath, sqlCipherPath)).toBe(29);
  });

  test("reports a non-empty SQLCipher version and uses WAL", () => {
    const value = fixture();
    const database = openSqlCipherDatabase({
      filename: value.databasePath,
      keyProvider: value.keyProvider,
    });

    const cipherVersion = scalar(
      database.query("PRAGMA cipher_version").get() as Record<string, unknown>,
    );
    const journalMode = scalar(
      database.query("PRAGMA journal_mode").get() as Record<string, unknown>,
    );

    expect(cipherVersion).toBeString();
    expect(cipherVersion).not.toBe("");
    expect(journalMode).toBe("wal");
    database.run("CREATE TABLE wal_probe (id INTEGER PRIMARY KEY)");
    expect(existsSync(`${value.databasePath}-wal`)).toBe(true);
    database.close();
  });

  test("reopens encrypted content and FTS with the correct ephemeral key", () => {
    const value = fixture();
    const created = openSqlCipherDatabase({
      filename: value.databasePath,
      keyProvider: value.keyProvider,
    });
    created.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    created.run("CREATE VIRTUAL TABLE messages_fts USING fts5(body)");
    created.run("INSERT INTO messages (body) VALUES (?)", ["classified test body"]);
    created.run("INSERT INTO messages_fts (body) VALUES (?)", ["classified test body"]);
    created.close();

    const reopened = openSqlCipherDatabase({
      filename: value.databasePath,
      keyProvider: value.keyProvider,
    });
    expect(reopened.query("SELECT body FROM messages").get()).toEqual({
      body: "classified test body",
    });
    expect(reopened.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all("classified")).toEqual([
      { rowid: 1 },
    ]);
    reopened.close();
  });

  test("rejects missing or wrong keys before callers can read schema", () => {
    const value = fixture();
    const created = openSqlCipherDatabase({
      filename: value.databasePath,
      keyProvider: value.keyProvider,
    });
    created.run("CREATE TABLE messages (id INTEGER PRIMARY KEY)");
    created.close();

    expect(() => openSqlCipherDatabase({
      filename: value.databasePath,
      keyProvider: undefined as never,
    })).toThrow(SqlCipherBootstrapError);
    expect(() => openSqlCipherDatabase({
      filename: value.databasePath,
      keyProvider: { getKey: () => new Uint8Array() },
    })).toThrow(SqlCipherBootstrapError);
    expect(() => openSqlCipherDatabase({
      filename: value.databasePath,
      keyProvider: keyProviderFor(crypto.getRandomValues(new Uint8Array(32))),
    })).toThrow(SqlCipherBootstrapError);
  });

  test("rejects a plaintext SQLite header without opening it", () => {
    const value = fixture();
    writeFileSync(value.databasePath, Buffer.concat([
      Buffer.from("SQLite format 3\u0000", "ascii"),
      Buffer.alloc(128),
    ]));

    expect(() => openSqlCipherDatabase({
      filename: value.databasePath,
      keyProvider: value.keyProvider,
    })).toThrow(SqlCipherBootstrapError);
  });

  test("ordinary Bun SQLite cannot read encrypted schema", () => {
    const value = fixture();
    const database = openSqlCipherDatabase({
      filename: value.databasePath,
      keyProvider: value.keyProvider,
    });
    database.run("CREATE TABLE messages (id INTEGER PRIMARY KEY)");
    database.close();

    expect(readFileSync(value.databasePath).subarray(0, 16).toString("ascii")).not.toBe("SQLite format 3\u0000");
    const plainBun = runPlainBunSqlite(value.databasePath);
    expect(plainBun.exitCode).toBe(0);
    expect(plainBun.stderr).not.toBe("");
  });
});
