import { expect, test } from "bun:test";
import { createTuiController, renderScreen } from "../src/index.ts";
import type { JsonObject, LocalAttachment } from "../../protocol/src/schema.ts";

const file = { path: "/tmp/report.pdf", name: "report.pdf", size: 1024, sha256: "a".repeat(64) };
async function setup(platform: string, picker: () => Promise<LocalAttachment | undefined>, send = async (): Promise<JsonObject> => ({ state: "Sent" })) {
  const calls: { method: string; params: JsonObject }[] = [];
  const controller = createTuiController({ pickAttachment: picker, client: {
    start: async () => {}, stop() {}, async request(method, params) {
      calls.push({ method, params });
      if (method === "account.list") return { available: true, chats: [{ platform, account: "personal", chat_id: "1", display_name: "대화", can_send: true }], errors: [] };
      if (method === "message.send") return send();
      if (method === "send.status") return { state: "Sent" };
      return { messages: [] };
    },
  } });
  await controller.start(); await controller.selectConversation(0);
  return { controller, calls };
}
test.each(["slack", "kakao", "telegram"])("%s attachment selection previews without sending; Enter sends exact chat once", async platform => {
  const pending = Promise.withResolvers<JsonObject>();
  const { controller, calls } = await setup(platform, async () => file, () => pending.promise);
  await controller.dispatchKey("Attach");
  expect(controller.state.attachment).toEqual(file);
  expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain("report.pdf · 1.0 KiB");
  expect(calls.some(c => c.method === "message.send")).toBe(false);
  await controller.dispatchKey("c"); expect(controller.state.composeActive).toBe(false);
  const sending = controller.dispatchKey("Enter"); await controller.dispatchKey("Enter");
  pending.resolve({ state: "Uncertain" }); await sending;
  const sent = calls.filter(c => c.method === "message.send");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.params).toEqual({ request_id: expect.any(String), chat: { platform, account: "personal", chat_id: "1" }, file });
  await controller.dispatchKey("s"); expect(calls.filter(c => c.method === "message.send")).toHaveLength(1);
  expect(controller.state.attachment).toBeUndefined(); controller.stop();
});
test("cancel and chat changes never send, and a late picker cannot attach to another conversation", async () => {
  const pending = Promise.withResolvers<LocalAttachment | undefined>();
  const { controller, calls } = await setup("slack", () => pending.promise);
  const selecting = controller.dispatchKey("a");
  controller.setActiveResource({ v: 1, kind: "chat", platform: "slack", account: "personal", chat_id: "other" });
  pending.resolve(file); await selecting;
  expect(controller.state.attachment).toBeUndefined();
  expect(calls.some(c => c.method === "message.send")).toBe(false); controller.stop();
  const canceled = await setup("slack", async () => undefined);
  await canceled.controller.dispatchKey("a"); expect(canceled.controller.state.attachment).toBeUndefined(); canceled.controller.stop();
  const selected = await setup("slack", async () => file);
  await selected.controller.dispatchKey("a"); await selected.controller.dispatchKey("Cancel");
  expect(selected.controller.state.attachment).toBeUndefined(); expect(selected.calls.some(c => c.method === "message.send")).toBe(false); selected.controller.stop();
});
