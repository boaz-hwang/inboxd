import { homedir } from "node:os";
import { join } from "node:path";

import { readOwnerToken } from "../../host/src/owner-token.ts";
import { parseMessageSendParams } from "../../protocol/src/index.ts";
import type { JsonObject } from "../../protocol/src/index.ts";
import {
  createCliHandlers,
  type CliHandlerOptions,
  type CliHandlers,
  type CliRole,
} from "./handlers.ts";
import { launchPackagedDaemon } from "./daemon-launcher.ts";
import { connectUdsTransport } from "./transport.ts";

export * from "./daemon-launcher.ts";
export * from "./handlers.ts";
export * from "./transport.ts";

export const defaultSocketPath = join(homedir(), ".inboxd", "state", "sock");

export interface UdsCliOptions extends Omit<CliHandlerOptions, "connect" | "launchDaemon"> {
  readonly socketPath?: string;
  readonly daemonBinary?: string;
  readonly configPath?: string;
  readonly readinessTimeoutMs?: number;
  readonly launchDaemon?: false | (() => Promise<void>);
}

/** Creates a CLI client with the daemon UDS as its only data transport. */
export function createUdsCliHandlers(options: UdsCliOptions = {}): CliHandlers {
  const socketPath = options.socketPath ?? defaultSocketPath;
  const approverToken = options.role === "approver"
    ? options.approverToken ?? readOwnerToken(socketPath)
    : undefined;
  const { daemonBinary, configPath, readinessTimeoutMs, launchDaemon: injectedLaunchDaemon, socketPath: _socketPath, ...handlerOptions } = options;
  const launchDaemon = injectedLaunchDaemon === false
    ? undefined
    : injectedLaunchDaemon ?? (() => launchPackagedDaemon({ daemonBinary, configPath, socketPath, readinessTimeoutMs }).then(() => {}));
  return createCliHandlers({
    ...handlerOptions,
    approverToken,
    senderToken: options.role === "sender" ? options.senderToken ?? readOwnerToken(socketPath) : undefined,
    connect: () => connectUdsTransport(socketPath),
    ...(launchDaemon === undefined ? {} : { launchDaemon }),
  });
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
    case "message send": result = await handlers.send(parseMessageSendParams(jsonArgument(payload, "message send"))); break;
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
    case "trajectory list": result = await handlers.trajectory("list", payload === undefined ? {} : jsonArgument(payload, "trajectory list")); break;
    case "trajectory delete": result = await handlers.trajectory("delete", jsonArgument(payload, "trajectory delete")); break;
    case "trajectory settings": result = await handlers.trajectory("settings", payload === undefined ? {} : jsonArgument(payload, "trajectory settings")); break;
    case "safety propose":
    case "safety approve": throw new Error("safety proposals and approvals are retired; use message send with a stable request_id");
    case "safety list": result = await handlers.listPending(); break;
    case "safety reject": result = await handlers.reject(jsonArgument(payload, "safety reject") as Parameters<CliHandlers["reject"]>[0]); break;
    default: throw new Error("unknown command");
  }
  write(JSON.stringify(result));
  return result;
}
