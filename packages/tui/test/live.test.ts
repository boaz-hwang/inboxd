import { expect, test } from "bun:test";
import { createTuiController } from "../src/index.ts";
import type { JsonObject } from "../../protocol/src/schema.ts";

test("daemon invalidations refresh the account snapshot and current chat while preserving drafts and scroll", async () => {
  let version = 1;
  let gate: Promise<void> | undefined;
  const calls: { method: string; params: JsonObject }[] = [];
  const controller = createTuiController({ client: {
    async start(topics) { expect(topics).toContain("account.changed"); }, stop() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "account.list") {
        await gate;
        return { available: true, chats: [{ platform: "slack", account: "a", chat_id: "c", display_name: `v${version}`, latest_ts: version, can_send: true }], errors: [] };
      }
      if (method === "account.messages") return { messages: Array.from({ length: version + 1 }, (_, i) => ({ id: String(i), platform: "slack", account: "a", chat_id: "c", ts: i, body: `message ${i}` })) };
      return {};
    },
  } });
  await controller.start();
  await controller.dispatchKey("Enter");
  await controller.dispatchKey("Enter");
  await controller.dispatchKey("draft");
  expect(controller.state.draft).toBe("draft");
  version = 2;
  await controller.receiveEvent("account.changed", { platform: "slack", account: "a", phase: "ready" });
  expect(controller.state.directory?.[0]?.title).toBeDefined();
  expect(controller.state.views.chat.data).toHaveLength(3);
  expect(controller.state.selected.chat).toBe(2);
  expect(controller.state.draft).toBe("draft");
  const messages = calls.filter(c => c.method === "account.messages").length;
  await controller.receiveEvent("account.changed", { platform: "telegram", account: "other", phase: "ready" });
  expect(calls.filter(c => c.method === "account.messages")).toHaveLength(messages);
  await controller.dispatchKey("Cancel");
  await controller.dispatchKey("ArrowUp");
  version = 3;
  await controller.receiveEvent("account.changed", { platform: "slack", account: "a" });
  expect(calls.filter(c => c.method === "account.messages").at(-1)?.params.message_id).toBe("1");
  expect(controller.state.selected.chat).toBe(1);

  let release!: () => void;
  gate = new Promise(resolve => { release = resolve; });
  const before = calls.filter(c => c.method === "account.list").length;
  const pending = Array.from({ length: 100 }, () => controller.receiveEvent("account.changed", { platform: "slack", account: "a" }));
  expect(calls.filter(c => c.method === "account.list").length - before).toBe(1);
  gate = undefined; release();
  await Promise.all(pending);
  expect(calls.filter(c => c.method === "account.list").length - before).toBeLessThanOrEqual(2);
  controller.stop();
  const stopped = calls.length;
  await controller.receiveEvent("account.changed", { platform: "slack", account: "a" });
  expect(calls).toHaveLength(stopped);
});
