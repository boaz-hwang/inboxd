import { chmodSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";

export class SingleInstanceError extends Error {
  constructor() {
    super("another inboxd daemon already owns this state directory");
    this.name = "SingleInstanceError";
  }
}

export interface SingleInstanceLock {
  release(): void;
}

function ownerIsAlive(lockPath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return false;
    process.kill(parsed.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH" && code !== "ENOENT";
  }
}

/** Atomically claims a daemon state directory; stale locks are reclaimed only after liveness checks. */
export function acquireSingleInstanceLock(directory: string): SingleInstanceLock {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode does not repair an already-existing directory. The lock,
  // database, and UDS endpoint must stay private to this OS account.
  chmodSync(directory, 0o700);
  const lockPath = join(directory, "inboxd.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, created_at: Date.now() }));
      closeSync(descriptor);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try { unlinkSync(lockPath); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || ownerIsAlive(lockPath)) throw new SingleInstanceError();
      try { unlinkSync(lockPath); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw new SingleInstanceError();
      }
    }
  }
  throw new SingleInstanceError();
}
