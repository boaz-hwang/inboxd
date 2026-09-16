import { describe, expect, test } from "bun:test";

import {
  createInitialState,
  createNativeScreen,
  createTuiController,
  mountInteractiveTui,
  displayWidth,
  reduce,
  renderScreen,
  sanitizePersistence,
  truncateCells,
  type TuiState,
} from "../src/index.ts";

const fixtures = {
  inbox: [
    { id: "m1", author: "민수", ts: "09:41", body: "긴 한국어 메시지와 ASCII text", edited: true },
    { id: "m2", author: "Ari", ts: "09:40", body: "deleted message", deleted: true },
  ],
  search: [{ id: "s1", author: "민수", ts: "09:41", body: "search result" }],
  approvals: [{ id: "a1", state: "Uncertain", destination: "slack:#ops", expires: "10m", body: "Deploy now", codeRequired: true }],
};

function readyState(): TuiState {
  let state = createInitialState({ platform: "slack", period: "24h" });
  state = reduce(state, { type: "connected", generation: 1 });
  state = reduce(state, { type: "subscribed", generation: 1 });
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "inbox", data: fixtures.inbox, coverage: { chats: 3, gaps: 1, freshness: "fresh" } });
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "search", data: fixtures.search, coverage: { chats: 3, gaps: 1, freshness: "partial" } });
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "approvals", data: fixtures.approvals });
  return state;
}

describe("five-screen operational model", () => {
  test("documents and handles 1–5, movement, activation, search, help and escape", () => {
    let state = readyState();
    for (const [key, screen] of [["1", "inbox"], ["2", "search"], ["3", "chat"], ["4", "approvals"], ["5", "doctor"]] as const) {
      state = reduce(state, { type: "key", key });
      expect(state.screen).toBe(screen);
    }
    state = reduce(state, { type: "key", key: "1" });
    state = reduce(state, { type: "key", key: "j" });
    expect(state.focus).toBe(1);
    state = reduce(state, { type: "key", key: "Enter" });
    expect(state.selected.inbox).toBe(1);
    state = reduce(state, { type: "key", key: "?" });
    expect(state.helpOpen).toBe(true);
    state = reduce(state, { type: "key", key: "Escape" });
    expect(state.helpOpen).toBe(false);
    const help = renderScreen(state, { width: 80, height: 24 });
    expect(help).toContain("1–5 j/k ↑↓ Enter / b c a Esc ? q");
    state = { ...state, draft: "memory-only reply" };
    state = reduce(state, { type: "key", key: "q" });
    expect(state.draft).toBe("");
    expect(state.notice).toContain("drafts cleared");
  });

  test("renders all screens with explicit focus, selection, unknown evidence, and named states", () => {
    let state = readyState();
    for (const screen of ["inbox", "search", "chat", "approvals", "doctor"] as const) {
      state = reduce(state, { type: "switchScreen", screen });
      const render = renderScreen(state, { width: 80, height: 24 });
      expect(render).toContain(`● ${screen.toUpperCase()}`);
      expect(render).toContain(">");
    }
    state = reduce(state, { type: "coverage", coverage: { chats: undefined, gaps: undefined, freshness: "unknown" } });
    const unknown = renderScreen(state, { width: 80, height: 24 });
    expect(unknown).toContain("? chats / ? gaps");
    expect(unknown).not.toContain("0 chats / 0 gaps");
    state = reduce(state, { type: "switchScreen", screen: "inbox" });
    state = reduce(state, { type: "queryLoading", generation: 1, screen: "inbox" });
    expect(renderScreen(state, { width: 80, height: 24 })).toContain("Loading");
    state = reduce(state, { type: "queryFailed", generation: 1, screen: "inbox", error: "inbox failed" });
    expect(renderScreen(state, { width: 80, height: 24 })).toContain("inbox failed — retry query");
    state = reduce(state, { type: "querySucceeded", generation: 1, screen: "inbox", data: [] });
    expect(renderScreen(state, { width: 80, height: 24 })).toContain("No messages");
  });

  test("uses a one-pane 80×24 squeeze and a 40/60 split at 120×40", () => {
    const state = readyState();
    const narrow = renderScreen(state, { width: 80, height: 24 });
    const wide = renderScreen(state, { width: 120, height: 40 });
    expect(narrow.split("\n")).toHaveLength(24);
    expect(wide.split("\n")).toHaveLength(40);
    expect(narrow).toContain("DETAIL (in place)");
    expect(narrow).not.toContain("LIST 40% │ DETAIL 60%");
    expect(wide).toContain("LIST 40% │ DETAIL 60%");
    expect(wide).toContain("Evidence:");
  });

  test("keeps fixed Search gaps and Chat inline coverage gaps", () => {
    let state = readyState();
    state = reduce(state, { type: "switchScreen", screen: "search" });
    const search = renderScreen(state, { width: 80, height: 24 });
    expect(search).toContain("Search query: (memory-only)");
    expect(search.split("\n").map((line) => line.trimEnd()).join("\n")).toContain("Coverage: partial · 3 chats / 1 gaps\n\nResults");
    state = reduce(state, { type: "switchScreen", screen: "chat" });
    const chat = renderScreen(state, { width: 80, height: 24 });
    expect(chat).toContain("── coverage gap: 1 · partial ──");
    expect(chat).toContain("(edited)");
    expect(chat).toContain("deleted");
  });

  test("requires code for uncertain approvals and disables actions while degraded", () => {
    let state = readyState();
    state = reduce(state, { type: "switchScreen", screen: "approvals" });
    state = reduce(state, { type: "key", key: "a" });
    let view = renderScreen(state, { width: 80, height: 24 });
    expect(view).toContain("UNCERTAIN — do not resend automatically");
    expect(view).toContain("Approval code [memory-only]");
    state = reduce(state, { type: "key", key: "x" });
    state = reduce(state, { type: "key", key: "Enter" });
    expect(state.notice).toContain("code");
    state = reduce(state, { type: "disconnected", generation: 1 });
    view = renderScreen(state, { width: 80, height: 24 });
    expect(view).toContain("Approve [disabled: disconnected]");
  });

  test("exposes doctor encryption, auth, daemon and stale/reconnect handling", () => {
    let state = readyState();
    state = reduce(state, { type: "switchScreen", screen: "doctor" });
    let view = renderScreen(state, { width: 80, height: 24 });
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
  });

  test("clips CJK by terminal cells without splitting and rejects secret persistence recursively", () => {
    expect(displayWidth("가나다")).toBe(6);
    expect(truncateCells("가나다라마바사", 7)).toBe("가나다…");
    expect(displayWidth(truncateCells("가나다라마바사", 7))).toBeLessThanOrEqual(7);
    expect(sanitizePersistence({ screen: "search", platform: "slack", period: "24h" })).toEqual({ screen: "search", platform: "slack", period: "24h" });
    expect(() => sanitizePersistence({ screen: "search", nested: { draft: "no", token: "no" }, query: "no", code: "no" })).toThrow(/not persisted/i);
  });

  test("constructs an OpenTUI native text renderable without starting an interactive loop", async () => {
    const native = await createNativeScreen(80, 24);
    expect(native.content).toContain("INBOXD");
    native.destroy();
  });

  test("controller subscribes before protocol-only refreshes and never retains approval codes", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let subscribed: readonly string[] = [];
    const controller = createTuiController({
      client: {
        start: async (topics) => { subscribed = topics; },
        stop: () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "chat.list") return { chats: [{ platform: "slack", account: "me", chat_id: "ops", display_name: "Ops" }] };
          if (method === "safety.intent.listPending") return { intents: [{ intent_id: "i1", actor: "me", scope: { platform: "slack", account: "me", chat_id: "ops" }, state: "Proposed", body: "Deploy", expires_at: 10, approval_code: "654321" }] };
          if (method === "system.status") return { ready: true, owner: "daemon" };
          if (method === "sync.status") return { state: "idle" };
          if (method === "auth.status") return { authenticated: true };
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });

    await controller.start();
    expect(subscribed).toEqual(["message.upserted", "coverage.changed", "safety.intent.changed"]);
    expect(calls.map((call) => call.method)).toEqual(["chat.list", "safety.intent.listPending", "system.status", "sync.status", "auth.status"]);
    expect(controller.state.connection.status).toBe("connected");
    expect(JSON.stringify(controller.state)).not.toContain("654321");
    expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("Ops");
    controller.stop();
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
    const output = renderScreen(controller.state, { width: 80, height: 24 });
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
    mounted.destroy();
    harness.renderer.destroy();
  });
});
