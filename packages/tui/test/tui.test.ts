import { describe, expect, test } from "bun:test";

import {
  createInitialState,
  createNativeScreen,
  createTuiController,
  mountInteractiveTui,
  displayWidth,
  reduce,
  renderInspectorScreen,
  sanitizePersistence,
  truncateCells,
  type TuiState,
} from "../src/index.ts";
import { runTuiEntrypoint } from "../src/main.ts";
import type { JsonObject, ResourceCapabilityV1 } from "../../protocol/src/schema.ts";

const slackChat = { platform: "slack", account: "work", chat_id: "ops" } as const;
const slackResource = { v: 1, kind: "chat", ...slackChat } as const;

function chatCapability(chat: { platform: string; account: string; chat_id: string }, send = true): ResourceCapabilityV1 {
  return {
    v: 1,
    resource: { v: 1, kind: "chat", ...chat },
    read: { mode: "bounded_history", limits: { max_page_size: 100, max_pages: 1, cursor: "opaque" } },
    write: send ? { mode: "send", content_mode: "text", reply: true } : { mode: "none", content_mode: "none", reply: false },
    receipt: { level: send ? "independent_readback" : "none" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_000 },
  };
}

const slackCapability = chatCapability(slackChat);

const fixtures = {
  inbox: [
    { id: "m1", resource: slackResource, chat: slackChat, author: "민수", ts: "09:41", body: "긴 한국어 메시지와 ASCII text", edited: true },
    { id: "m2", resource: slackResource, chat: slackChat, author: "Ari", ts: "09:40", body: "deleted message", deleted: true },
  ],
  search: [{ id: "s1", resource: slackResource, chat: slackChat, author: "민수", ts: "09:41", body: "search result" }],
  chat: [
    { id: "m1", resource: slackResource, chat: slackChat, author: "민수", ts: "09:41", body: "긴 한국어 메시지와 ASCII text", edited: true },
    { id: "m2", resource: slackResource, chat: slackChat, author: "Ari", ts: "09:40", body: "deleted message", deleted: true },
  ],
  approvals: [{ id: "a1", resource: slackResource, chat: slackChat, state: "Uncertain", destination: "slack:#ops", expires: "10m", body: "Deploy now" }],
};

function readyState(): TuiState {
  let state = createInitialState({ platform: "slack", period: "24h" });
  state = reduce(state, { type: "connected", generation: 1 });
  state = reduce(state, { type: "subscribed", generation: 1 });
  state = reduce(state, { type: "capabilitySucceeded", generation: 1, data: [slackCapability] });
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "inbox", data: fixtures.inbox, coverage: { chats: 3, gaps: 1, freshness: "fresh" } });
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "search", data: fixtures.search, coverage: { chats: 3, gaps: 1, freshness: "partial" } });
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "chat", data: fixtures.chat, coverage: { chats: 3, gaps: 1, freshness: "partial" } });
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "approvals", data: fixtures.approvals });
  return { ...state, pane: "messages", activeChat: slackChat, activeResource: slackResource };
}

describe("operational controller and explicit evidence inspector", () => {
  test("the executable exits zero after a clean renderer teardown", async () => {
    const exitCodes: number[] = [];

    await runTuiEntrypoint({
      run: async () => undefined,
      exit: (code) => { exitCodes.push(code); },
      report: () => { throw new Error("must not report an error"); },
    });

    expect(exitCodes).toEqual([0]);
  });


  test("documents and handles 1–5, movement, activation, search, help and escape", () => {
    let state = readyState();
    for (const [key, screen] of [["1", "inbox"], ["2", "search"], ["3", "chat"], ["4", "approvals"], ["5", "doctor"]] as const) {
      state = reduce(state, { type: "key", key });
      expect(state.screen).toBe(screen);
    }
    state = { ...reduce(state, { type: "key", key: "1" }), pane: "messages" };
    state = reduce(state, { type: "key", key: "j" });
    expect(state.focus).toBe(1);
    state = reduce(state, { type: "key", key: "Enter" });
    expect(state.selected.inbox).toBe(1);
    state = reduce(state, { type: "key", key: "?" });
    expect(state.helpOpen).toBe(true);
    state = reduce(state, { type: "key", key: "Cancel" });
    expect(state.helpOpen).toBe(false);
    const help = renderInspectorScreen(state, { width: 80, height: 24 });
    expect(help).toContain("1–5 j/k ↑↓ Enter-open / Shift+R c r-reply s-status Ctrl+C ?");
    state = { ...state, draft: "memory-only reply" };
    state = reduce(state, { type: "key", key: "Quit" });
    expect(state.draft).toBe("");
    expect(state.notice).toContain("drafts cleared");
  });

  test("renders all screens with explicit focus, selection, unknown evidence, and named states", () => {
    let state = readyState();
    for (const screen of ["inbox", "search", "chat", "approvals", "doctor"] as const) {
      state = reduce(state, { type: "switchScreen", screen });
      const render = renderInspectorScreen(state, { width: 80, height: 24 });
      expect(render).toContain(`● ${screen === "approvals" ? "HISTORY" : screen.toUpperCase()}`);
      expect(render).toContain(">");
    }
    state = reduce(state, { type: "coverage", coverage: { chats: undefined, gaps: undefined, freshness: "unknown" } });
    const unknown = renderInspectorScreen(state, { width: 80, height: 24 });
    expect(unknown).toContain("? chats / ? gaps");
    expect(unknown).not.toContain("0 chats / 0 gaps");
    state = reduce(state, { type: "switchScreen", screen: "inbox" });
    state = reduce(state, { type: "queryLoading", generation: 1, screen: "inbox" });
    expect(renderInspectorScreen(state, { width: 80, height: 24 })).toContain("Loading");
    state = reduce(state, { type: "queryFailed", generation: 1, screen: "inbox", error: "inbox failed" });
    expect(renderInspectorScreen(state, { width: 80, height: 24 })).toContain("inbox failed — retry query");
    state = reduce(state, { type: "querySucceeded", generation: 1, screen: "inbox", data: [] });
    expect(renderInspectorScreen(state, { width: 80, height: 24 })).toContain("No messages");
  });

  test("uses a one-pane 80×24 squeeze and a 40/60 split at 120×40", () => {
    const state = readyState();
    const narrow = renderInspectorScreen(state, { width: 80, height: 24 });
    const wide = renderInspectorScreen(state, { width: 120, height: 40 });
    expect(narrow.split("\n")).toHaveLength(24);
    expect(wide.split("\n")).toHaveLength(40);
    expect(narrow).toContain("DETAIL (in place)");
    expect(narrow).not.toContain("LIST 40% │ DETAIL 60%");
    expect(wide).toContain("LIST 40%");
    expect(wide).toContain("DETAIL 60%");
    expect(wide).toContain("Evidence rail:");
    expect(wide).toContain("Status rail:");
  });

  test("renders actual 40/60 list-detail content and an activated in-place detail", () => {
    let state = readyState();
    state = reduce(state, { type: "switchScreen", screen: "inbox" });

    const wide = renderInspectorScreen(state, { width: 120, height: 40 });
    expect(wide).toContain("LIST 40%");
    expect(wide).toContain("DETAIL 60%");
    expect(wide.split("\n").find(line => line.includes("LIST 40%"))?.indexOf("│")).toBe(48);
    expect(wide).toContain("Detail — Inbox");
    expect(wide).toContain("Message: 긴 한국어 메시지와 ASCII text");

    state = { ...state, detailOpen: true, selected: { ...state.selected, [state.screen]: state.focus } };
    const narrow = renderInspectorScreen(state, { width: 80, height: 24 });
    expect(narrow).toContain("Detail — Inbox");
    expect(narrow).toContain("Back: Ctrl+C");
    expect(narrow).toContain("Message: 긴 한국어 메시지와 ASCII text");
  });

  test("retains Chat coverage and Approval uncertainty in activated narrow details", () => {
    let state = readyState();
    state = reduce(state, { type: "switchScreen", screen: "chat" });
    state = { ...state, detailOpen: true, selected: { ...state.selected, [state.screen]: state.focus } };
    expect(renderInspectorScreen(state, { width: 80, height: 24 })).toContain("── coverage gap: 1 · partial ──");

    state = reduce(state, { type: "switchScreen", screen: "approvals" });
    state = { ...state, detailOpen: true, selected: { ...state.selected, [state.screen]: state.focus } };
    expect(renderInspectorScreen(state, { width: 80, height: 24 })).toContain("UNCERTAIN — do not resend automatically");
  });

  test("keeps fixed Search gaps and Chat inline coverage gaps", () => {
    let state = readyState();
    state = reduce(state, { type: "switchScreen", screen: "search" });
    const search = renderInspectorScreen(state, { width: 80, height: 24 });
    expect(search).toContain("Search query: (memory-only)");
    expect(search.split("\n").map((line) => line.trimEnd()).join("\n")).toContain("Coverage: partial · 3 chats / 1 gaps\n\nResults");
    state = reduce(state, { type: "switchScreen", screen: "chat" });
    const chat = renderInspectorScreen(state, { width: 80, height: 24 });
    expect(chat).toContain("── coverage gap: 1 · partial ──");
    expect(chat).toContain("(edited)");
    expect(chat).toContain("deleted");
  });

  test("keeps Chat compose controls and the coverage gap visible above a long 80×24 list", () => {
    let state = readyState();
    state = reduce(state, {
      type: "querySucceeded",
      generation: 1,
      screen: "chat",
      data: Array.from({ length: 30 }, (_, index) => ({ id: `m-${index}`, author: "operator", body: `message ${index}` })),
      coverage: { chats: 3, gaps: 1, freshness: "partial" },
    });
    state = reduce(state, { type: "switchScreen", screen: "chat" });
    state = reduce(state, { type: "key", key: "c" });
    state = reduce(state, { type: "key", key: "x" });

    const chat = renderInspectorScreen(state, { width: 80, height: 24 });
    expect(chat).toContain("Compose text: x [memory-only]");
    expect(chat).toContain("── coverage gap: 1 · partial ──");
  });



  test("active compose remains visible with separate submit and cancel controls in detail", () => {
    let state = reduce(readyState(), { type: "switchScreen", screen: "chat" });
    for (const key of ["d", "c", "x"]) state = reduce(state, { type: "key", key });
    state = { ...state, draft: "long draft ".repeat(50) };
    for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
      const text = renderInspectorScreen(state, size);
      expect(text).toContain("Compose text:");
      expect(text).toContain("Enter send · Ctrl+C cancel");
      expect(text).toContain("[memory-only]");
    }
  });

  test("wraps and scrolls long grapheme-safe detail rather than losing the message tail", () => {
    expect(displayWidth("👩‍💻🇰🇷é")).toBe(5);
    const body = "가👩‍💻é ".repeat(600) + "END-OF-MESSAGE";
    for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
      let state = reduce(readyState(), { type: "querySucceeded", generation: 1, screen: "inbox", data: [{ id: "long", body, resource: slackResource }] });
      state = { ...state, detailOpen: true, selected: { ...state.selected, [state.screen]: state.focus } };
      let text = renderInspectorScreen(state, size);
      expect(text).toContain("PgUp/PgDn scroll");
      expect(text).not.toContain("END-OF-MESSAGE");
      for (let page = 0; page < 30; page++) state = reduce(state, { type: "key", key: "PageDown" });
      text = renderInspectorScreen(state, size);
      expect(text).toContain("END-OF-MESSAGE");
      expect(text.split("\n").every(line => displayWidth(line) === size.width)).toBe(true);
      expect(text).not.toMatch(/👩(?!‍💻)/u);
      state = reduce(state, { type: "key", key: "Home" });
      expect(renderInspectorScreen(state, size)).toContain("Message:");
    }
  });

  test("qualifies other-intent uncertainty without mislabeling the selected proposal", () => {
    let state = reduce(readyState(), { type: "querySucceeded", generation: 1, screen: "approvals", data: [{ id: "p", state: "Proposed" }, ...fixtures.approvals] });
    state = reduce(state, { type: "switchScreen", screen: "approvals" });
    state = { ...state, detailOpen: true, selected: { ...state.selected, [state.screen]: state.focus } };
    for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
      const text = renderInspectorScreen(state, size);
      expect(text).toContain("Other intent: UNCERTAIN");
      expect(text).toContain("State: Proposed");
    }
  });

  test("empty list context reports focus 0/0 instead of a phantom first row", () => {
    const state = createInitialState();
    const text = renderInspectorScreen(state, { width: 120, height: 40 });
    expect(text).toContain("focus 0/0");
    expect(text).not.toContain("focus 1/0");
  });

  test("clamps focus and selection when a refreshed list shrinks", () => {
    let state = readyState();
    state = reduce(state, { type: "key", key: "j" });
    state = reduce(state, { type: "key", key: "Enter" });
    state = reduce(state, { type: "querySucceeded", generation: 1, screen: "inbox", data: [fixtures.inbox[0]!] });
    expect(state.focus).toBe(0);
    expect(state.selected.inbox).toBe(0);
    expect(renderInspectorScreen(state, { width: 120, height: 40 })).toContain("> ● slack › work › chat:ops 민수");
    expect(renderInspectorScreen(state, { width: 80, height: 24 })).not.toContain("No selected item");
    state = reduce(state, { type: "switchScreen", screen: "approvals" });
    state = reduce(state, { type: "querySucceeded", generation: 1, screen: "inbox", data: [] });
    state = reduce(state, { type: "switchScreen", screen: "inbox" });
    expect(state.focus).toBe(0);
  });

  test.each(["inbox", "search", "chat", "approvals"] as const)("keeps focused %s rows visible at both terminal sizes", (screen) => {
    let state = readyState();
    state = reduce(state, { type: "querySucceeded", generation: 1, screen,
      data: Array.from({ length: 60 }, (_, index) => ({ resource: slackResource, id: `r${index}`, author: `row-${index}`, state: "Uncertain" })), nextCursor: "more" });
    state = { ...reduce(state, { type: "switchScreen", screen }), pane: "messages" };
    for (let i = 0; i < 59; i++) state = reduce(state, { type: "key", key: "j" });
    for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
      const output = renderInspectorScreen(state, size);
      expect(output).toContain(screen === "approvals" ? "> ● slack › work › chat:ops row-59" : "> ○ slack › work › chat:ops row-59");
      expect(output).toContain("scroll for more results");
      expect(output).toContain("Evidence rail:");
      expect(output.split("\n")).toHaveLength(size.height);
      expect(output.split("\n").every((line) => displayWidth(line) === size.width)).toBe(true);
      if (screen === "approvals") {
        expect(output).toContain("UNCERTAIN — do not resend automatically");
        expect(output).toContain("Historical record [read-only]");
      }
      if (screen === "chat") expect(output).toContain("coverage gap:");
      state = reduce(state, { type: "key", key: "k" });
      expect(renderInspectorScreen(state, size)).toContain(screen === "approvals" ? "> ● slack › work › chat:ops row-58" : "> ○ slack › work › chat:ops row-58");
      state = reduce(state, { type: "key", key: "j" });
    }
  });



  test("exposes doctor encryption, auth, daemon and stale/reconnect handling", () => {
    let state = readyState();
    state = reduce(state, { type: "switchScreen", screen: "doctor" });
    let view = renderInspectorScreen(state, { width: 80, height: 24 });
    expect(view).toContain("Encryption: unknown");
    expect(view).toContain("Authentication: unknown");
    expect(view).toContain("Daemon: connected");
    state = reduce(state, { type: "disconnected", generation: 1 });
    expect(state.connection.stale).toBe(true);
    expect(state.connection.status).toBe("reconnecting");
    state = reduce(state, { type: "connected", generation: 2 });
    state = reduce(state, { type: "querySucceeded", generation: 1, screen: "inbox", data: [] });
    expect(state.views.inbox.status).toBe("stale");
    state = reduce(state, { type: "event", generation: 1, method: "safety.intent.changed" });
    expect(state.requery).not.toContain("approvals");
    state = reduce(state, { type: "subscribed", generation: 2 });
    state = reduce(state, { type: "event", generation: 2, method: "safety.intent.changed" });
    expect(state.requery).toContain("inbox");
    expect(state.requery).toContain("approvals");
    expect(state.requery).toContain("doctor");
    expect(state.connection.status).toBe("connected");
    state = reduce(state, { type: "switchScreen", screen: "doctor" });
    state = reduce(state, { type: "disconnected", generation: 2 });
    expect(renderInspectorScreen(state, { width: 80, height: 24 })).toContain("Daemon: stale response retained");
  });

  test("clips CJK by terminal cells without splitting and rejects secret persistence recursively", () => {
    expect(displayWidth("가나다")).toBe(6);
    expect(truncateCells("가나다라마바사", 7)).toBe("가나다…");
    expect(truncateCells("가\u0301나다라마바사", 5)).toBe("가\u0301나…");
    expect(displayWidth(truncateCells("가나다라마바사", 7))).toBeLessThanOrEqual(7);
    expect(sanitizePersistence({ screen: "search", platform: "slack", period: "24h" })).toEqual({ screen: "search", platform: "slack", period: "24h" });
    expect(() => sanitizePersistence({ screen: "search", nested: { draft: "no", token: "no" }, query: "no", code: "no" })).toThrow(/not persisted/i);
  });

  test("constructs an OpenTUI native text renderable without starting an interactive loop", async () => {
    const native = await createNativeScreen(80, 24);
    expect(native.content).toContain("inboxd");
    native.destroy();
  });

  test("controller subscribes before protocol-only refreshes and never retains approval codes", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let subscribed: readonly string[] = [];
    const chat = { platform: "slack", account: "me", chat_id: "ops" };
    const controller = createTuiController({
      client: {
        start: async (topics) => { subscribed = topics; },
        stop: () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capability.list") return { v: 1, resources: [chatCapability(chat)] };
          if (method === "chat.list") return { chats: [{ ...chat, display_name: "Ops" }] };
          if (method === "message.recent") return { messages: [] };
          if (method === "safety.intent.listPending") return { intents: [{ intent_id: "i1", actor: "me", scope: { platform: "slack", account: "me", chat_id: "ops" }, state: "Proposed", body: "Deploy", expires_at: 10 }] };
          if (method === "system.status") return { ready: true, owner: "daemon" };
          if (method === "sync.status") return { state: "idle" };
          if (method === "auth.status") return { authenticated: true };
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });

    await controller.start();
    expect(subscribed).toEqual(["account.changed", "message.upserted", "coverage.changed", "safety.intent.changed", "capability.changed"]);
    expect(calls.map((call) => call.method)).toEqual(["account.list", "capability.list", "chat.list", "message.recent", "safety.intent.listPending", "system.status", "sync.status", "auth.status"]);
    expect(controller.state.connection.status).toBe("connected");
    expect(JSON.stringify(controller.state)).not.toContain("654321");
    await controller.dispatchKey("4");
    expect(JSON.stringify(controller.state)).not.toContain("654321");
    controller.stop();
  });

  test("treats nullable message revisions as absent while retaining timestamps and explicit flags", async () => {
    const controller = createTuiController({
      client: {
        start: async () => {}, stop: () => {},
        request: async () => ({ messages: [
          { msg_id: "ordinary", body: "ordinary", edited_at: null, deleted_at: null },
          { msg_id: "missing", body: "missing" },
          { msg_id: "edited", edited_at: 0, deleted_at: null },
          { msg_id: "deleted", edited_at: null, deleted_at: 123 },
          { msg_id: "flags", edited_at: null, deleted_at: null, edited: true, deleted: true },
        ] }),
      },
    });
    const chat = { platform: "slack", account: "me", chat_id: "ops" };
    controller.setActiveChat(chat);
    controller.setSearch({ chat, interval: { from_ts: 0, to_ts: 200 }, query: "ordinary" });
    await controller.start();
    for (const screen of ["chat", "search"] as const) {
      expect(controller.state.views[screen].data.map(({ edited, deleted }) => [edited, deleted])).toEqual([
        [false, false], [false, false], [true, false], [false, true], [true, true],
      ]);
    }
  });

  test("maps the real daemon message and coverage shape without hiding limits", async () => {
    const controller = createTuiController({
      client: {
        start: async () => {},
        stop: () => {},
        request: async (method) => {
          if (method === "chat.list") return { chats: [] };
          if (method === "message.search") return {
            messages: [{ msg_id: "m1", author_id: "u1", ts: 1_700_000_000, body: "실제 shape" }],
            coverage: {
              target: { chat: { platform: "slack", account: "me", chat_id: "ops" }, interval: { from_ts: 0, to_ts: 2_000_000_000 } },
              covered: [{ interval: { from_ts: 0, to_ts: 100 }, kind: "backfill" }],
              gaps: [{ interval: { from_ts: 100, to_ts: 200 }, reason: "unknown" }],
              freshness: [{ interval: { from_ts: 0, to_ts: 100 }, collected_at: 1_700_000_001, mutations_verified_at: null }],
              limits: [{ reason: "unsupported" }, { reason: "rate_limit" }],
            },
          };
          if (method === "safety.intent.listPending") return { intents: [] };
          if (method === "system.status") return {};
          if (method === "sync.status") return {};
          if (method === "auth.status") return {};
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });
    controller.setSearch({
      chat: { platform: "slack", account: "me", chat_id: "ops" },
      interval: { from_ts: 0, to_ts: 2_000_000_000 },
      query: "shape",
    });
    await controller.start();
    await controller.dispatchKey("2");
    const output = renderInspectorScreen(controller.state, { width: 80, height: 24 });
    expect(output).toContain("1700000000");
    expect(output).toContain("partial · 1 chats / 1 gaps / 2 limits");
  });

  test("binds actual OpenTUI keypress events to the controller", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const harness = await createTestRenderer({ width: 80, height: 24 });
    const controller = createTuiController({
      client: { start: async () => {}, stop: () => {}, request: async () => ({}) },
      initialState: createInitialState(),
    });
    const mounted = await mountInteractiveTui(harness.renderer, controller);
    await harness.mockInput.typeText("2");
    await Promise.resolve();
    expect(controller.state.screen).toBe("search");
    harness.mockInput.pressKey("f", { ctrl: true });
    await harness.mockInput.typeText("alert");
    await Promise.resolve();
    expect(controller.state.searchQuery).toBe("alert");
    expect(controller.state.searchActive).toBe(true);
    mounted.destroy();
    harness.renderer.destroy();
  });

  test("removed detail key leaves the room list ready to open a chat", async () => {
    let initialState = readyState();
    initialState = reduce(initialState, {
      type: "querySucceeded",
      generation: 1,
      screen: "inbox",
      data: [{ id: "slack:me:ops", chat: { platform: "slack", account: "me", chat_id: "ops" }, author: "Ops" }],
    });
    const controller = createTuiController({
      initialState,
      client: { start: async () => {}, stop: () => {}, request: async () => ({}) },
    });

    await controller.dispatchKey("d");
    expect(controller.state.screen).toBe("inbox");
    expect(controller.state.detailOpen).toBe(false);
    await controller.dispatchKey("Enter");
    expect(controller.state.screen).toBe("chat");
  });

  test("submits memory-only typed search text to the active chat", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const chat = { platform: "slack", account: "me", chat_id: "ops" };
    const controller = createTuiController({
      client: {
        start: async () => {},
        stop: () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "chat.list") return { chats: [] };
          if (method === "safety.intent.listPending") return { intents: [] };
          if (method === "system.status" || method === "sync.status" || method === "auth.status") return {};
          if (method === "message.search") return { messages: [], coverage: { covered: [], gaps: [], limits: [] } };
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });

    await controller.start();
    controller.setActiveChat(chat);
    controller.setSearch({ chat, interval: { from_ts: 10, to_ts: 20 }, query: "" });
    await controller.dispatchKey("MessageSearch");
    for (const key of "alert") await controller.dispatchKey(key);
    expect(renderInspectorScreen(controller.state, { width: 80, height: 24 })).toContain("Search query: alert [memory-only]");
    await controller.dispatchKey("Enter");

    expect(calls.filter((call) => call.method === "message.search")).toEqual([
      { method: "message.search", params: { chat, interval: { from_ts: 10, to_ts: 20 }, query: "alert" } },
    ]);
    expect(controller.state.searchActive).toBe(false);
    expect(controller.state.notice).toContain("search submitted");
    controller.stop();
    expect(controller.state.searchQuery).toBe("");
  });

  test("submits a typed Chat compose draft directly with a durable request ID", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const scope = { platform: "slack", account: "me", chat_id: "ops" };
    const controller = createTuiController({
      client: {
        start: async () => {},
        stop: () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capability.list") return { v: 1, resources: [chatCapability(scope)] };
          if (method === "chat.list") return { chats: [] };
          if (method === "safety.intent.listPending") return { intents: [] };
          if (method === "system.status") return { send_capable: true };
          if (method === "sync.status" || method === "auth.status") return {};
          if (method === "message.send") return { state: "Sent" };
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });

    await controller.start();
    controller.setActiveChat(scope);
    await controller.dispatchKey("3");
    await controller.dispatchKey("c");
    for (const key of "deploy tonight") await controller.dispatchKey(key);
    expect(renderInspectorScreen(controller.state, { width: 80, height: 24 })).toContain("Compose text: deploy tonight [memory-only]");
    await controller.dispatchKey("Enter");

    expect(calls.filter((call) => call.method === "message.send")).toEqual([
      { method: "message.send", params: {
        request_id: expect.any(String),
        envelope: {
          v: 2,
          destination: { v: 1, kind: "chat", ...scope },
          content: { mode: "text", body: "deploy tonight" },
        },
      } },
    ]);
    expect(controller.state.draft).toBe("");
    expect(controller.state.notice).toContain("보냈습니다.");
  });

  test("keeps q and b as input text instead of quitting or backfilling", async () => {
    const calls: string[] = [];
    const chat = slackChat;
    const controller = createTuiController({
      initialState: reduce(readyState(), { type: "querySucceeded", generation: 1, screen: "approvals", data: [{ ...fixtures.approvals[0]!, state: "Proposed" }] }),
      client: {
        start: async () => {},
        stop: () => { calls.push("stop"); },
        request: async (method) => { calls.push(method); return {}; },
      },
    });
    controller.setActiveChat(chat);

    await controller.dispatchKey("MessageSearch");
    await controller.dispatchKey("q");
    await controller.dispatchKey("b");
    expect(controller.state.searchQuery).toBe("qb");
    expect(controller.state.searchActive).toBe(true);

    await controller.dispatchKey("Cancel");
    await controller.dispatchKey("3");
    await controller.dispatchKey("c");
    await controller.dispatchKey("q");
    await controller.dispatchKey("b");
    expect(controller.state.draft).toBe("qb");
    expect(controller.state.composeActive).toBe(true);

    await controller.dispatchKey("Cancel");
    await controller.dispatchKey("4");
    await controller.dispatchKey("a");
    expect(calls).toEqual([]);
  });

  test("submits the current chat interval through sync.backfill with Shift+R", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const chat = { platform: "slack", account: "me", chat_id: "ops" };
    const controller = createTuiController({
      client: {
        start: async () => {},
        stop: () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capability.list") return { v: 1, resources: [chatCapability(chat)] };
          if (method === "chat.list") return { chats: [] };
          if (method === "safety.intent.listPending") return { intents: [] };
          if (method === "system.status" || method === "sync.status" || method === "auth.status" || method === "sync.backfill") return {};
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });

    await controller.start();
    controller.setActiveChat(chat);
    controller.setSearch({ chat, interval: { from_ts: 10, to_ts: 20 }, query: "" });
    await controller.dispatchKey("3");
    await controller.dispatchKey("R");

    expect(calls.filter((call) => call.method === "sync.backfill")).toEqual([
      { method: "sync.backfill", params: { platform: "slack", account: "me", chat_id: "ops", from_ts: 10, to_ts: 20 } },
    ]);
    expect(controller.state.notice).toContain("no action retried");
  });

  test("keeps colon-bearing ChatRef values structural for inbox, search, sends, and backfill", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const chat = { platform: "slack", account: "stable:acct", chat_id: "stable:ops" };
    const controller = createTuiController({
      client: {
        start: async () => {},
        stop: () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capability.list") return { v: 1, resources: [chatCapability(chat)] };
          if (method === "chat.list") return { chats: [{ ...chat, display_name: "Stable Ops" }] };
          if (method === "message.recent") return { messages: [{ ...chat, msg_id: "recent", body: "latest" }] };
          if (method === "message.inbox" || method === "message.search") return { messages: [], coverage: { covered: [], gaps: [], limits: [] } };
          if (method === "safety.intent.listPending") return { intents: [] };
          if (method === "system.status") return { send_capable: true };
          if (method === "sync.status" || method === "auth.status" || method === "sync.backfill") return {};
          if (method === "message.send") return { state: "Sent" };
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });

    await controller.start();
    await controller.dispatchKey("Enter");
    controller.setSearch({ chat, interval: { from_ts: 10, to_ts: 20 }, query: "needle" });
    await controller.dispatchKey("MessageSearch");
    for (const key of "needle") await controller.dispatchKey(key);
    await controller.dispatchKey("Enter");
    await controller.dispatchKey("3");
    await controller.dispatchKey("c");
    for (const key of "deploy") await controller.dispatchKey(key);
    await controller.dispatchKey("Enter");
    await controller.dispatchKey("R");

    expect(calls.filter((call) => call.method === "message.inbox")).toEqual([
      { method: "message.inbox", params: { chat } },
      { method: "message.inbox", params: { chat } },
      { method: "message.inbox", params: { chat } },
    ]);
    expect(calls.filter((call) => call.method === "message.search")).toEqual([
      { method: "message.search", params: { chat, interval: { from_ts: 10, to_ts: 20 }, query: "needle" } },
    ]);
    expect(calls.filter((call) => call.method === "message.send")).toEqual([
      { method: "message.send", params: {
        request_id: expect.any(String),
        envelope: {
          v: 2,
          destination: { v: 1, kind: "chat", ...chat },
          content: { mode: "text", body: "deploy" },
        },
      } },
    ]);
    expect(calls.filter((call) => call.method === "sync.backfill")).toEqual([
      { method: "sync.backfill", params: { platform: "slack", account: "stable:acct", chat_id: "stable:ops", from_ts: 10, to_ts: 20 } },
    ]);
  });

  test("abandons a pending search when the operator starts and cancels a new query", async () => {
    let finish!: (value: JsonObject) => void;
    let searchCalls = 0;
    const controller = createTuiController({ client: {
      start: async () => {}, stop: () => {},
      request: async (method) => {
        if (method !== "message.search") return {};
        searchCalls++;
        return new Promise((resolve) => { finish = resolve; });
      },
    } });
    await controller.start();
    controller.setActiveChat({ platform: "slack", account: "me", chat_id: "ops" });
    await controller.dispatchKey("MessageSearch");
    await controller.dispatchKey("x");
    const search = controller.dispatchKey("Enter");
    await controller.dispatchKey("MessageSearch");
    await controller.dispatchKey("y");
    finish({ messages: [{ msg_id: "obsolete" }], next_cursor: "obsolete-page" });
    await search;
    expect(controller.state.views.search.data).toEqual([]);
    expect(controller.state.views.search.nextCursor).toBeUndefined();
    expect(controller.state.searchQuery).toBe("y");
    await controller.dispatchKey("Cancel");
    await controller.receiveEvent("message.upserted");
    expect(searchCalls).toBe(1);
  });

  test.each(["search", "chat"] as const)("invalidates %s rows, cursors and pending pages as soon as its scope changes", async (screen) => {
    let finish!: (value: JsonObject) => void;
    const chat = { platform: "slack", account: "me", chat_id: "old" };
    const controller = createTuiController({ client: {
      start: async () => {}, stop: () => {},
      request: async (method, params) => {
        if (params.cursor !== undefined) return new Promise((resolve) => { finish = resolve; });
        if (method === "message.search" || method === "message.inbox") return { messages: [{ msg_id: "old" }], next_cursor: "old-page" };
        return {};
      },
    } });
    controller.setActiveChat(chat);
    controller.setSearch({ chat, interval: { from_ts: 0, to_ts: 10 }, query: "old" });
    await controller.start();
    await controller.dispatchKey(screen === "search" ? "2" : "3");
    const page = controller.dispatchKey(controller.state.screen === "chat" ? "PageUp" : "PageDown");
    if (screen === "search") controller.setSearch({ chat, interval: { from_ts: 0, to_ts: 10 }, query: "new" });
    else controller.setActiveChat({ ...chat, chat_id: "new" });
    const changed = controller.state.views[screen];
    expect(changed.data).toEqual([]);
    expect(changed.nextCursor).toBeUndefined();
    finish({ messages: [{ msg_id: "obsolete-page" }], next_cursor: "obsolete-next" });
    await page;
    expect(controller.state.views[screen]).toEqual(changed);
  });

  test.each([
    ["inbox", "message.recent"], ["search", "message.search"], ["chat", "message.inbox"],
    ["approvals", "safety.intent.listPending"],
  ] as const)("ignores out-of-order %s responses and failures in the same connection", async (screen, method) => {
    const pending: Array<{ resolve(value: JsonObject): void; reject(error: Error): void }> = [];
    let defer = false;
    const chat = { platform: "slack", account: "me", chat_id: "ops" };
    const controller = createTuiController({ client: {
      start: async () => {}, stop: () => {},
      request: async (name, params) => name === method && defer
        ? new Promise((resolve, reject) => pending.push({ resolve, reject })) : name === "chat.list" ? { chats: [chat] } : {},
    } });
    controller.setActiveChat(chat);
    controller.setSearch({ chat, interval: { from_ts: 0, to_ts: 10 }, query: "needle" });
    await controller.start();
    defer = true;
    const event = screen === "approvals" ? "safety.intent.changed" : "message.upserted";
    const startRequest = async () => {
      const previous = pending.length;
      const completion = controller.receiveEvent(event);
      for (let i = 0; i < 30 && pending.length === previous; i++) await Promise.resolve();
      expect(pending.length).toBe(previous + 1);
      return { completion };
    };
    const oldest = await startRequest();
    const older = await startRequest();
    const newest = await startRequest();
    const result = (id: string) => ({
      chats: [{ ...chat, chat_id: id }], messages: [{ msg_id: id }],
      intents: [{ intent_id: id, actor: "me", scope: chat, state: "Proposed" }],
      coverage: { freshness: "fresh", gaps: id === "new" ? 1 : 99 }, next_cursor: id,
    });
    pending[2]!.resolve(result("new"));
    await newest.completion;
    const current = controller.state.views[screen];
    const currentCoverage = controller.state.coverage;
    pending[1]!.resolve(result("old"));
    await older.completion;
    expect(controller.state.views[screen]).toEqual(current);
    expect(controller.state.coverage).toEqual(currentCoverage);
    pending[0]!.reject(new Error("obsolete failure"));
    await oldest.completion;
    expect(controller.state.views[screen]).toEqual(current);
  });

  test("does not continue an obsolete refresh after disconnect", async () => {
    let finish!: (value: JsonObject) => void;
    const calls: string[] = [];
    const controller = createTuiController({ client: {
      start: async () => {}, stop: () => {},
      request: async (method) => {
        calls.push(method);
        if (method === "chat.list") return new Promise((resolve) => { finish = resolve; });
        return {};
      },
    } });
    const starting = controller.start();
    for (let i = 0; i < 30 && !calls.includes("chat.list"); i++) await Promise.resolve();
    expect(calls).toEqual(["account.list", "capability.list", "chat.list"]);
    controller.disconnected();
    finish({ chats: [] });
    await starting;
    expect(calls).toEqual(["account.list", "capability.list", "chat.list"]);
    expect(controller.state.connection.status).toBe("reconnecting");
  });

  test("does not apply an old page or reuse its cursor while a replacement list is loading", async () => {
    const pending: Array<(value: JsonObject) => void> = [];
    const cursors: unknown[] = [];
    let defer = false;
    const controller = createTuiController({ client: {
      start: async () => {}, stop: () => {},
      request: async (method, params) => {
        if (method === "chat.list") return { chats: [{ platform: "slack", account: "me", chat_id: "ops" }] };
        if (method !== "message.recent") return {};
        cursors.push(params.cursor);
        if (defer) return new Promise((resolve) => { pending.push(resolve); });
        return { messages: [{ platform: "slack", account: "me", chat_id: "ops", msg_id: "first" }], next_cursor: "old-page" };
      },
    } });
    await controller.start();
    defer = true;
    const page = controller.dispatchKey(controller.state.screen === "chat" ? "PageUp" : "PageDown");
    const refresh = controller.receiveEvent("message.upserted");
    for (let i = 0; i < 30 && pending.length < 2; i++) await Promise.resolve();
    pending[1]!({ messages: [{ platform: "slack", account: "me", chat_id: "ops", msg_id: "replacement" }], next_cursor: "new-page" });
    await refresh;
    pending[0]!({ messages: [{ platform: "slack", account: "me", chat_id: "ops", msg_id: "obsolete" }] });
    await page;
    expect(controller.state.views.inbox.data.map((row) => row.id)).toEqual(["replacement"]);
    const nextRefresh = controller.receiveEvent("message.upserted");
    const more = controller.dispatchKey(controller.state.screen === "chat" ? "PageUp" : "PageDown");
    for (let i = 0; i < 30 && pending.length < 3; i++) await Promise.resolve();
    expect(cursors).toEqual([undefined, "old-page", undefined, undefined]);
    pending[2]!({ messages: [] });
    await Promise.all([nextRefresh, more]);
  });

  test("shows continuation for an empty pending approval page", () => {
    let state = readyState();
    state = reduce(state, { type: "querySucceeded", generation: 1, screen: "approvals", data: [], nextCursor: "after-expired" });
    state = reduce(state, { type: "switchScreen", screen: "approvals" });
    expect(renderInspectorScreen(state, { width: 80, height: 24 })).toContain("scroll for more results");
  });

  test("loads historical approval pages without enabling their old codes", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const scope = { platform: "slack", account: "me", chat_id: "ops" };
    const controller = createTuiController({ client: {
      start: async () => {}, stop: () => {},
      request: async (method, params) => {
        calls.push({ method, params });
        if (method !== "safety.intent.listPending") return {};
        const second = params.cursor === "approval-next";
        return { intents: [{ intent_id: second ? "second" : "first", actor: "operator", scope,
          state: "Proposed" }],
          ...(second ? {} : { next_cursor: "approval-next" }) };
      },
    } });
    await controller.start();
    await controller.dispatchKey("4");
    expect(controller.state.views.approvals.nextCursor).toBe("approval-next");
    await Promise.all([controller.dispatchKey(controller.state.screen === "chat" ? "PageUp" : "PageDown"), controller.dispatchKey(controller.state.screen === "chat" ? "PageUp" : "PageDown")]);
    expect(controller.state.views.approvals.data.map((row) => row.id)).toEqual(["first", "second"]);
    expect(controller.state.views.approvals.nextCursor).toBeUndefined();
    await controller.dispatchKey("j");
    await controller.dispatchKey("Enter");
    expect(JSON.stringify(controller.state)).not.toMatch(/111111|222222/);
    await controller.dispatchKey("a");
    for (const digit of "222222") await controller.dispatchKey(digit);
    await controller.dispatchKey("Enter");
    expect(calls.filter((call) => call.method === "safety.intent.approve")).toEqual([]);
    expect(calls.filter((call) => call.params.cursor !== undefined)).toEqual([
      { method: "safety.intent.listPending", params: { cursor: "approval-next" } },
    ]);
  });

  test("retains paged inbox, search, and chat rows and clears the subscribed notice after current queries settle", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const chat = { platform: "slack", account: "me", chat_id: "ops" };
    const controller = createTuiController({
      client: {
        start: async () => {},
        stop: () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          const cursor = params.cursor;
          if (method === "chat.list") return { chats: [chat] };
          if (method === "message.recent") return cursor === "inbox-next"
            ? { messages: [{ ...chat, msg_id: "second", body: "Second" }] }
            : { messages: [{ ...chat, msg_id: "first", body: "Ops" }], next_cursor: "inbox-next" };
          if (method === "message.search") return cursor === "search-next"
            ? { messages: [{ msg_id: "s2", body: "second search" }], coverage: { covered: [], gaps: [], limits: [] } }
            : { messages: [{ msg_id: "s1", body: "first search" }], coverage: { covered: [], gaps: [], limits: [] }, next_cursor: "search-next" };
          if (method === "message.inbox") return cursor === "chat-next"
            ? { messages: [{ msg_id: "c2", body: "second chat" }], coverage: { covered: [], gaps: [], limits: [] } }
            : { messages: [{ msg_id: "c1", body: "first chat" }], coverage: { covered: [], gaps: [], limits: [] }, next_cursor: "chat-next" };
          if (method === "safety.intent.listPending") return { intents: [] };
          if (method === "system.status" || method === "sync.status" || method === "auth.status") return {};
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });
    controller.setActiveChat(chat);
    controller.setSearch({ chat, interval: { from_ts: 10, to_ts: 20 }, query: "needle" });

    await controller.start();
    expect(controller.state.notice).not.toBe("subscribed — re-query required");
    expect(renderInspectorScreen(controller.state, { width: 80, height: 24 })).toContain("scroll for more results");

    for (const screen of ["inbox", "search", "chat"] as const) {
      await controller.dispatchKey(screen === "inbox" ? "1" : screen === "search" ? "2" : "3");
      if (screen === "inbox") await Promise.all([controller.dispatchKey(controller.state.screen === "chat" ? "PageUp" : "PageDown"), controller.dispatchKey(controller.state.screen === "chat" ? "PageUp" : "PageDown")]);
      else await controller.dispatchKey(controller.state.screen === "chat" ? "PageUp" : "PageDown");
      expect(controller.state.views[screen].data).toHaveLength(2);
      expect(controller.state.views[screen].nextCursor).toBeUndefined();
    }
    expect(calls.filter((call) => call.params.cursor !== undefined).map((call) => call.params.cursor)).toEqual(["inbox-next", "search-next", "chat-next"]);
  });
});
