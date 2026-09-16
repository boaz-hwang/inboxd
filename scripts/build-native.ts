import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const cargo = process.env.CARGO ?? Bun.which("cargo") ?? join(homedir(), ".cargo", "bin", "cargo");
const targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
const result = Bun.spawnSync({
  cmd: [cargo, "build", "--locked", "--release", "-p", "inboxd-core"],
  cwd: root,
  env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
  stdout: "inherit",
  stderr: "inherit",
});
if (result.exitCode !== 0) process.exit(result.exitCode);

const extension = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
const source = join(targetDirectory, "release", process.platform === "win32" ? `inboxd_core.${extension}` : `libinboxd_core.${extension}`);
const destinationDirectory = join(root, "packages", "native", "native");
mkdirSync(destinationDirectory, { recursive: true });
const destination = join(destinationDirectory, `libinboxd_core.${extension}`);
const temporary = join(destinationDirectory, `.${process.pid}-${Date.now()}-libinboxd_core.${extension}`);
try {
  copyFileSync(source, temporary);
  // rename is atomic within this directory: a failed copy leaves the prior
  // working native library untouched.
  renameSync(temporary, destination);
} finally {
  rmSync(temporary, { force: true });
}
