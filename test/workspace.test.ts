import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const workspaces = [
  "packages/core",
  "packages/store",
  "packages/sync",
  "packages/safety",
  "packages/protocol",
  "packages/daemon",
  "packages/cli",
  "packages/tui",
  "packages/mcp",
  "platforms/slack",
  "contrib/kakao",
];

describe("workspace bootstrap", () => {
  test("declares every planned package", () => {
    for (const workspace of workspaces) {
      expect(existsSync(join(root, workspace, "package.json"))).toBe(true);
    }
  });

  test("provides the dependency-boundary checker", () => {
    expect(existsSync(join(root, "scripts/check-boundaries.ts"))).toBe(true);
  });
});
