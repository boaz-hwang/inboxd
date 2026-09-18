import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { getTdjson } from "prebuilt-tdlib";

const root = resolve(import.meta.dir, "..");
const executableMode = 0o700;
const manifestMode = 0o600;
const productSchemaVersion = "inboxd-product/v1";
const manifestName = "manifest.json";
const telegramTdjsonName = "inboxd-telegram-libtdjson.dylib";
const telegramTdlAddonDirectory = "prebuilds";
const telegramTdlAddonName = `${telegramTdlAddonDirectory}/darwin-arm64/tdl.node`;
const dependencyLockPaths = ["Cargo.lock", "bun.lock"] as const;
const workerEntrypoints = [
  { name: "inboxd-slack-worker", source: "platforms/slack/src/bin.ts" },
  { name: "inboxd-telegram-worker", source: "platforms/telegram/src/worker-entrypoint.ts" },
  { name: "inboxd-kakao-local-worker", source: "contrib/kakao/src/worker-entrypoint.ts" },
  { name: "inboxd-kakao-message-worker", source: "platforms/kakao-message/src/bin.ts" },
] as const;

interface ManifestFile {
  readonly name: string;
  readonly kind: "daemon" | "worker" | "runtime-library";
  readonly source_entrypoint: string;
  readonly sha256: string;
  readonly size: number;
  readonly mode: "0600" | "0700";
}

function fail(message: string): never {
  throw new Error(`inboxd product build: ${message}`);
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function currentIdentity(): { readonly uid: number; readonly gid: number } {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("production artifacts require macOS arm64");
  }
  if (process.getuid === undefined || process.getgid === undefined) {
    fail("cannot determine the build owner");
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

function assertOwnedPrivateDirectory(path: string, uid: number): void {
  const stat = lstatIfPresent(path);
  if (stat === undefined) fail(`private directory is missing: ${path}`);
  if (stat.isSymbolicLink()) fail(`refusing symlink directory: ${path}`);
  if (!stat.isDirectory()) fail(`expected a directory: ${path}`);
  if (stat.uid !== uid) fail(`directory is not owned by the current user: ${path}`);
  if ((stat.mode & 0o077) !== 0) fail(`directory is not owner-only: ${path}`);
}

function assertNearestExistingComponentIsSafe(path: string, uid: number): void {
  let candidate = path;
  for (;;) {
    const stat = lstatIfPresent(candidate);
    if (stat !== undefined) {
      if (stat.isSymbolicLink()) fail(`refusing symlink destination component: ${candidate}`);
      if (!stat.isDirectory()) fail(`destination component is not a directory: ${candidate}`);
      if (stat.uid !== uid) fail(`destination component is not owned by the current user: ${candidate}`);
      if ((stat.mode & 0o077) !== 0) fail(`destination component is not owner-only: ${candidate}`);
      return;
    }
    const parent = dirname(candidate);
    if (parent === candidate) fail(`cannot find a safe destination parent for ${path}`);
    candidate = parent;
  }
}

function prepareDestination(output: string, uid: number): void {
  if (basename(output).length === 0 || dirname(output) === output) {
    fail("destination must name a product directory");
  }
  const parent = dirname(output);
  assertNearestExistingComponentIsSafe(parent, uid);
  mkdirSync(parent, { recursive: true, mode: executableMode });
  chmodSync(parent, executableMode);
  assertOwnedPrivateDirectory(parent, uid);

  const destination = lstatIfPresent(output);
  if (destination === undefined) return;
  if (destination.isSymbolicLink()) fail(`refusing symlink destination: ${output}`);
  if (!destination.isDirectory()) fail(`destination is not a directory: ${output}`);
  if (destination.uid !== uid) fail(`destination is not owned by the current user: ${output}`);
  if ((destination.mode & 0o077) !== 0) fail(`destination is not owner-only: ${output}`);
}

function commandPath(environmentName: string, commandName: string): string {
  const configured = process.env[environmentName];
  if (configured !== undefined && configured.length > 0) return configured;
  return Bun.which(commandName) ?? join(homedir(), ".cargo", "bin", commandName);
}

function runCommand(label: string, command: readonly string[], extraEnvironment: Record<string, string> = {}): void {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: [...command],
      cwd: root,
      env: { ...process.env, ...extraEnvironment },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    fail(`${label} could not start`);
  }
  if (result.exitCode !== 0) fail(`${label} failed with exit code ${result.exitCode}`);
}

function rustHostTriple(rustc: string): string {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync({
      cmd: [rustc, "-vV"],
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
  } catch {
    fail("rustc target inspection could not start");
  }
  if (result.exitCode !== 0) fail("rustc target inspection failed");
  if (result.stdout === undefined) fail("rustc target inspection produced no output");
  const match = /^host: (.+)$/m.exec(result.stdout.toString());
  if (match === null) fail("rustc did not report a host target triple");
  return match[1]!;
}

function sha256(path: string): string {
  const stat = lstatIfPresent(path);
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
    fail(`cannot hash non-regular file: ${path}`);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dependencyLockHash(): string {
  const hash = createHash("sha256");
  for (const relativePath of dependencyLockPaths) {
    const path = join(root, relativePath);
    const stat = lstatIfPresent(path);
    if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
      fail(`dependency lock is not a regular file: ${relativePath}`);
    }
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function secureRegularFile(path: string, uid: number, gid: number, mode: number): Stats {
  const initial = lstatIfPresent(path);
  if (initial === undefined || !initial.isFile() || initial.isSymbolicLink()) {
    fail(`artifact is not a regular file: ${path}`);
  }
  chownSync(path, uid, gid);
  chmodSync(path, mode);
  const secured = lstatSync(path);
  if (!secured.isFile() || secured.isSymbolicLink() || secured.uid !== uid || (secured.mode & 0o777) !== mode) {
    fail(`artifact ownership or mode could not be secured: ${path}`);
  }
  return secured;
}

function manifestFile(
  directory: string,
  name: string,
  kind: "daemon" | "worker" | "runtime-library",
  sourceEntrypoint: string,
  mode: 0o600 | 0o700,
  uid: number,
  gid: number,
): ManifestFile {
  const path = join(directory, name);
  const stat = secureRegularFile(path, uid, gid, mode);
  return {
    name,
    kind,
    source_entrypoint: sourceEntrypoint,
    sha256: sha256(path),
    size: stat.size,
    mode: mode === 0o700 ? "0700" : "0600",
  };
}

function compileWorker(bun: string, stage: string, name: string, source: string): void {
  const sourcePath = join(root, source);
  const stat = lstatIfPresent(sourcePath);
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
    fail(`worker entrypoint is not a regular file: ${source}`);
  }
  runCommand(`compiling ${name}`, [
    bun,
    "build",
    "--compile",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    "--outfile",
    join(stage, name),
    sourcePath,
  ]);
}

function atomicSwapMacOS(stage: string, destination: string): void {
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    renameatx_np: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  try {
    const atCurrentWorkingDirectory = -2;
    const renameSwap = 0x00000002;
    const stagePath = Buffer.from(`${stage}\0`);
    const destinationPath = Buffer.from(`${destination}\0`);
    const result = library.symbols.renameatx_np(
      atCurrentWorkingDirectory,
      stagePath,
      atCurrentWorkingDirectory,
      destinationPath,
      renameSwap,
    );
    if (result !== 0) fail("atomic product directory swap failed");
  } finally {
    library.close();
  }
}

function publish(stage: string, destination: string, uid: number): void {
  const current = lstatIfPresent(destination);
  if (current === undefined) {
    renameSync(stage, destination);
    return;
  }
  if (current.isSymbolicLink()) fail(`refusing symlink destination: ${destination}`);
  if (!current.isDirectory()) fail(`destination is not a directory: ${destination}`);
  if (current.uid !== uid || (current.mode & 0o077) !== 0) {
    fail(`destination is not an owner-only current-user directory: ${destination}`);
  }
  atomicSwapMacOS(stage, destination);
  rmSync(stage, { recursive: true, force: true });
}

function buildProduct(): void {
  const { uid, gid } = currentIdentity();
  const configuredOutput = process.env.INBOXD_PRODUCT_OUT;
  const output = resolve(root, configuredOutput ?? "target/inboxd-product/release");
  prepareDestination(output, uid);

  const initialDependencyLockHash = dependencyLockHash();
  const cargo = commandPath("CARGO", "cargo");
  const rustc = commandPath("RUSTC", "rustc");
  const bun = process.env.BUN ?? process.execPath;
  const targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR ?? "target");
  const targetTriple = rustHostTriple(rustc);
  if (targetTriple !== "aarch64-apple-darwin") {
    fail(`unsupported Rust target triple: ${targetTriple}`);
  }

  const stage = mkdtempSync(join(dirname(output), `.${basename(output)}.stage-`));
  chmodSync(stage, executableMode);
  assertOwnedPrivateDirectory(stage, uid);
  let published = false;
  try {
    runCommand("release Rust daemon build", [
      cargo,
      "build",
      "--locked",
      "--release",
      "--package",
      "inboxd-daemon",
      "--bin",
      "inboxd-daemon",
      "--no-default-features",
    ], {
      CARGO_TARGET_DIR: targetDirectory,
      CARGO_ENCODED_RUSTFLAGS: "",
      RUSTDOCFLAGS: "",
      RUSTFLAGS: "",
    });

    const daemonSource = join(targetDirectory, "release", "inboxd-daemon");
    const daemonDestination = join(stage, "inboxd-daemon");
    const daemonStat = lstatIfPresent(daemonSource);
    if (daemonStat === undefined || !daemonStat.isFile() || daemonStat.isSymbolicLink()) {
      fail("Cargo did not produce a regular inboxd-daemon release executable");
    }
    copyFileSync(daemonSource, daemonDestination);

    for (const worker of workerEntrypoints) {
      compileWorker(bun, stage, worker.name, worker.source);
    }
    const telegramTdjsonSource = getTdjson();
    const telegramTdjsonStat = lstatIfPresent(telegramTdjsonSource);
    if (telegramTdjsonStat === undefined || !telegramTdjsonStat.isFile() || telegramTdjsonStat.isSymbolicLink()) {
      fail("prebuilt Telegram TDLib runtime is not a regular file");
    }
    copyFileSync(telegramTdjsonSource, join(stage, telegramTdjsonName));
    const tdlEntrypoint = Bun.resolveSync("tdl", join(root, "platforms/telegram"));
    const telegramTdlAddonSource = join(
      dirname(dirname(tdlEntrypoint)),
      "prebuilds/darwin-arm64/tdl.node",
    );
    const telegramTdlAddonStat = lstatIfPresent(telegramTdlAddonSource);
    if (telegramTdlAddonStat === undefined
      || !telegramTdlAddonStat.isFile()
      || telegramTdlAddonStat.isSymbolicLink()) {
      fail("Telegram tdl native addon is not a regular file");
    }
    const telegramTdlAddonPlatform = join(stage, telegramTdlAddonDirectory, "darwin-arm64");
    mkdirSync(telegramTdlAddonPlatform, { recursive: true, mode: executableMode });
    for (const directory of [
      join(stage, telegramTdlAddonDirectory),
      telegramTdlAddonPlatform,
    ]) {
      chownSync(directory, uid, gid);
      chmodSync(directory, executableMode);
      assertOwnedPrivateDirectory(directory, uid);
    }
    copyFileSync(telegramTdlAddonSource, join(stage, telegramTdlAddonName));

    const finalDependencyLockHash = dependencyLockHash();
    if (finalDependencyLockHash !== initialDependencyLockHash) {
      fail("dependency locks changed during the product build");
    }

    const files: ManifestFile[] = [
      manifestFile(
        stage,
        "inboxd-daemon",
        "daemon",
        "crates/inboxd-daemon/src/main.rs",
        0o700,
        uid,
        gid,
      ),
      ...workerEntrypoints.map((worker) => manifestFile(
        stage,
        worker.name,
        "worker",
        worker.source,
        0o700,
        uid,
        gid,
      )),
      manifestFile(
        stage,
        telegramTdjsonName,
        "runtime-library",
        "@prebuilt-tdlib/darwin-arm64/libtdjson.dylib",
        0o600,
        uid,
        gid,
      ),
      manifestFile(
        stage,
        telegramTdlAddonName,
        "runtime-library",
        "tdl/prebuilds/darwin-arm64/tdl.node",
        0o600,
        uid,
        gid,
      ),
    ];
    const manifest = {
      schema_version: productSchemaVersion,
      target: {
        triple: targetTriple,
        platform: process.platform,
        arch: process.arch,
      },
      dependency_lock: {
        algorithm: "sha256",
        paths: dependencyLockPaths,
        sha256: finalDependencyLockHash,
      },
      files,
    } as const;
    const manifestPath = join(stage, manifestName);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: manifestMode,
    });
    secureRegularFile(manifestPath, uid, gid, manifestMode);

    publish(stage, output, uid);
    published = true;
  } finally {
    if (!published) rmSync(stage, { recursive: true, force: true });
  }
}

try {
  buildProduct();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
