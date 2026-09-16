import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqlCipherBootstrapError, openSqlCipherDatabase } from "../../packages/store/src/sqlcipher";

const manifestPath = new URL("./manifest.json", import.meta.url).pathname;
const directory = mkdtempSync(join(tmpdir(), "inboxd-sqlcipher-spike-"));
const databasePath = join(directory, "messages.db");
const key = crypto.getRandomValues(new Uint8Array(32));
const keyProvider = { getKey: () => key.slice() };

const outcomes = {
  correctKeyReopenWithFts: false,
  missingKeyRejected: false,
  wrongKeyRejected: false,
  ordinaryBunSqliteRejected: false,
  walPathObserved: false,
  plaintextHeaderRejected: false,
  unsetSqlCipherPathRejected: false,
  invalidSqlCipherPathRejected: false,
};

function firstValue(row: Record<string, unknown> | null): unknown {
  return row ? Object.values(row)[0] : undefined;
}

function childBootstrap(sqlCipherPath?: string): number {
  const modulePath = new URL("../../packages/store/src/sqlcipher.ts", import.meta.url).pathname;
  const script = `
    import { openSqlCipherDatabase, SqlCipherBootstrapError } from ${JSON.stringify(modulePath)};
    try {
      openSqlCipherDatabase({
        filename: ${JSON.stringify(join(directory, "child.db"))},
        keyProvider: { getKey: () => new Uint8Array([1]) },
      }).close();
      process.exit(23);
    } catch (error) {
      process.exit(error instanceof SqlCipherBootstrapError ? 0 : 31);
    }
  `;
  const env = { ...process.env };
  if (sqlCipherPath === undefined) delete env.SQLCIPHER_PATH;
  else env.SQLCIPHER_PATH = sqlCipherPath;
  return Bun.spawnSync({ cmd: [process.execPath, "--eval", script], env }).exitCode;
}

function ordinaryBunCanNotReadSchema(): boolean {
  const script = `
    import { Database } from "bun:sqlite";
    try {
      const database = new Database(${JSON.stringify(databasePath)});
      database.query("SELECT name FROM sqlite_master").all();
      database.close();
      process.exit(23);
    } catch {
      process.exit(0);
    }
  `;
  return Bun.spawnSync({ cmd: [process.execPath, "--eval", script] }).exitCode === 0;
}

function rejected(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch (error) {
    return error instanceof SqlCipherBootstrapError;
  }
}

try {
  const database = openSqlCipherDatabase({ filename: databasePath, keyProvider });
  const version = firstValue(database.query("PRAGMA cipher_version").get() as Record<string, unknown>);
  if (typeof version !== "string" || version.length === 0) throw new Error("missing SQLCipher version");

  database.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  database.run("CREATE VIRTUAL TABLE messages_fts USING fts5(body)");
  database.run("INSERT INTO messages (body) VALUES (?)", ["spike probe"]);
  database.run("INSERT INTO messages_fts (body) VALUES (?)", ["spike probe"]);
  outcomes.walPathObserved = existsSync(`${databasePath}-wal`);
  database.close();

  const reopened = openSqlCipherDatabase({ filename: databasePath, keyProvider });
  const hasBody = reopened.query("SELECT body FROM messages").get() !== null;
  const hasFts = reopened.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").get("spike") !== null;
  reopened.close();
  outcomes.correctKeyReopenWithFts = hasBody && hasFts;

  outcomes.missingKeyRejected = rejected(() => openSqlCipherDatabase({
    filename: databasePath,
    keyProvider: undefined as never,
  }));
  outcomes.wrongKeyRejected = rejected(() => openSqlCipherDatabase({
    filename: databasePath,
    keyProvider: { getKey: () => crypto.getRandomValues(new Uint8Array(32)) },
  }));
  outcomes.ordinaryBunSqliteRejected = ordinaryBunCanNotReadSchema();

  const plainPath = join(directory, "plain.db");
  writeFileSync(plainPath, Buffer.concat([Buffer.from("SQLite format 3\u0000", "ascii"), Buffer.alloc(128)]));
  outcomes.plaintextHeaderRejected = rejected(() => openSqlCipherDatabase({ filename: plainPath, keyProvider }));
  outcomes.unsetSqlCipherPathRejected = childBootstrap() === 0;
  outcomes.invalidSqlCipherPathRejected = childBootstrap("/missing/libsqlcipher.dylib") === 0;

  if (!Object.values(outcomes).every(Boolean)) throw new Error("one or more SQLCipher checks failed");
  writeFileSync(manifestPath, `${JSON.stringify({
    spike: "0-encryption",
    observedAt: new Date().toISOString(),
    sqlCipherVersion: version,
    outcomes,
  }, null, 2)}\n`);
} finally {
  rmSync(directory, { force: true, recursive: true });
}
