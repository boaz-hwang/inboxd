import { describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { assertNativeAbiVersion, coreCall, NATIVE_ABI_VERSION } from "../src/index.ts";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("Rust core Bun FFI bridge", () => {
  test("round-trips wire Unicode and maps unknown operations", () => {
    const text = `before\ud800${String.fromCodePoint(0xf0000)}${String.fromCodePoint(0xf0800)}after`;
    expect(coreCall<{ pong: boolean; input: { text: string } }>("ping", { text })).toEqual({ pong: true, input: { text } });
    expect(() => coreCall("unknown", {})).toThrow(/unknown core operation/i);
  });

  test("keeps callback buffers isolated across repeated and nested pure calls", () => {
    for (let index = 0; index < 8; index++) {
      expect(coreCall<{ pong: boolean; input: { index: number } }>("ping", { index })).toEqual({ pong: true, input: { index } });
    }
    const nested = coreCall<boolean>("host.roundtrip", { method: "host.allowSend", args: { safe: true } }, undefined, {
      allowSend: () => coreCall<{ pong: boolean }>("ping", { nested: "ok" }).pong,
    });
    expect(nested).toBe(true);
  });

  test("preserves structured Unicode errors and rejects missing or wrong ABI versions", () => {
    expect(() => coreCall("host.roundtrip", { method: "없는.호스트", args: {} })).toThrow(/없는\.호스트/);
    const message = `x\ud800${String.fromCodePoint(0xf0000)}`;
    let captured: Error | undefined;
    try { coreCall("host.roundtrip", { method: "host.allowSend", args: null }, undefined, { allowSend: () => { throw new Error(message); } }); }
    catch (error) { captured = error as Error; }
    expect(captured?.name).toBe("Error");
    expect(captured?.message).toBe(message);
    expect(() => assertNativeAbiVersion(undefined)).toThrow(/missing/);
    expect(() => assertNativeAbiVersion(NATIVE_ABI_VERSION + 1)).toThrow(/mismatch/);
  });

  test("round-trips every finite JSON number exactly through ping and timestamp normalization", () => {
    const numbers = [
      2.513903366783964e233,
      5.8956333004974164e-120,
      1700785133613.1575,
      1700687331747.8599,
    ];
    for (const ts of numbers) {
      expect(coreCall<{ input: { ts: number } }>("ping", { ts }).input.ts).toBe(ts);
      const event = coreCall<{ message: { ts: number } }>("domain.normalizeMessageEvent", {
        kind: "create",
        message: { key: { platform: "p", account: "a", chat_id: "c", msg_id: "m" }, author_id: "u", ts, body: "body", attachments: [] },
        revision: { source: "adapter", value: 1 },
      });
      expect(event.message.ts).toBe(ts);
    }
  });

  test("retained production consumers stay pure", () => {
    const packages = join(import.meta.dir, "..", "..");
    const consumers = sourceFiles(packages)
      .filter((path) => relative(packages, path).includes("/src/"))
      .filter((path) => readFileSync(path, "utf8").includes("native/src/index"));
    const retained = consumers;
    expect(retained.map((path) => relative(packages, path)).sort()).toEqual([
      "core/src/capabilities.ts",
      "core/src/coverage.ts",
      "core/src/models.ts",
    ]);
    for (const path of retained) {
      expect(readFileSync(path, "utf8")).not.toMatch(/bun:sqlite|\bDatabase\b/);
    }
  });

  test("does not need cargo or the current project directory at runtime", () => {
    const outside = mkdtempSync(join(tmpdir(), "inboxd-native-runtime-"));
    try {
      const entry = join(import.meta.dir, "..", "src", "index.ts");
      const script = `import { coreCall } from ${JSON.stringify(entry)}; if (!coreCall('ping', {}).pong) process.exit(1);`;
      const result = Bun.spawnSync({ cmd: [process.execPath, "--eval", script], cwd: outside, env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  test("fails actionably when a copied runtime has no native library", () => {
    const outside = mkdtempSync(join(tmpdir(), "inboxd-native-missing-"));
    try {
      const source = join(import.meta.dir, "..", "src", "index.ts");
      const copied = join(outside, "src", "index.ts");
      mkdirSync(join(outside, "src"), { recursive: true });
      copyFileSync(source, copied);
      const script = `import { coreCall } from ${JSON.stringify(copied)}; try { coreCall('ping', {}); process.exit(2); } catch (error) { if (error.name !== 'CoreUnavailableError') process.exit(3); }`;
      const result = Bun.spawnSync({ cmd: [process.execPath, "--eval", script], cwd: outside, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  test("packages the artifact from a configured Cargo target directory", () => {
    const root = join(import.meta.dir, "..", "..", "..");
    const outside = mkdtempSync(join(tmpdir(), "inboxd-native-target-dir-"));
    try {
      for (const file of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) copyFileSync(join(root, file), join(outside, file));
      cpSync(join(root, "crates"), join(outside, "crates"), { recursive: true });
      mkdirSync(join(outside, "scripts"), { recursive: true });
      copyFileSync(join(root, "scripts", "build-native.ts"), join(outside, "scripts", "build-native.ts"));
      const targetDirectory = join(outside, "custom-target");
      const result = Bun.spawnSync({
        cmd: [process.execPath, "scripts/build-native.ts"],
        cwd: outside,
        env: { ...process.env, RUSTFLAGS: "", RUSTDOCFLAGS: "", CARGO: join(process.env.HOME!, ".cargo", "bin", "cargo"), CARGO_TARGET_DIR: targetDirectory },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      const extension = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
      expect(existsSync(join(outside, "packages", "native", "native", `libinboxd_core.${extension}`))).toBeTrue();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  }, 120_000);
});
