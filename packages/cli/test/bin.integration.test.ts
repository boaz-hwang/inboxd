import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { launchDaemon } from "../../daemon/src/launcher.ts";

test.each([
  ["success", ["daemon", "status"], 0],
  ["remote failure", ["sync", "backfill", JSON.stringify({ platform: "slack", account: "stable:a", chat_id: "stable:c", from_ts: 1, to_ts: 2 })], 1],
] as const)("real CLI closes its UDS and exits after %s", async (_label, argv, exitCode) => {
  const home = mkdtempSync("/tmp/inboxd-cli-bin-");
  const state = join(home, ".inboxd");
  const daemon = await launchDaemon({ version: 1, state_dir: state, database_path: join(state, "db"), socket_path: join(state, "sock"), keychain: { service: "test", account: "test" } }, { keyProvider: { getKey: () => "cli-bin-test-key" } });
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/bin.ts"), ...argv], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = await Promise.race([child.exited.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1500); })]);
    if (!exited) child.kill();
    await child.exited;
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    if (exitCode === 0) expect(JSON.parse(stdout)).toMatchObject({ ready: true });
    else expect(stderr).toContain("approver role is required");
    expect(exited).toBe(true);
    expect(child.exitCode).toBe(exitCode);
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    await daemon.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
