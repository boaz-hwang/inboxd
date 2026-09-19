import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { ensureFirstRunConfiguration, type FirstRunDependencies } from "../src/setup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(process.env.HOME!, ".inboxd-setup-test-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return {
    root,
    state: join(root, "state"),
    config: join(root, "config.json"),
    database: join(root, "state", "inboxd.db"),
    socket: join(root, "state", "sock"),
  };
}

function dependencies(calls: string[]): FirstRunDependencies {
  return {
    isInteractive: () => true,
    initializeKeychain: async () => { calls.push("keychain"); },
    selectProvider: async () => { calls.push("select"); return "finish"; },
    connectTelegram: async () => { throw new Error("not selected"); },
    connectSlack: async () => { throw new Error("not selected"); },
    report: message => { calls.push(`report:${message}`); },
  };
}

test("first run initializes Keychain and writes an owner-only base configuration", async () => {
  const paths = fixture();
  const calls: string[] = [];
  await ensureFirstRunConfiguration(paths, dependencies(calls));
  expect(calls).toEqual(["keychain", "select"]);
  expect(lstatSync(paths.state).mode & 0o777).toBe(0o700);
  expect(lstatSync(paths.config).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(paths.config, "utf8"))).toEqual({
    version: 1,
    state_dir: paths.state,
    database_path: paths.database,
    socket_path: paths.socket,
    keychain: { service: "com.inboxd.database", account: "default" },
    providers: [],
  });
});

test("an existing owner-only configuration is never overwritten or re-prompted", async () => {
  const paths = fixture();
  mkdirSync(paths.state, { mode: 0o700 });
  await Bun.write(paths.config, "preserve");
  chmodSync(paths.config, 0o600);
  const calls: string[] = [];
  await ensureFirstRunConfiguration(paths, dependencies(calls));
  expect(calls).toEqual([]);
  expect(readFileSync(paths.config, "utf8")).toBe("preserve");
});

test("KakaoTalk selection reports its evidence requirements without fabricating a connection", async () => {
  const paths = fixture();
  const calls: string[] = [];
  const deps = dependencies(calls);
  let selections = 0;
  await ensureFirstRunConfiguration(paths, {
    ...deps,
    selectProvider: async () => selections++ === 0 ? "kakao" : "finish",
  });
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  expect(config.providers).toEqual([]);
  expect(calls.some(call => call.includes("KakaoTalk"))).toBeTrue();
});
