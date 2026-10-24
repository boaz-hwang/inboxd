import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionRegistry } from "../src/contracts.ts";
import { saveConnection } from "../src/private-config.ts";

test("driver registry rejects duplicates and dispatches exact provider", async () => {
  const driver = { id: "slack" as const, label: "Slack", connect: async () => ({ kind: "slack", binding_id: "a" }) };
  expect(() => new ConnectionRegistry([driver, driver])).toThrow();
  const registry = new ConnectionRegistry([driver]);
  expect(() => registry.connect("unknown")).toThrow();
  expect(await registry.connect("slack")).toEqual({ kind: "slack", binding_id: "a" });
});
test("save connection preserves other bindings and rejects public configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "inboxd-connect-"));
  const path = join(root, "config.json");
  try {
    writeFileSync(path, JSON.stringify({ version: 1, providers: [{ kind: "telegram", binding_id: "original" }], state_dir: "state" }), { mode: 0o600 });
    saveConnection(path, { kind: "slack", binding_id: "new" });
    saveConnection(path, { kind: "slack", binding_id: "new", account: "updated" });
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.providers).toHaveLength(2);
    expect(config.providers[0].binding_id).toBe("original");
    expect(config.providers[1].account).toBe("updated");
    expect(config.state_dir).toBe("state");
  } finally { rmSync(root, { recursive: true }); }
});

test("reconnecting Slack replaces legacy room bindings for that account only", () => {
  const root = mkdtempSync(join(tmpdir(), "inboxd-connect-"));
  const path = join(root, "config.json");
  try {
    const unrelated = [
      { kind: "telegram", binding_id: "telegram", account: "one" },
      { kind: "slack", binding_id: "other-slack", account: "two" },
    ];
    writeFileSync(path, JSON.stringify({ version: 1, providers: [
      ...unrelated,
      { kind: "slack", binding_id: "old-room-a", account: "one", credentials: "stale" },
      { kind: "slack", binding_id: "old-room-b", account: "one", credentials: "stale" },
    ] }), { mode: 0o600 });
    const connected = { kind: "slack", binding_id: "self-chat", account: "one", credentials: "fresh" };
    saveConnection(path, connected);
    saveConnection(path, connected);
    expect(JSON.parse(readFileSync(path, "utf8")).providers).toEqual([...unrelated, connected]);
  } finally { rmSync(root, { recursive: true }); }
});

test("Slack users in one workspace coexist and reauthentication preserves legacy history keys", () => {
  const root = mkdtempSync(join(tmpdir(), "inboxd-connect-"));
  const path = join(root, "config.json");
  const first = { kind: "slack", team_id: "T1", user_id: "U1", account: "slack:team:T1", binding_id: "legacy", bot_token: "old" };
  const second = { kind: "slack", team_id: "T1", user_id: "U2", account: "slack:team:T1:user:U2", binding_id: "second", bot_token: "other" };
  try {
    writeFileSync(path, JSON.stringify({ version: 1, providers: [first] }), { mode: 0o600 });
    saveConnection(path, second);
    saveConnection(path, { ...first, account: "slack:team:T1:user:U1", binding_id: "new", bot_token: "fresh" });
    expect(JSON.parse(readFileSync(path, "utf8")).providers).toEqual([second, { ...first, bot_token: "fresh" }]);
    const before = readFileSync(path, "utf8");
    expect(() => saveConnection(path, { ...second, user_id: "U3", binding_id: "legacy" })).toThrow("덮어쓸 수 없습니다");
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally { rmSync(root, { recursive: true }); }
});
