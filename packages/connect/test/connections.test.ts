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
