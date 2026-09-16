import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { daemonStateDirectory } from "./lifecycle.ts";

const approverTokenFilename = "approver.token";

/** The token is deliberately colocated with the owner-only daemon state directory. */
export function defaultApproverTokenPath(socketPath: string): string {
  return join(daemonStateDirectory(socketPath), approverTokenFilename);
}

function assertOwnerOnlyMode(path: string, expected: number): void {
  if ((lstatSync(path).mode & 0o777) !== expected) throw new Error(`local approver token ${path} is not owner-only`);
}

/** Reads the local token only after verifying the state file remains owner-only. */
export function readLocalApproverToken(socketPath: string): string {
  const path = defaultApproverTokenPath(socketPath);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("local approver token is not a regular file");
  assertOwnerOnlyMode(path, 0o600);
  const token = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("local approver token is invalid");
  return token;
}

/** Creates once, then loads a CSPRNG token without ever printing or returning it over protocol. */
export function ensureLocalApproverToken(socketPath: string): string {
  const stateDirectory = daemonStateDirectory(socketPath);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o700);
  const path = defaultApproverTokenPath(socketPath);
  try {
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${randomBytes(32).toString("base64url")}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(path, 0o600);
  return readLocalApproverToken(socketPath);
}

/** Exact-length check plus timing-safe comparison; supplied secrets never enter errors or logs. */
export function matchesLocalApproverToken(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
