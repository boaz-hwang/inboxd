import { expect, test } from "bun:test";
import { createTuiController, renderScreen } from "../src/index.ts";
import { conversationRows } from "../src/workspace-model.ts";
import type { JsonObject } from "../../protocol/src/schema.ts";

async function setup(leave: () => Promise<JsonObject> = async () => ({ state: "Left" })) {
  const calls: { method: string; params: JsonObject }[] = [];
  const controller = createTuiController({ client: {
    start: async () => {}, stop() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === "account.list") return { available: true, chats: [
        { platform: "kakao", account: "one", chat_id: "same", display_name: "첫째 방", latest_ts: 30, can_send: true },
        { platform: "kakao", account: "two", chat_id: "same", display_name: "둘째 방", latest_ts: 20, can_send: true },
      ] };
      if (method === "account.messages") return { messages: [] };
      if (method === "account.leave") return leave();
      return {};
    },
  } });
  await controller.start();
  return { controller, calls, mutations: () => calls.filter(c => c.method === "account.leave") };
}

test("Shift+D confirms the arrow's exact room, not the open room, once", async () => {
  let resolve!: (result: JsonObject) => void;
  const { controller, mutations } = await setup(() => new Promise(r => { resolve = r; }));
  await controller.selectConversation(0);
  // Shift+Tab moves from messages back to rooms, then select another account.
  await controller.dispatchKey("ShiftTab");
  expect(controller.state.pane).toBe("rooms");
  await controller.dispatchKey("ArrowDown");
  await controller.dispatchKey("D");
  expect(controller.state.leaveRoom?.title).toBe("둘째 방");
  expect(mutations()).toHaveLength(0);
  for (const width of [80, 120]) expect(renderScreen(controller.state, { width, height: 24 })).toContain("Enter / Y 나가기");
  await controller.dispatchKey("ArrowUp");
  await controller.selectConversation(0);
  expect(controller.state.leaveRoom?.resource.account).toBe("two");
  const pending = controller.dispatchKey("Enter");
  await controller.dispatchKey("Enter");
  await controller.dispatchKey("D");
  expect(mutations()).toEqual([{ method: "account.leave", params: { platform: "kakao", account: "two", chat_id: "same" } }]);
  resolve({ state: "Left" });
  await pending;
  expect(conversationRows(controller.state).map(r => r.resource.account)).toEqual(["one"]);
  expect(controller.state.activeResource?.account).toBe("one");
  expect(controller.state.roomFocus).toBe(0);
  controller.stop();
});

for (const cancel of ["Escape", "Cancel", "n"]) test(`${cancel} cancels without exiting or changing selection`, async () => {
  const { controller, mutations } = await setup();
  await controller.dispatchKey("ArrowDown");
  await controller.dispatchKey("D");
  await controller.dispatchKey(cancel);
  expect(controller.state.leaveRoom).toBeUndefined();
  expect(controller.state.quitRequested).toBe(false);
  expect(controller.state.roomFocus).toBe(1);
  expect(mutations()).toHaveLength(0);
  controller.stop();
});

test("failed leave retains room and does not retry", async () => {
  const { controller, mutations } = await setup(async () => { throw new Error("lost connection"); });
  await controller.dispatchKey("D");
  await controller.dispatchKey("y");
  expect(conversationRows(controller.state)).toHaveLength(2);
  expect(controller.state.leaveRoom).toBeUndefined();
  expect(controller.state.notice).toContain("확인하지 못했습니다");
  expect(mutations()).toHaveLength(1);
  controller.stop();
});

test("leaving the open room clears its editor and returns to rooms", async () => {
  const { controller } = await setup();
  await controller.selectConversation(0);
  await controller.dispatchKey("ShiftTab");
  await controller.dispatchKey("D");
  await controller.dispatchKey("Enter");
  expect(controller.state.activeResource).toBeUndefined();
  expect(controller.state.screen).toBe("inbox");
  expect(controller.state.pane).toBe("rooms");
  controller.stop();
});

test("Shift+D is ordinary text in search and composer, and inactive outside rooms", async () => {
  const { controller, mutations } = await setup();
  await controller.dispatchKey("/");
  await controller.dispatchKey("D");
  expect(controller.state.searchQuery).toBe("D");
  expect(controller.state.leaveRoom).toBeUndefined();
  await controller.selectConversation(0); // search remains active; no navigation
  await controller.dispatchKey("Cancel");
  await controller.selectConversation(0);
  await controller.dispatchKey("c");
  await controller.dispatchKey("D");
  expect(controller.state.draft).toBe("D");
  expect(controller.state.leaveRoom).toBeUndefined();
  expect(mutations()).toHaveLength(0);
  controller.stop();
});


test("disconnect cancels confirmation and reconnect never replays it", async () => {
  const { controller, mutations } = await setup();
  await controller.dispatchKey("D");
  controller.disconnected();
  expect(controller.state.leaveRoom).toBeUndefined();
  await controller.start();
  expect(mutations()).toHaveLength(0);
  controller.stop();
});
