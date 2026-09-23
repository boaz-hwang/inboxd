import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { launchPackagedDaemon } from "../src/daemon-launcher.ts";
import { createUdsCliHandlers } from "../src/index.ts";

interface Fixture {
  readonly root: string;
  readonly binary: string;
  readonly configPath: string;
  readonly socketPath: string;
  readonly recordPath: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createReadyFixture(): Fixture {
  const root = mkdtempSync(join(import.meta.dir, ".daemon-launcher-"));
  chmodSync(root, 0o700);
  const binary = join(root, "inboxd-daemon");
  const fixtureSource = join(root, "fixture-daemon.ts");
  const configPath = join(root, "config.json");
  const socketPath = join(root, "daemon.sock");
  const recordPath = join(root, "launch.json");
  const errorPath = join(root, "fixture.err");
  writeFileSync(configPath, JSON.stringify({ socket_path: socketPath, record_path: recordPath }), { mode: 0o600 });
  writeFileSync(fixtureSource, `
import { createServer } from "node:net";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "--config") process.exit(64);
const config = JSON.parse(readFileSync(argv[1], "utf8"));
const stdinContents = readFileSync(0, "utf8");
writeFileSync(config.record_path, JSON.stringify({
  pid: process.pid,
  argv,
  envKeys: Object.keys(process.env).sort(),
  leaked: process.env.INBOXD_LAUNCHER_SECRET ?? null,
  replyWorkers: process.env.INBOXD_REPLY_WORKERS ?? null,
  stdinClosed: stdinContents.length === 0,
}), { mode: 0o600 });
rmSync(config.socket_path, { force: true });
const server = createServer((socket) => {
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    for (;;) {
      const newline = buffered.indexOf("\\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      const result = request.method === "system.status" ? { ready: true, owner: "fixture" } : {};
      socket.write(JSON.stringify({ type: "response", id: request.id, method: request.method, ok: true, result }) + "\\n");
    }
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.socket_path, resolve);
});
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
setInterval(() => {}, 1_000);
`);
  writeFileSync(binary, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixtureSource)} "$@" 2>${shellQuote(errorPath)}\n`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  chmodSync(configPath, 0o600);
  return { root, binary, configPath, socketPath, recordPath };
}

async function stopFixture(fixture: Fixture): Promise<void> {
  if (existsSync(fixture.recordPath)) {
    const pid = JSON.parse(readFileSync(fixture.recordPath, "utf8")).pid as number;
    try { process.kill(pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await Bun.sleep(10);
    }
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

test("launches the fixed executable with only --config and waits for protocol readiness", async () => {
  const fixture = createReadyFixture();
  const previousSecret = process.env.INBOXD_LAUNCHER_SECRET;
  const previousReplyWorkers = process.env.INBOXD_REPLY_WORKERS;
  process.env.INBOXD_LAUNCHER_SECRET = "must-not-cross";
  process.env.INBOXD_REPLY_WORKERS = "1";
  try {
    const result = await launchPackagedDaemon({
      daemonBinary: fixture.binary,
      configPath: fixture.configPath,
      socketPath: fixture.socketPath,
      readinessTimeoutMs: 2_000,
    });
    expect(result).toBe("started");
    const launched = JSON.parse(readFileSync(fixture.recordPath, "utf8"));
    expect(launched.argv).toEqual(["--config", fixture.configPath]);
    expect(launched.stdinClosed).toBe(true);
    expect(launched.leaked).toBeNull();
    expect(launched.replyWorkers).toBe("1");
    expect(launched.envKeys).toEqual(expect.arrayContaining(["HOME", "PATH"]));
  } catch (error) {
    const errorPath = join(fixture.root, "fixture.err");
    if (existsSync(errorPath)) console.error(readFileSync(errorPath, "utf8"));
    throw error;
  } finally {
    if (previousSecret === undefined) delete process.env.INBOXD_LAUNCHER_SECRET;
    else process.env.INBOXD_LAUNCHER_SECRET = previousSecret;
    if (previousReplyWorkers === undefined) delete process.env.INBOXD_REPLY_WORKERS;
    else process.env.INBOXD_REPLY_WORKERS = previousReplyWorkers;
    await stopFixture(fixture);
  }
});

test("createUdsCliHandlers injects the packaged launcher into daemon start", async () => {
  const fixture = createReadyFixture();
  const handlers = createUdsCliHandlers({
    daemonBinary: fixture.binary,
    configPath: fixture.configPath,
    socketPath: fixture.socketPath,
    readinessTimeoutMs: 2_000,
  });
  try {
    await expect(handlers.daemonStart()).resolves.toMatchObject({ ready: true, owner: "fixture" });
  } finally {
    handlers.stop();
    await stopFixture(fixture);
  }
});

test("rejects launch files below a group- or world-writable ancestor", async () => {
  const fixture = createReadyFixture();
  chmodSync(fixture.root, 0o777);
  try {
    await expect(launchPackagedDaemon({
      daemonBinary: fixture.binary,
      configPath: fixture.configPath,
      socketPath: fixture.socketPath,
      readinessTimeoutMs: 500,
    })).rejects.toThrow(/ancestor.*trusted|trusted.*ancestor/i);
    expect(existsSync(fixture.recordPath)).toBe(false);
  } finally {
    await stopFixture(fixture);
  }
});
