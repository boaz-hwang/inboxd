import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { validatePackagedDaemonBinary } from "../packages/cli/src/daemon-launcher.ts";

const root = resolve(import.meta.dir, "..");
const defaultExecutablePath = join(root, "target", "inboxd-product", "release", "inboxd-daemon");
const usage = "usage: bun run daemon -- [--config <path>]";

type DaemonSignal = "SIGINT" | "SIGTERM";

export interface DaemonSignalSource {
  on(signal: DaemonSignal, handler: () => void): void;
  off(signal: DaemonSignal, handler: () => void): void;
}

interface DaemonChild {
  readonly exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

interface DaemonSpawnOptions {
  readonly stdin: "inherit";
  readonly stdout: "inherit";
  readonly stderr: "inherit";
}

export interface RunPackagedDaemonDependencies {
  readonly executablePath?: string;
  readonly signals?: DaemonSignalSource;
  readonly spawn?: (command: readonly string[], options: DaemonSpawnOptions) => DaemonChild;
}

export function daemonConfigPath(arguments_: readonly string[], home = homedir()): string {
  if (arguments_.length === 0) return join(home, ".inboxd", "config.json");
  if (arguments_.length === 2 && arguments_[0] === "--config" && arguments_[1]!.length > 0) {
    return arguments_[1]!;
  }
  throw new Error(usage);
}


function spawnDaemon(command: readonly string[], options: DaemonSpawnOptions): DaemonChild {
  const child = Bun.spawn({
    cmd: [...command],
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  });
  return {
    exited: child.exited,
    kill(signal) {
      child.kill(signal);
    },
  };
}

const processSignals: DaemonSignalSource = {
  on(signal, handler) {
    process.on(signal, handler);
  },
  off(signal, handler) {
    process.off(signal, handler);
  },
};

export async function runPackagedDaemon(
  arguments_: readonly string[],
  dependencies: RunPackagedDaemonDependencies = {},
): Promise<number> {
  const configPath = daemonConfigPath(arguments_);
  const executablePath = dependencies.executablePath ?? defaultExecutablePath;
  try {
    validatePackagedDaemonBinary(executablePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "cannot be inspected";
    throw new Error(`packaged inboxd-daemon is missing or untrusted; run bun run build:product first: ${reason}`);
  }

  const child = (dependencies.spawn ?? spawnDaemon)(
    [executablePath, "--config", configPath],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  const signals = dependencies.signals ?? processSignals;
  const forwarders = new Map<DaemonSignal, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const forward = () => {
      try {
        child.kill(signal);
      } catch {
        // The foreground child may have already exited after the terminal sent
        // the same signal to its process group.
      }
    };
    forwarders.set(signal, forward);
    signals.on(signal, forward);
  }

  try {
    return await child.exited;
  } finally {
    for (const [signal, forward] of forwarders) signals.off(signal, forward);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runPackagedDaemon(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unable to launch packaged inboxd-daemon";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
