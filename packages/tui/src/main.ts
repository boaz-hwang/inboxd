import { homedir } from "node:os";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ReconnectingProtocolClient, type ClientRole } from "../../protocol/src/index.ts";
import { createTuiController, type TuiController } from "./index.ts";
import { mountInteractiveTui } from "./runtime.ts";
import { connectTuiUdsTransport } from "./transport.ts";

export const defaultTuiSocketPath = join(homedir(), ".inboxd", "sock");

export interface RunTuiOptions {
  readonly socketPath?: string;
  readonly role?: Extract<ClientRole, "reader" | "approver">;
}

export interface RunTuiEntrypointOptions {
  readonly run: () => Promise<void>;
  readonly exit: (code: number) => unknown;
  readonly report: (message: string) => unknown;
}

/** Reads the daemon's owner-only local approver token without importing daemon internals. */
export function readTuiApproverToken(socketPath: string): string {
  const path = join(dirname(socketPath), "approver.token");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("local approver token is not an owner-only regular file");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("local approver token is invalid");
  return token;
}

function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Starts the real OpenTUI terminal client against the daemon UDS protocol. */
export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  if (!isTTY()) throw new Error("inboxd-tui requires stdin and stdout to be TTYs");
  const role = options.role ?? "approver";
  const socketPath = options.socketPath ?? defaultTuiSocketPath;
  let controller: TuiController;
  const client = new ReconnectingProtocolClient({
    connect: () => connectTuiUdsTransport(socketPath),
    role,
    isTTY,
    ...(role === "approver" ? { approverToken: readTuiApproverToken(socketPath) } : {}),
    onEvent: (event) => { void controller.receiveEvent(event.method); },
  });
  controller = createTuiController({ client });

  const coreModule = "@opentui/core";
  const { createCliRenderer } = await import(coreModule);
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: ["SIGINT", "SIGTERM"] });
  const mounted = await mountInteractiveTui(renderer, controller);
  const unsubscribe = controller.subscribe((state) => {
    if (state.quitRequested) renderer.destroy();
  });

  try {
    await controller.start();
    await new Promise<void>((resolve) => renderer.once("destroy", resolve));
  } finally {
    unsubscribe();
    mounted.destroy();
    controller.stop();
    if (!renderer.isDestroyed) renderer.destroy();
  }
}

/** Converts renderer completion into an explicit executable exit status. */
export async function runTuiEntrypoint(options: RunTuiEntrypointOptions = {
  run: () => runTui(),
  exit: (code) => process.exit(code),
  report: (message) => console.error(message),
}): Promise<void> {
  try {
    await options.run();
    options.exit(0);
  } catch (error) {
    options.report(error instanceof Error ? `inboxd-tui: ${error.message}` : "inboxd-tui: failed to start");
    options.exit(1);
  }
}

if (import.meta.main) {
  void runTuiEntrypoint();
}
