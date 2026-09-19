import { Database, type SQLQueryBindings } from "bun:sqlite";
import { CString, dlopen, FFIType, JSCallback, ptr, suffix } from "bun:ffi";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CoreHooks {
  readonly now?: () => number;
  readonly id?: () => string;
}

export interface CoreHostError { readonly name: string; readonly message: string; }
export const NATIVE_ABI_VERSION = 1;
interface CoreEnvelope { readonly ok: boolean; readonly value?: unknown; readonly error?: CoreHostError; }
interface NativeSymbols {
  inboxd_core_abi_version(): number;
  inboxd_core_call(op: Uint8Array, input: Uint8Array, callback: number): number;
  inboxd_core_free(pointer: number): void;
}

interface NativeLibrary { readonly symbols: NativeSymbols; }
let library: NativeLibrary | undefined;

function libraryPath(): string {
  return join(import.meta.dir, "..", "native", `libinboxd_core.${suffix}`);
}

function nativeLibrary(): NativeLibrary {
  if (library !== undefined) return library;
  const path = libraryPath();
  if (!existsSync(path)) throw namedError("CoreUnavailableError", "native core is not built; run bun run build:native");
  const loaded = dlopen(path, {
    inboxd_core_abi_version: { args: [], returns: "u32" },
    inboxd_core_call: { args: ["ptr", "ptr", "ptr"], returns: "ptr" },
    inboxd_core_free: { args: [FFIType.ptr], returns: FFIType.void },
  }) as unknown as NativeLibrary & { close(): void };
  try {
    assertNativeAbiVersion(loaded.symbols.inboxd_core_abi_version());
    library = loaded;
    return loaded;
  } catch (error) {
    loaded.close();
    throw error;
  }
}

/** Exported for a small deterministic ABI gate test; normal callers use coreCall. */
export function assertNativeAbiVersion(actual: unknown): void {
  if (actual !== NATIVE_ABI_VERSION) {
    throw namedError("CoreAbiError", `native core ABI mismatch: expected ${NATIVE_ABI_VERSION}, received ${typeof actual === "number" ? actual : "missing"}`);
  }
}

function namedError(name: string, message: string): Error {
  const error = name === "TypeError" ? new TypeError(message)
    : name === "RangeError" ? new RangeError(message)
      : name === "SyntaxError" ? new SyntaxError(message)
        : new Error(message);
  error.name = name;
  return error;
}

function structuredError(error: unknown): CoreHostError {
  if (error instanceof Error) return { name: error.name || "Error", message: error.message };
  return { name: "Error", message: "host operation failed" };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw namedError("TypeError", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function sqlArgs(value: unknown): { sql: string; params: unknown[] } {
  const args = object(value, "SQL host arguments");
  if (typeof args.sql !== "string" || args.sql.length === 0) throw namedError("TypeError", "SQL host sql must be a non-empty string");
  if (args.params !== undefined && !Array.isArray(args.params)) throw namedError("TypeError", "SQL host params must be an array");
  return { sql: args.sql, params: (args.params ?? []) as unknown[] };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hostCall(database: Database | undefined, hooks: CoreHooks | undefined, method: string, args: unknown): unknown {
  switch (method) {
    case "host.now": return hooks?.now?.() ?? Date.now();
    case "host.id": return hooks?.id?.() ?? crypto.randomUUID();
    case "host.canonicalSha256": return createHash("sha256").update(canonical(args)).digest("hex");
    case "host.canonicalJson": return canonical(args);
    case "host.sha256Text": {
      if (typeof args !== "string") throw namedError("TypeError", "host.sha256Text requires a string");
      return createHash("sha256").update(args).digest("hex");
    }
    case "host.jsonStringify": return JSON.stringify(args);
    case "host.jsonParse": {
      if (typeof args !== "string") throw namedError("TypeError", "host.jsonParse requires a JSON string");
      return JSON.parse(args);
    }
    case "host.numberToString": {
      if (typeof args !== "number" || !Number.isFinite(args)) throw namedError("TypeError", "host.numberToString requires a finite number");
      return String(args);
    }
    case "host.utf16Compare": {
      const input = object(args, "host.utf16Compare arguments");
      if (typeof input.left !== "string" || typeof input.right !== "string") throw namedError("TypeError", "host.utf16Compare requires left and right strings");
      return input.left < input.right ? -1 : input.left > input.right ? 1 : 0;
    }
    case "host.codePointLength": {
      if (typeof args !== "string") throw namedError("TypeError", "host.codePointLength requires a string");
      return Array.from(args).length;
    }
    case "host.base64urlEncode": {
      if (typeof args !== "string") throw namedError("TypeError", "host.base64urlEncode requires a UTF-8 string");
      return Buffer.from(args, "utf8").toString("base64url");
    }
    case "host.base64urlDecode": {
      if (typeof args !== "string" || !/^[A-Za-z0-9_-]*$/.test(args)) throw namedError("TypeError", "host.base64urlDecode requires base64url text");
      return Buffer.from(args, "base64url").toString("utf8");
    }
    case "sql.run": {
      if (database === undefined) throw namedError("HostError", "SQL host requires a database");
      const parsed = sqlArgs(args);
      return { changes: database.run(parsed.sql, parsed.params as SQLQueryBindings[]).changes };
    }
    case "sql.get": {
      if (database === undefined) throw namedError("HostError", "SQL host requires a database");
      const parsed = sqlArgs(args);
      return database.query(parsed.sql).get(...parsed.params as SQLQueryBindings[]) ?? null;
    }
    case "sql.all": {
      if (database === undefined) throw namedError("HostError", "SQL host requires a database");
      const parsed = sqlArgs(args);
      return database.query(parsed.sql).all(...parsed.params as SQLQueryBindings[]);
    }
    case "sql.exec": {
      if (database === undefined) throw namedError("HostError", "SQL host requires a database");
      const parsed = sqlArgs(args);
      database.exec(parsed.sql);
      return null;
    }
    case "sql.transaction.begin": if (database === undefined) throw namedError("HostError", "SQL host requires a database"); database.exec("BEGIN IMMEDIATE"); return null;
    case "sql.transaction.commit": if (database === undefined) throw namedError("HostError", "SQL host requires a database"); database.exec("COMMIT"); return null;
    case "sql.transaction.rollback": if (database === undefined) throw namedError("HostError", "SQL host requires a database"); database.exec("ROLLBACK"); return null;
    default: throw namedError("RangeError", `unknown host method: ${method}`);
  }
}

/** Calls the Rust core synchronously; SQLCipher ownership remains in Bun. */
export function coreCall<T>(op: string, input: unknown, database?: Database, hooks?: CoreHooks): T {
  if (typeof op !== "string" || op.length === 0) throw namedError("TypeError", "core operation must be a non-empty string");
  assertFiniteNumbers(input);
  const encodedInput = encodeWireValue(input);
  let callbackResponse: Buffer | undefined;
  const callback = new JSCallback((pointer: number, length: bigint) => {
    let response: unknown;
    try {
      const request = decodeWireValue(JSON.parse(new CString(pointer, 0, Number(length)))) as { method?: unknown; args?: unknown };
      if (typeof request.method !== "string") throw namedError("TypeError", "host request method must be a string");
      response = { ok: true, value: hostCall(database, hooks, request.method, request.args) };
    } catch (error) {
      response = { ok: false, error: structuredError(error) };
    }
    callbackResponse = Buffer.from(`${JSON.stringify(encodeWireValue(response))}\0`, "utf8");
    return ptr(callbackResponse);
  }, { args: ["ptr", "usize"], returns: "ptr" });
  let pointer = 0;
  try {
    const serialized = JSON.stringify(encodedInput);
    if (serialized === undefined) throw namedError("TypeError", "core input must be JSON-serializable");
    // Bun's FFI does not accept a JS string as a raw pointer on every runtime;
    // keep explicit NUL-terminated UTF-8 buffers alive for the native call.
    const opBytes = Buffer.from(`${op}\0`, "utf8");
    const inputBytes = Buffer.from(`${serialized}\0`, "utf8");
    pointer = nativeLibrary().symbols.inboxd_core_call(opBytes, inputBytes, callback.ptr as number);
    if (!pointer) throw namedError("CoreError", "native core returned no result");
    const envelope = decodeWireValue(JSON.parse(new CString(pointer))) as CoreEnvelope;
    if (envelope.ok) return envelope.value as T;
    throw namedError(envelope.error?.name ?? "CoreError", envelope.error?.message ?? "native core failed");
  } finally {
    if (pointer) nativeLibrary().symbols.inboxd_core_free(pointer);
    callback.close();
  }
}

const wireSurrogateBase = 0xf0000;
const wireSurrogateEnd = 0xf07ff;
const wireEscape = 0xf0800;

function encodeWireString(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const point = value.codePointAt(index)!;
        if (point >= wireSurrogateBase && point <= wireEscape) result += String.fromCodePoint(wireEscape);
        result += String.fromCodePoint(point);
        index++;
        continue;
      }
      result += String.fromCodePoint(wireSurrogateBase + unit - 0xd800);
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) { result += String.fromCodePoint(wireSurrogateBase + unit - 0xd800); continue; }
    const point = value.codePointAt(index)!;
    if (point >= wireSurrogateBase && point <= wireEscape) result += String.fromCodePoint(wireEscape);
    result += String.fromCodePoint(point);
    if (point > 0xffff) index++;
  }
  return result;
}

function decodeWireString(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const point = value.codePointAt(index)!;
    if (point === wireEscape) {
      const next = value.codePointAt(index + 2);
      if (next === undefined) throw namedError("TypeError", "malformed native UTF-16 escape");
      result += String.fromCodePoint(next);
      index += next > 0xffff ? 3 : 2;
      continue;
    }
    if (point >= wireSurrogateBase && point <= wireSurrogateEnd) result += String.fromCharCode(0xd800 + point - wireSurrogateBase);
    else result += String.fromCodePoint(point);
    if (point > 0xffff) index++;
  }
  return result;
}

function encodeWireValue(value: unknown): unknown {
  if (typeof value === "string") return encodeWireString(value);
  if (Array.isArray(value)) return value.map(encodeWireValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [encodeWireString(key), encodeWireValue(item)]));
  return value;
}

function decodeWireValue(value: unknown): unknown {
  if (typeof value === "string") return decodeWireString(value);
  if (Array.isArray(value)) return value.map(decodeWireValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [decodeWireString(key), decodeWireValue(item)]));
  return value;
}

function assertFiniteNumbers(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw namedError("TypeError", "native core input contains a non-finite number");
  if (Array.isArray(value)) { for (const item of value) assertFiniteNumbers(item); return; }
  if (value !== null && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>)) assertFiniteNumbers(item);
}
