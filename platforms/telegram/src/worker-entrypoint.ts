import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  PROTOCOL_LIMITS,
  parseWorkerRequestFrame,
  parseWorkerResponse,
  type WorkerRequestForOperationV1,
  type WorkerRequestV1,
  type WorkerResponseV1,
} from "../../../packages/protocol/src/schema.ts";
import {
  createTelegramWorkerCore,
  type TelegramWorkerBinding,
  type TelegramWorkerCore,
} from "./worker-core.ts";
import {
  createProductionTdlibPort,
  MISSING_TDLIB_PRODUCTION_PACK_REASON,
  unavailablePort,
  type ProductionTdlibOptions,
} from "./production-tdlib.ts";
import type { TdlibUserClientPort } from "./tdlib-port.ts";

export const TELEGRAM_WORKER_ENV = Object.freeze({
  account: "INBOXD_TELEGRAM_ACCOUNT",
  apiHash: "INBOXD_TELEGRAM_API_HASH",
  apiId: "INBOXD_TELEGRAM_API_ID",
  bindingId: "INBOXD_TELEGRAM_BINDING_ID",
  chatIdsJson: "INBOXD_TELEGRAM_CHAT_IDS_JSON",
  databaseDirectory: "INBOXD_TELEGRAM_DATABASE_DIRECTORY",
  filesDirectory: "INBOXD_TELEGRAM_FILES_DIRECTORY",
  selfUserId: "INBOXD_TELEGRAM_SELF_USER_ID",
} as const);

type Environment = Readonly<Record<string, string | undefined>>;

export interface TelegramWorkerConfig {
  readonly apiId: number;
  readonly apiHash: string;
  readonly databaseDirectory: string;
  readonly filesDirectory: string;
  readonly binding: TelegramWorkerBinding;
}

export interface TelegramProductionWorkerDependencies {
  readonly createPort?: (options: ProductionTdlibOptions) => Promise<TdlibUserClientPort>;
  readonly now?: () => number;
  readonly input?: AsyncIterable<Uint8Array>;
  readonly write?: (line: Uint8Array) => Promise<void> | void;
}

class TelegramWorkerConfigurationError extends Error {
  readonly name = "TelegramWorkerConfigurationError";

  constructor() {
    super("Telegram worker configuration is invalid");
  }
}

const CONFIGURATION_NAMES = Object.freeze(Object.values(TELEGRAM_WORKER_ENV).sort());
const encoder = new TextEncoder();
const PACKAGED_TDJSON_NAME = "inboxd-telegram-libtdjson.dylib";
const PACKAGED_TDL_ADDON_DIRECTORY = "prebuilds";
const PACKAGED_TDL_ADDON_NAME = "prebuilds/darwin-arm64/tdl.node";

function hasUnsafeMacAcl(path: string): boolean {
  if (process.platform !== "darwin") return true;
  const inspected = spawnSync("/bin/ls", ["-lde", path], {
    encoding: "utf8",
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    shell: false,
  });
  if (inspected.status !== 0 || inspected.error !== undefined) return true;
  const entries = inspected.stdout.split("\n").slice(1)
    .filter((line) => /^\s*\d+:/.test(line));
  return entries.some((line) => !/^\s*\d+:\s+.*\sdeny(?:\s|$)/.test(line));
}

function privateNode(path: string, type: "directory" | "file", expectedMode: number): boolean {
  if (process.getuid === undefined) return false;
  const stat = lstatSync(path);
  const correctType = type === "directory" ? stat.isDirectory() : stat.isFile();
  return correctType && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === expectedMode && !hasUnsafeMacAcl(path);
}

function manifestRuntimeFile(
  manifest: unknown,
  name: string,
  path: string,
): boolean {
  if (typeof manifest !== "object" || manifest === null) return false;
  const files = (manifest as { files?: unknown }).files;
  if (!Array.isArray(files)) return false;
  const matches = files.filter((entry) => typeof entry === "object" && entry !== null
    && (entry as { name?: unknown }).name === name);
  if (matches.length !== 1) return false;
  const entry = matches[0] as { kind?: unknown; mode?: unknown; sha256?: unknown; size?: unknown };
  const contents = readFileSync(path);
  return entry.kind === "runtime-library" && entry.mode === "0600" && entry.size === contents.byteLength
    && entry.sha256 === createHash("sha256").update(contents).digest("hex");
}

function packagedTdlibRuntime(): {
  readonly tdjsonPath: string;
} | undefined {
  const executableDirectory = dirname(process.execPath);
  const tdjsonPath = join(executableDirectory, PACKAGED_TDJSON_NAME);
  const tdlAddonDirectory = join(executableDirectory, PACKAGED_TDL_ADDON_DIRECTORY);
  const addonPlatformDirectory = join(tdlAddonDirectory, "darwin-arm64");
  const addonPath = join(executableDirectory, PACKAGED_TDL_ADDON_NAME);
  const manifestPath = join(executableDirectory, "manifest.json");
  try {
    if (!privateNode(executableDirectory, "directory", 0o700)
      || !privateNode(tdlAddonDirectory, "directory", 0o700)
      || !privateNode(addonPlatformDirectory, "directory", 0o700)
      || !privateNode(manifestPath, "file", 0o600)
      || !privateNode(tdjsonPath, "file", 0o600)
      || !privateNode(addonPath, "file", 0o600)) return undefined;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if ((manifest as { schema_version?: unknown }).schema_version !== "inboxd-product/v1"
      || !manifestRuntimeFile(manifest, PACKAGED_TDJSON_NAME, tdjsonPath)
      || !manifestRuntimeFile(manifest, PACKAGED_TDL_ADDON_NAME, addonPath)) return undefined;
    return { tdjsonPath };
  } catch {
    return undefined;
  }
}

function invalidConfiguration(): never {
  throw new TelegramWorkerConfigurationError();
}

function exactEnvironmentValue(environment: Environment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string") invalidConfiguration();
  return value;
}

function boundedCanonicalValue(value: string, maximum: number): string {
  if (value.length === 0
    || value.includes("\0")
    || encoder.encode(value).byteLength > maximum
    || value.normalize("NFC") !== value) {
    invalidConfiguration();
  }
  return value;
}

function canonicalAbsolutePath(value: string): string {
  const canonical = boundedCanonicalValue(value, 4_096);
  if (!isAbsolute(canonical) || resolve(canonical) !== canonical) invalidConfiguration();
  return canonical;
}

function canonicalPositiveInteger(value: string, maximum: bigint): number {
  if (!/^[1-9]\d*$/.test(value)) invalidConfiguration();
  const parsed = BigInt(value);
  if (parsed > maximum) invalidConfiguration();
  return Number(parsed);
}

function canonicalTelegramChatId(value: unknown): string {
  if (typeof value !== "string") invalidConfiguration();
  const match = /^telegram:chat:(-?(?:0|[1-9]\d*))$/.exec(value);
  if (match === null) invalidConfiguration();
  const raw = BigInt(match[1]!);
  if (raw === 0n || raw < BigInt(Number.MIN_SAFE_INTEGER) || raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalidConfiguration();
  }
  return value;
}

export function loadTelegramWorkerConfig(environment: Environment): TelegramWorkerConfig {
  const names = Object.keys(environment).sort();
  if (names.length !== CONFIGURATION_NAMES.length
    || names.some((name, index) => name !== CONFIGURATION_NAMES[index])) {
    invalidConfiguration();
  }

  const account = boundedCanonicalValue(exactEnvironmentValue(environment, TELEGRAM_WORKER_ENV.account), 512);
  const bindingId = boundedCanonicalValue(exactEnvironmentValue(environment, TELEGRAM_WORKER_ENV.bindingId), 512);
  const apiHash = exactEnvironmentValue(environment, TELEGRAM_WORKER_ENV.apiHash);
  if (!/^[0-9a-f]{32}$/.test(apiHash)) invalidConfiguration();
  const apiId = canonicalPositiveInteger(
    exactEnvironmentValue(environment, TELEGRAM_WORKER_ENV.apiId),
    2_147_483_647n,
  );
  const selfUserIdRaw = exactEnvironmentValue(environment, TELEGRAM_WORKER_ENV.selfUserId);
  canonicalPositiveInteger(selfUserIdRaw, BigInt(Number.MAX_SAFE_INTEGER));
  const databaseDirectory = canonicalAbsolutePath(
    exactEnvironmentValue(environment, TELEGRAM_WORKER_ENV.databaseDirectory),
  );
  const filesDirectory = canonicalAbsolutePath(
    exactEnvironmentValue(environment, TELEGRAM_WORKER_ENV.filesDirectory),
  );

  const chatIdsJson = exactEnvironmentValue(environment, TELEGRAM_WORKER_ENV.chatIdsJson);
  if (encoder.encode(chatIdsJson).byteLength > 1_048_576) invalidConfiguration();
  let parsedChatIds: unknown;
  try {
    parsedChatIds = JSON.parse(chatIdsJson);
  } catch {
    invalidConfiguration();
  }
  if (!Array.isArray(parsedChatIds)
    || parsedChatIds.length < 1
    || parsedChatIds.length > 128
    || JSON.stringify(parsedChatIds) !== chatIdsJson) {
    invalidConfiguration();
  }
  const chatIds = parsedChatIds.map(canonicalTelegramChatId);
  if (new Set(chatIds).size !== chatIds.length) invalidConfiguration();

  return {
    apiId,
    apiHash,
    databaseDirectory,
    filesDirectory,
    binding: {
      binding_id: bindingId,
      account,
      self_user_id: selfUserIdRaw,
      chat_ids: chatIds,
    },
  };
}

export type TelegramWorkerFatalCode =
  | "invalid_request_frame"
  | "request_frame_too_large"
  | "unterminated_request_frame"
  | "request_timeout"
  | "core_failure"
  | "response_invalid_or_oversized"
  | "output_write_failed"
  | "input_stream_invalid";

const FATAL_MESSAGES: Readonly<Record<TelegramWorkerFatalCode, string>> = {
  invalid_request_frame: "Telegram worker request frame rejected",
  request_frame_too_large: "Telegram worker request frame rejected",
  unterminated_request_frame: "Telegram worker input ended with an incomplete frame",
  request_timeout: "Telegram worker request timed out",
  core_failure: "Telegram worker operation failed",
  response_invalid_or_oversized: "Telegram worker response rejected",
  output_write_failed: "Telegram worker output failed",
  input_stream_invalid: "Telegram worker input stream rejected",
};

export class TelegramWorkerFatalError extends Error {
  readonly name = "TelegramWorkerFatalError";

  constructor(readonly code: TelegramWorkerFatalCode) {
    super(FATAL_MESSAGES[code]);
  }
}

export interface TelegramWorkerFrameOptions {
  readonly binding: TelegramWorkerBinding;
  readonly port: TdlibUserClientPort;
  readonly now: () => number;
  readonly frame: string | Uint8Array;
}

export interface TelegramJsonLinesWorkerOptions {
  readonly binding: TelegramWorkerBinding;
  readonly port: TdlibUserClientPort;
  readonly now: () => number;
  readonly input: AsyncIterable<Uint8Array>;
  /** Receives exactly one newline-terminated response frame per accepted request. */
  readonly write: (line: Uint8Array) => Promise<void> | void;
  /** May lower, but never raise, the protocol frame ceiling. */
  readonly maxRequestFrameBytes?: number;
}

function dispatch(core: TelegramWorkerCore, request: WorkerRequestV1): Promise<WorkerResponseV1> {
  switch (request.operation.op) {
    case "health":
      return core.health(request as WorkerRequestForOperationV1<"health">);
    case "read_page":
      return core.readPage(request as WorkerRequestForOperationV1<"read_page">);
    case "send":
      return core.send(request as WorkerRequestForOperationV1<"send">);
    case "read_receipt":
      return core.readReceipt(request as WorkerRequestForOperationV1<"read_receipt">);
  }
}

async function withinRequestDeadline<T>(
  request: WorkerRequestV1,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TelegramWorkerFatalError("request_timeout")), request.limits.timeout_ms);
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function dispatchAndEncode(core: TelegramWorkerCore, request: WorkerRequestV1): Promise<Uint8Array> {
  let response: WorkerResponseV1;
  try {
    response = await dispatch(core, request);
  } catch (error) {
    if (error instanceof TelegramWorkerFatalError) throw error;
    throw new TelegramWorkerFatalError("core_failure");
  }
  try {
    const validated = parseWorkerResponse(response, request);
    const bytes = new TextEncoder().encode(JSON.stringify(validated));
    if (bytes.byteLength > request.limits.max_response_bytes || bytes.includes(0x0a) || bytes.includes(0x0d)) {
      throw new Error("invalid response frame");
    }
    return bytes;
  } catch {
    throw new TelegramWorkerFatalError("response_invalid_or_oversized");
  }
}

async function handleFrameWithCore(
  core: TelegramWorkerCore,
  frame: string | Uint8Array,
  write?: (response: Uint8Array) => Promise<void>,
): Promise<Uint8Array> {
  let request: WorkerRequestV1;
  try {
    request = parseWorkerRequestFrame(frame);
  } catch {
    throw new TelegramWorkerFatalError("invalid_request_frame");
  }

  return withinRequestDeadline(request, async () => {
    const bytes = await dispatchAndEncode(core, request);
    if (write !== undefined) await write(bytes);
    return bytes;
  });
}

/** Handles one raw JSON frame; failures are fixed diagnostics with no frame echo. */
export async function handleTelegramWorkerFrame(options: TelegramWorkerFrameOptions): Promise<Uint8Array> {
  const core = createTelegramWorkerCore({ binding: options.binding, port: options.port, now: options.now });
  return handleFrameWithCore(core, options.frame);
}

function joinFrame(parts: readonly Uint8Array[], byteLength: number): Uint8Array {
  const frame = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    frame.set(part, offset);
    offset += part.byteLength;
  }
  return frame;
}

/**
 * Runs a serial, backpressured JSON-lines loop. It never pulls another input
 * chunk while provider work or output is pending, so it owns no request queue.
 * A timeout is fatal: the process launcher must terminate the worker rather
 * than allow an uncancelled TDLib call to overlap later work.
 */
export async function runTelegramJsonLinesWorker(options: TelegramJsonLinesWorkerOptions): Promise<void> {
  const maximum = options.maxRequestFrameBytes ?? PROTOCOL_LIMITS.worker_frame_bytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > PROTOCOL_LIMITS.worker_frame_bytes) {
    throw new TypeError("Telegram worker frame bound is invalid");
  }
  const core = createTelegramWorkerCore({ binding: options.binding, port: options.port, now: options.now });
  let parts: Uint8Array[] = [];
  let frameBytes = 0;

  const append = (part: Uint8Array): void => {
    if (frameBytes + part.byteLength > maximum) {
      throw new TelegramWorkerFatalError("request_frame_too_large");
    }
    if (part.byteLength > 0) parts.push(part.slice());
    frameBytes += part.byteLength;
  };

  for await (const chunk of options.input) {
    if (!(chunk instanceof Uint8Array)) throw new TelegramWorkerFatalError("input_stream_invalid");
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      append(chunk.subarray(start, index));
      if (frameBytes === 0) throw new TelegramWorkerFatalError("invalid_request_frame");
      const frame = joinFrame(parts, frameBytes);
      parts = [];
      frameBytes = 0;
      await handleFrameWithCore(core, frame, async (response) => {
        const line = new Uint8Array(response.byteLength + 1);
        line.set(response);
        line[line.byteLength - 1] = 0x0a;
        try {
          await options.write(line);
        } catch {
          throw new TelegramWorkerFatalError("output_write_failed");
        }
      });
      start = index + 1;
    }
    append(chunk.subarray(start));
  }

  if (frameBytes !== 0) throw new TelegramWorkerFatalError("unterminated_request_frame");
}

async function writeStandardOutput(bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await Bun.stdout.write(bytes.subarray(offset));
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error("Telegram worker output failed");
    }
    offset += written;
  }
}

/** Builds the fixed production worker only after the exact env contract passes. */
export async function runTelegramProductionWorker(
  environment: Environment,
  dependencies: TelegramProductionWorkerDependencies = {},
): Promise<void> {
  const config = loadTelegramWorkerConfig(environment);
  const runtime = dependencies.createPort === undefined ? packagedTdlibRuntime() : undefined;
  const port = dependencies.createPort === undefined && runtime === undefined
    ? unavailablePort(MISSING_TDLIB_PRODUCTION_PACK_REASON)
    : await (dependencies.createPort ?? createProductionTdlibPort)({
      apiId: config.apiId,
      apiHash: config.apiHash,
      databaseDirectory: config.databaseDirectory,
      filesDirectory: config.filesDirectory,
      ...(runtime ?? {}),
    });
  try {
    await runTelegramJsonLinesWorker({
      binding: config.binding,
      port,
      now: dependencies.now ?? (() => Math.floor(Date.now() / 1_000)),
      input: dependencies.input ?? (Bun.stdin.stream() as AsyncIterable<Uint8Array>),
      write: dependencies.write ?? writeStandardOutput,
    });
  } finally {
    await port.close?.();
  }
}

function terminate(reason: "invalid configuration" | "worker failure", code: number): number {
  process.stderr.write(`Telegram worker terminated: ${reason}\n`);
  return code;
}

export async function main(
  environment: Environment = process.env,
  dependencies: TelegramProductionWorkerDependencies = {},
): Promise<number> {
  try {
    await runTelegramProductionWorker(environment, dependencies);
    return 0;
  } catch (error) {
    if (error instanceof TelegramWorkerConfigurationError) {
      return terminate("invalid configuration", 64);
    }
    return terminate("worker failure", 74);
  }
}

if (import.meta.main) process.exitCode = await main();
