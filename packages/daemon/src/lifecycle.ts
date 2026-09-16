import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const defaultSocketPath = join(homedir(), ".inboxd", "sock");
export const defaultDatabasePath = join(homedir(), ".inboxd", "inboxd.db");

function connect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const settle = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/** Removes only an unreachable Unix-domain socket, never a reachable daemon endpoint. */
export async function removeStaleSocket(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  const stat = lstatSync(socketPath);
  if (!stat.isSocket()) throw new Error("daemon socket path exists but is not a socket");
  if (await connect(socketPath)) return false;
  try {
    unlinkSync(socketPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function daemonStateDirectory(socketPath: string): string {
  return dirname(socketPath);
}
