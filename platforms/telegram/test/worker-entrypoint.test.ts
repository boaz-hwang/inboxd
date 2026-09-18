import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { WorkerRequestForOperationV1 } from "../../../packages/protocol/src/schema.ts";
import {
  TELEGRAM_WORKER_ENV,
  TelegramWorkerFatalError,
  handleTelegramWorkerFrame,
  loadTelegramWorkerConfig,
  main,
  runTelegramJsonLinesWorker,
  runTelegramProductionWorker,
} from "../src/worker-entrypoint.ts";
import { MISSING_TDLIB_PRODUCTION_PACK_REASON } from "../src/production-tdlib.ts";
import type {
  TdlibAuthorizationState,
  TdlibChat,
  TdlibHistoryRequest,
  TdlibMessage,
  TdlibSendTextRequest,
  TdlibUser,
  TdlibUserClientPort,
} from "../src/tdlib-port.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const entrypoint = resolve(import.meta.dir, "../src/worker-entrypoint.ts");
const binding = {
  binding_id: "telegram-primary",
  account: "account:primary",
  self_user_id: "777000",
  chat_ids: ["telegram:chat:-1001234567890"],
} as const;
const productionEnvironment = {
  [TELEGRAM_WORKER_ENV.account]: binding.account,
  [TELEGRAM_WORKER_ENV.apiHash]: "0123456789abcdef0123456789abcdef",
  [TELEGRAM_WORKER_ENV.apiId]: "12345",
  [TELEGRAM_WORKER_ENV.bindingId]: binding.binding_id,
  [TELEGRAM_WORKER_ENV.chatIdsJson]: JSON.stringify(binding.chat_ids),
  [TELEGRAM_WORKER_ENV.databaseDirectory]: "/var/lib/inboxd/telegram/database",
  [TELEGRAM_WORKER_ENV.filesDirectory]: "/var/lib/inboxd/telegram/files",
  [TELEGRAM_WORKER_ENV.selfUserId]: binding.self_user_id,
};

function withoutEnvironmentName(name: string): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(productionEnvironment).filter(([entryName]) => entryName !== name));
}

function healthRequest(input: {
  requestId?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
} = {}): WorkerRequestForOperationV1<"health"> {
  return {
    v: 1,
    type: "worker_request",
    request_id: input.requestId ?? "health-1",
    generation: 1,
    binding_id: binding.binding_id,
    limits: {
      timeout_ms: input.timeoutMs ?? 1_000,
      max_response_bytes: input.maxResponseBytes ?? 65_536,
      max_queue_depth: 1,
    },
    operation: { op: "health" },
  };
}

class HealthPort implements TdlibUserClientPort {
  readonly availability = { available: true } as const;
  authorizationCalls = 0;
  closeCalls = 0;

  constructor(private readonly authorization: () => Promise<TdlibAuthorizationState> = async () => ({
    "@type": "authorizationStateReady",
  })) {}

  async getAuthorizationState(): Promise<TdlibAuthorizationState> {
    this.authorizationCalls += 1;
    return this.authorization();
  }

  async getMe(): Promise<TdlibUser> {
    return { "@type": "user", id: binding.self_user_id };
  }

  async getChat(_chatId: string): Promise<TdlibChat> {
    throw new Error("unexpected getChat");
  }

  async getChatHistory(_request: TdlibHistoryRequest): Promise<readonly TdlibMessage[]> {
    throw new Error("unexpected getChatHistory");
  }

  async sendTextMessage(_request: TdlibSendTextRequest): Promise<TdlibMessage> {
    throw new Error("unexpected sendTextMessage");
  }

  async getMessage(_chatId: string, _messageId: string): Promise<TdlibMessage> {
    throw new Error("unexpected getMessage");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

async function* inputChunks(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

async function runEntrypoint(
  input: string | Uint8Array,
  env: Readonly<Record<string, string>>,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, entrypoint],
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(input);
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("Telegram bounded JSON-lines worker entrypoint", () => {
  test("loads the exact canonical fixed-worker environment", () => {
    expect(loadTelegramWorkerConfig(productionEnvironment)).toEqual({
      apiId: 12345,
      apiHash: "0123456789abcdef0123456789abcdef",
      databaseDirectory: "/var/lib/inboxd/telegram/database",
      filesDirectory: "/var/lib/inboxd/telegram/files",
      binding,
    });
  });

  test("rejects unknown and non-canonical fixed configuration before creating a TDLib port", async () => {
    const invalidEnvironments = [
      withoutEnvironmentName(TELEGRAM_WORKER_ENV.databaseDirectory),
      withoutEnvironmentName(TELEGRAM_WORKER_ENV.filesDirectory),
      { ...productionEnvironment, PATH: "/untrusted" },
      { ...productionEnvironment, INBOXD_TELEGRAM_BOT_TOKEN: "forbidden" },
      { ...productionEnvironment, [TELEGRAM_WORKER_ENV.apiId]: "012345" },
      { ...productionEnvironment, [TELEGRAM_WORKER_ENV.apiId]: "2147483648" },
      { ...productionEnvironment, [TELEGRAM_WORKER_ENV.apiHash]: "0123456789ABCDEF0123456789ABCDEF" },
      { ...productionEnvironment, [TELEGRAM_WORKER_ENV.bindingId]: "" },
      { ...productionEnvironment, [TELEGRAM_WORKER_ENV.account]: "e\u0301" },
      { ...productionEnvironment, [TELEGRAM_WORKER_ENV.selfUserId]: "0777000" },
      { ...productionEnvironment, [TELEGRAM_WORKER_ENV.selfUserId]: "9007199254740992" },
      { ...productionEnvironment, [TELEGRAM_WORKER_ENV.chatIdsJson]: '[ "telegram:chat:-1001234567890" ]' },
      { ...productionEnvironment, [TELEGRAM_WORKER_ENV.chatIdsJson]: '["telegram:chat:0"]' },
      {
        ...productionEnvironment,
        [TELEGRAM_WORKER_ENV.chatIdsJson]: '["telegram:chat:-1001234567890","telegram:chat:-1001234567890"]',
      },
    ];
    let createPortCalls = 0;

    for (const environment of invalidEnvironments) {
      await expect(runTelegramProductionWorker(environment, {
        createPort: async () => {
          createPortCalls += 1;
          return new HealthPort();
        },
        input: inputChunks([]),
        write: async () => {},
      })).rejects.toThrow("Telegram worker configuration is invalid");
    }
    expect(createPortCalls).toBe(0);
  });

  test.each([
    ["empty database directory", TELEGRAM_WORKER_ENV.databaseDirectory, ""],
    ["relative database directory", TELEGRAM_WORKER_ENV.databaseDirectory, "telegram/database"],
    ["traversing database directory", TELEGRAM_WORKER_ENV.databaseDirectory, "/var/lib/inboxd/telegram/../database"],
    ["redundant-separator database directory", TELEGRAM_WORKER_ENV.databaseDirectory, "/var/lib//inboxd/telegram/database"],
    ["non-NFC database directory", TELEGRAM_WORKER_ENV.databaseDirectory, "/var/lib/inboxd/telegram/e\u0301"],
    ["NUL-containing database directory", TELEGRAM_WORKER_ENV.databaseDirectory, "/var/lib/inboxd/telegram/data\0base"],
    ["oversized database directory", TELEGRAM_WORKER_ENV.databaseDirectory, `/${"d".repeat(4_096)}`],
    ["relative files directory", TELEGRAM_WORKER_ENV.filesDirectory, "telegram/files"],
    ["dot-segment files directory", TELEGRAM_WORKER_ENV.filesDirectory, "/var/lib/inboxd/telegram/./files"],
    ["trailing-separator files directory", TELEGRAM_WORKER_ENV.filesDirectory, "/var/lib/inboxd/telegram/files/"],
  ])("rejects %s before creating a TDLib port", async (_label, name, value) => {
    let createPortCalls = 0;

    await expect(runTelegramProductionWorker({ ...productionEnvironment, [name]: value }, {
      createPort: async () => {
        createPortCalls += 1;
        return new HealthPort();
      },
      input: inputChunks([]),
      write: async () => {},
    })).rejects.toThrow("Telegram worker configuration is invalid");
    expect(createPortCalls).toBe(0);
  });

  test("wires canonical configuration through the bounded worker and closes TDLib at natural EOF", async () => {
    const output: Uint8Array[] = [];
    const port = new HealthPort();
    let productionOptions: unknown;
    const request = JSON.stringify(healthRequest({ requestId: "production-health" }));

    await runTelegramProductionWorker(productionEnvironment, {
      createPort: async (options) => {
        productionOptions = options;
        return port;
      },
      now: () => 205,
      input: inputChunks([encoder.encode(`${request}\n`)]),
      write: async (line) => { output.push(line.slice()); },
    });

    expect(productionOptions).toEqual({
      apiId: 12345,
      apiHash: "0123456789abcdef0123456789abcdef",
      databaseDirectory: "/var/lib/inboxd/telegram/database",
      filesDirectory: "/var/lib/inboxd/telegram/files",
    });
    expect(output).toHaveLength(1);
    expect(JSON.parse(decoder.decode(output[0]!))).toEqual(expect.objectContaining({
      request_id: "production-health",
      operation: "health",
      ok: true,
    }));
    expect(port.closeCalls).toBe(1);
  });

  test("closes TDLib and emits only a generic diagnostic when a process frame is fatal", async () => {
    const secret = "frame-secret-must-not-leak";
    const port = new HealthPort();
    const diagnostics: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      diagnostics.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await main(productionEnvironment, {
        createPort: async () => port,
        input: inputChunks([encoder.encode(`{"secret":"${secret}"}\n`)]),
        write: async () => { throw new Error("must not write"); },
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(code).toBe(74);
    expect(diagnostics.join("")).toBe("Telegram worker terminated: worker failure\n");
    expect(diagnostics.join("")).not.toContain(secret);
    expect(port.closeCalls).toBe(1);
  });

  test("declares and compiles a standalone fixed worker that handles one bounded health frame", async () => {
    const packageJson = await Bun.file(resolve(import.meta.dir, "../package.json")).json() as {
      readonly bin?: Readonly<Record<string, string>>;
    };
    expect(packageJson.bin?.["inboxd-telegram-worker"]).toBe("src/worker-entrypoint.ts");

    const directory = await mkdtemp(join(tmpdir(), "inboxd-telegram-worker-"));
    const binary = join(directory, "inboxd-telegram-worker");
    const stateDirectory = join(directory, "state");
    const workDirectory = join(directory, "work");
    try {
      const build = Bun.spawn({
        cmd: [process.execPath, "build", "--compile", entrypoint, "--outfile", binary],
        cwd: resolve(import.meta.dir, "../../.."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [buildCode, buildStderr] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      expect(buildCode, buildStderr).toBe(0);

      await Promise.all([
        mkdir(stateDirectory),
        mkdir(workDirectory),
      ]);

      const child = Bun.spawn({
        cmd: [binary],
        cwd: workDirectory,
        env: {
          ...productionEnvironment,
          [TELEGRAM_WORKER_ENV.databaseDirectory]: join(stateDirectory, "database"),
          [TELEGRAM_WORKER_ENV.filesDirectory]: join(stateDirectory, "files"),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(`${JSON.stringify(healthRequest({ requestId: "standalone-health" }))}\n`);
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 10_000);
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timer));

      expect(code).toBe(0);
      expect(stderr).toBe("");
      const lines = stdout.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual(expect.objectContaining({
        request_id: "standalone-health",
        operation: "health",
        ok: true,
        result: {
          state: "unavailable",
          auth: expect.objectContaining({
            state: "unknown",
            reason: MISSING_TDLIB_PRODUCTION_PACK_REASON,
          }),
        },
      }));
      expect(await readdir(workDirectory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("executes as a process and rejects invalid configuration instead of exiting silently", async () => {
    const secret = "not-a-valid-api-hash";
    const result = await runEntrypoint("", { INBOXD_TELEGRAM_API_HASH: secret });

    expect(result.code).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Telegram worker terminated: invalid configuration\n");
    expect(result.stderr).not.toContain(secret);
  });

  test("handles fragmented and coalesced request lines with one bounded response line each", async () => {
    const first = JSON.stringify(healthRequest({ requestId: "health-1" }));
    const second = JSON.stringify(healthRequest({ requestId: "health-2" }));
    const wire = encoder.encode(`${first}\n${second}\n`);
    const outputs: Uint8Array[] = [];
    const port = new HealthPort();

    await runTelegramJsonLinesWorker({
      binding,
      port,
      now: () => 200,
      input: inputChunks([wire.slice(0, 17), wire.slice(17, first.length + 3), wire.slice(first.length + 3)]),
      write: async (line) => { outputs.push(line.slice()); },
    });

    expect(outputs).toHaveLength(2);
    expect(outputs.every((line) => line.at(-1) === 0x0a)).toBe(true);
    expect(outputs.map((line) => JSON.parse(decoder.decode(line)))).toEqual([
      expect.objectContaining({ request_id: "health-1", operation: "health", ok: true }),
      expect.objectContaining({ request_id: "health-2", operation: "health", ok: true }),
    ]);
    expect(port.authorizationCalls).toBe(2);
  });

  test("rejects an oversized raw input frame before JSON decoding or TDLib I/O", async () => {
    const port = new HealthPort();
    const output: Uint8Array[] = [];

    const run = runTelegramJsonLinesWorker({
      binding,
      port,
      now: () => 201,
      input: inputChunks([encoder.encode(`${"x".repeat(65)}\n`)]),
      write: async (line) => { output.push(line.slice()); },
      maxRequestFrameBytes: 64,
    });

    await expect(run).rejects.toEqual(expect.objectContaining({
      name: "TelegramWorkerFatalError",
      code: "request_frame_too_large",
      message: "Telegram worker request frame rejected",
    }));
    expect(output).toEqual([]);
    expect(port.authorizationCalls).toBe(0);
  });

  test("fails closed instead of emitting a response above the request output bound", async () => {
    const output: Uint8Array[] = [];
    const request = JSON.stringify(healthRequest({ maxResponseBytes: 1 }));

    await expect(runTelegramJsonLinesWorker({
      binding,
      port: new HealthPort(),
      now: () => 202,
      input: inputChunks([encoder.encode(`${request}\n`)]),
      write: async (line) => { output.push(line.slice()); },
    })).rejects.toEqual(expect.objectContaining({
      code: "response_invalid_or_oversized",
      message: "Telegram worker response rejected",
    }));
    expect(output).toEqual([]);
  });

  test("enforces request timeout as a fatal worker boundary", async () => {
    const port = new HealthPort(() => new Promise<TdlibAuthorizationState>(() => {}));
    const request = JSON.stringify(healthRequest({ timeoutMs: 5 }));

    await expect(handleTelegramWorkerFrame({
      binding,
      port,
      now: () => 203,
      frame: encoder.encode(request),
    })).rejects.toEqual(expect.objectContaining({
      code: "request_timeout",
      message: "Telegram worker request timed out",
    }));
    expect(port.authorizationCalls).toBe(1);
  });

  test("extends the request timeout through response output backpressure", async () => {
    const request = JSON.stringify(healthRequest({ timeoutMs: 5 }));
    const run = runTelegramJsonLinesWorker({
      binding,
      port: new HealthPort(),
      now: () => 203,
      input: inputChunks([encoder.encode(`${request}\n`)]),
      write: () => new Promise<void>(() => {}),
    });
    const outcome = await Promise.race([
      run.then(
        () => ({ code: "completed" }),
        (error: unknown) => error,
      ),
      new Promise<{ readonly code: "still_pending" }>((resolve) => {
        setTimeout(() => resolve({ code: "still_pending" }), 50);
      }),
    ]);

    expect(outcome).toEqual(expect.objectContaining({
      code: "request_timeout",
      message: "Telegram worker request timed out",
    }));
  });

  test("never echoes malformed frame content through fatal diagnostics", async () => {
    const secret = "api_hash=do-not-log-this";
    let caught: unknown;
    try {
      await runTelegramJsonLinesWorker({
        binding,
        port: new HealthPort(),
        now: () => 204,
        input: inputChunks([encoder.encode(`{"secret":"${secret}"}\n`)]),
        write: async () => { throw new Error("must not write"); },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TelegramWorkerFatalError);
    expect((caught as TelegramWorkerFatalError).code).toBe("invalid_request_frame");
    expect(String(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain("secret");
  });
});
