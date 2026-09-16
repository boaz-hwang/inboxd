import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

const SQLITE_HEADER = "SQLite format 3\0";

/**
 * The only production SQLCipher binary accepted by the macOS arm64 build.
 *
 * Use the versioned Cellar path, not Homebrew's mutable `opt` symlink, then
 * pin the binary digest so a replacement at that path fails before SQLite can
 * open a database. Update this record only when intentionally shipping and
 * reviewing a new SQLCipher pack.
 */
const PRODUCTION_SQLCIPHER_PACK = {
  platform: "darwin",
  arch: "arm64",
  libraryPath: "/opt/homebrew/Cellar/sqlcipher/4.19.0/lib/libsqlcipher.3.53.4.dylib",
  sha256: "275d151f5f8d82fd0f61d0eed024068c8d504830f805e56386fe714437b56801",
} as const;

let configuredSqlCipherPath: string | undefined;

export class SqlCipherBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlCipherBootstrapError";
  }
}

export type SqlCipherKey = string | Uint8Array;

export interface SqlCipherKeyProvider {
  /** Returns key material only when a caller explicitly opens the store. */
  getKey(): SqlCipherKey;
}

export interface OpenSqlCipherDatabaseOptions {
  filename: string;
  keyProvider: SqlCipherKeyProvider;
}

/**
 * A production key provider for a macOS Keychain generic-password entry.
 * The Keychain is not queried until getKey() is called explicitly.
 */
export class MacOSKeychainKeyProvider implements SqlCipherKeyProvider {
  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  getKey(): string {
    if (process.platform !== "darwin") {
      throw new SqlCipherBootstrapError("macOS Keychain is unavailable on this platform");
    }

    const result = Bun.spawnSync({
      cmd: [
        "/usr/bin/security",
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        this.account,
        "-w",
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new SqlCipherBootstrapError("Unable to retrieve SQLCipher key from macOS Keychain");
    }

    const key = new TextDecoder().decode(result.stdout).trim();
    if (key.length === 0) {
      throw new SqlCipherBootstrapError("macOS Keychain returned an empty SQLCipher key");
    }
    return key;
  }
}

function testSqlCipherLibraryPath(): string {
  const path = process.env.SQLCIPHER_PATH;
  if (!path) {
    throw new SqlCipherBootstrapError("SQLCIPHER_PATH must name the SQLCipher dynamic library");
  }
  if (!isAbsolute(path) || !existsSync(path)) {
    throw new SqlCipherBootstrapError("SQLCIPHER_PATH must name an existing absolute dynamic library");
  }

  try {
    if (!statSync(path).isFile()) {
      throw new SqlCipherBootstrapError("SQLCIPHER_PATH must name a SQLCipher dynamic library file");
    }
  } catch (error) {
    if (error instanceof SqlCipherBootstrapError) throw error;
    throw new SqlCipherBootstrapError("SQLCIPHER_PATH could not be inspected");
  }
  return path;
}

function productionSqlCipherLibraryPath(): string {
  if (process.platform !== PRODUCTION_SQLCIPHER_PACK.platform || process.arch !== PRODUCTION_SQLCIPHER_PACK.arch) {
    throw new SqlCipherBootstrapError("No allowlisted SQLCipher pack is available for this production platform");
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(PRODUCTION_SQLCIPHER_PACK.libraryPath);
    if (canonicalPath !== PRODUCTION_SQLCIPHER_PACK.libraryPath || !statSync(canonicalPath).isFile()) {
      throw new SqlCipherBootstrapError("The production SQLCipher pack is not the allowlisted library file");
    }
  } catch (error) {
    if (error instanceof SqlCipherBootstrapError) throw error;
    throw new SqlCipherBootstrapError("The allowlisted production SQLCipher pack is unavailable");
  }

  try {
    const actualDigest = createHash("sha256").update(readFileSync(canonicalPath)).digest("hex");
    if (actualDigest !== PRODUCTION_SQLCIPHER_PACK.sha256) {
      throw new SqlCipherBootstrapError("The production SQLCipher pack failed provenance verification");
    }
  } catch (error) {
    if (error instanceof SqlCipherBootstrapError) throw error;
    throw new SqlCipherBootstrapError("The production SQLCipher pack could not be provenance-checked");
  }
  return canonicalPath;
}

function sqlCipherLibraryPath(): string {
  return process.env.NODE_ENV === "test"
    ? testSqlCipherLibraryPath()
    : productionSqlCipherLibraryPath();
}

/**
 * Select SQLCipher before the first Bun SQLite database is constructed.
 * `SQLCIPHER_PATH` is a test-only escape hatch. Production always resolves and
 * verifies the fixed allowlisted pack, ignoring ambient loader input.
 */
export function configureSqlCipher(): void {
  const path = sqlCipherLibraryPath();
  if (configuredSqlCipherPath) {
    if (configuredSqlCipherPath !== path) {
      throw new SqlCipherBootstrapError("SQLCipher was already configured with a different library");
    }
    return;
  }

  try {
    if (!Database.setCustomSQLite(path)) {
      throw new SqlCipherBootstrapError("Bun refused the requested SQLCipher library");
    }
    configuredSqlCipherPath = path;
  } catch (error) {
    if (error instanceof SqlCipherBootstrapError) throw error;
    throw new SqlCipherBootstrapError("Unable to configure Bun with SQLCipher");
  }
}

function keyAsHex(key: SqlCipherKey): string {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  if (bytes.length === 0) {
    throw new SqlCipherBootstrapError("A non-empty SQLCipher key is required");
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rejectPlainSqliteHeader(filename: string): void {
  if (!existsSync(filename)) return;

  let descriptor: number | undefined;
  try {
    descriptor = openSync(filename, "r");
    const header = Buffer.alloc(SQLITE_HEADER.length);
    readSync(descriptor, header, 0, header.length, 0);
    if (header.toString("ascii") === SQLITE_HEADER) {
      throw new SqlCipherBootstrapError("Refusing plaintext SQLite database header");
    }
  } catch (error) {
    if (error instanceof SqlCipherBootstrapError) throw error;
    throw new SqlCipherBootstrapError("Unable to inspect database header before opening");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertSqlCipherReady(database: Database): void {
  const result = database.query("PRAGMA cipher_version").get() as Record<string, unknown> | null;
  const version = result ? Object.values(result)[0] : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new SqlCipherBootstrapError("Loaded SQLite library does not report a SQLCipher version");
  }
}

/** Opens an encrypted database, applying key, schema verification, and WAL before return. */
export function openSqlCipherDatabase({
  filename,
  keyProvider,
}: OpenSqlCipherDatabaseOptions): Database {
  if (!filename) throw new SqlCipherBootstrapError("An encrypted database filename is required");
  if (!keyProvider) throw new SqlCipherBootstrapError("A SQLCipher key provider is required");

  const key = keyAsHex(keyProvider.getKey());
  rejectPlainSqliteHeader(filename);
  configureSqlCipher();

  let database: Database | undefined;
  try {
    database = new Database(filename, { create: true, readwrite: true });
    database.run(`PRAGMA key = "x'${key}'"`);
    assertSqlCipherReady(database);
    database.query("SELECT name FROM sqlite_master LIMIT 1").all();

    const journalMode = database.query("PRAGMA journal_mode = WAL").get() as Record<string, unknown> | null;
    if (!journalMode || Object.values(journalMode)[0] !== "wal") {
      throw new SqlCipherBootstrapError("SQLCipher database could not enable WAL");
    }
    return database;
  } catch (error) {
    database?.close();
    if (error instanceof SqlCipherBootstrapError) throw error;
    throw new SqlCipherBootstrapError("Unable to open encrypted SQLCipher database");
  }
}
