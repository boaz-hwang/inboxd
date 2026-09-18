import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { RustDaemonHarness } from "../../../test/helpers/rust-daemon-harness.ts";

const harnesses: RustDaemonHarness[] = [];
const describeWithRustDaemon = process.env.INBOXD_DAEMON_BIN ? describe : describe.skip;

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.dispose();
});

describeWithRustDaemon("real CLI Rust daemon process lifecycle", () => {
  test.each([
    ["success", ["daemon", "status"], 0],
    ["remote failure", ["sync", "backfill", JSON.stringify({ platform: "slack", account: "stable:a", chat_id: "stable:c", from_ts: 1, to_ts: 2 })], 1],
  ] as const)("closes its UDS and exits after %s", async (_label, argv, exitCode) => {
    const harness = new RustDaemonHarness();
    harnesses.push(harness);
    await harness.start();
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/bin.ts"), ...argv], {
      env: { ...process.env, HOME: harness.root },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race([child.exited.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1500); })]);
      if (!exited) child.kill();
      await child.exited;
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      if (exitCode === 0) expect(JSON.parse(stdout)).toMatchObject({ ready: true, owner: "daemon" });
      else expect(stderr).toContain("approver role is required");
      expect(exited).toBe(true);
      expect(child.exitCode).toBe(exitCode);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  });
});
