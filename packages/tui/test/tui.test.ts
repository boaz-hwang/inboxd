import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { readTuiApproverToken, runTuiEntrypoint } from "../src/main.ts";

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
  test("the executable exits zero after a clean renderer teardown", async () => {
    const exitCodes: number[] = [];

    await runTuiEntrypoint({
      run: async () => undefined,
      exit: (code) => { exitCodes.push(code); },
      report: () => { throw new Error("must not report an error"); },
    });

    expect(exitCodes).toEqual([0]);
  });

  test("reads only the daemon owner-only approver token beside the socket", () => {
    const directory = mkdtempSync(join(tmpdir(), "inboxd-tui-token-"));
    try {
      const socketPath = join(directory, "sock");
      const tokenPath = join(directory, "approver.token");
      const token = "abcdefghijklmnopqrstuvwxyz_1234567890";
      writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
      expect(readTuiApproverToken(socketPath)).toBe(token);
      chmodSync(tokenPath, 0o644);
      expect(() => readTuiApproverToken(socketPath)).toThrow(/owner-only/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
    expect(help).toContain("1–5 j/k ↑↓ Enter / n-more b c a Esc ? q");
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
    expect(wide).toContain("LIST 40%");
    expect(wide).toContain("DETAIL 60%");
    expect(wide).toContain("Evidence rail:");
    expect(wide).toContain("Status rail:");
  });

  test("renders actual 40/60 list-detail content and an activated in-place detail", () => {
    let state = readyState();
    state = reduce(state, { type: "switchScreen", screen: "inbox" });

    const wide = renderScreen(state, { width: 120, height: 40 });
    expect(wide).toContain("LIST 40%");
    expect(wide).toContain("DETAIL 60%");
    expect(wide.split("\n")[2]?.indexOf("│")).toBe(48);
    expect(wide).toContain("Detail — Inbox");
    expect(wide).toContain("Message: 긴 한국어 메시지와 ASCII text");

    state = reduce(state, { type: "key", key: "Enter" });
    const narrow = renderScreen(state, { width: 80, height: 24 });
    expect(narrow).toContain("Detail — Inbox");
    expect(narrow).toContain("Back: Esc");
    expect(narrow).toContain("Message: 긴 한국어 메시지와 ASCII text");
  });

  test("retains Chat coverage and Approval uncertainty in activated narrow details", () => {
    let state = readyState();
    state = reduce(state, { type: "switchScreen", screen: "chat" });
    state = reduce(state, { type: "key", key: "Enter" });
    expect(renderScreen(state, { width: 80, height: 24 })).toContain("── coverage gap: 1 · partial ──");

    state = reduce(state, { type: "switchScreen", screen: "approvals" });
    state = reduce(state, { type: "key", key: "Enter" });
    expect(renderScreen(state, { width: 80, height: 24 })).toContain("UNCERTAIN — do not resend automatically");
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

    const chat = renderScreen(state, { width: 80, height: 24 });
    expect(chat).toContain("Compose proposal: x [memory-only]");
    expect(chat).toContain("── coverage gap: 1 · partial ──");
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
    state = reduce(state, { type: "switchScreen", screen: "doctor" });
    state = reduce(state, { type: "disconnected", generation: 2 });
    expect(renderScreen(state, { width: 80, height: 24 })).toContain("Daemon: stale response retained");
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
    await controller.dispatchKey("4");
    expect(controller.currentApprovalCode()).toBe("654321");
    expect(renderScreen(controller.state, { width: 80, height: 24 }, { approvalCode: controller.currentApprovalCode() })).toContain("654321");
    expect(JSON.stringify(controller.state)).not.toContain("654321");
    controller.stop();
    expect(controller.currentApprovalCode()).toBeUndefined();
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
    await harness.mockInput.typeText("/alert");
    await Promise.resolve();
    expect(controller.state.searchQuery).toBe("alert");
    expect(controller.state.searchActive).toBe(true);
    mounted.destroy();
    harness.renderer.destroy();
  });

  test("activates Inbox detail before opening its chat", async () => {
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

    await controller.dispatchKey("Enter");
    expect(controller.state.screen).toBe("inbox");
    expect(controller.state.detailOpen).toBe(true);
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
    await controller.dispatchKey("/");
    for (const key of "alert") await controller.dispatchKey(key);
    expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("Search query: alert [memory-only]");
    await controller.dispatchKey("Enter");

    expect(calls.filter((call) => call.method === "message.search")).toEqual([
      { method: "message.search", params: { chat, interval: { from_ts: 10, to_ts: 20 }, query: "alert" } },
    ]);
    expect(controller.state.searchActive).toBe(false);
    expect(controller.state.notice).toContain("search submitted");
    controller.stop();
    expect(controller.state.searchQuery).toBe("");
  });

  test("submits a typed Chat compose draft as an approval-gated proposal", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const scope = { platform: "slack", account: "me", chat_id: "ops" };
    const controller = createTuiController({
      actor: "tui:operator",
      client: {
        start: async () => {},
        stop: () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "chat.list") return { chats: [] };
          if (method === "safety.intent.listPending") return { intents: [] };
          if (method === "system.status" || method === "sync.status" || method === "auth.status") return {};
          if (method === "safety.intent.create") return { intent_id: "proposal-1", state: "Proposed" };
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });

    await controller.start();
    controller.setActiveChat(scope);
    await controller.dispatchKey("3");
    await controller.dispatchKey("c");
    for (const key of "deploy tonight") await controller.dispatchKey(key);
    expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("Compose proposal: deploy tonight [memory-only]");
    await controller.dispatchKey("Enter");

    expect(calls.filter((call) => call.method === "safety.intent.create")).toEqual([
      { method: "safety.intent.create", params: { actor: "tui:operator", scope, body: "deploy tonight" } },
    ]);
    expect(controller.state.draft).toBe("");
    expect(controller.state.notice).toContain("proposal created");
  });

  test("keeps q and b as input text instead of quitting or backfilling", async () => {
    const calls: string[] = [];
    const chat = { platform: "slack", account: "me", chat_id: "ops" };
    const controller = createTuiController({
      initialState: readyState(),
      client: {
        start: async () => {},
        stop: () => { calls.push("stop"); },
        request: async (method) => { calls.push(method); return {}; },
      },
    });
    controller.setActiveChat(chat);

    await controller.dispatchKey("/");
    await controller.dispatchKey("q");
    await controller.dispatchKey("b");
    expect(controller.state.searchQuery).toBe("qb");
    expect(controller.state.searchActive).toBe(true);

    await controller.dispatchKey("Escape");
    await controller.dispatchKey("3");
    await controller.dispatchKey("c");
    await controller.dispatchKey("q");
    await controller.dispatchKey("b");
    expect(controller.state.draft).toBe("qb");
    expect(controller.state.composeActive).toBe(true);

    await controller.dispatchKey("Escape");
    await controller.dispatchKey("4");
    await controller.dispatchKey("a");
    await controller.dispatchKey("b");
    expect(controller.state.codeBuffer).toBe("b");
    expect(calls).toEqual([]);
  });

  test("submits the current chat interval through sync.backfill with b", async () => {
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
          if (method === "system.status" || method === "sync.status" || method === "auth.status" || method === "sync.backfill") return {};
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });

    await controller.start();
    controller.setActiveChat(chat);
    controller.setSearch({ chat, interval: { from_ts: 10, to_ts: 20 }, query: "" });
    await controller.dispatchKey("b");

    expect(calls.filter((call) => call.method === "sync.backfill")).toEqual([
      { method: "sync.backfill", params: { platform: "slack", account: "me", chat_id: "ops", from_ts: 10, to_ts: 20 } },
    ]);
    expect(controller.state.notice).toContain("no action retried");
  });

  test("keeps colon-bearing ChatRef values structural for inbox, search, proposals, and backfill", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const chat = { platform: "slack", account: "stable:acct", chat_id: "stable:ops" };
    const controller = createTuiController({
      actor: "tui:operator",
      client: {
        start: async () => {},
        stop: () => {},
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "chat.list") return { chats: [{ ...chat, display_name: "Stable Ops" }] };
          if (method === "message.inbox" || method === "message.search") return { messages: [], coverage: { covered: [], gaps: [], limits: [] } };
          if (method === "safety.intent.listPending") return { intents: [] };
          if (method === "system.status" || method === "sync.status" || method === "auth.status" || method === "sync.backfill") return {};
          if (method === "safety.intent.create") return { intent_id: "proposal-1", state: "Proposed" };
          throw new Error(`unexpected protocol call: ${method}`);
        },
      },
    });

    await controller.start();
    await controller.dispatchKey("Enter");
    await controller.dispatchKey("Enter");
    controller.setSearch({ chat, interval: { from_ts: 10, to_ts: 20 }, query: "needle" });
    await controller.dispatchKey("/");
    for (const key of "needle") await controller.dispatchKey(key);
    await controller.dispatchKey("Enter");
    await controller.dispatchKey("3");
    await controller.dispatchKey("c");
    for (const key of "deploy") await controller.dispatchKey(key);
    await controller.dispatchKey("Enter");
    await controller.dispatchKey("b");

    expect(calls.filter((call) => call.method === "message.inbox")).toEqual([
      { method: "message.inbox", params: { chat } },
    ]);
    expect(calls.filter((call) => call.method === "message.search")).toEqual([
      { method: "message.search", params: { chat, interval: { from_ts: 10, to_ts: 20 }, query: "needle" } },
    ]);
    expect(calls.filter((call) => call.method === "safety.intent.create")).toEqual([
      { method: "safety.intent.create", params: { actor: "tui:operator", scope: chat, body: "deploy" } },
    ]);
    expect(calls.filter((call) => call.method === "sync.backfill")).toEqual([
      { method: "sync.backfill", params: { platform: "slack", account: "stable:acct", chat_id: "stable:ops", from_ts: 10, to_ts: 20 } },
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
          if (method === "chat.list") return cursor === "inbox-next"
            ? { chats: [{ platform: "slack", account: "me", chat_id: "second", display_name: "Second" }] }
            : { chats: [{ ...chat, display_name: "Ops" }], next_cursor: "inbox-next" };
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
    expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("more results [n]");

    for (const screen of ["inbox", "search", "chat"] as const) {
      await controller.dispatchKey(screen === "inbox" ? "1" : screen === "search" ? "2" : "3");
      if (screen === "inbox") await Promise.all([controller.dispatchKey("n"), controller.dispatchKey("n")]);
      else await controller.dispatchKey("n");
      expect(controller.state.views[screen].data).toHaveLength(2);
      expect(controller.state.views[screen].nextCursor).toBeUndefined();
    }
    expect(calls.filter((call) => call.params.cursor !== undefined).map((call) => call.params.cursor)).toEqual(["inbox-next", "search-next", "chat-next"]);
  });
});
