import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validatePackagedDaemonBinary } from "../../../host/src/daemon-launcher.ts";
import type { FirstRunPaths } from "../setup.ts";
import { safeEnvironment } from "../host.ts";
function privateDirectory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
export async function runTelegramBootstrap(
  paths: FirstRunPaths,
  productDirectory: string,
  apiId: string,
  apiHash: string,
): Promise<unknown> {
  const bindingHash = createHash("sha256").update("telegram-personal").digest("hex");
  const bindingRoot = join(paths.state, "telegram", bindingHash);
  const database = join(bindingRoot, "database");
  const files = join(bindingRoot, "files");
  for (const path of [join(paths.state, "telegram"), bindingRoot, database, files]) privateDirectory(path);
  const qrHtml = join(paths.root, "telegram-login.html");
  const resultPath = join(paths.root, "telegram-bootstrap-result.json");
  const bootstrap = join(productDirectory, "inboxd-telegram-bootstrap");
  validatePackagedDaemonBinary(bootstrap);
  const child = spawn(bootstrap, [], {
    env: safeEnvironment({
      INBOXD_TELEGRAM_API_ID: apiId,
      INBOXD_TELEGRAM_API_HASH: apiHash,
      INBOXD_TELEGRAM_DATABASE_DIRECTORY: database,
      INBOXD_TELEGRAM_FILES_DIRECTORY: files,
      INBOXD_TELEGRAM_QR_HTML: qrHtml,
      INBOXD_TELEGRAM_BOOTSTRAP_RESULT: resultPath,
    }),
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let buffered = "";
  let opened = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const status = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (status === "QR_READY" && !opened) {
        opened = true;
        spawnSync("/usr/bin/open", [qrHtml], { stdio: "ignore", shell: false });
      }
    }
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", () => reject(new Error("Telegram bootstrap could not start")));
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new Error("Telegram authentication failed");
  const stat = lstatSync(resultPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Telegram bootstrap result is not private");
  }
  return JSON.parse(readFileSync(resultPath, "utf8"));
}
