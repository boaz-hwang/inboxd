import { closeSync, constants, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ProviderConfiguration } from "./contracts.ts";

export function readPrivateJson(path: string): Record<string, unknown> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 1_048_576) throw new Error("계정 설정 파일의 소유권과 권한을 확인하세요.");
    let value: unknown;
    try { value = JSON.parse(readFileSync(fd, "utf8")); }
    catch { throw new Error("계정 설정 JSON을 읽지 못했습니다."); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("계정 설정 형식이 올바르지 않습니다.");
    return value as Record<string, unknown>;
  } finally { closeSync(fd); }
}

/** Read again under a lock; never overwrite another completed connection. */
export function saveConnection(path: string, provider: ProviderConfiguration): void {
  if (typeof provider.binding_id !== "string" || !provider.binding_id || typeof provider.kind !== "string") throw new Error("연결 정보 검증에 실패했습니다.");
  const lock = `${path}.connect-lock`;
  const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const config = readPrivateJson(path);
    if (config.version !== 1 || !Array.isArray(config.providers)) throw new Error("Inboxd 설정 형식이 올바르지 않습니다.");
    config.providers = [...config.providers.filter(p => p?.binding_id !== provider.binding_id), provider];
    const encoded = `${JSON.stringify(config, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > 65_536) throw new Error("연결 설정 크기가 허용 범위를 넘었습니다.");
    writeFileSync(temporary, encoded, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    closeSync(fd); unlinkSync(lock);
    try { unlinkSync(temporary); } catch { /* already renamed */ }
  }
}
