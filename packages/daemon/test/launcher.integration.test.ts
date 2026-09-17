import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { connectUdsTransport } from "../../cli/src/transport.ts";
import { ReconnectingProtocolClient } from "../../protocol/src/index.ts";
import { loadDaemonConfig, launchDaemon, type DaemonConfig } from "../src/launcher.ts";
import { readLocalApproverToken } from "../src/main.ts";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.();
});

describe("shipped daemon launcher", () => {
  test("owner-only reader bindings launch bounded Slack and Kakao reads over real UDS", async () => {
    const root = mkdtempSync("/private/tmp/inboxd-read-launch-");
    const scope = { account: "stable:account", chat_id: "stable:chat" };
    const config = { version: 1, state_dir: root, database_path: join(root, "db"), socket_path: join(root, "sock"), keychain: { service: "test", account: "test" },
      readers: { slack: { binding: "slack-local", allowed_chats: [scope] }, kakao: { binding: "kakao-local", allowed_chats: [scope], max_measurement_age: 10 } } };
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    const calls: string[] = [];
    const launched = await launchDaemon(loadDaemonConfig(path), { keyProvider: { getKey: () => "read-launch-test" }, now: () => 100,
      readerBindings: {
        slack: { "slack-local": () => ({ authenticatedRunner: async (request) => {
          calls.push("slack"); expect(request.max_pages).toBe(1); expect(request.limit).toBe(100);
          return { status: "ok", ...scope, self_id: "self", unread_count: 0, next_cursor: null,
            events: [{ channel_id: scope.chat_id, message_id: "s1", author_id: "self", ts: 20, body: "slack" }] };
        } }) },
        kakao: { "kakao-local": () => ({ measurement: { schema_version: "kakao-contrib-read-measurement/v1", kind: "kakao-read-field-measurement", status: "VALIDATED", observation: "observed", source: "authorized-live-measurement", observed_at: 100, send: false, supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body"] },
          reader: async (request) => { calls.push("kakao"); expect(request.max_pages).toBe(1); return [{ account_id: scope.account, chat_id: scope.chat_id, message_id: "k1", author_id: "someone", ts: 20, body: "kakao" }]; } }) },
      },
    });
    stops.push(launched.stop);
    const client = new ReconnectingProtocolClient({ role: "reader", connect: () => connectUdsTransport(launched.socketPath) });
    try {
      await client.start([]);
      expect(await client.request("chat.list", {})).toMatchObject({ chats: [{ platform: "kakao", ...scope }, { platform: "slack", ...scope }] });
      const uncollected = await client.request("message.recent", { chats: [{ platform: "slack", ...scope }], interval: { from_ts: 10, to_ts: 90 } });
      expect(uncollected.messages).toEqual([]);
      expect(uncollected.coverage).toMatchObject([{ covered: [], limits: [], gaps: [{ interval: { from_ts: 10, to_ts: 90 }, reason: "unknown" }] }]);
      for (const platform of ["slack", "kakao"]) {
        await expect(client.request("sync.backfill", { platform, ...scope, from_ts: 10, to_ts: 90 })).rejects.toThrow(/approver/i);
      }
      expect(calls).toEqual([]);
      const owner = new ReconnectingProtocolClient({ role: "approver", isTTY: () => true, approverToken: readLocalApproverToken(launched.socketPath), connect: () => connectUdsTransport(launched.socketPath) });
      try {
        await owner.start([]);
        for (const platform of ["slack", "kakao"]) {
          expect(await owner.request("sync.backfill", { platform, ...scope, from_ts: 10, to_ts: 90 })).toMatchObject({ event_count: 1, authoritative: false });
        const recent = await client.request("message.recent", { chats: [{ platform, ...scope }], interval: { from_ts: 10, to_ts: 90 } });
        expect(recent.messages).toHaveLength(1);
      }
      } finally { owner.stop(); }
      expect(calls).toEqual(["slack", "kakao"]);
    } finally { client.stop(); }
  });

  test.each([
    { token: null }, { send: true }, { allowed_chats: [] },
    { allowed_chats: [{ account: "display-name", chat_id: "stable:c" }] },
    { allowed_chats: [{ account: "stable:a", chat_id: "stable:c", token: null }] },
    { allowed_chats: Array.from({ length: 101 }, (_, index) => ({ account: "stable:a", chat_id: `stable:c${index}` })) },
    { allowed_chats: [{ account: "stable:a", chat_id: "stable:c" }, { account: "stable:a", chat_id: "stable:c" }] },
    { binding: "../module" },
  ])("rejects unsafe reader configuration before factory/key-provider I/O %#", async (invalid) => {
    const root = mkdtempSync("/tmp/inboxd-config-deny-");
    let calls = 0;
    const config = { version: 1, state_dir: root, database_path: join(root, "db"), socket_path: join(root, "sock"), keychain: { service: "test", account: "test" },
      readers: { slack: { binding: "local", allowed_chats: [{ account: "stable:a", chat_id: "stable:c" }], ...invalid } } };
    await expect(launchDaemon(config as DaemonConfig, { keyProvider: { getKey: () => { calls++; return "test-only-key"; } },
      readerBindings: { slack: { local: () => { calls++; return { authenticatedRunner: async () => { throw new Error("not reached"); } }; } } },
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("unresolved reader bindings fail before any factory or encrypted-store initialization", async () => {
    const root = mkdtempSync("/tmp/inboxd-bind-deny-");
    const reader = { binding: "local", allowed_chats: [{ account: "stable:a", chat_id: "stable:c" }] };
    const config: DaemonConfig = { version: 1, state_dir: root, database_path: join(root, "db"), socket_path: join(root, "sock"), keychain: { service: "test", account: "test" }, readers: { slack: reader, kakao: { ...reader, max_measurement_age: 10 } } };
    let factories = 0;
    let opens = 0;
    await expect(launchDaemon(config, { keyProvider: { getKey: () => { opens++; return "test-only-key"; } },
      readerBindings: { slack: { local: () => { factories++; return { authenticatedRunner: async () => { throw new Error("not reachable"); } }; } } },
    })).rejects.toThrow("binding is unavailable");
    expect(factories).toBe(0);
    expect(opens).toBe(0);
  });

  test("loads only an owner-only regular config with bounded local paths", () => {
    const root = mkdtempSync(join(tmpdir(), "inboxd-launcher-config-"));
    const path = join(root, "config.json");
    const config: DaemonConfig = {
      version: 1,
      state_dir: root,
      database_path: join(root, "inboxd.db"),
      socket_path: join(root, "sock"),
      keychain: { service: "inboxd-test", account: "owner" },
    };
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    expect(loadDaemonConfig(path)).toEqual(config);

    chmodSync(path, 0o644);
    expect(() => loadDaemonConfig(path)).toThrow("owner-only");
    chmodSync(path, 0o600);
    const link = join(root, "config-link.json");
    symlinkSync(path, link);
    expect(() => loadDaemonConfig(link)).toThrow("regular file");
  });

  test("starts and stops the real UDS daemon from validated config", async () => {
    const root = mkdtempSync("/tmp/inboxd-launch-");
    const launched = await launchDaemon({
      version: 1,
      state_dir: root,
      database_path: join(root, "inboxd.db"),
      socket_path: join(root, "sock"),
      keychain: { service: "unused-in-test", account: "unused-in-test" },
    }, { keyProvider: { getKey: () => "launcher-test-key" } });
    stops.push(launched.stop);

    const client = new ReconnectingProtocolClient({ role: "reader", connect: () => connectUdsTransport(launched.socketPath) });
    await client.start([]);
    expect(await client.request("system.ping", {})).toEqual({ pong: true });
    expect(await client.request("system.status", {})).toMatchObject({ ready: true, owner: "daemon" });
    client.stop();
  });
});
