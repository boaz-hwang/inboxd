import { existsSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "../..");
const MAX_CALLS = 256;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface RustStorageCall {
  readonly op: string;
  readonly input: unknown;
}

interface RustStorageError {
  readonly name?: string;
  readonly message?: string;
}

export type RustStorageResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error?: RustStorageError };

function cargoExecutable(): string {
  if (process.env.CARGO) return process.env.CARGO;
  const homeCargo = process.env.HOME ? join(process.env.HOME, ".cargo", "bin", "cargo") : "";
  return homeCargo && existsSync(homeCargo) ? homeCargo : "cargo";
}

function rustFixtureEnvironment(): Record<string, string | undefined> {
  const { RUSTFLAGS: _rustFlags, RUSTDOCFLAGS: _rustdocFlags, ...environment } = process.env;
  const prefix = process.platform === "darwin"
    ? (existsSync("/opt/homebrew/opt/sqlcipher") ? "/opt/homebrew/opt/sqlcipher" : "/usr/local/opt/sqlcipher")
    : undefined;
  return {
    ...environment,
    ...(prefix === undefined ? {} : {
      SQLCIPHER_LIB_DIR: process.env.SQLCIPHER_LIB_DIR ?? join(prefix, "lib"),
      SQLCIPHER_INCLUDE_DIR: process.env.SQLCIPHER_INCLUDE_DIR ?? join(prefix, "include"),
      PKG_CONFIG_PATH: process.env.PKG_CONFIG_PATH ?? join(prefix, "lib", "pkgconfig"),
    }),
  };
}

/** Runs the test-only Rust storage owner with its fixed synthetic [42; 32] key. */
export function runRustStorageFixture(databasePath: string, calls: readonly RustStorageCall[]): RustStorageResult[] {
  if (calls.length === 0 || calls.length > MAX_CALLS) {
    throw new Error(`Rust storage fixture requires from 1 to ${MAX_CALLS} calls`);
  }
  for (const call of calls) {
    if (typeof call.op !== "string" || call.op.length === 0) throw new Error("Rust storage fixture operation must be non-empty");
  }
  const request = JSON.stringify({ path: databasePath, calls });
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) throw new Error("Rust storage fixture request exceeds its test bound");
  const child = Bun.spawnSync({
    cmd: [cargoExecutable(), "run", "--quiet", "-p", "inboxd-storage", "--example", "compat"],
    cwd: REPOSITORY_ROOT,
    env: rustFixtureEnvironment(),
    stdin: new TextEncoder().encode(request),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new TextDecoder().decode(child.stderr).trim();
  if (child.exitCode !== 0) throw new Error(`Rust storage fixture failed (${child.exitCode}): ${stderr}`);
  if (child.stdout.byteLength > MAX_RESPONSE_BYTES) throw new Error("Rust storage fixture response exceeds its test bound");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(child.stdout));
  } catch {
    throw new Error("Rust storage fixture returned invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== calls.length) {
    throw new Error("Rust storage fixture returned the wrong result count");
  }
  return parsed as RustStorageResult[];
}

export function rustStorageValues(databasePath: string, calls: readonly RustStorageCall[]): unknown[] {
  return runRustStorageFixture(databasePath, calls).map((result, index) => {
    if (result.ok) return result.value;
    const error = result.error;
    throw new Error(`Rust storage fixture ${calls[index]!.op} failed: ${error?.name ?? "Error"}: ${error?.message ?? "unknown error"}`);
  });
}

export function queryRustStorageRows(databasePath: string, sql: string, params: readonly unknown[] = []): Record<string, unknown>[] {
  const [rows] = rustStorageValues(databasePath, [{
    op: "host.roundtrip",
    input: { method: "sql.all", args: { sql, params } },
  }]);
  if (!Array.isArray(rows)) throw new Error("Rust storage fixture SQL query did not return rows");
  return rows as Record<string, unknown>[];
}
