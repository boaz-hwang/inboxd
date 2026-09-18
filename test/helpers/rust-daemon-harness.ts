import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";

import { connectUdsTransport } from "../../packages/cli/src/transport.ts";
import { queryRustStorageRows, rustStorageValues } from "./rust-storage-fixture.ts";

export const TEST_DATABASE_KEY = new Uint8Array(32).fill(42);
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

export interface RustDaemonSeed {
  readonly identity: Record<string, unknown>;
  readonly unread: Record<string, unknown>;
  readonly batch: Record<string, unknown>;
}

const DEFAULT_SEED: RustDaemonSeed = {
  identity: {
      platform: FIXTURE_CHAT.platform,
      account: FIXTURE_CHAT.account,
      status: "known",
      self_id: "self",
      source: "authenticated_adapter",
      observed_at: 50,
  },
  unread: {
      chat: FIXTURE_CHAT,
      status: "known",
      count: 1,
      source: "platform",
      observed_at: 50,
  },
  batch: {
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
  },
};

export function seedRustDaemonFixture(databasePath: string, seed: RustDaemonSeed = DEFAULT_SEED): void {
  rustStorageValues(databasePath, [
    { op: "store.migrate", input: null },
    { op: "store.recordAccountIdentity", input: seed.identity },
    { op: "store.recordUnreadState", input: seed.unread },
    { op: "store.applySyncBatch", input: seed.batch },
  ]);
}

type DaemonProcess = ReturnType<typeof Bun.spawn>;

export type FixedWorkerKind = "slack" | "telegram" | "kakao-local" | "kakao-official";

export interface RustDaemonHarnessOptions {
  readonly providers?: readonly Record<string, unknown>[];
  /** Release fake worker copied under each production-fixed sibling name. */
  readonly fixedWorkerBinary?: string;
}

const FIXED_WORKER_NAMES: Readonly<Record<FixedWorkerKind, string>> = {
  slack: "inboxd-slack-worker",
  telegram: "inboxd-telegram-worker",
  "kakao-local": "inboxd-kakao-local-worker",
  "kakao-official": "inboxd-kakao-message-worker",
};

const FIXTURE_PARENT = join(import.meta.dir, "../../target/inboxd-test-fixtures");

function assertPrivateDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`${label} must be mode 0700`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} must be owned by the fixture user`);
}

function createPrivateFixtureRoot(): string {
  mkdirSync(FIXTURE_PARENT, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(FIXTURE_PARENT, "Rust daemon fixture parent");
  const root = mkdtempSync(join(FIXTURE_PARENT, "inboxd-rd-"));
  assertPrivateDirectory(root, "Rust daemon fixture root");
  return root;
}

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
  readonly root: string;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly socketPath: string;
  readonly configPath: string;
  readonly executablePath: string;
  private readonly providers: readonly Record<string, unknown>[];
  private readonly fixedWorkerPaths = new Map<FixedWorkerKind, string>();
  private process: CapturedProcess | undefined;

  constructor(options: RustDaemonHarnessOptions = {}) {
    this.root = createPrivateFixtureRoot();
    this.stateDir = join(this.root, ".inboxd");
    this.databasePath = join(this.stateDir, "inboxd.db");
    this.socketPath = join(this.stateDir, "sock");
    this.configPath = join(this.root, "config.json");
    this.providers = options.providers ?? [];
    mkdirSync(this.stateDir, { mode: 0o700 });
    if (options.fixedWorkerBinary !== undefined) {
      if (!existsSync(options.fixedWorkerBinary)) throw new Error("fixedWorkerBinary must name the built release fake worker executable");
      const binDir = join(this.root, "bin");
      mkdirSync(binDir, { mode: 0o700 });
      this.executablePath = join(binDir, "inboxd-daemon");
      copyFileSync(daemonBinary(), this.executablePath);
      chmodSync(this.executablePath, 0o700);
      for (const [kind, name] of Object.entries(FIXED_WORKER_NAMES) as Array<[FixedWorkerKind, string]>) {
        const destination = join(binDir, name);
        copyFileSync(options.fixedWorkerBinary, destination);
        chmodSync(destination, 0o700);
        this.fixedWorkerPaths.set(kind, destination);
      }
    } else {
      this.executablePath = daemonBinary();
    }
    writeFileSync(this.configPath, JSON.stringify(this.config()), { mode: 0o600 });
  }

  config(): Record<string, unknown> {
    return {
      version: 1,
      state_dir: this.stateDir,
      database_path: this.databasePath,
      socket_path: this.socketPath,
      keychain: { service: "inboxd-test", account: "fixture" },
      ...(this.providers.length === 0 ? {} : { providers: this.providers }),
    };
  }

  seed(): void {
    seedRustDaemonFixture(this.databasePath);
  }

  seedFixture(seed: RustDaemonSeed): void {
    seedRustDaemonFixture(this.databasePath, seed);
  }

  queryRows(sql: string, params: readonly unknown[] = []): Record<string, unknown>[] {
    if (this.process?.child.exitCode === null) throw new Error("stop the Rust daemon before inspecting its encrypted database");
    return queryRustStorageRows(this.databasePath, sql, params);
  }

  assertPrivateFixtureRoot(): void {
    assertPrivateDirectory(FIXTURE_PARENT, "Rust daemon fixture parent");
    assertPrivateDirectory(this.root, "Rust daemon fixture root");
  }

  async start(extraEnv: Record<string, string | undefined> = {}): Promise<void> {
    if (this.process && this.process.child.exitCode === null) throw new Error("Rust daemon fixture is already running");
    const child = Bun.spawn([this.executablePath, "--config", this.configPath], {
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
      if (!existsSync(this.socketPath)) {
        await Bun.sleep(10);
        continue;
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

  assertFixedWorkersAreRegularOwnerExecutables(): void {
    if (this.fixedWorkerPaths.size !== Object.keys(FIXED_WORKER_NAMES).length) {
      throw new Error("configured fixture did not install every fixed worker sibling");
    }
    const executableDirectory = join(this.root, "bin");
    for (const [kind, path] of this.fixedWorkerPaths) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${kind} fixed worker is not a copied regular file`);
      if ((stat.mode & 0o777) !== 0o700) throw new Error(`${kind} fixed worker is not owner-executable mode 0700`);
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${kind} fixed worker is not owned by the fixture user`);
      if (!path.startsWith(`${executableDirectory}/`)) throw new Error(`${kind} fixed worker is not a daemon sibling`);
    }
    const config = lstatSync(this.configPath);
    if (!config.isFile() || config.isSymbolicLink() || (config.mode & 0o777) !== 0o600) {
      throw new Error("configured daemon config is not an owner-only regular file");
    }
  }

  removeFixedWorker(kind: FixedWorkerKind): void {
    const path = this.fixedWorkerPaths.get(kind);
    if (path === undefined) throw new Error(`${kind} fixed worker was not installed`);
    rmSync(path);
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
