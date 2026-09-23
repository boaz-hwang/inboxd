import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";

const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const STATUS_PROBE_TIMEOUT_MS = 200;
const POLL_INTERVAL_MS = 25;
const TERMINATION_GRACE_MS = 250;
const SAFE_ENV_KEYS = ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "INBOXD_REPLY_MODEL", "INBOXD_REPLY_PYTHON", "INBOXD_REPLY_WORKERS"] as const;

export const defaultDaemonBinary = fileURLToPath(
  new URL("../../../target/inboxd-product/release/inboxd-daemon", import.meta.url),
);
export const defaultDaemonConfigPath = join(homedir(), ".inboxd", "config.json");

export interface PackagedDaemonLaunchOptions {
  readonly daemonBinary?: string;
  readonly configPath?: string;
  readonly socketPath: string;
  readonly readinessTimeoutMs?: number;
}

export type PackagedDaemonLaunchResult = "already-running" | "started";

type ChildExit =
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null };

function readinessTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new Error("daemon readiness timeout must be an integer from 1 to 60000 milliseconds");
  }
  return timeout;
}

function inspectOwnerFile(path: string, label: "daemon binary" | "daemon config") {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} path must be absolute and normalized`);
  }
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (typeof process.getuid !== "function") {
    throw new Error(`${label} ownership cannot be verified on this platform`);
  }
  if (stat.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
  validateMacAcl(path, label);
  return stat;
}

function validateMacAcl(path: string, label: string): void {
  if (process.platform !== "darwin") return;
  const inspected = spawnSync("/bin/ls", ["-lde", path], {
    encoding: "utf8",
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    shell: false,
  });
  if (inspected.status !== 0 || inspected.error !== undefined) {
    throw new Error(`${label} ACL could not be verified`);
  }
  const lines = inspected.stdout.split("\n");
  const mode = lines[0]?.trimStart().split(/\s+/, 1)[0] ?? "";
  if (!mode.includes("+")) return;
  const entries = lines.slice(1).filter((line) => line.trim().length > 0);
  if (entries.length === 0 || entries.some((line) => !/^\s*\d+:\s+.*\sdeny(?:\s|$)/.test(line))) {
    throw new Error(`${label} must not grant ACL mutation rights`);
  }
}

function validateTrustedAncestors(path: string, label: string): void {
  if (typeof process.getuid !== "function") {
    throw new Error(`${label} ancestor ownership cannot be verified on this platform`);
  }
  const owner = process.getuid();
  const parent = dirname(path);
  const components = parent.split("/").filter((component) => component.length > 0);
  let current = "/";
  for (const component of ["", ...components]) {
    if (component !== "") current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new Error(`${label} ancestor is unavailable`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== owner) || (stat.mode & 0o022) !== 0) {
      throw new Error(`${label} ancestor is not trusted`);
    }
    validateMacAcl(current, `${label} ancestor`);
  }
}

function validateLaunchFiles(daemonBinary: string, configPath: string): void {
  validatePackagedDaemonBinary(daemonBinary);
  validateTrustedAncestors(configPath, "daemon config");
  const config = inspectOwnerFile(configPath, "daemon config");
  if ((config.mode & 0o777) !== 0o600) throw new Error("daemon config must have mode 0600");
}

/** Validates the fixed packaged daemon and every pathname ancestor before pathname spawn. */
export function validatePackagedDaemonBinary(daemonBinary: string): void {
  validateTrustedAncestors(daemonBinary, "daemon binary");
  const binary = inspectOwnerFile(daemonBinary, "daemon binary");
  if ((binary.mode & 0o100) === 0) throw new Error("daemon binary must be owner-executable");
  if ((binary.mode & 0o022) !== 0) throw new Error("daemon binary must not be group- or world-writable");
}

function daemonEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  env.HOME ??= homedir();
  return env;
}

function daemonIsReady(socketPath: string, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let buffered = "";
    let settled = false;
    const timer = setTimeout(() => finish(false), milliseconds);
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ready);
    };
    socket.once("error", () => finish(false));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "request", id: "launcher-hello", method: "system.hello", params: { role: "reader" } })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "launcher-status", method: "system.status", params: {} })}\n`);
    });
    socket.on("data", (chunk) => {
      buffered += chunk.toString();
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const response = JSON.parse(line) as { id?: unknown; ok?: unknown; result?: { ready?: unknown } };
          if (response.id === "launcher-status") finish(response.ok === true && response.result?.ready === true);
          else if (response.id === "launcher-hello" && response.ok !== true) finish(false);
        } catch {
          finish(false);
        }
      }
    });
    socket.once("close", () => finish(false));
    socket.connect(socketPath);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminateChild(child: ChildProcess, exited: Promise<ChildExit>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch { return; }
  const stopped = await Promise.race([exited.then(() => true), delay(TERMINATION_GRACE_MS).then(() => false)]);
  if (!stopped) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([exited, delay(TERMINATION_GRACE_MS)]);
  }
}

function describeExit(exit: ChildExit): string {
  if (exit.kind === "error") return "packaged daemon could not be spawned";
  if (exit.signal !== null) return `packaged daemon exited before readiness (signal ${exit.signal})`;
  return `packaged daemon exited before readiness (code ${exit.code ?? "unknown"})`;
}

/** Launches only the fixed packaged Rust daemon and returns after a real status RPC succeeds. */
export async function launchPackagedDaemon(
  options: PackagedDaemonLaunchOptions,
): Promise<PackagedDaemonLaunchResult> {
  const timeoutMs = readinessTimeout(options.readinessTimeoutMs);
  const deadline = Date.now() + timeoutMs;
  const initialProbeMs = Math.max(1, Math.min(STATUS_PROBE_TIMEOUT_MS, deadline - Date.now()));
  if (await daemonIsReady(options.socketPath, initialProbeMs)) return "already-running";

  const daemonBinary = options.daemonBinary ?? defaultDaemonBinary;
  const configPath = options.configPath ?? defaultDaemonConfigPath;
  validateLaunchFiles(daemonBinary, configPath);

  const child = spawn(daemonBinary, ["--config", configPath], {
    detached: true,
    env: daemonEnvironment(),
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  let observedExit: ChildExit | undefined;
  const exited = new Promise<ChildExit>((resolve) => {
    child.once("error", (error) => {
      observedExit = { kind: "error", error };
      resolve(observedExit);
    });
    child.once("exit", (code, signal) => {
      observedExit = { kind: "exit", code, signal };
      resolve(observedExit);
    });
  });
  child.unref();

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await terminateChild(child, exited);
      throw new Error("packaged daemon readiness deadline exceeded; on macOS, check the Keychain access prompt for inboxd-daemon");
    }
    if (await daemonIsReady(options.socketPath, Math.min(STATUS_PROBE_TIMEOUT_MS, remaining))) {
      return "started";
    }
    if (observedExit !== undefined) {
      const finalRemaining = deadline - Date.now();
      if (finalRemaining > 0 && await daemonIsReady(options.socketPath, Math.min(STATUS_PROBE_TIMEOUT_MS, finalRemaining))) {
        return "already-running";
      }
      throw new Error(describeExit(observedExit));
    }
    await Promise.race([delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))), exited]);
  }
}
