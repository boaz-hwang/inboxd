import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const temporaryRoot = mkdtempSync(join(process.env.HOME!, ".inboxd-product-artifacts-"));
const productDirectory = join(temporaryRoot, "product", "release");
const secretSentinel = "inboxd-product-build-must-not-copy-this-secret";
const manifestName = "manifest.json";
const telegramAppCredentialsName = "telegram-app.json";
const telegramTdjsonName = "inboxd-telegram-libtdjson.dylib";
const telegramTdlAddonDirectory = "prebuilds";
const telegramTdlAddonName = `${telegramTdlAddonDirectory}/darwin-arm64/tdl.node`;
const executableNames = [
  "inboxd-daemon",
  "inboxd-keychain",
  "inboxd",
  "inboxd-account-worker",
  "inboxd-slack-worker",
  "inboxd-telegram-worker",
  "inboxd-telegram-bootstrap",
  "inboxd-kakao-personal-worker",
  "inboxd-kakao-local-worker",
  "inboxd-kakao-message-worker",
] as const;
const replyRuntimeNames = ["inboxd-reply-worker.py", "context_intelligence.py", "policy.py", "evaluation.py", "personalization.py"];
const expectedSources = new Map<string, string>([
  ["inboxd-daemon", "crates/inboxd-daemon/src/main.rs"],
  ["inboxd-keychain", "crates/inboxd-keychain/src/main.rs"],
  ["inboxd", "packages/cli/src/bin.ts"],
  [telegramAppCredentialsName, "installer:telegram-app-credentials"],
  ["inboxd-account-worker", "packages/accounts/src/worker.ts"],
  ["inboxd-slack-worker", "platforms/slack/src/bin.ts"],
  ["inboxd-telegram-worker", "platforms/telegram/src/worker-entrypoint.ts"],
  ["inboxd-telegram-bootstrap", "platforms/telegram/src/bootstrap.ts"],
  ["inboxd-kakao-personal-worker", "contrib/kakao/src/personal-entrypoint.ts"],
  ["inboxd-kakao-local-worker", "contrib/kakao/src/worker-entrypoint.ts"],
  ["inboxd-kakao-message-worker", "platforms/kakao-message/src/bin.ts"],
  [telegramTdjsonName, "@prebuilt-tdlib/darwin-arm64/libtdjson.dylib"],
  [telegramTdlAddonName, "tdl/prebuilds/darwin-arm64/tdl.node"],
  ...replyRuntimeNames.map(name => [name, `packages/reply-model/${name === "inboxd-reply-worker.py" ? "worker.py" : name}`] as [string, string]),
]);

interface ProductManifest {
  readonly schema_version: "inboxd-product/v1";
  readonly target: {
    readonly triple: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly dependency_lock: {
    readonly algorithm: "sha256";
    readonly paths: readonly ["Cargo.lock", "bun.lock"];
    readonly sha256: string;
  };
  readonly files: readonly {
    readonly name: string;
    readonly kind: "application-credential" | "daemon" | "launcher" | "worker" | "runtime-library";
    readonly source_entrypoint: string;
    readonly sha256: string;
    readonly size: number;
    readonly mode: "0600" | "0700";
  }[];
}

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  command: readonly string[],
  options: { readonly env?: Record<string, string | undefined>; readonly stdin?: "ignore" } = {},
): Promise<ProcessResult> {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: root,
    env: options.env,
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function buildProduct(
  output = productDirectory,
  overrides: Record<string, string | undefined> = {},
): Promise<ProcessResult> {
  return run([process.execPath, "run", "build:product"], {
    env: {
      ...process.env,
      INBOXD_PRODUCT_OUT: output,
      INBOXD_TEST_PACKAGE_SECRET: secretSentinel,
      INBOXD_PACKAGE_TELEGRAM_APP: "1",
      INBOXD_TELEGRAM_API_ID: "12345",
      INBOXD_TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
      ...overrides,
    },
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function dependencyLockHash(): string {
  const hash = createHash("sha256");
  for (const path of ["Cargo.lock", "bun.lock"] as const) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function inventory(path: string): string[] {
  return readdirSync(path).sort();
}

function snapshot(path: string): Map<string, string> {
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    const directory = join(path, relativeDirectory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else files.push(relativePath);
    }
  };
  visit("");
  return new Map(files.sort().map((name) => [name, sha256(join(path, name))]));
}

function rustHostTriple(): string {
  const result = Bun.spawnSync({
    cmd: [process.env.RUSTC ?? "rustc", "-vV"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const match = /^host: (.+)$/m.exec(result.stdout.toString());
  expect(match).not.toBeNull();
  return match![1]!;
}

async function runTelegramHealth(
  databaseDirectory: string,
  filesDirectory: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const telegram = Bun.spawn({
    cmd: [
      "/usr/bin/sandbox-exec",
      "-p",
      `(version 1) (allow default) (deny file-read-data (subpath "${join(root, "node_modules")}"))`,
      join(productDirectory, "inboxd-telegram-worker"),
    ],
    cwd: productDirectory,
    env: {
      INBOXD_TELEGRAM_ACCOUNT: "artifact-test",
      INBOXD_TELEGRAM_API_HASH: "00000000000000000000000000000000",
      INBOXD_TELEGRAM_API_ID: "1",
      INBOXD_TELEGRAM_BINDING_ID: "telegram-artifact-test",
      INBOXD_TELEGRAM_CHAT_IDS_JSON: '["telegram:chat:1"]',
      INBOXD_TELEGRAM_DATABASE_DIRECTORY: databaseDirectory,
      INBOXD_TELEGRAM_FILES_DIRECTORY: filesDirectory,
      INBOXD_TELEGRAM_SELF_USER_ID: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  telegram.stdin.write(`${JSON.stringify({
    v: 1,
    type: "worker_request",
    request_id: "artifact-health",
    generation: 1,
    binding_id: "telegram-artifact-test",
    limits: { timeout_ms: 30_000, max_response_bytes: 65_536, max_queue_depth: 1 },
    operation: { op: "health" },
  })}\n`);
  telegram.stdin.end();
  const timer = setTimeout(() => telegram.kill(), 45_000);
  const [code, stdout, stderr] = await Promise.all([
    telegram.exited,
    new Response(telegram.stdout).text(),
    new Response(telegram.stderr).text(),
  ]).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}

async function rejectedTelegramNativeMappings(
  databaseDirectory: string,
  filesDirectory: string,
): Promise<{ response: string; mappings: string }> {
  const telegram = Bun.spawn({
    cmd: [
      "/usr/bin/sandbox-exec",
      "-p",
      `(version 1) (allow default) (deny file-read-data (subpath "${join(root, "node_modules")}"))`,
      join(productDirectory, "inboxd-telegram-worker"),
    ],
    cwd: productDirectory,
    env: {
      INBOXD_TELEGRAM_ACCOUNT: "artifact-test",
      INBOXD_TELEGRAM_API_HASH: "00000000000000000000000000000000",
      INBOXD_TELEGRAM_API_ID: "1",
      INBOXD_TELEGRAM_BINDING_ID: "telegram-artifact-test",
      INBOXD_TELEGRAM_CHAT_IDS_JSON: '["telegram:chat:1"]',
      INBOXD_TELEGRAM_DATABASE_DIRECTORY: databaseDirectory,
      INBOXD_TELEGRAM_FILES_DIRECTORY: filesDirectory,
      INBOXD_TELEGRAM_SELF_USER_ID: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  telegram.stdin.write(`${JSON.stringify({
    v: 1,
    type: "worker_request",
    request_id: "rejected-artifact-health",
    generation: 1,
    binding_id: "telegram-artifact-test",
    limits: { timeout_ms: 30_000, max_response_bytes: 65_536, max_queue_depth: 1 },
    operation: { op: "health" },
  })}\n`);
  const timer = setTimeout(() => telegram.kill(), 45_000);
  const reader = telegram.stdout.getReader();
  let response = "";
  try {
    while (!response.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response += new TextDecoder().decode(chunk.value);
    }
    const vmmap = Bun.spawnSync({
      cmd: ["/usr/bin/vmmap", String(telegram.pid)],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(vmmap.exitCode, vmmap.stderr.toString()).toBe(0);
    return { response, mappings: vmmap.stdout.toString() };
  } finally {
    clearTimeout(timer);
    telegram.kill();
    telegram.stdin.end();
    await telegram.exited;
    reader.releaseLock();
  }
}

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("atomic production product artifacts", () => {
  test("builds the release daemon, launcher, and real standalone workers into one verified bundle", async () => {
    const firstBuild = await buildProduct();
    expect(firstBuild.code, firstBuild.stderr).toBe(0);

    const expectedInventory = [
      ...executableNames,
      ...replyRuntimeNames,
      telegramAppCredentialsName,
      telegramTdjsonName,
      telegramTdlAddonDirectory,
      manifestName,
    ].sort();
    expect(inventory(productDirectory)).toEqual(expectedInventory);
    expect(inventory(productDirectory)).not.toContain("inboxd-fake-worker");
    expect(lstatSync(productDirectory).mode & 0o777).toBe(0o700);
    expect(lstatSync(dirname(productDirectory)).mode & 0o777).toBe(0o700);

    const manifestPath = join(productDirectory, manifestName);
    const manifestStat = lstatSync(manifestPath);
    expect(manifestStat.isFile()).toBeTrue();
    expect(manifestStat.isSymbolicLink()).toBeFalse();
    expect(manifestStat.uid).toBe(process.getuid!());
    expect(manifestStat.mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ProductManifest;
    expect(manifest.schema_version).toBe("inboxd-product/v1");
    expect(manifest.target).toEqual({
      triple: rustHostTriple(),
      platform: process.platform,
      arch: process.arch,
    });
    expect(manifest.dependency_lock).toEqual({
      algorithm: "sha256",
      paths: ["Cargo.lock", "bun.lock"],
      sha256: dependencyLockHash(),
    });
    expect(manifest.files.map((file) => file.name)).toEqual([
      ...executableNames,
      ...replyRuntimeNames,
      telegramTdjsonName,
      telegramTdlAddonName,
      telegramAppCredentialsName,
    ]);

    for (const file of manifest.files) {
      const path = join(productDirectory, file.name);
      const stat = lstatSync(path);
      expect(stat.isFile(), file.name).toBeTrue();
      expect(stat.isSymbolicLink(), file.name).toBeFalse();
      expect(stat.uid, file.name).toBe(process.getuid!());
      const expectedMode = file.kind === "runtime-library" || file.kind === "application-credential" ? 0o600 : 0o700;
      expect(stat.mode & 0o777, file.name).toBe(expectedMode);
      expect(file.kind).toBe(file.name === "inboxd-daemon"
        ? "daemon"
        : file.name === "inboxd"
          ? "launcher"
        : file.name === telegramAppCredentialsName
          ? "application-credential"
        : file.name === "inboxd-keychain" || file.name === "inboxd-account-worker" || expectedSources.get(file.name)?.startsWith("platforms/")
          || expectedSources.get(file.name)?.startsWith("contrib/") ? "worker" : "runtime-library");
      expect(file.source_entrypoint).toBe(expectedSources.get(file.name)!);
      expect(file.mode).toBe(file.kind === "runtime-library" || file.kind === "application-credential" ? "0600" : "0700");
      expect(file.size).toBe(stat.size);
      expect(file.sha256).toBe(sha256(path));
      expect(readFileSync(path).includes(Buffer.from(secretSentinel)), file.name).toBeFalse();
    }
    expect(readFileSync(manifestPath).includes(Buffer.from(secretSentinel))).toBeFalse();

    const telegramStateDirectory = join(temporaryRoot, "telegram-state");
    const telegramDatabaseDirectory = join(telegramStateDirectory, "database");
    const telegramFilesDirectory = join(telegramStateDirectory, "files");
    mkdirSync(telegramDatabaseDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(telegramFilesDirectory, { recursive: true, mode: 0o700 });
    const telegram = await runTelegramHealth(telegramDatabaseDirectory, telegramFilesDirectory);
    expect(telegram.code, telegram.stderr).toBe(0);
    expect(telegram.stderr).toBe("");
    expect(telegram.stdout).not.toContain("missing_tdlib_production_pack");
    expect(telegram.stdout).not.toContain("tdlib_production_adapter_initialization_failed");

    for (const workerName of executableNames.filter((name) => name !== "inboxd-daemon")) {
      const result = await run([join(productDirectory, workerName)], { env: { HOME: temporaryRoot } });
      expect(result.code, workerName).not.toBe(0);
      expect(result.stdout, workerName).toBe("");
    }
    const daemonUsage = await run([join(productDirectory, "inboxd-daemon")], { env: {} });
    expect(daemonUsage.code).not.toBe(0);
    expect(daemonUsage.stdout).toBe("");
    expect(daemonUsage.stderr).toContain("usage: inboxd-daemon --config <owner-only-config.json>");

    const bootstrapHome = join(temporaryRoot, "bootstrap-home");
    const bootstrapRoot = join(bootstrapHome, ".inboxd");
    const bootstrapState = join(bootstrapRoot, "state", "telegram", "artifact-binding");
    const bootstrapDatabase = join(bootstrapState, "database");
    const bootstrapFiles = join(bootstrapState, "files");
    const bootstrapQr = join(bootstrapRoot, "telegram-login.html");
    const bootstrapResult = join(bootstrapRoot, "telegram-bootstrap-result.json");
    mkdirSync(bootstrapDatabase, { recursive: true, mode: 0o700 });
    mkdirSync(bootstrapFiles, { recursive: true, mode: 0o700 });
    const stateAclAdded = Bun.spawnSync({
      cmd: ["/bin/chmod", "+a", "group:everyone allow read,write,delete", bootstrapDatabase],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(stateAclAdded.exitCode, stateAclAdded.stderr.toString()).toBe(0);
    try {
      const rejectedBootstrap = await run([
        "/usr/bin/sandbox-exec",
        "-p",
        `(version 1) (allow default) (deny file-read-data (subpath "${join(root, "node_modules")}"))`,
        join(productDirectory, "inboxd-telegram-bootstrap"),
      ], { env: {
        DYLD_PRINT_LIBRARIES: "1",
        HOME: bootstrapHome,
        INBOXD_TELEGRAM_API_HASH: "00000000000000000000000000000000",
        INBOXD_TELEGRAM_API_ID: "1",
        INBOXD_TELEGRAM_BINDING_ID: "telegram-artifact-test",
        INBOXD_TELEGRAM_DATABASE_DIRECTORY: bootstrapDatabase,
        INBOXD_TELEGRAM_FILES_DIRECTORY: bootstrapFiles,
        INBOXD_TELEGRAM_QR_HTML: bootstrapQr,
        INBOXD_TELEGRAM_BOOTSTRAP_RESULT: bootstrapResult,
      } });
      expect(rejectedBootstrap.code).not.toBe(0);
      expect(rejectedBootstrap.stdout).toBe("");
      expect(rejectedBootstrap.stderr).toContain("Telegram bootstrap terminated: failure");
      expect(rejectedBootstrap.stderr).not.toContain(join(productDirectory, telegramTdlAddonName));
      expect(rejectedBootstrap.stderr).not.toContain(join(productDirectory, telegramTdjsonName));
      expect(existsSync(bootstrapQr)).toBeFalse();
      expect(existsSync(bootstrapResult)).toBeFalse();
    } finally {
      const stateAclRemoved = Bun.spawnSync({ cmd: ["/bin/chmod", "-a#", "0", bootstrapDatabase] });
      expect(stateAclRemoved.exitCode).toBe(0);
    }

    const helperHash = sha256(join(productDirectory, "inboxd-keychain"));
    const noPrompt = await run([join(productDirectory, "inboxd-keychain"), "get", "inboxd-nonexistent-helper-test", "missing"], {env:{HOME:temporaryRoot}});
    expect(noPrompt.code).not.toBe(0);
    expect(noPrompt.stdout).toBe("");
    const completeSnapshot = snapshot(productDirectory);
    const failedBuild = await buildProduct(productDirectory, { CARGO: "/usr/bin/false" });
    expect(failedBuild.code).not.toBe(0);
    expect(snapshot(productDirectory)).toEqual(completeSnapshot);

    const secondBuild = await buildProduct();
    expect(secondBuild.code, secondBuild.stderr).toBe(0);
    expect(sha256(join(productDirectory, "inboxd-keychain"))).toBe(helperHash);
    expect(inventory(productDirectory)).toEqual(expectedInventory);
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).files.map((file: { name: string }) => file.name))
      .toEqual([...executableNames, ...replyRuntimeNames, telegramTdjsonName, telegramTdlAddonName, telegramAppCredentialsName]);

    const tdjsonPath = join(productDirectory, telegramTdjsonName);
    const aclAdded = Bun.spawnSync({
      cmd: ["/bin/chmod", "+a", "group:everyone allow write,delete", tdjsonPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(aclAdded.exitCode, aclAdded.stderr.toString()).toBe(0);
    try {
      const rejectedAcl = await rejectedTelegramNativeMappings(
        telegramDatabaseDirectory,
        telegramFilesDirectory,
      );
      expect(rejectedAcl.response).toContain("missing_tdlib_production_pack");
      expect(rejectedAcl.mappings).not.toContain(telegramTdlAddonName);
      expect(rejectedAcl.mappings).not.toContain(telegramTdjsonName);
    } finally {
      const aclRemoved = Bun.spawnSync({ cmd: ["/bin/chmod", "-a#", "0", tdjsonPath] });
      expect(aclRemoved.exitCode).toBe(0);
    }

    const originalManifest = readFileSync(manifestPath, "utf8");
    const invalidManifest = JSON.parse(originalManifest) as { files: Array<{ name: string; sha256: string }> };
    const tdjsonEntry = invalidManifest.files.find((file) => file.name === telegramTdjsonName);
    expect(tdjsonEntry).toBeDefined();
    tdjsonEntry!.sha256 = "0".repeat(64);
    await Bun.write(manifestPath, `${JSON.stringify(invalidManifest, null, 2)}\n`);
    try {
      const rejectedManifest = await rejectedTelegramNativeMappings(
        telegramDatabaseDirectory,
        telegramFilesDirectory,
      );
      expect(rejectedManifest.response).toContain("missing_tdlib_production_pack");
      expect(rejectedManifest.mappings).not.toContain(telegramTdlAddonName);
      expect(rejectedManifest.mappings).not.toContain(telegramTdjsonName);
    } finally {
      await Bun.write(manifestPath, originalManifest);
    }
  }, 300_000);

  test("rejects a non-private existing destination parent without changing its mode", async () => {
    const broadParent = join(temporaryRoot, "broad-parent");
    mkdirSync(broadParent, { mode: 0o755 });

    const result = await buildProduct(join(broadParent, "release"), { CARGO: "/usr/bin/false" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/owner-only/i);
    expect(lstatSync(broadParent).mode & 0o777).toBe(0o755);
    expect(inventory(broadParent)).toEqual([]);
  });

  test("rejects a symlink in the configured destination path before invoking a build", async () => {
    const actualParent = join(temporaryRoot, "actual-parent");
    const linkedParent = join(temporaryRoot, "linked-parent");
    mkdirSync(actualParent, { mode: 0o700 });
    symlinkSync(actualParent, linkedParent, "dir");

    const result = await buildProduct(join(linkedParent, "release"), { CARGO: "/usr/bin/false" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/symlink/i);
    expect(inventory(actualParent)).toEqual([]);
  });
});
