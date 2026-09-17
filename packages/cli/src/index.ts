import { homedir } from "node:os";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { JsonObject } from "../../protocol/src/index.ts";
import {
  createAgentHandlers,
  createCliHandlers,
  formatCliResult,
  type AgentHandlers,
  type CliHandlerOptions,
  type CliHandlers,
  type CliRole,
} from "./handlers.ts";
import { connectUdsTransport } from "./transport.ts";

export * from "./handlers.ts";
export * from "./transport.ts";

export const defaultSocketPath = join(homedir(), ".inboxd", "sock");

export interface UdsCliOptions extends Omit<CliHandlerOptions, "connect"> {
  readonly socketPath?: string;
}

export function readCliApproverToken(socketPath: string): string {
  const path = join(dirname(socketPath), "approver.token");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("local approver token is not an owner-only regular file");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("local approver token is invalid");
  return token;
}

/** Creates a CLI client with the daemon UDS as its only data transport. */
export function createUdsCliHandlers(options: UdsCliOptions = {}): CliHandlers {
  const socketPath = options.socketPath ?? defaultSocketPath;
  const approverToken = options.role === "approver"
    ? options.approverToken ?? readCliApproverToken(socketPath)
    : undefined;
  return createCliHandlers({ ...options, approverToken, connect: () => connectUdsTransport(socketPath) });
}

export function createUdsAgentHandlers(options: Omit<UdsCliOptions, "role"> = {}): AgentHandlers {
  const socketPath = options.socketPath ?? defaultSocketPath;
  return createAgentHandlers({ ...options, connect: () => connectUdsTransport(socketPath) });
}

function jsonArgument(value: string | undefined, label: string): JsonObject {
  if (value === undefined) throw new Error(`${label} requires a JSON object argument`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} argument must be valid JSON`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} argument must be a JSON object`);
  }
  return parsed as JsonObject;
}

/**
 * Thin command dispatcher. It accepts JSON command payloads so every request is
 * handed unchanged to the daemon protocol; it never opens a local data store.
 */
export async function runCli(
  argv: readonly string[],
  options: { readonly handlers?: CliHandlers; readonly role?: CliRole; readonly write?: (line: string) => void } = {},
): Promise<JsonObject> {
  const handlers = options.handlers ?? createUdsCliHandlers({ role: options.role });
  const write = options.write ?? ((line: string) => console.log(line));
  const [group, action, payload] = argv;
  let result: JsonObject;
  switch (`${group ?? ""} ${action ?? ""}`) {
    case "daemon start": result = await handlers.daemonStart(); break;
    case "daemon status": result = await handlers.daemonStatus(); break;
    case "chat list": result = await handlers.chatList(); break;
    case "message inbox": result = await handlers.inbox(jsonArgument(payload, "message inbox") as unknown as Parameters<CliHandlers["inbox"]>[0]); break;
    case "message recent": result = await handlers.recent(jsonArgument(payload, "message recent") as unknown as Parameters<CliHandlers["recent"]>[0]); break;
    case "message evidence": result = await handlers.evidence(jsonArgument(payload, "message evidence") as unknown as Parameters<CliHandlers["evidence"]>[0]); break;
    case "message get": result = await handlers.get(jsonArgument(payload, "message get") as unknown as Parameters<CliHandlers["get"]>[0]); break;
    case "message search": result = await handlers.search(jsonArgument(payload, "message search") as unknown as Parameters<CliHandlers["search"]>[0]); break;
    case "sync status": result = await handlers.syncStatus(); break;
    case "sync backfill": result = await handlers.backfill(jsonArgument(payload, "sync backfill") as unknown as Parameters<CliHandlers["backfill"]>[0]); break;
    case "auth status": result = await handlers.authStatus(); break;
    case "send status": {
      if (payload === undefined) throw new Error("send status requires an id");
      result = await handlers.sendStatus(payload);
      break;
    }
    case "doctor status": result = await handlers.doctor(); break;
    case "safety propose": result = await handlers.propose(jsonArgument(payload, "safety propose")); break;
    case "safety list": result = await handlers.listPending(); break;
    case "safety approve": throw new Error("approval codes are accepted only by the owner-local TUI");
    case "safety reject": result = await handlers.reject(jsonArgument(payload, "safety reject") as Parameters<CliHandlers["reject"]>[0]); break;
    default: throw new Error("unknown command");
  }
  write(formatCliResult(result, handlers.role));
  return result;
}
