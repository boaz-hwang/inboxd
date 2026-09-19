import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwnerToken } from "../src/owner-token.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("local delegation accepts only an owner-only regular token and rejects symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "inboxd-owner-token-"));
  roots.push(root);
  const tokenPath = join(root, "approver.token");
  const socketPath = join(root, "sock");
  const token = "owner".repeat(8);
  writeFileSync(tokenPath, token, { mode: 0o600 });
  expect(readOwnerToken(socketPath)).toBe(token);
  chmodSync(tokenPath, 0o644);
  expect(() => readOwnerToken(socketPath)).toThrow(/owner-only/);
  rmSync(tokenPath);
  const actual = join(root, "actual");
  writeFileSync(actual, token, { mode: 0o600 });
  symlinkSync(actual, tokenPath);
  expect(() => readOwnerToken(socketPath)).toThrow(/symlink/);
  rmSync(tokenPath);
  writeFileSync(tokenPath, "x".repeat(4097), { mode: 0o600 });
  expect(() => readOwnerToken(socketPath)).toThrow(/owner-only/);
  writeFileSync(tokenPath, "short", { mode: 0o600 });
  expect(() => readOwnerToken(socketPath)).toThrow(/invalid/);
});
