import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";

import { connectUdsTransport } from "../../packages/cli/src/transport.ts";
import { applySyncBatch, migrateDatabase, openSqlCipherDatabase, recordAccountIdentity, recordUnreadState } from "../../packages/store/src/index.ts";

export const TEST_DATABASE_KEY = new Uint8Array(32).fill(0x44);
export const TEST_DATABASE_KEY_HEX = Buffer.from(TEST_DATABASE_KEY).toString("hex");

export interface FixtureChat {
  readonly platform: string;
  readonly account: string;
  readonly chat_id: string;
}

export const FIXTURE_CHAT: FixtureChat = { platform: "test", account: "fixture", chat_id: "room" };
export const FIXTURE_INTERVAL = { from_ts: 0, to_ts: 100 } as const;

function daemonBinary(): string {
  const path = process.env.INBOXD_DAEMON_BIN;
  if (!path || !existsSync(path)) throw new Error("INBOXD_DAEMON_BIN must name the built Rust daemon executable");
  return path;
}

function configureTestSqlCipher(): void {
  process.env.NODE_ENV = "test";
  if (process.env.SQLCIPHER_PATH) return;
  for (const candidate of [
    "/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib",
    "/usr/local/opt/sqlcipher/lib/libsqlcipher.dylib",
  ]) {
    if (existsSync(candidate)) {
      process.env.SQLCIPHER_PATH = candidate;
      return;
    }
  }
  throw new Error("SQLCIPHER_PATH must name the local SQLCipher library for the TypeScript seed fixture");
}

export function seedRustDaemonFixture(databasePath: string): void {
  configureTestSqlCipher();
  const database = openSqlCipherDatabase({ filename: databasePath, keyProvider: { getKey: () => TEST_DATABASE_KEY } });
  try {
    migrateDatabase(database);
    recordAccountIdentity(database, {
      platform: FIXTURE_CHAT.platform,
      account: FIXTURE_CHAT.account,
      status: "known",
      self_id: "self",
      source: "authenticated_adapter",
      observed_at: 50,
    });
    recordUnreadState(database, {
      chat: FIXTURE_CHAT,
      status: "known",
      count: 1,
      source: "platform",
      observed_at: 50,
    });
    applySyncBatch(database, {
      events: [
        {
          kind: "create",
          message: { key: { ...FIXTURE_CHAT, msg_id: "m1" }, author_id: "self", ts: 10, body: "fixture first", attachments: [] },
          revision: { source: "adapter", value: 1 },
        },
        {
          kind: "create",
          message: { key: { ...FIXTURE_CHAT, msg_id: "m2" }, author_id: "other", ts: 20, body: "fixture second needle", attachments: [] },
          revision: { source: "adapter", value: 1 },
        },
      ],
      coverage: [{ chat: FIXTURE_CHAT, interval: FIXTURE_INTERVAL, kind: "backfill", collected_at: 100, mutations_verified_at: 100 }],
    });
  } finally {
    database.close();
  }
}

type DaemonProcess = ReturnType<typeof Bun.spawn>;

interface CapturedProcess {
  readonly child: DaemonProcess;
  readonly stdout: Promise<string>;
  readonly stderr: Promise<string>;
}

function capture(child: DaemonProcess): CapturedProcess {
  return {
    child,
    stdout: new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    stderr: new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  };
}

async function exitWithin(child: DaemonProcess, milliseconds: number): Promise<number | undefined> {
  return Promise.race([
    child.exited,
    Bun.sleep(milliseconds).then(() => undefined),
  ]);
}

export class RustDaemonHarness {
  readonly root = mkdtempSync(join(tmpdir(), "inboxd-rust-daemon-"));
  readonly stateDir = join(this.root, "state");
  readonly databasePath = join(this.stateDir, "inboxd.db");
  readonly socketPath = join(this.stateDir, "sock");
  readonly configPath = join(this.root, "config.json");
  private process: CapturedProcess | undefined;

  constructor() {
    mkdirSync(this.stateDir, { mode: 0o700 });
    writeFileSync(this.configPath, JSON.stringify(this.config()), { mode: 0o600 });
  }

  config(): Record<string, unknown> {
    return {
      version: 1,
      state_dir: this.stateDir,
      database_path: this.databasePath,
      socket_path: this.socketPath,
      keychain: { service: "inboxd-test", account: "fixture" },
    };
  }

  seed(): void {
    seedRustDaemonFixture(this.databasePath);
  }

  async start(extraEnv: Record<string, string | undefined> = {}): Promise<void> {
    if (this.process && this.process.child.exitCode === null) throw new Error("Rust daemon fixture is already running");
    const child = Bun.spawn([daemonBinary(), "--config", this.configPath], {
      env: {
        ...process.env,
        INBOXD_TEST_DATABASE_KEY_HEX: TEST_DATABASE_KEY_HEX,
        ...extraEnv,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.process = capture(child);
    await this.waitUntilReady();
  }

  async waitUntilReady(milliseconds = 5_000): Promise<void> {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      const process = this.process;
      if (!process) throw new Error("Rust daemon fixture has no process");
      if (process.child.exitCode !== null) {
        throw new Error(`Rust daemon exited ${process.child.exitCode}: ${(await process.stderr).trim()}`);
      }
      try {
        const transport = await connectUdsTransport(this.socketPath);
        transport.close();
        return;
      } catch {
        await Bun.sleep(10);
      }
    }
    throw new Error("Rust daemon did not expose its UDS before the fixture deadline");
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<{ code: number; stdout: string; stderr: string }> {
    const process = this.process;
    if (!process) return { code: 0, stdout: "", stderr: "" };
    if (process.child.exitCode === null) process.child.kill(signal);
    let code = await exitWithin(process.child, 5_000);
    if (code === undefined) {
      process.child.kill("SIGKILL");
      code = await process.child.exited;
    }
    const result = { code: code!, stdout: await process.stdout, stderr: await process.stderr };
    this.process = undefined;
    return result;
  }

  async crash(): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.stop("SIGKILL");
  }

  async restart(): Promise<void> {
    if (this.process) await this.stop("SIGKILL");
    await this.start();
  }

  token(): string {
    return readFileSync(join(this.stateDir, "approver.token"), "utf8").trim();
  }

  childPid(): number {
    const child = this.process?.child;
    if (!child || child.exitCode !== null) throw new Error("Rust daemon fixture is not running");
    return child.pid;
  }

  assertPrivateArtifacts(): void {
    for (const path of [this.socketPath, join(this.stateDir, "inboxd.lock"), join(this.stateDir, "approver.token")]) {
      const stat = statSync(path);
      if ((stat.mode & 0o777) !== 0o600) throw new Error(`${path} is not mode 0600`);
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${path} is not owned by the fixture user`);
    }
  }

  async dispose(): Promise<void> {
    await this.stop().catch(() => ({ code: -1, stdout: "", stderr: "" }));
    rmSync(this.root, { recursive: true, force: true });
  }
}

interface LineWaiter {
  active: boolean;
  resolve(value: Buffer | null): void;
  reject(error: Error): void;
}

export class RawUdsConnection {
  private buffer = Buffer.alloc(0);
  private readonly lines: Array<Buffer | null> = [];
  private readonly waiters: LineWaiter[] = [];
  private closed = false;

  private constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("close", () => {
      this.closed = true;
      this.deliver(null);
    });
    socket.on("error", () => {});
  }

  static connect(path: string): Promise<RawUdsConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      const fail = (error: Error) => reject(error);
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.removeListener("error", fail);
        resolve(new RawUdsConnection(socket));
      });
    });
  }

  send(value: unknown): void {
    this.socket.write(`${JSON.stringify(value)}\n`);
  }

  sendBytes(value: Uint8Array): void {
    this.socket.write(value);
  }

  async request(id: string, method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    this.send({ type: "request", id, method, params });
    for (;;) {
      const frame = await this.nextJson();
      if (frame === null) throw new Error("daemon connection closed before the response");
      if (frame.type === "response" && frame.id === id) return frame;
    }
  }

  async nextLine(milliseconds = 2_000): Promise<Buffer | null> {
    if (this.lines.length > 0) return this.lines.shift()!;
    if (this.closed) return null;
    return new Promise<Buffer | null>((resolve, reject) => {
      const waiter: LineWaiter = { active: true, resolve, reject };
      this.waiters.push(waiter);
      setTimeout(() => {
        if (!waiter.active) return;
        waiter.active = false;
        reject(new Error("timed out waiting for a daemon frame"));
      }, milliseconds);
    });
  }

  async nextJson(milliseconds = 2_000): Promise<Record<string, any> | null> {
    const line = await this.nextLine(milliseconds);
    return line === null ? null : JSON.parse(line.toString("utf8"));
  }

  close(): void {
    this.socket.destroy();
  }

  private drain(): void {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      this.deliver(line);
    }
  }

  private deliver(value: Buffer | null): void {
    for (;;) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.lines.push(value);
        return;
      }
      if (!waiter.active) continue;
      waiter.active = false;
      waiter.resolve(value);
      return;
    }
  }
}

export async function waitFor(predicate: () => boolean, milliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not observed before the fixture deadline");
    await Bun.sleep(10);
  }
}

export async function runRustDaemonOnce(
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([daemonBinary(), ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const captured = capture(child);
  const code = await child.exited;
  return { code, stdout: await captured.stdout, stderr: await captured.stderr };
}
