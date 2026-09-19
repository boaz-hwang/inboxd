import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Read the local owner's credential without following a symlink or accepting shared access. */
export function readOwnerToken(socketPath: string): string {
  const path = join(dirname(socketPath), "approver.token");
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new Error("local owner token must not be a symlink");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > 4096) {
      throw new Error("local owner token is not an owner-only regular file");
    }
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{32,4096}$/.test(token)) throw new Error("local owner token is invalid");
    return token;
  } finally { closeSync(fd); }
}
