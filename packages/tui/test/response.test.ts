import { expect, test } from "bun:test";
import { createTuiController, renderScreen } from "../src/index.ts";
import { conversationRows } from "../src/workspace-model.ts";
import { renderedObservation } from "../src/workspace.ts";
import type { JsonObject } from "../../protocol/src/schema.ts";

function setup(options: { state?: string; status?: string; long?: boolean; readOnly?: boolean; open?: (params: JsonObject) => Promise<JsonObject>; next?: () => Promise<JsonObject>; get?: () => Promise<JsonObject>; seen?: () => Promise<JsonObject> } = {}) {
  const calls: { method: string; params: JsonObject }[] = [];
  let sequence = 0;
  const sessions = new Map<string, string>();
  const rooms = ["A", "B"].map((chat_id, i) => ({ platform: "kakao", account: "owner", chat_id, display_name: chat_id, latest_ts: 20 - i, preview: chat_id, can_send: !options.readOnly, unread: { count: 1, source: "observed", status: i ? "at_least" : "known" }, suggestion_status: "ready" }));
  const controller = createTuiController({ client: { start: async () => {}, stop() {}, async request(method, params) {
    calls.push({ method, params });
    if (method === "account.list") return { available: true, chats: rooms, errors: [] };
    if (method === "account.messages") return { messages: [{ id: `${params.chat_id}-m`, author_name: "상대", body: options.long ? "긴 메시지 내용 ".repeat(500) : "내일 이야기할까요?", ts: 10 }] };
    if (method === "response.open") {
      if (options.open) return options.open(params);
      const chat = params.chat as JsonObject, id = `s${++sequence}`; sessions.set(id, String(chat.chat_id));
      return { response_session_id: id, chat, incoming_version: "v1", source_message_ids: [`${chat.chat_id}-m`], status: options.status ?? "ready", suggestion: options.readOnly ? null : { id: `g${sequence}`, text: "확인해 볼게요.", context_version: "v1" } };
    }
    if (method === "response.get" && options.get) return options.get();
    if (method === "response.get") return { status: options.status ?? "ready", suggestion: { id: "g1", text: "늦은 추천", context_version: "v1" } };
    if (method === "response.next" && options.next) return options.next();
    if (method === "response.next") return { status: "next", chat: { platform: "kakao", account: "owner", chat_id: "B" } };
    if (method === "response.seen" && options.seen) return options.seen();
    if (method === "response.seen") return { unread: { count: 0, source: "observed", status: "known" } };
    if (method === "message.send" || method === "send.status") return { state: options.state ?? "Sent" };
    return {};
  } } });
  const render = () => { const observed = renderedObservation(controller.state, { width: 120, height: 40 }); controller.observeRendered(observed.slices, observed.suggestionVisible); };
  return { controller, calls, render, rooms };
}

test("Enter opens the selected room while an empty response composer remains active", async () => {
  const { controller, calls } = setup();
  try {
    await controller.start();
    await controller.dispatchKey("Enter");
    expect(controller.state.activeChat?.chat_id).toBe("A");
    expect(controller.state.composeActive).toBe(true);
    await controller.dispatchKey("ShiftTab");
    await controller.dispatchKey("ArrowDown");
    await controller.dispatchKey("Enter");
    expect(controller.state.activeChat?.chat_id).toBe("B");
    expect(controller.state.pane).toBe("messages");
    expect(controller.state.response?.chat.chat_id).toBe("B");
    expect(calls.filter(call => call.method === "message.send")).toHaveLength(0);
  } finally { controller.stop(); }
});

test("Enter returns to the same room with its draft and response session intact", async () => {
  const { controller, calls } = setup();
  try {
    await controller.start(); await controller.selectConversation(0);
    await controller.dispatchPaste("작성 중인 답장");
    const session = controller.state.response?.id;
    await controller.dispatchKey("ShiftTab");
    await controller.dispatchKey("Enter");
    expect(controller.state.pane).toBe("messages");
    expect(controller.state.draft).toBe("작성 중인 답장");
    expect(controller.state.response?.id).toBe(session);
    expect(calls.filter(call => call.method === "message.send")).toHaveLength(0);
  } finally { controller.stop(); }
});

test("room-list Enter keeps separate drafts and cursors without sending", async () => {
  const { controller, calls } = setup();
  try {
    await controller.start(); await controller.selectConversation(0);
    await controller.dispatchPaste("A 초안");
    await controller.dispatchKey("ArrowLeft");
    const cursor = controller.state.draftCursor;
    await controller.dispatchKey("ShiftTab");
    await controller.dispatchKey("ArrowDown");
    await controller.dispatchKey("Enter");
    expect(controller.state.activeChat?.chat_id).toBe("B");
    expect(controller.state.draft).toBe("");
    await controller.dispatchPaste("B 초안");
    await controller.dispatchKey("ShiftTab");
    await controller.dispatchKey("ArrowUp");
    await controller.dispatchKey("Enter");
    expect(controller.state.activeChat?.chat_id).toBe("A");
    expect(controller.state.draft).toBe("A 초안");
    expect(controller.state.draftCursor).toBe(cursor);
    await controller.dispatchKey("ShiftTab");
    await controller.dispatchKey("ArrowDown");
    await controller.dispatchKey("Enter");
    expect(controller.state.draft).toBe("B 초안");
    expect(calls.filter(call => call.method === "message.send")).toHaveLength(0);
  } finally { controller.stop(); }
});

test("cancelled draft does not return on a later room visit", async () => {
  const { controller } = setup();
  try {
    await controller.start(); await controller.selectConversation(0);
    await controller.dispatchPaste("지울 초안");
    await controller.dispatchKey("ShiftTab"); await controller.dispatchKey("ArrowDown"); await controller.dispatchKey("Enter");
    await controller.dispatchKey("ShiftTab"); await controller.dispatchKey("ArrowUp"); await controller.dispatchKey("Enter");
    expect(controller.state.draft).toBe("지울 초안");
    await controller.dispatchKey("Cancel");
    await controller.dispatchKey("ShiftTab"); await controller.dispatchKey("ArrowDown"); await controller.dispatchKey("Enter");
    await controller.dispatchKey("ShiftTab"); await controller.dispatchKey("ArrowUp"); await controller.dispatchKey("Enter");
    expect(controller.state.draft).toBe("");
  } finally { controller.stop(); }
});

test("a late response from the previous room cannot replace a restored draft", async () => {
  let resolveA!: (value: JsonObject) => void;
  let signalA!: () => void;
  const requestedA = new Promise<void>(resolve => { signalA = resolve; });
  const { controller, calls } = setup({ open: params => {
    const chat = params.chat as JsonObject;
    if (chat.chat_id === "A" && !resolveA) return new Promise(resolve => { resolveA = resolve; signalA(); });
    return Promise.resolve({ response_session_id: `session-${chat.chat_id}`, chat, status: "ready", source_message_ids: [], suggestion: { id: `suggestion-${chat.chat_id}`, text: `추천 ${chat.chat_id}` } });
  } });
  try {
    await controller.start();
    const openingA = controller.selectConversation(0);
    await requestedA;
    await controller.dispatchPaste("내 A 초안");
    await controller.dispatchKey("ShiftTab"); await controller.dispatchKey("ArrowDown"); await controller.dispatchKey("Enter");
    resolveA({ response_session_id: "late-A", chat: { platform: "kakao", account: "owner", chat_id: "A" }, status: "ready", suggestion: { id: "late", text: "늦은 A 추천" } });
    await openingA;
    expect(controller.state.activeChat?.chat_id).toBe("B");
    expect(controller.state.response?.chat.chat_id).toBe("B");
    await controller.dispatchKey("ShiftTab"); await controller.dispatchKey("ArrowUp"); await controller.dispatchKey("Enter");
    expect(controller.state.draft).toBe("내 A 초안");
    expect(controller.state.response?.chat.chat_id).toBe("A");
    expect(calls.filter(call => call.method === "message.send")).toHaveLength(0);
  } finally { controller.stop(); }
});

test("provider-read refresh clears response targets without overwriting the user's draft", async () => {
  const { controller, calls } = setup({ get: async () => ({ status: "abstained", source_message_ids: [], suggestion: null }) });
  try {
    await controller.start(); await controller.selectConversation(0);
    await controller.dispatchPaste("작성한 답장");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(controller.state.response?.sourceIds).toEqual([]);
    expect(controller.state.response?.suggestion).toBeUndefined();
    expect(controller.state.draft).toBe("작성한 답장");
    expect(calls.some(call => call.method === "message.send")).toBe(false);
    expect(calls.filter(call => call.method === "response.seen")).toHaveLength(1);
  } finally { controller.stop(); }
});

test("reopening a read room still displays its unsent recommendation and Tab accepts it", async () => {
  let sequence = 0;
  const { controller, calls, render, rooms } = setup({ open: async params => {
    const chat = params.chat as JsonObject;
    return { response_session_id: `retained-${++sequence}`, chat, incoming_version: "v1", source_message_ids: sequence > 1 ? [] : ["A-m"], status: "ready", suggestion: { id: `reply-${chat.chat_id}`, text: "읽어도 남아 있는 추천", context_version: "v1" } };
  } });
  try {
    await controller.start(); await controller.selectConversation(0);
    render(); await new Promise(resolve => setTimeout(resolve, 0));
    rooms[0]!.unread.count = 0;
    expect(conversationRows(controller.state).find(row => row.title === "A")?.unread).toBe(0);
    const original = controller.state.response?.suggestion?.id;
    await controller.selectConversation(1);
    await controller.selectConversation(0);
    expect(controller.state.response?.suggestion?.id).toBe(original);
    expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain("읽어도 남아 있는 추천");
    await controller.dispatchKey("Tab");
    expect(controller.state.draft).toBe("읽어도 남아 있는 추천");
    expect(calls.filter(call => call.method === "message.send")).toHaveLength(0);
  } finally { controller.stop(); }
});

test("async read rollback restores unread without resubmitting on render or changing draft", async () => {
  const { controller, render, calls } = setup({ seen: async () => ({ unread: { count: 0, source: "combined", status: "known" }, read_sync: { operation_id: "read-1", status: "pending" } }) });
  try {
    await controller.start(); await controller.selectConversation(0);
    render(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(conversationRows(controller.state).find(r => r.title === "A")?.unread).toBe(0);
    await controller.dispatchKey("my draft");
    await controller.receiveEvent("account.changed", { phase: "read_sync", platform: "kakao", account: "owner", chat_id: "A", read_sync: { operation_id: "read-1", status: "failed" }, unread: { count: 1, source: "combined", status: "known" } });
    expect(conversationRows(controller.state).find(r => r.title === "A")?.unread).toBe(1);
    expect(controller.state.notice).toContain("읽음 동기화 실패");
    expect(controller.state.draft).toBe("my draft");
    expect(renderScreen({ ...controller.state, notice: undefined }, { width: 120, height: 40 })).toContain("읽음 동기화 실패");
    render(); await Promise.resolve();
    expect(calls.filter(c => c.method === "response.seen")).toHaveLength(1);
    expect(calls.filter(c => c.method === "message.send")).toHaveLength(0);
  } finally { controller.stop(); }
});

test("early read rollback cannot be overwritten by a late optimistic reply", async () => {
  let resolveSeen!: (value: JsonObject) => void;
  const { controller, render } = setup({ seen: () => new Promise(resolve => { resolveSeen = resolve; }) });
  try {
    await controller.start(); await controller.selectConversation(0); render();
    await controller.receiveEvent("account.changed", { phase: "read_sync", platform: "kakao", account: "owner", chat_id: "A", read_sync: { operation_id: "read-2", status: "failed" }, unread: { count: 1, source: "combined", status: "known" } });
    resolveSeen({ unread: { count: 0, source: "combined", status: "known" }, read_sync: { operation_id: "read-2", status: "pending" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(conversationRows(controller.state).find(r => r.title === "A")?.unread).toBe(1);
  } finally { controller.stop(); }
});

test("read rollback for a previous room does not interrupt the current composer", async () => {
  const { controller } = setup();
  try {
    await controller.start(); await controller.selectConversation(1);
    await controller.dispatchKey("B draft");
    const notice = controller.state.notice;
    await controller.receiveEvent("account.changed", { phase: "read_sync", platform: "kakao", account: "owner", chat_id: "A", read_sync: { operation_id: "read-old-room", status: "failed" }, unread: { count: 2, source: "combined", status: "known" } });
    expect(conversationRows(controller.state).find(r => r.title === "A")?.unread).toBe(2);
    expect(controller.state.activeChat?.chat_id).toBe("B");
    expect(controller.state.draft).toBe("B draft");
    expect(controller.state.notice).toBe(notice);
  } finally { controller.stop(); }
});

test("ready ghost needs Tab before Enter; send then next Tab only opens next room", async () => {
  const { controller, calls, render } = setup();
  try {
    await controller.start(); await controller.selectConversation(0);
    expect(controller.state.composeActive).toBe(true);
    expect(controller.state.draft).toBe("");
    expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain("확인해 볼게요.");
    await controller.dispatchKey("Enter"); expect(calls.some(c => c.method === "message.send")).toBe(false);
    render(); await Promise.resolve();
    await controller.dispatchKey("Tab"); expect(controller.state.draft).toBe("확인해 볼게요.");
    await controller.dispatchKey("Enter");
    expect(calls.find(c => c.method === "message.send")?.params.response_session_id).toBe("s1");
    expect(controller.state.response?.sendState).toBe("Sent");
    await controller.dispatchKey("Tab");
    expect(controller.state.activeChat?.chat_id).toBe("B");
    expect(controller.state.draft).toBe("");
    expect(controller.state.responseFocus).toBe(true);
    expect(calls.filter(c => c.method === "response.feedback" && c.params.event === "inserted")).toHaveLength(1);
  } finally { controller.stop(); }
});

test("Esc clears an accepted suggestion and Tab opens the next unread room", async () => {
  const { controller, calls, render } = setup();
  try {
    await controller.start(); await controller.selectConversation(0);
    render(); await Promise.resolve();
    await controller.dispatchKey("Tab");
    expect(controller.state.draft).toBe("확인해 볼게요.");
    await controller.dispatchKey("Cancel");
    expect(controller.state.draft).toBe("");
    await controller.dispatchKey("Tab");
    expect(controller.state.activeChat?.chat_id).toBe("B");
    expect(calls.filter(call => call.method === "message.send")).toHaveLength(0);
    expect(calls.filter(call => call.method === "response.next")).toHaveLength(1);
  } finally { controller.stop(); }
});

test("Tab advances after all-read succeeds with a reply target outside loaded history", async () => {
  const { controller, calls } = setup({ status: "abstained", open: async params => ({
    response_session_id: "off-page", chat: params.chat, status: "abstained", source_message_ids: ["A-off-page"], suggestion: null,
  }) });
  try {
    await controller.start(); await controller.selectConversation(0);
    await controller.dispatchKey("Tab");
    expect(controller.state.activeChat?.chat_id).toBe("B");
    expect(calls.filter(call => call.method === "response.next")).toHaveLength(1);
  } finally { controller.stop(); }
});

test("failed all-read synchronization restores the off-page Tab guard", async () => {
  const { controller, calls } = setup({ status: "abstained", open: async params => ({
    response_session_id: "off-page", chat: params.chat, status: "abstained", source_message_ids: ["A-off-page"], suggestion: null,
  }), seen: async () => ({ unread: { count: 0, source: "combined", status: "known" }, read_sync: { operation_id: "off-page-read", status: "pending" } }) });
  try {
    await controller.start(); await controller.selectConversation(0);
    await controller.receiveEvent("account.changed", { phase: "read_sync", platform: "kakao", account: "owner", chat_id: "A", read_sync: { operation_id: "off-page-read", status: "failed" }, unread: { count: 1, source: "combined", status: "known" } });
    await controller.dispatchKey("Tab");
    expect(controller.state.activeChat?.chat_id).toBe("A");
    expect(calls.filter(call => call.method === "response.next")).toHaveLength(0);
  } finally { controller.stop(); }
});

test.each(["synced", "failed"])("early %s read synchronization preserves the correct off-page Tab behavior", async status => {
  let completeSeen!: (value: JsonObject) => void;
  const { controller, calls } = setup({ status: "abstained", open: async params => ({
    response_session_id: "off-page", chat: params.chat, status: "abstained", source_message_ids: ["A-off-page"], suggestion: null,
  }), seen: () => new Promise(resolve => { completeSeen = resolve; }) });
  try {
    await controller.start(); await controller.selectConversation(0);
    expect(completeSeen).toBeDefined();
    await controller.receiveEvent("account.changed", { phase: "read_sync", platform: "kakao", account: "owner", chat_id: "A", read_sync: { operation_id: "early-read", status }, unread: { count: status === "synced" ? 0 : 1, source: "combined", status: "known" } });
    completeSeen({ unread: { count: 0, source: "combined", status: "known" }, read_sync: { operation_id: "early-read", status: "pending" } });
    await Bun.sleep(0);
    expect(conversationRows(controller.state).find(row => row.title === "A")?.unread).toBe(status === "synced" ? 0 : 1);
    await controller.dispatchKey("Tab");
    expect(controller.state.activeChat?.chat_id).toBe(status === "synced" ? "B" : "A");
    expect(calls.filter(call => call.method === "response.next")).toHaveLength(status === "synced" ? 1 : 0);
  } finally { controller.stop(); }
});

test("read synchronization completion history stays bounded beyond 1024 operations", async () => {
  const { controller } = setup();
  try {
    await controller.start();
    for (let n = 0; n < 1025; n++) {
      await controller.receiveEvent("account.changed", { phase: "read_sync", read_sync: { operation_id: `read-${n}`, status: "synced" } });
    }
    const completions = (controller as unknown as { completedReadSync: Map<string, string> }).completedReadSync;
    expect(completions.size).toBe(1024);
    expect(completions.has("read-0")).toBe(false);
    expect(completions.get("read-1024")).toBe("synced");
  } finally { controller.stop(); }
});

test("direct paste hides recommendation permanently after erasing and records first input once", async () => {
  const { controller, calls } = setup();
  try {
    await controller.start(); await controller.selectConversation(0);
    await controller.dispatchPaste("가"); await controller.dispatchKey("Backspace");
    expect(controller.state.draft).toBe(""); expect(controller.state.response?.hidden).toBe(true);
    await controller.dispatchPaste("직접 작성");
    expect(calls.filter(c => c.method === "response.feedback" && c.params.event === "first_input")).toHaveLength(1);
    await controller.dispatchKey("Tab"); expect(controller.state.draft).toBe("직접 작성");
    expect(calls.some(c => c.method === "response.next")).toBe(false);
  } finally { controller.stop(); }
});

test("Shift+Tab leaves and returns to a composing message without changing its draft or recommendation", async () => {
  const { controller, calls } = setup();
  try {
    await controller.start(); await controller.selectConversation(0);
    await controller.dispatchPaste("직접 작성");
    const feedbackBefore = calls.filter(call => call.method === "response.feedback").length;
    await controller.dispatchKey("ShiftTab");
    expect(controller.state.pane).toBe("rooms");
    expect(controller.state.composeActive).toBe(true);
    expect(controller.state.draft).toBe("직접 작성");
    expect(calls.some(call => call.method === "response.next")).toBe(false);
    expect(calls.filter(call => call.method === "response.feedback")).toHaveLength(feedbackBefore);
    expect(renderScreen(controller.state, { width: 120, height: 40 })).not.toContain("직접 작성\u2060");
    await controller.dispatchKey("ArrowDown");
    expect(controller.state.roomFocus).toBe(1);
    await controller.dispatchKey("Tab");
    expect(controller.state.pane).toBe("rooms");
    await controller.dispatchKey("!");
    await controller.dispatchPaste("붙여넣기");
    await controller.dispatchKey("Enter");
    expect(controller.state.activeChat?.chat_id).toBe("B");
    expect(controller.state.draft).toBe("");
    expect(calls.some(call => call.method === "message.send")).toBe(false);
    await controller.dispatchKey("ShiftTab");
    await controller.dispatchKey("ArrowUp");
    await controller.dispatchKey("Enter");
    expect(controller.state.activeChat?.chat_id).toBe("A");
    expect(controller.state.draft).toBe("직접 작성");
    expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain("직접 작성\u2060");
    await controller.dispatchKey("!");
    expect(controller.state.draft).toBe("직접 작성!");
  } finally { controller.stop(); }
});

test.each([
  ["failed", "추천 생성 실패 · 직접 입력 가능"],
  ["abstained", "추천 없음 · Tab 다음 안 읽은 방 · 직접 입력"],
])("%s recommendation state has an explicit compose hint", async (status, hint) => {
  const { controller } = setup({ status });
  try {
    await controller.start(); await controller.selectConversation(0);
    expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain(hint);
  } finally { controller.stop(); }
});

test("latest self message shows no reply target without a generation failure hint", async () => {
  const noTarget = { status: "abstained", error: "no_reply_target", source_message_ids: [], suggestion: null };
  const { controller } = setup({ open: async () => ({ response_session_id: "self-last", ...noTarget }), get: async () => noTarget });
  try {
    await controller.start(); await controller.selectConversation(0);
    const frame = renderScreen(controller.state, { width: 120, height: 40 });
    expect(frame).toContain("답장 대상 없음 · 직접 입력 가능");
    expect(frame).not.toContain("추천 생성 실패");
    expect(controller.state.response?.suggestion).toBeUndefined();
  } finally { controller.stop(); }
});

test("latest self target error overrides a historical failed suggestion error", async () => {
  const noTarget = { status: "abstained", error: "no_reply_target", source_message_ids: [], suggestion: { id: "old", status: "failed", error: "draft_check_withheld", text: null } };
  const { controller } = setup({ open: async () => ({ response_session_id: "self-after-failure", ...noTarget }), get: async () => noTarget });
  try {
    await controller.start(); await controller.selectConversation(0);
    await Bun.sleep(280); // Cover response.get as well as response.open.
    const frame = renderScreen(controller.state, { width: 120, height: 40 });
    expect(frame).toContain("답장 대상 없음 · 직접 입력 가능");
    expect(frame).not.toContain("추천 생성 실패");
    expect(controller.state.response?.error).toBe("no_reply_target");
    expect(controller.state.response?.suggestion).toBeUndefined();
  } finally { controller.stop(); }
});

test.each(["Failed", "Uncertain"])("%s never advances or automatically resends", async state => {
  const { controller, calls, render } = setup({ state });
  try {
    await controller.start(); await controller.selectConversation(0); render();
    await controller.dispatchKey("Tab"); await controller.dispatchKey("Enter");
    await controller.dispatchKey("Tab"); await controller.dispatchKey("Enter"); await controller.dispatchKey("x");
    expect(calls.filter(c => c.method === "message.send")).toHaveLength(1);
    expect(calls.some(c => c.method === "response.next")).toBe(false);
    expect(controller.state.draft).toBe("");
  } finally { controller.stop(); }
});

test("entering a room marks all messages read without scrolling or displaying the suggestion", async () => {
  const { controller, calls } = setup({ long: true, status: "abstained" });
  try {
    await controller.start();
    expect(calls.some(c => c.method === "response.seen")).toBe(false);
    await controller.selectConversation(0);
    expect(calls.find(c => c.method === "response.seen")?.params).toMatchObject({ all: true, message_ids: [] });
    expect(calls.some(c => c.params.event === "shown")).toBe(false);
    expect(controller.state.directory?.find(row => row.chat?.chat_id === "A")?.unreadEvidence?.count).toBe(0);
  } finally { controller.stop(); }
});

test("structured unread survives directory mapping and same-time ordering uses chat identity", async () => {
  const { controller, rooms } = setup(); rooms[1]!.latest_ts = rooms[0]!.latest_ts;
  try {
    await controller.start();
    expect(conversationRows(controller.state).map(r => [r.title, r.unread, r.unreadStatus])).toEqual([["A", 1, "known"], ["B", 1, "at_least"]]);
    expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain("[1+]");
    await controller.selectConversation(0); await controller.dispatchPaste("보존");
    rooms[1]!.latest_ts = 50; await controller.receiveEvent("account.changed", { platform: "kakao", account: "owner" });
    expect(conversationRows(controller.state)[0]!.title).toBe("B");
    expect(controller.state.activeChat?.chat_id).toBe("A"); expect(controller.state.draft).toBe("보존");
  } finally { controller.stop(); }
});

test("queued recommendation never advances and read-only room never inserts or sends", async () => {
  for (const options of [{ status: "generating" }, { readOnly: true, status: "abstained" }]) {
    const { controller, calls, render } = setup(options);
    try {
      await controller.start(); await controller.selectConversation(0); render(); await Promise.resolve();
      await controller.dispatchKey("Tab"); await controller.dispatchKey("Enter");
      expect(calls.some(c => c.method === "message.send")).toBe(false);
      if (!options.readOnly) expect(calls.some(c => c.method === "response.next")).toBe(false);
    } finally { controller.stop(); }
  }
});

test("late response.open is discarded on escape and never resurrects composing", async () => {
  let resolve!: (result: JsonObject) => void;
  const { controller, calls } = setup({ open: () => new Promise(r => { resolve = r; }) });
  try {
    await controller.start(); const opening = controller.selectConversation(0);
    while (!resolve) await Promise.resolve();
    await controller.dispatchKey("Cancel");
    resolve({ response_session_id: "old", status: "ready", suggestion: { id: "old", text: "오래된 추천" } }); await opening;
    expect(controller.state.response).toBeUndefined(); expect(controller.state.composeActive).toBe(false);
  } finally { controller.stop(); }
});

test("typing and erasing while open is pending never restores a late ghost", async () => {
  let resolve!: (result: JsonObject) => void;
  const { controller, calls } = setup({ open: () => new Promise(r => { resolve = r; }) });
  try {
    await controller.start(); const opening = controller.selectConversation(0);
    while (!resolve) await Promise.resolve();
    await controller.dispatchKey("가"); await controller.dispatchKey("Backspace");
    resolve({ response_session_id: "late", status: "ready", suggestion: { id: "late", text: "늦은 추천" } }); await opening;
    expect(controller.state.draft).toBe(""); expect(controller.state.response?.hidden).toBe(true);
    expect(renderScreen(controller.state, { width: 120, height: 40 })).not.toContain("늦은 추천");
    expect(calls.filter(c => c.method === "response.feedback" && c.params.event === "first_input")).toHaveLength(1);
  } finally { controller.stop(); }
});

test("new asynchronous recommendation cannot overwrite an accepted edited draft", async () => {
  const { controller } = setup();
  try {
    await controller.start(); await controller.selectConversation(0); await controller.dispatchKey("Tab");
    await controller.dispatchPaste(" 추가 작성");
    const draft = controller.state.draft;
    await new Promise(resolve => setTimeout(resolve, 280));
    expect(controller.state.response?.suggestion?.text).toBe("늦은 추천");
    expect(controller.state.draft).toBe(draft); expect(controller.state.response?.hidden).toBe(true);
  } finally { controller.stop(); }
});


test.each([false, true])("typing during pending next cancels navigation even after erase=%s", async erase => {
  let finishNext!: (result: JsonObject) => void;
  const { controller, render } = setup({ status: "abstained", next: () => new Promise(resolve => { finishNext = resolve; }) });
  try {
    await controller.start(); await controller.selectConversation(0); render(); await Promise.resolve();
    const moving = controller.dispatchKey("Tab");
    expect(finishNext).toBeDefined();
    await controller.dispatchPaste("가");
    if (erase) await controller.dispatchKey("Backspace");
    finishNext({ status: "next", chat: { platform: "kakao", account: "owner", chat_id: "B" } });
    await moving;
    expect(controller.state.activeChat?.chat_id).toBe("A");
    expect(controller.state.draft).toBe(erase ? "" : "가");
    expect(controller.state.notice).toContain("이동을 취소");
  } finally { controller.stop(); }
});

test("unavailable result with a chat never opens another response session", async () => {
  const { controller, calls, render } = setup({ status: "abstained", next: async () => ({ status: "unavailable", chat: { platform: "kakao", account: "owner", chat_id: "A" }, remaining_unknown: true }) });
  try {
    await controller.start(); await controller.selectConversation(0); render(); await Promise.resolve();
    await controller.dispatchKey("Tab");
    expect(calls.filter(call => call.method === "response.open")).toHaveLength(1);
    expect(controller.state.response?.id).toBe("s1");
    expect(controller.state.notice).toContain("확인할 수 없는 대화");
  } finally { controller.stop(); }
});


test("observed context changes immediately remove ghost and preserve an inserted draft", async () => {
  const { controller } = setup();
  try {
    await controller.start(); await controller.selectConversation(0);
    const otherRoom = controller.receiveEvent("message.upserted", { platform: "kakao", account: "owner", chat_id: "B" });
    expect(controller.state.response?.status).toBe("ready"); await otherRoom;
    await controller.dispatchKey("Tab");
    const draft = controller.state.draft;
    const changed = controller.receiveEvent("message.upserted", { platform: "kakao", account: "owner", chat_id: "A" });
    expect(controller.state.response?.status).toBe("stale");
    expect(controller.state.response?.suggestion).toBeUndefined();
    expect(controller.state.draft).toBe(draft);
    await changed;
    expect(controller.state.notice).toContain("다시 확인");
  } finally { controller.stop(); }
});

test("in-flight get cannot restore a recommendation invalidated by a message event", async () => {
  let completeGet!: (result: JsonObject) => void;
  const { controller } = setup({ get: () => new Promise(resolve => { completeGet = resolve; }) });
  try {
    await controller.start(); await controller.selectConversation(0);
    await new Promise(resolve => setTimeout(resolve, 280)); expect(completeGet).toBeDefined();
    await controller.receiveEvent("message.upserted", { platform: "kakao", account: "owner", chat_id: "A" });
    completeGet({ status: "ready", suggestion: { id: "old", text: "무효한 옛 추천" } });
    await Promise.resolve(); await Promise.resolve();
    expect(controller.state.response?.status).toBe("stale");
    expect(controller.state.response?.suggestion).toBeUndefined();
    expect(renderScreen(controller.state, { width: 120, height: 40 })).not.toContain("무효한 옛 추천");
  } finally { controller.stop(); }
});

test("pending open invalidated by an incoming message retains session but never exposes old ready result", async () => {
  let completeOpen!: (result: JsonObject) => void;
  const { controller, calls } = setup({ open: () => new Promise(resolve => { completeOpen = resolve; }), next: async () => ({ status: "none" }), get: async () => ({ status: "stale", suggestion: null }) });
  try {
    await controller.start(); const opening = controller.selectConversation(0);
    while (!completeOpen) await Promise.resolve();
    await controller.receiveEvent("message.upserted", { platform: "kakao", account: "owner", chat_id: "A" });
    completeOpen({ response_session_id: "late-stale", status: "ready", source_message_ids: ["A-m"], suggestion: { id: "old", text: "무효한 open 추천" } });
    await opening;
    expect(controller.state.response?.id).toBe("late-stale");
    expect(controller.state.response?.status).toBe("stale");
    expect(controller.state.response?.suggestion).toBeUndefined();
    expect(renderScreen(controller.state, { width: 120, height: 40 })).not.toContain("무효한 open 추천");
    await controller.dispatchKey("Tab");
    expect(controller.state.draft).toBe("");
    expect(calls.some(call => call.method === "response.feedback" && call.params.event === "inserted")).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 280));
    expect(calls.some(call => call.method === "response.get" && call.params.response_session_id === "late-stale")).toBe(true);
  } finally { controller.stop(); }
});

test("empty cache loads server history before recommendation and hides only confirmed empty rooms", async () => {
  for (const outcome of ["history", "empty", "failure", "paged"] as const) {
    const calls: {method: string; params: JsonObject}[] = [];
    let historyReads = 0;
    const chat = {platform:"telegram",account:"a",chat_id:"42"};
    const controller = createTuiController({client:{start:async()=>{},stop(){},async request(method,params){
      calls.push({method,params});
      if(method==="account.list") return {available:true,chats:[{...chat,display_name:"Room",latest_ts:1,can_send:true}],errors:[]};
      if(method==="account.messages") {
        historyReads++;
        if(historyReads===1) return {messages:[],complete:false};
        if(outcome==="failure") throw new Error("offline");
        if(outcome==="empty") return {messages:[],complete:true};
        if(outcome==="paged" && !params.cursor) return {messages:[],complete:false,next_cursor:"older"};
        return {messages:[{id:"10",body:"실제 이전 대화",ts:1}],complete:true};
      }
      if(method==="response.open") return {response_session_id:"session",status:"queued",source_message_ids:[]};
      return {};
    }}});
    try {
      await controller.start(); await controller.selectConversation(0);
      expect(historyReads).toBeGreaterThanOrEqual(2);
      expect(calls.some(c=>c.method==="response.open")).toBe(outcome==="history"||outcome==="paged");
      expect(controller.state.directory?.length).toBe(outcome==="empty"?0:1);
      if(outcome==="paged") expect(calls.some(c=>c.params.cursor==="older")).toBe(true);
    } finally {controller.stop();}
  }
});
