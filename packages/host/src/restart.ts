import { readFileSync, lstatSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { launchPackagedDaemon, type PackagedDaemonLaunchOptions } from "./daemon-launcher.ts";

/** Stop only the owner-local daemon identified by both its lock and executable. */
export async function restartPackagedDaemon(options: PackagedDaemonLaunchOptions & { daemonBinary: string }): Promise<void> {
  const lock = join(dirname(options.socketPath), "inboxd.lock");
  if (existsSync(lock)) {
    const stat = lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error("invalid daemon lock");
    const { pid } = JSON.parse(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid daemon PID");
    const probe = spawnSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    if (probe.status === 0) {
      if (probe.stdout.trim() !== options.daemonBinary) throw new Error("daemon executable identity does not match; restart Inboxd manually");
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 12_000;
      while (existsSync(lock) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (existsSync(lock)) throw new Error("daemon is still shutting down");
    }
  }
  await launchPackagedDaemon(options);
}
