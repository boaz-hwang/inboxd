import { expect, test } from "bun:test";
import { createInitialState, createTuiController, displayWidth, mountInteractiveTui, reduce, renderScreen, type TuiState } from "../src/index.ts";
import { conversationRows, filteredMessages } from "../src/workspace-model.ts";
import type { JsonObject, ResourceCapabilityV1, ResourceRefV1 } from "../../protocol/src/schema.ts";

const resources = ["slack", "telegram", "kakao"].map(platform => ({ v: 1, kind: "chat", platform, account: `${platform}-private-account`, chat_id: `${platform}-opaque-id` } as const));
const capabilities: ResourceCapabilityV1[] = resources.map(resource => ({ v: 1, resource, read: { mode: "bounded_history", limits: { max_page_size: 100, max_pages: 1, cursor: "none" } }, write: { mode: "send", content_mode: "text", reply: resource.platform !== "kakao" }, receipt: { level: "independent_readback" }, auth: { state: "authenticated", reason: null, observed_at: 1 } }));
const messages = resources.map((resource, i) => ({ resource, chat: { platform: resource.platform, account: resource.account, chat_id: resource.chat_id }, id: `m${i}`, msg_id: `m${i}`, author: ["민수", "지연", "서준"][i], ts: "1726650000", body: ["내일 오후에 만나요", "자료 확인했습니다", "점심 같이 드실래요?"][i] }));
function fixture(): TuiState {
  let state = createInitialState();
  state = reduce(state, { type: "connected", generation: 1 });
  state = reduce(state, { type: "subscribed", generation: 1 });
  state = reduce(state, { type: "capabilitySucceeded", generation: 1, data: capabilities });
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "inbox", data: messages, coverage: { freshness: "partial", gaps: 1 } });
  return { ...state, notice: undefined, directory: resources.map((resource, i) => ({ id: `r${i}`, resource, title: ["디자인팀", "가족", "친구들"][i] })) };
}
function mockController() {
  const calls: { method: string; params: JsonObject }[] = [];
  const controller = createTuiController({ client: { start: async () => {}, stop: () => {}, request: async (method, params) => {
    calls.push({ method, params });
    if (method === "capability.list") return { v: 1, resources: capabilities } as unknown as JsonObject;
    if (method === "chat.list") return { chats: resources.map((r, i) => ({ platform: r.platform, account: r.account, chat_id: r.chat_id, display_name: ["디자인팀", "가족", "친구들"][i] })) };
    if (method === "message.recent") return { messages: messages.map(m => ({ ...m.chat, msg_id: m.id, body: m.body, author: m.author, ts: m.ts })) };
    if (method === "message.inbox") return { messages: [{ msg_id: "parent", author: "민수", body: "한글 메시지 👩‍💻" }] };
    if (method === "message.send") return { state: "Verified" };
    if (method === "safety.intent.listPending") return { intents: [] };
    return {};
  } } });
  return { controller, calls };
}

test.each([{ width: 80, height: 24 }, { width: 120, height: 40 }])("unified workspace shows essential information, separated providers, and exact cells: %j", size => {
  const state = fixture();
  const frame = renderScreen(state, size);
  for (const text of ["[SL]", "[TG]", "[KK]", "디자인팀", "가족", "친구들", "내일 오후에 만나요", "자료 확인했습니다", "점심 같이 드실래요?"]) expect(frame).toContain(text);
  for (const text of ["private-account", "opaque-id", "observed_at", "max_page", "READ ", "WRITE ", "RECEIPT", "AUTH ", "generation", "memory-only", "Evidence rail"]) expect(frame).not.toContain(text);
  expect(frame).toContain("일부 기록만 표시 중");
  expect(frame.split("\n")).toHaveLength(size.height);
  for (const line of frame.split("\n")) expect(displayWidth(line)).toBe(size.width);
});

test("filter affects both rooms and messages; exact resources remain unmodified", () => {
  let state = fixture();
  state = reduce(state, { type: "key", key: "]" }); // all -> kakao
  expect(state.platform).toBe("kakao");
  expect(conversationRows(state)).toHaveLength(1);
  expect(filteredMessages(state, "inbox")).toHaveLength(1);
  expect(conversationRows(state)[0]!.resource).toEqual(resources[2]);
  const frame = renderScreen(state, { width: 120, height: 40 });
  expect(frame).toContain("점심 같이");
  expect(frame).not.toContain("내일 오후에");
});

test("chat selection -> text input -> direct send preserves destination", async () => {
  const { controller, calls } = mockController();
  await controller.start();
  await controller.dispatchKey("ArrowDown");
  await controller.dispatchKey("Enter");
  expect(controller.state.activeResource).toEqual(resources[1]);
  expect(controller.state.screen).toBe("chat");
  await controller.dispatchKey("Enter");
  expect(controller.state.composeActive).toBe(true);
  await controller.dispatchPaste("좋아요\n내일 봐요 👩‍💻");
  await controller.dispatchKey("Enter");
  expect(controller.state.screen).toBe("chat");
  expect(controller.state.draft).toBe("");
  const create = calls.find(c => c.method === "message.send")!;
  expect(create.params.envelope).toEqual({ v: 2, destination: resources[1], content: { mode: "text", body: "좋아요\n내일 봐요 👩‍💻" } });
  expect(calls.some(c => c.method === "safety.intent.approve")).toBe(false);
  expect(controller.state.lastSend?.state).toBe("Verified");
  expect(calls.filter(c => c.method === "safety.intent.approve")).toHaveLength(0);
  controller.stop();
});

test("editor preserves graphemes, inserts at cursor and never interprets pasted shortcuts", async () => {
  const { controller, calls } = mockController();
  await controller.start();
  await controller.dispatchPaste("q4ac");
  expect(controller.state.quitRequested).toBe(false);
  await controller.selectConversation(0);
  await controller.dispatchKey("Enter");
  await controller.dispatchPaste("가👩‍💻나");
  await controller.dispatchKey("ArrowLeft");
  await controller.dispatchKey("Backspace");
  expect(controller.state.draft).toBe("가나");
  await controller.dispatchKey("ShiftEnter");
  await controller.dispatchPaste("q4ac");
  expect(controller.state.draft).toBe("가\nq4ac나");
  expect(calls.some(c => c.method === "message.send")).toBe(false);
  await controller.dispatchKey("Escape");
  expect(controller.state.draft).toBe("");
  controller.stop();
});

test("platform filter never changes the destination of an active draft", async () => {
  const { controller } = mockController();
  await controller.start();
  await controller.selectConversation(1);
  await controller.dispatchKey("Enter");
  await controller.dispatchKey("]");
  await controller.selectConversation(2);
  expect(controller.state.activeResource).toEqual(resources[1]);
  expect(controller.state.draft).toBe("]");
  expect(controller.state.platform).toBeUndefined();
  controller.disconnected();
  expect(controller.state.draft).toBe("");
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("연결 끊김");
  controller.stop();
});

test("read-only and unavailable capabilities never open an editor", () => {
  let state = { ...fixture(), screen: "chat" as const, activeResource: resources[0], pane: "messages" as const };
  state = { ...state, capabilities: { ...state.capabilities, data: [] } };
  const next = reduce(state, { type: "key", key: "c" });
  expect(next.composeActive).toBe(false);
  expect(renderScreen(next, { width: 80, height: 24 })).toContain("보관 기록 · 읽기 전용");
});

test.each([{ width: 80, height: 24 }, { width: 120, height: 40 }])("native renderer keyboard and paste use the real workspace at %j", async size => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const harness = await createTestRenderer(size);
  const { controller } = mockController();
  const mounted = await mountInteractiveTui(harness.renderer, controller);
  try {
    await controller.start();
    harness.mockInput.pressEnter();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(controller.state.screen).toBe("chat");
    harness.mockInput.pressEnter();
    await harness.mockInput.typeText("한글 답장");
    await new Promise(resolve => setTimeout(resolve, 10));
    await harness.flush();
    expect(controller.state.draft).toBe("한글 답장");
    const frame = renderScreen(controller.state, size);
    expect(frame).toContain("한글 답장▏");
    expect(frame).toContain("Enter 보내기");
    for (const line of frame.split("\n")) expect(displayWidth(line)).toBe(size.width);
    harness.mockInput.pressKey("ESC");
  } finally { mounted.destroy(); controller.stop(); harness.renderer.destroy(); }
});

test("conversation search is local, matches Korean names and provider names, and opens exact scope", async () => {
  const { controller, calls } = mockController();
  await controller.start();
  const before = calls.length;
  await controller.dispatchKey("Find");
  await controller.dispatchPaste("가족");
  expect(conversationRows(controller.state)).toHaveLength(1);
  expect(calls).toHaveLength(before);
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("대화 찾기  가족▏");
  await controller.dispatchKey("Enter");
  expect(controller.state.activeResource).toEqual(resources[1]);
  expect(controller.state.finderActive).toBe(false);
  expect(controller.state.finderQuery).toBe("");
  await controller.dispatchKey("Find");
  await controller.dispatchPaste("no match");
  await controller.dispatchKey("Enter");
  expect(controller.state.finderActive).toBe(true);
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("검색 결과 없음");
  await controller.dispatchKey("Escape");
  expect(controller.state.finderQuery).toBe("");
  controller.stop();
});

test("native Ctrl+F searches message content in the exact selected chat", async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const harness = await createTestRenderer({ width: 80, height: 24 });
  const { controller, calls } = mockController();
  const mounted = await mountInteractiveTui(harness.renderer, controller);
  try {
    await controller.start();
    await controller.selectConversation(1);
    harness.mockInput.pressKey("f", { ctrl: true });
    await harness.mockInput.typeText("검색어");
    harness.mockInput.pressEnter();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls.find(c => c.method === "message.search")?.params).toMatchObject({ chat: messages[1]!.chat, query: "검색어" });
    expect(controller.state.finderActive).not.toBe(true);
  } finally { mounted.destroy(); controller.stop(); harness.renderer.destroy(); }
});

test("native mouse selection and terminal resize retain the exact active chat", async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const harness = await createTestRenderer({ width: 120, height: 40 });
  const { controller } = mockController();
  const mounted = await mountInteractiveTui(harness.renderer, controller);
  try {
    await controller.start();
    await harness.flush();
    await harness.mockMouse.click(8, 8); // second sidebar conversation
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(controller.state.activeResource).toEqual(resources[1]);
    harness.resize(80, 24);
    await harness.flush();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("[TG] 가족");
    expect(frame).toContain("Enter 답장 작성");
    expect(frame).not.toContain("max_page");
    harness.mockInput.pressTab();
    harness.mockInput.pressTab();
    await harness.flush();
    expect(harness.captureCharFrame()).toContain("디자인팀");
    expect(controller.state.activeResource).toEqual(resources[1]);
  } finally { mounted.destroy(); controller.stop(); harness.renderer.destroy(); }
});

test("a historical account with the same Telegram chat ID never precedes the connected account", () => {
  const current = resources[1]!;
  const historical = { ...current, account: "previous-account" };
  const state = { ...fixture(), directory: [{ id: "old", resource: historical }, { id: "current", resource: current }], views: { ...fixture().views, inbox: { ...fixture().views.inbox, data: [{ id: "old-message", resource: historical, body: "old history" }, ...messages] } } };
  const telegram = conversationRows(state).filter(room => room.resource.platform === "telegram");
  expect(telegram.map(room => room.resource.account)).toEqual([current.account, historical.account]);
  const archived = { ...state, screen: "chat" as const, activeResource: historical, pane: "messages" as const };
  const frame = renderScreen(archived, { width: 80, height: 24 });
  expect(frame).toContain("보관 기록 · 읽기 전용");
  expect(frame).not.toContain("계정 연결 확인 필요");
  expect(reduce(archived, { type: "key", key: "c" }).composeActive).toBe(false);
});

test("connection loading is not described as a login failure", () => {
  const state = { ...fixture(), screen: "chat" as const, activeResource: resources[1], capabilities: { status: "loading" as const, data: [] } };
  expect(renderScreen(state, { width: 80, height: 24 })).toContain("연결 상태 확인 중");
  expect(renderScreen(state, { width: 80, height: 24 })).not.toContain("계정 연결 확인 필요");
});
