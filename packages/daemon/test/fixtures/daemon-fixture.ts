import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import type { SqlCipherKeyProvider } from "../../../store/src/sqlcipher.ts";

export interface DaemonFixture {
  readonly directory: string;
  readonly socketPath: string;
  readonly databasePath: string;
  readonly keyProvider: SqlCipherKeyProvider;
  dispose(): void;
}

export function createDaemonFixture(): DaemonFixture {
  const directory = mkdtempSync("/tmp/inboxd-daemon-");
  mkdirSync(join(directory, "state"));
  const key = crypto.getRandomValues(new Uint8Array(32));
  return {
    directory,
    socketPath: join(directory, "state", "inboxd.sock"),
    databasePath: join(directory, "state", "inboxd.db"),
    keyProvider: { getKey: () => key.slice() },
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export interface JsonLineClient {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  nextFrame(): Promise<Record<string, unknown>>;
  closed: Promise<void>;
  close(): void;
}

export async function connectJsonLines(socketPath: string): Promise<JsonLineClient> {
  const socket = createConnection(socketPath);
  const frames: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  let buffered = "";
  let closedResolve!: () => void;
  const closed = new Promise<void>((resolve) => { closedResolve = resolve; });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const frame = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    }
  });
  socket.once("close", () => closedResolve());
  socket.once("error", () => closedResolve());
  return {
    request(method, params = {}) {
      const id = crypto.randomUUID();
      socket.write(`${JSON.stringify({ type: "request", id, method, params })}\n`);
      return new Promise((resolve, reject) => {
        const receive = (frame: Record<string, unknown>) => {
          if (frame.type === "response" && frame.id === id) {
            if (frame.ok === true) resolve(frame.result as Record<string, unknown>);
            else {
              const error = frame.error as { message?: unknown; code?: unknown } | undefined;
              reject(Object.assign(new Error(String(error?.message)), { code: error?.code }));
            }
            return;
          }
          waiters.push(receive);
        };
        const frame = frames.shift();
        if (frame) receive(frame);
        else waiters.push(receive);
      });
    },
    nextFrame() {
      const frame = frames.shift();
      return frame ? Promise.resolve(frame) : new Promise((resolve) => waiters.push(resolve));
    },
    closed,
    close: () => socket.destroy(),
  };
}
