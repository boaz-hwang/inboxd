import { describe, expect, test } from "bun:test";
import {
  assertGatewayCapabilities,
  gatewayCapabilities,
  type Gateway,
} from "../src/index.ts";

const noSendOrRevision = gatewayCapabilities({
  list_chats: true,
  fetch_historical: true,
  send: false,
  watch: true,
  revision: "none",
  read_cursor_comparison: "none",
});

const gatewayWithoutSend: Gateway = {
  capabilities: noSendOrRevision,
  listChats: async () => [],
  fetchHistorical: async () => ({ events: [], coverage: [], limits: [] }),
  watch: async () => () => {},
};

describe("gateway capabilities", () => {
  test("allows explicit send:false and revision:none", () => {
    expect(noSendOrRevision.send).toBe(false);
    expect(noSendOrRevision.revision).toBe("none");
    expect(noSendOrRevision.read_cursor_comparison).toBe("none");
    expect(() => assertGatewayCapabilities(gatewayWithoutSend)).not.toThrow();
  });

  test("rejects a capability claim when its core port is absent", () => {
    const overclaim: Gateway = {
      ...gatewayWithoutSend,
      capabilities: gatewayCapabilities({
        ...noSendOrRevision,
        send: true,
      }),
    };

    expect(() => assertGatewayCapabilities(overclaim)).toThrow(/send/i);
  });

  test("rejects an exposed core port that its manifest denies", () => {
    const deniedPort: Gateway = {
      ...gatewayWithoutSend,
      send: async () => ({ platform_message_id: "1710000000.000100" }),
    };

    expect(() => assertGatewayCapabilities(deniedPort)).toThrow(/send/i);
  });
});
