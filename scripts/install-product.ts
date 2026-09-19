import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const home = homedir();
const product = join(home, ".inboxd", "product", "release");
const binDirectory = join(home, ".local", "bin");
const command = join(binDirectory, "inboxd");
const uid = process.getuid?.();
const gid = process.getgid?.();
if (uid === undefined || gid === undefined || process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Inboxd local install currently requires macOS arm64 with POSIX ownership support");
}
const installUid: number = uid;
const installGid: number = gid;

function ensureDirectory(path: string, mode: number, privateDirectory: boolean): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== installUid) {
      throw new Error(`refusing unsafe install directory: ${path}`);
    }
    if ((stat.mode & 0o022) !== 0 || (privateDirectory && (stat.mode & 0o077) !== 0)) {
      throw new Error(`refusing writable or non-private install directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { recursive: true, mode });
    chownSync(path, installUid, installGid);
    chmodSync(path, mode);
  }
}

ensureDirectory(join(home, ".inboxd"), 0o700, true);
ensureDirectory(join(home, ".inboxd", "product"), 0o700, true);
ensureDirectory(join(home, ".local"), 0o755, false);
ensureDirectory(binDirectory, 0o755, false);

const telegramApiId = process.env.INBOXD_TELEGRAM_API_ID ?? "";
const telegramApiHash = process.env.INBOXD_TELEGRAM_API_HASH ?? "";
if (!/^[1-9]\d{0,9}$/.test(telegramApiId) || !/^[0-9a-f]{32}$/.test(telegramApiHash)) {
  throw new Error("Inboxd installer requires its Telegram application credentials in the repo-local .env");
}

const build = spawnSync(process.execPath, [join(root, "scripts/build-product.ts")], {
  cwd: root,
  env: { ...process.env, INBOXD_PRODUCT_OUT: product, INBOXD_PACKAGE_TELEGRAM_APP: "1" },
  stdio: "inherit",
});
if (build.status !== 0) throw new Error("Inboxd product build failed");

const quotedProduct = `'${join(product, "inboxd").replaceAll("'", "'\\''")}'`;
const wrapper = `#!/bin/sh\nexec ${quotedProduct} "$@"\n`;
const temporary = join(binDirectory, `.${basename(command)}.${process.pid}.tmp`);
try {
  writeFileSync(temporary, wrapper, { encoding: "utf8", flag: "wx", mode: 0o700 });
  chownSync(temporary, installUid, installGid);
  chmodSync(temporary, 0o700);
  renameSync(temporary, command);
  chmodSync(command, 0o755);
} finally {
  rmSync(temporary, { force: true });
}

const pathEntries = (process.env.PATH ?? "").split(":");
console.log(`Installed Inboxd command: ${command}`);
if (!pathEntries.includes(binDirectory)) {
  console.log(`Add this directory to PATH: export PATH="${binDirectory}:$PATH"`);
}
console.log("Run: inboxd");
