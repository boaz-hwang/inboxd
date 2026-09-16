import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

import { createDaemon } from "../src/main.ts";
import { removeStaleSocket } from "../src/lifecycle.ts";
import { createDaemonFixture } from "./fixtures/daemon-fixture.ts";

const fixtures: ReturnType<typeof createDaemonFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });

function fixture() { const value = createDaemonFixture(); fixtures.push(value); return value; }

describe("single daemon owner", () => {
  test("concurrent starts yield exactly one database owner", async () => {
    const state = fixture();
    const options = { socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider };
    const [first, second] = await Promise.allSettled([createDaemon(options), createDaemon(options)]);
    const started = [first, second].filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof createDaemon>>> => result.status === "fulfilled");
    expect(started).toHaveLength(1);
    expect([first, second].filter((result) => result.status === "rejected")).toHaveLength(1);
    await started[0]!.value.stop();
  });

  test("stale socket cleanup never unlinks a reachable active owner", async () => {
    const state = fixture();
    const daemon = await createDaemon({ socketPath: state.socketPath, databasePath: state.databasePath, keyProvider: state.keyProvider });
    expect(await removeStaleSocket(state.socketPath)).toBe(false);
    expect(existsSync(state.socketPath)).toBe(true);
    await daemon.stop();
  });

  test("removes an unreachable stale socket only", async () => {
    const state = fixture();
    const stale = createServer();
    await new Promise<void>((resolve) => stale.listen(state.socketPath, resolve));
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    expect(existsSync(state.socketPath)).toBe(true);
    expect(await removeStaleSocket(state.socketPath)).toBe(true);
    expect(existsSync(state.socketPath)).toBe(false);
  });

  test("fails before sync or platform I/O when encrypted open fails", async () => {
    const state = fixture();
    let syncCalls = 0;
    let platformCalls = 0;
    await expect(createDaemon({
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: { getKey: () => { throw new Error("key unavailable"); } },
      startSync: async () => { syncCalls++; },
      startPlatform: async () => { platformCalls++; },
    })).rejects.toThrow();
    expect(syncCalls).toBe(0);
    expect(platformCalls).toBe(0);
    expect(existsSync(state.socketPath)).toBe(false);
  });
});
