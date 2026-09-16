import type { Gateway } from "./ports.ts";
import { coreCall } from "../../native/src/index.ts";

export type RevisionCapability = "adapter" | "none";
export type ReadCursorComparison = "message_id" | "timestamp" | "none";

/**
 * An adapter's declared limits. A false capability must not be exposed as an
 * operational gateway port, preventing callers from inferring unsupported work.
 */
export interface GatewayCapabilities {
  readonly list_chats: boolean;
  readonly fetch_historical: boolean;
  readonly send: boolean;
  readonly watch: boolean;
  readonly revision: RevisionCapability;
  readonly read_cursor_comparison: ReadCursorComparison;
}

const portCapabilities = [
  ["list_chats", "listChats"],
  ["fetch_historical", "fetchHistorical"],
  ["send", "send"],
  ["watch", "watch"],
] as const;

export function gatewayCapabilities(value: GatewayCapabilities): GatewayCapabilities {
  return coreCall("domain.gatewayCapabilities", value);
}

/** Reject adapters whose manifest claims more than their supplied ports provide. */
export function assertGatewayCapabilities(gateway: Gateway): void {
  coreCall("domain.assertGatewayCapabilities", {
    capabilities: gateway.capabilities,
    ports: Object.fromEntries(portCapabilities.map(([, port]) => [port, typeof gateway[port] === "function"])),
  });
}
