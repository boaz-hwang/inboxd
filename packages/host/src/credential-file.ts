import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export function readPrivate(path: string): Record<string, any> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 1_048_576) throw new Error("Unsafe account credentials file");
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid account credentials file");
    return value;
  } finally { closeSync(fd); }
}
export function savePrivate(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd);
    renameSync(temporary, path);
  } finally { closeSync(fd); try { unlinkSync(temporary); } catch {} }
}
export async function acquireLock(path: string): Promise<() => void> {
  const deadline = Date.now() + 25_000;
  while (true) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, String(process.pid));
      return () => { closeSync(fd); unlinkSync(path); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A crashed owner must not permanently disable recovery. Never steal a
      // live process's lock, even if the refresh is slow.
      try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const st = fstatSync(fd);
          if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new Error("Unsafe account refresh lock");
          const pid = Number(readFileSync(fd, "utf8"));
          let dead = !Number.isSafeInteger(pid) || pid < 1;
          if (!dead) { try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") dead = true; } }
          if (dead && Date.now() - st.mtimeMs > 30_000 && statSync(path).ino === st.ino) unlinkSync(path);
        } finally { closeSync(fd); }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (Date.now() >= deadline) throw new Error("Credential refresh lock timed out");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
