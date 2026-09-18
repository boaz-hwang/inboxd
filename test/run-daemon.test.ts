import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  daemonConfigPath,
  runPackagedDaemon,
  type DaemonSignalSource,
} from "../scripts/run-daemon.ts";

const root = resolve(import.meta.dir, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "inboxd-run-daemon-"));
const fakeExecutable = join(temporaryRoot, "inboxd-daemon");
writeFileSync(fakeExecutable, "not invoked by the injected spawn fixture\n", { mode: 0o700 });
chmodSync(fakeExecutable, 0o700);

class FakeSignals implements DaemonSignalSource {
  readonly handlers = new Map<NodeJS.Signals, Set<() => void>>();

  on(signal: "SIGINT" | "SIGTERM", handler: () => void): void {
    const handlers = this.handlers.get(signal) ?? new Set<() => void>();
    handlers.add(handler);
    this.handlers.set(signal, handlers);
  }

  off(signal: "SIGINT" | "SIGTERM", handler: () => void): void {
    this.handlers.get(signal)?.delete(handler);
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    for (const handler of this.handlers.get(signal) ?? []) handler();
  }
}

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("packaged Rust daemon launcher", () => {
  test("uses the default config and accepts only one exact --config argument pair", () => {
    expect(daemonConfigPath([], "/Users/example")).toBe("/Users/example/.inboxd/config.json");
    expect(daemonConfigPath(["--config", "relative/../literal config.json"], "/unused"))
      .toBe("relative/../literal config.json");
    expect(() => daemonConfigPath(["--help"], "/unused")).toThrow(
      "usage: bun run daemon -- [--config <path>]",
    );
    expect(() => daemonConfigPath(["--config", ""], "/unused")).toThrow(
      "usage: bun run daemon -- [--config <path>]",
    );
    expect(() => daemonConfigPath(["--config", "a", "extra"], "/unused")).toThrow(
      "usage: bun run daemon -- [--config <path>]",
    );
  });

  test("spawns the packaged daemon directly with inherited stdio and preserves its exit code", async () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.daemon).toBe("bun scripts/run-daemon.ts");

    const commands: string[][] = [];
    const options: unknown[] = [];
    const signals = new FakeSignals();
    const code = await runPackagedDaemon(["--config", "relative/../literal config.json"], {
      executablePath: fakeExecutable,
      signals,
      spawn(command, spawnOptions) {
        commands.push([...command]);
        options.push(spawnOptions);
        return { exited: Promise.resolve(23), kill: () => {} };
      },
    });

    expect(code).toBe(23);
    expect(commands).toEqual([[
      fakeExecutable,
      "--config",
      "relative/../literal config.json",
    ]]);
    expect(options).toEqual([{ stdin: "inherit", stdout: "inherit", stderr: "inherit" }]);
    expect(signals.handlers.get("SIGINT")?.size ?? 0).toBe(0);
    expect(signals.handlers.get("SIGTERM")?.size ?? 0).toBe(0);
  });

  test("fails closed before spawning when the packaged bundle executable is missing", async () => {
    let spawnCalls = 0;
    await expect(runPackagedDaemon([], {
      executablePath: join(temporaryRoot, "missing-daemon"),
      signals: new FakeSignals(),
      spawn() {
        spawnCalls += 1;
        return { exited: Promise.resolve(0), kill: () => {} };
      },
    })).rejects.toThrow(/packaged inboxd-daemon.*missing/i);
    expect(spawnCalls).toBe(0);
  });

  test("forwards SIGINT and SIGTERM to the foreground child and removes handlers after exit", async () => {
    const signals = new FakeSignals();
    const completion = Promise.withResolvers<number>();
    const forwarded: NodeJS.Signals[] = [];
    const running = runPackagedDaemon([], {
      executablePath: fakeExecutable,
      signals,
      spawn() {
        return {
          exited: completion.promise,
          kill(signal) {
            forwarded.push(signal);
          },
        };
      },
    });

    await Bun.sleep(0);
    expect(signals.handlers.get("SIGINT")?.size).toBe(1);
    expect(signals.handlers.get("SIGTERM")?.size).toBe(1);
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    expect(forwarded).toEqual(["SIGINT", "SIGTERM"]);
    completion.resolve(0);
    expect(await running).toBe(0);
    expect(signals.handlers.get("SIGINT")?.size ?? 0).toBe(0);
    expect(signals.handlers.get("SIGTERM")?.size ?? 0).toBe(0);
  });
});
