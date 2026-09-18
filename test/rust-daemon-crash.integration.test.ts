import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectUdsTransport } from "../packages/cli/src/transport.ts";
import {
  ReconnectingProtocolClient,
  type ProtocolMessage,
  type ProtocolTransport,
} from "../packages/protocol/src/index.ts";
import {
  FIXTURE_CHAT,
  RawUdsConnection,
  RustDaemonHarness,
  TEST_DATABASE_KEY_HEX,
  runRustDaemonOnce,
  waitFor,
} from "./helpers/rust-daemon-harness.ts";

const harnesses: RustDaemonHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.dispose();
});

async function fixture(): Promise<RustDaemonHarness> {
  const harness = new RustDaemonHarness();
  harnesses.push(harness);
  await harness.start();
  return harness;
}

async function retryTransport(socketPath: string): Promise<ProtocolTransport> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await connectUdsTransport(socketPath);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(10);
    }
  }
}

describe("release Rust daemon crash and restart lifecycle", () => {
  test("accepts only the exact owner-only config contract and the feature-gated 32-byte test key", async () => {
    const root = mkdtempSync(join(tmpdir(), "inboxd-rust-config-"));
    const state = join(root, "state");
    const base = {
      version: 1,
      state_dir: state,
      database_path: join(state, "db"),
      socket_path: join(state, "sock"),
      keychain: { service: "inboxd-test", account: "fixture" },
    };
    const env = { INBOXD_TEST_DATABASE_KEY_HEX: TEST_DATABASE_KEY_HEX };
    try {
      const usage = await runRustDaemonOnce([], { env });
      expect(usage.code).not.toBe(0);
      expect(usage.stderr).toContain("usage: inboxd-daemon --config <owner-only-config.json>");

      const invalid: Array<{ name: string; config: Record<string, unknown>; mode?: number; key?: string }> = [
        { name: "unknown-field", config: { ...base, executable: "/tmp/provider" } },
        { name: "raw-key", config: { ...base, database_key: TEST_DATABASE_KEY_HEX } },
        { name: "wrong-version", config: { ...base, version: 2 } },
        { name: "escaped-database", config: { ...base, database_path: join(root, "outside.db") } },
        { name: "world-readable", config: base, mode: 0o644 },
        { name: "short-key", config: base, key: TEST_DATABASE_KEY_HEX.slice(2) },
        { name: "non-hex-key", config: base, key: "z".repeat(64) },
      ];
      for (const scenario of invalid) {
        const path = join(root, `${scenario.name}.json`);
        writeFileSync(path, JSON.stringify(scenario.config), { mode: scenario.mode ?? 0o600 });
        const result = await runRustDaemonOnce(["--config", path], {
          env: { INBOXD_TEST_DATABASE_KEY_HEX: scenario.key ?? TEST_DATABASE_KEY_HEX },
        });
        expect(result.code, scenario.name).not.toBe(0);
        expect(result.stderr, scenario.name).not.toContain(TEST_DATABASE_KEY_HEX);
        expect(result.stdout, scenario.name).not.toContain(TEST_DATABASE_KEY_HEX);
      }

      const target = join(root, "target.json");
      const link = join(root, "config-link.json");
      writeFileSync(target, JSON.stringify(base), { mode: 0o600 });
      symlinkSync(target, link);
      const linked = await runRustDaemonOnce(["--config", link], { env });
      expect(linked.code).not.toBe(0);
      expect(linked.stderr).toMatch(/regular file|symlink/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reclaims crash-stale socket and lock, preserves a private token, and cleans up on bounded signals", async () => {
    const harness = await fixture();
    harness.assertPrivateArtifacts();
    const token = harness.token();

    const duplicate = await runRustDaemonOnce(["--config", harness.configPath], {
      env: { INBOXD_TEST_DATABASE_KEY_HEX: TEST_DATABASE_KEY_HEX },
    });
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.stderr).toMatch(/already owns|already reachable/i);

    const crashed = await harness.crash();
    expect(crashed.code).not.toBe(0);
    expect(existsSync(harness.socketPath)).toBeTrue();
    expect(existsSync(join(harness.stateDir, "inboxd.lock"))).toBeTrue();
    expect(existsSync(join(harness.stateDir, "approver.token"))).toBeTrue();

    await harness.start();
    harness.assertPrivateArtifacts();
    expect(harness.token()).toBe(token);
    const connection = await RawUdsConnection.connect(harness.socketPath);
    await connection.request("hello", "system.hello", { role: "reader" });
    expect(await connection.request("ping", "system.ping", {})).toMatchObject({ ok: true, result: { pong: true } });
    connection.close();

    const stopped = await harness.stop();
    expect(stopped.code).toBe(0);
    expect(existsSync(harness.socketPath)).toBeFalse();
    expect(existsSync(join(harness.stateDir, "inboxd.lock"))).toBeFalse();
    expect(existsSync(join(harness.stateDir, "approver.token"))).toBeTrue();

    chmodSync(join(harness.stateDir, "approver.token"), 0o644);
    const refused = await runRustDaemonOnce(["--config", harness.configPath], {
      env: { INBOXD_TEST_DATABASE_KEY_HEX: TEST_DATABASE_KEY_HEX },
    });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/owner-only/i);
    expect(existsSync(join(harness.stateDir, "inboxd.lock"))).toBeFalse();
    chmodSync(join(harness.stateDir, "approver.token"), 0o600);

    await harness.start();
    expect(harness.token()).toBe(token);
  });

  test("reconnects with generation fencing, requires re-query, and never replays a committed action", async () => {
    const harness = await fixture();
    const restartReady = Promise.withResolvers<void>();
    const listeners: Array<(message: ProtocolMessage) => void> = [];
    let connections = 0;
    let actionSends = 0;
    let crashed = false;
    let freshRequestId: string | undefined;
    let heldFresh: ProtocolMessage | undefined;

    const client = new ReconnectingProtocolClient({
      role: "agent",
      connect: async () => {
        const generation = connections++;
        if (generation > 0) await restartReady.promise;
        const transport = await retryTransport(harness.socketPath);
        return {
          send(message) {
            if (message.type === "request" && message.method === "safety.intent.create") actionSends++;
            if (generation === 1 && message.type === "request" && message.method === "system.status") freshRequestId = message.id;
            transport.send(message);
          },
          onMessage(listener) {
            listeners[generation] = listener;
            return transport.onMessage((message) => {
              if (!crashed && generation === 0 && message.type === "response" && message.method === "safety.intent.create") {
                crashed = true;
                transport.close();
                void (async () => {
                  await harness.crash();
                  await harness.start();
                  restartReady.resolve();
                })();
                return;
              }
              if (generation === 1 && message.type === "response" && message.id === freshRequestId) {
                heldFresh = message;
                return;
              }
              listener(message);
            });
          },
          onClose: (listener) => transport.onClose(listener),
          close: () => transport.close(),
        } satisfies ProtocolTransport;
      },
    });

    try {
      await client.start([]);
      const dispatched = client.request("safety.intent.create", { actor: "agent:crash", scope: FIXTURE_CHAT, body: "commit once" });
      await expect(dispatched).rejects.toThrow(/connection/i);
      await restartReady.promise;
      await waitFor(() => client.ready && connections === 2);
      expect(client.requeryRequired).toBeTrue();
      expect(actionSends).toBe(1);
      expect(await client.request("chat.list", {})).toEqual({ chats: [] });

      const fresh = client.request("system.status", {});
      let freshSettled = false;
      void fresh.finally(() => { freshSettled = true; });
      await waitFor(() => heldFresh !== undefined && freshRequestId !== undefined);
      listeners[0]!(heldFresh!);
      await Bun.sleep(50);
      expect(freshSettled).toBeFalse();
      listeners[1]!(heldFresh!);
      expect(await fresh).toMatchObject({ ready: true, owner: "daemon" });

      const owner = await RawUdsConnection.connect(harness.socketPath);
      await owner.request("owner-hello", "system.hello", { role: "approver", approver_token: harness.token() });
      const pending = await owner.request("pending", "safety.intent.listPending", {});
      expect(pending.result.intents).toHaveLength(1);
      expect(pending.result.intents[0]).toMatchObject({ actor: "agent:crash", state: "Proposed" });
      owner.close();
    } finally {
      client.stop();
    }
  });
});
