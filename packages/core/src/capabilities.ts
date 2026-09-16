import type { Gateway } from "./ports.ts";

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
  for (const [capability] of portCapabilities) {
    if (typeof value[capability] !== "boolean") {
      throw new TypeError(`${capability} capability must be boolean`);
    }
  }
  if (value.revision !== "adapter" && value.revision !== "none") {
    throw new TypeError("revision capability must be adapter or none");
  }
  if (
    value.read_cursor_comparison !== "message_id"
    && value.read_cursor_comparison !== "timestamp"
    && value.read_cursor_comparison !== "none"
  ) {
    throw new TypeError("read_cursor_comparison must be message_id, timestamp, or none");
  }
  return { ...value };
}

/** Reject adapters whose manifest claims more than their supplied ports provide. */
export function assertGatewayCapabilities(gateway: Gateway): void {
  const capabilities = gatewayCapabilities(gateway.capabilities);
  for (const [capability, port] of portCapabilities) {
    const exposed = typeof gateway[port] === "function";
    if (capabilities[capability] && !exposed) {
      throw new TypeError(`gateway claims ${capability} but does not provide ${port}`);
    }
    if (!capabilities[capability] && exposed) {
      throw new TypeError(`gateway exposes ${port} while capability ${capability} is false`);
    }
  }
}
