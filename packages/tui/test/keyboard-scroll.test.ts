import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { actionKey } from "../src/runtime.ts";
import { editDraft } from "../src/editor.ts";
import { createInitialState, createTuiController, reduce, renderScreen } from "../src/index.ts";
import { chatScrollMetrics } from "../src/workspace.ts";

const key = (name: string, modifiers: Partial<KeyEvent> = {}) => ({ name, sequence: name, ctrl: false, shift: false, meta: false, option: false, ...modifiers } as KeyEvent);
test("terminal shortcuts distinguish editing, modifiers, and literal characters", () => {
  expect(actionKey(key("c", { ctrl: true }))).toBe("Cancel");
  expect(actionKey(key("q"))).toBe("q");
  expect(actionKey(key("q", { ctrl: true }))).toBe("");
  expect(actionKey(key("return", { shift: true }))).toBe("ShiftEnter");
  expect(actionKey(key("r", { shift: true }))).toBe("R");
  expect(actionKey(key("up", { shift: true }), true)).toBe("PageUp");
  expect(actionKey(key("down", { shift: true }), true)).toBe("PageDown");
  for (const modifier of [{ meta: true }, { option: true }]) {
    expect(actionKey(key("left", modifier), true)).toBe("WordLeft");
    expect(actionKey(key("right", modifier), true)).toBe("WordRight");
    expect(actionKey(key("backspace", modifier), true)).toBe("DeleteWordLeft");
  }
  expect(actionKey(key("k", { ctrl: true }), true)).toBe("KillLineRight");
  expect(actionKey(key("k", { ctrl: true }))).toBe("Find");
});

test("editor moves and deletes complete Korean and emoji graphemes across lines", () => {
  const text = "안녕 👩‍💻\nhello world";
  expect(editDraft(text, text.length, "WordLeft")?.cursor).toBe(text.indexOf("world"));
  expect(editDraft(text, text.length, "DeleteWordLeft")?.text).toBe("안녕 👩‍💻\nhello ");
  const emojiEnd = text.indexOf("\n");
  expect(editDraft(text, emojiEnd, "Backspace")?.text).toBe("안녕 \nhello world");
  expect(editDraft(text, text.length, "Home")?.cursor).toBe(text.indexOf("hello"));
  expect(editDraft(text, 0, "End")?.cursor).toBe(emojiEnd);
  expect(editDraft("가나다\nabc", 2, "ArrowDown")?.cursor).toBe(6);
});

test("Ctrl+C cancels then exits; typing resets the consecutive interrupt", async () => {
  let stopped = 0;
  const state = { ...createInitialState(), composeActive: true, composeMode: "text" as const, pane: "messages" as const, draft: "draft" };
  const controller = createTuiController({ initialState: state, client: { start: async () => {}, stop: () => { stopped++; }, request: async () => ({}) } });
  await controller.dispatchKey("Escape");
  expect(controller.state.draft).toBe("draft");
  await controller.dispatchKey("Cancel");
  expect(controller.state.draft).toBe("");
  expect(controller.state.quitRequested).toBe(false);
  await controller.dispatchKey("q");
  expect(controller.state.quitRequested).toBe(false);
  await controller.dispatchKey("Cancel");
  expect(stopped).toBe(0);
  await controller.dispatchKey("Cancel");
  expect(controller.state.quitRequested).toBe(true);
  expect(stopped).toBe(1);
});

test("scrolling loads older messages once, keeps them ordered, and reaches the tail", async () => {
  const resource = { v: 1, kind: "chat", platform: "slack", account: "me", chat_id: "room" } as const;
  let state = reduce(createInitialState(), { type: "connected", generation: 0 });
  state = { ...state, accountMode: false, screen: "chat", activeResource: resource, activeChat: { platform: "slack", account: "me", chat_id: "room" }, pane: "messages", focus: 0, views: { ...state.views, chat: { ...state.views.chat, status: "ready", data: [{ id: "new", body: "latest", ts: "20", resource }], nextCursor: "older" } } };
  const calls: string[] = [];
  const controller = createTuiController({ initialState: state, client: { start: async () => {}, stop: () => {}, request: async (method, params) => {
    calls.push(method);
    return { messages: Array.from({ length: 12 }, (_, i) => ({ msg_id: `old-${i}`, ts: String(i), body: `old ${i}` })) };
  } } });
  await controller.dispatchKey("n");
  expect(calls).toEqual([]);
  await Promise.all([controller.dispatchKey("PageUp"), controller.dispatchKey("PageUp")]);
  expect(calls).toEqual(["message.inbox"]);
  expect(controller.state.views.chat.data.at(-1)?.id).toBe("new");
  for (let i = 0; i < 5; i++) await controller.dispatchKey("PageDown");
  const metrics = chatScrollMetrics(controller.state, { width: 80, height: 24 });
  expect(metrics.top + metrics.visible).toBe(metrics.total);
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("latest");
  expect(renderScreen(controller.state, { width: 80, height: 24 })).not.toContain("n 다음");
});

test("native Kitty input handles Shift+Enter, Option movement, mouse scrolling and the real cursor", async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const { mountInteractiveTui } = await import("../src/runtime.ts");
  const resource = { v: 1, kind: "chat", platform: "slack", account: "me", chat_id: "room" } as const;
  const initialState = { ...createInitialState(), screen: "chat" as const, activeResource: resource, pane: "messages" as const, composeActive: true, composeMode: "text" as const, draft: "hello world", focus: 29 };
  initialState.views.chat = { ...initialState.views.chat, data: Array.from({ length: 30 }, (_, i) => ({ id: String(i), body: `message ${i}`, resource })), status: "ready" };
  const controller = createTuiController({ initialState, client: { start: async () => {}, stop: () => {}, request: async () => ({}) } });
  const harness = await createTestRenderer({ width: 80, height: 24, kittyKeyboard: true });
  const positions: Array<[number, number, boolean | undefined]> = [];
  const original = harness.renderer.setCursorPosition.bind(harness.renderer);
  harness.renderer.setCursorPosition = (x, y, visible) => { positions.push([x, y, visible]); original(x, y, visible); };
  const mounted = await mountInteractiveTui(harness.renderer, controller);
  try {
    await harness.flush();
    expect(positions.at(-1)?.[2]).toBe(true);
    harness.mockInput.pressArrow("left", { meta: true });
    await harness.waitFor(() => controller.state.draftCursor === 6);
    harness.mockInput.pressEnter({ shift: true });
    await harness.waitFor(() => controller.state.draft === "hello \nworld");
    harness.mockInput.pressArrow("up", { shift: true });
    await harness.waitFor(() => controller.state.chatScrollOffset !== undefined);
    const top = controller.state.chatScrollOffset!;
    await harness.flush();
    await harness.mockMouse.scroll(60, 8, "up");
    await harness.waitFor(() => controller.state.chatScrollOffset! < top);
    expect(controller.state.draft).toBe("hello \nworld");
    expect(harness.captureCharFrame()).not.toContain("▏");
    harness.mockInput.pressCtrlC();
    await harness.waitFor(() => !controller.state.composeActive);
    expect(positions.at(-1)?.[2]).toBe(false);
  } finally { mounted.destroy(); controller.stop(); harness.renderer.destroy(); }
});

test.each(["filters", "rooms"] as const)("Ctrl+C exits immediately from %s, including an open room with a draft", async pane => {
  let stopped = 0;
  const controller = createTuiController({
    initialState: { ...createInitialState(), screen: "chat", pane, composeActive: true, draft: "unsent" },
    client: { start: async () => {}, stop: () => { stopped++; }, request: async () => ({}) },
  });
  await controller.dispatchKey("Cancel");
  expect(controller.state.quitRequested).toBe(true);
  expect(controller.state.draft).toBe("");
  expect(stopped).toBe(1);
});

test.each(["inbox", "chat", "search", "approvals", "doctor"] as const)("b and d have no action or help entry on %s", async screen => {
  const calls: string[] = [];
  const controller = createTuiController({
    initialState: { ...createInitialState(), screen, pane: "messages", helpOpen: true },
    client: { start: async () => {}, stop: () => {}, request: async method => { calls.push(method); return {}; } },
  });
  await controller.dispatchKey("b");
  await controller.dispatchKey("d");
  expect(calls).toEqual([]);
  expect(controller.state.detailOpen).toBe(false);
  const frame = renderScreen(controller.state, { width: 120, height: 40 });
  expect(frame).not.toContain("d 상세");
  expect(frame).not.toContain("b 불러오기");
  expect(frame).toContain("Shift+R 불러오기");
});
