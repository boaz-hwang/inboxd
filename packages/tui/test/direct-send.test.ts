import { expect, test } from "bun:test";
import { createTuiController } from "../src/index.ts";
import type { JsonObject } from "../../protocol/src/schema.ts";

const resource = { v: 1, kind: "chat", platform: "slack", account: "work", chat_id: "ops" } as const;
function fixture(send: () => Promise<JsonObject>) {
  const calls: { method: string; params: JsonObject }[] = [];
  const controller = createTuiController({ client: {
    start: async () => {}, stop() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "capability.list") return { v: 1, resources: [{ v: 1, resource, read: { mode: "bounded_history", limits: { max_page_size: 100, max_pages: 1, cursor: "opaque" } }, write: { mode: "send", content_mode: "text", reply: true }, auth: { state: "authenticated", reason: null, observed_at: 1 }, receipt: { level: "independent_readback" } }] };
      if (method === "safety.intent.listPending") return { intents: [{ intent_id: "old", actor: "operator", scope: resource, state: "Proposed", body: "old draft" }] };
      if (method === "message.inbox") return { messages: [] };
      if (method === "message.send") return send();
      if (method === "send.status") return { state: "Sent" };
      return {};
    },
  } });
  return { controller, calls };
}
async function compose(controller: ReturnType<typeof createTuiController>) {
  await controller.start(); controller.setActiveResource(resource);
  await controller.dispatchKey("3"); await controller.dispatchKey("c"); await controller.dispatchPaste("hello");
}

test("historical approval records cannot claim codes or replay sends", async () => {
  const { controller, calls } = fixture(async () => ({ state: "Sent" }));
  await controller.start(); await controller.dispatchKey("4"); await controller.dispatchKey("a");
  expect(calls.map(c => c.method)).not.toContain("safety.intent.claimApprovalCode");
  expect(calls.map(c => c.method)).not.toContain("safety.intent.approve");
  controller.stop();
});

test.each(["Sent", "Verified", "Uncertain", "Failed"])("direct send retains request identity and %s outcome without approval", async state => {
  const { controller, calls } = fixture(async () => ({ state }));
  await compose(controller); await controller.dispatchKey("Enter");
  const send = calls.find(c => c.method === "message.send")!;
  expect(controller.state.lastSend).toEqual({ requestId: String(send.params.request_id), resource, state });
  expect(controller.state.draft).toBe("");
  expect(calls.map(c => c.method)).not.toContain("safety.intent.create");
  controller.stop();
});

test.each(["resolve", "reject"])("disconnect during send (%s) preserves uncertain request and only queries status after reconnect", async completion => {
  const pending = Promise.withResolvers<JsonObject>();
  const { controller, calls } = fixture(() => pending.promise);
  await compose(controller);
  const sending = controller.dispatchKey("Enter");
  const requestId = controller.state.lastSend!.requestId;
  await controller.dispatchKey("Enter");
  controller.disconnected();
  await controller.start();
  if (completion === "resolve") pending.resolve({ state: "Sent" }); else pending.reject(new Error("lost response"));
  await sending;
  expect(controller.state.lastSend).toMatchObject({ requestId, state: "Uncertain" });
  await controller.dispatchKey("s");
  expect(calls.filter(c => c.method === "message.send")).toHaveLength(1);
  expect(calls.filter(c => c.method === "send.status")).toEqual([{ method: "send.status", params: { id: requestId } }]);
  expect(controller.state.lastSend?.state).toBe("Sent");
  controller.stop();
});
