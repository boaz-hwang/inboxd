import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_ATTACHMENT_BYTES, parseLocalAttachment, type LocalAttachment } from "../../protocol/src/index.ts";

/** One bounded, regular-file read; never follow a replaced symlink or block on a FIFO. */
async function readRegularFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ATTACHMENT_BYTES) throw new Error("첨부는 1바이트부터 100 MiB까지의 일반 파일만 지원합니다");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error("파일이 변경되었습니다. 다시 선택하세요");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export async function describeAttachment(source: string): Promise<LocalAttachment> {
  const path = await realpath(source);
  const bytes = await readRegularFile(path);
  return parseLocalAttachment({ path, name: basename(source), size: bytes.length, sha256: digest(bytes) });
}
/** Upload exactly the selected bytes, or fail before provider I/O. */
export async function readSelectedAttachment(value: LocalAttachment): Promise<Buffer> {
  const file = parseLocalAttachment(value);
  const bytes = await readRegularFile(file.path);
  if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error("파일이 변경되었습니다. 다시 선택하세요");
  return bytes;
}
export async function pickAttachment(): Promise<LocalAttachment | undefined> {
  if (process.platform !== "darwin") throw new Error("파일 선택은 현재 macOS에서 지원합니다");
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("/usr/bin/osascript", ["-e", 'POSIX path of (choose file with prompt "첨부할 파일 선택 (최대 100 MiB)")'], { encoding: "utf8", timeout: 300_000, maxBuffer: 16_384 }));
  } catch (error) {
    if (String((error as { stderr?: string }).stderr).includes("(-128)")) return undefined;
    throw new Error("파일 선택 창을 열지 못했습니다");
  }
  return describeAttachment(stdout.replace(/\r?\n$/, ""));
}
