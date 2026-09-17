import { expect, test } from "bun:test";
import { createInitialState, createTuiController, renderScreen } from "../src/index.ts";
import type { JsonObject } from "../../protocol/src/schema.ts";

const slack = { platform: "slack", account: "work:one", chat_id: "ops:one" };
const empty = { ...slack, chat_id: "uncollected" };

test.each(["Uncertain", "Sent", "Verified", "Sending"])("never approves or retries %s even with a supplied code after reconnect", async state => {
  const calls: string[] = [];
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      calls.push(method);
      if (method === "safety.intent.listPending") return { intents: [{ intent_id: "terminal", actor: "operator", scope: slack, state }] };
      return {};
    },
  } });
  await controller.start();
  await controller.dispatchKey("4");
  expect(controller.currentApprovalCode()).toBeUndefined();
  expect(controller.state.views.approvals.data[0]?.codeRequired).toBe(false);
  await controller.dispatchKey("a");
  expect(controller.state.approvalPrompt).toBe(false);
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain(`Approve [disabled: ${state}]`);
  controller.disconnected();
  await controller.start();
  await controller.dispatchKey("a");
  await controller.dispatchKey("Enter");
  expect(calls.filter(method => method === "safety.intent.approve")).toEqual([]);
  controller.stop();
});

test.each([
  ["Sent", "acknowledged; not verified"],
  ["Verified", "destination read-back matched"],
  ["Uncertain", "outcome unknown; do not resend"],
])("preserves observed %s after approval leaves pending list and shows it in Chat", async (state, meaning) => {
  let completed = false;
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      if (method === "safety.intent.listPending") return { intents: completed ? [] : [{ intent_id: "proposal", actor: "operator", scope: slack, state: "Proposed", body: "send me" }] };
      if (method === "safety.intent.approve") { completed = true; return { intent_id: "proposal", state, scope: slack, body: "send me" }; }
      return {};
    },
  } });
  controller.setActiveChat(slack);
  await controller.start();
  await controller.dispatchKey("4");
  await controller.dispatchKey("a");
  for (const key of "123456") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(controller.state.views.approvals.data).toContainEqual(expect.objectContaining({ id: "proposal", state, codeRequired: false }));
  expect(controller.currentApprovalCode()).toBeUndefined();
  for (const screen of ["4", "3"]) {
    await controller.dispatchKey(screen);
    for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
      const output = renderScreen(controller.state, size);
      expect(output).toContain(state);
      expect(output).toContain(meaning);
      expect(output).toContain("session observation");
    }
  }
  controller.stop();
});

test.each([
  { completion: "resolve", reconnectFirst: false },
  { completion: "reject", reconnectFirst: false },
  { completion: "resolve", reconnectFirst: true },
  { completion: "reject", reconnectFirst: true },
])("disconnect during approval completion stays conservative: %j", async ({ completion, reconnectFirst }) => {
  const result = Promise.withResolvers<JsonObject>();
  const calls: string[] = [];
  let dispatched = false;
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      calls.push(method);
      if (method === "safety.intent.listPending") return { intents: dispatched ? [] : [{ intent_id: "in-flight", actor: "operator", scope: slack, state: "Proposed" }] };
      if (method === "safety.intent.approve") { dispatched = true; return result.promise; }
      return {};
    },
  } });
  await controller.start();
  await controller.dispatchKey("4");
  await controller.dispatchKey("a");
  for (const key of "123456") await controller.dispatchKey(key);
  const submitting = controller.dispatchKey("Enter");
  expect(dispatched).toBe(true);
  controller.disconnected();
  expect(controller.state.views.approvals.data[0]).toMatchObject({ state: "Uncertain", codeRequired: false });
  expect(controller.state.views.approvals.status).toBe("stale");
  expect(controller.state.approvalPrompt).toBe(false);
  expect(controller.state.codeBuffer).toBe("");
  expect(controller.currentApprovalCode()).toBeUndefined();
  expect(controller.state.notice).toContain("no action retried");
  if (reconnectFirst) await controller.start();
  const noticeBeforeCompletion = controller.state.notice;
  const callsBeforeCompletion = calls.length;
  if (completion === "resolve") result.resolve({ state: "Sent", receipt: "late-receipt" });
  else result.reject(new Error("response lost"));
  await submitting;
  expect(calls.length).toBe(callsBeforeCompletion);
  expect(controller.state.notice).toBe(noticeBeforeCompletion);
  expect(controller.state.views.approvals.data[0]).toMatchObject({ state: "Uncertain", codeRequired: false });
  if (!reconnectFirst) await controller.start();
  for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
    const text = renderScreen(controller.state, size);
    expect(text).toContain("outcome unknown; do not resend");
    expect(text).not.toContain("acknowledged; not verified");
  }
  await controller.dispatchKey("a");
  await controller.dispatchKey("Enter");
  expect(controller.state.approvalPrompt).toBe(false);
  expect(calls.filter(method => method === "safety.intent.approve")).toHaveLength(1);
  expect(JSON.stringify(controller.state)).not.toContain("123456");
  controller.stop();
});

test("pending-list replays cannot re-enable an in-flight or disconnected approval", async () => {
  const result = Promise.withResolvers<JsonObject>();
  let approvals = 0;
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      if (method === "safety.intent.listPending") return { intents: [{ intent_id: "replayed", actor: "operator", scope: slack, state: "Proposed" }] };
      if (method === "safety.intent.approve") { approvals++; return result.promise; }
      return {};
    },
  } });
  await controller.start();
  await controller.dispatchKey("4");
  await controller.dispatchKey("a");
  for (const key of "123456") await controller.dispatchKey(key);
  const submitting = controller.dispatchKey("Enter");
  await controller.receiveEvent("safety.intent.changed");
  expect(controller.state.views.approvals.data[0]).toMatchObject({ state: "Sending", codeRequired: false });
  expect(controller.currentApprovalCode()).toBeUndefined();
  await controller.dispatchKey("a");
  expect(controller.state.approvalPrompt).toBe(false);
  controller.disconnected();
  await controller.start();
  expect(controller.state.views.approvals.data[0]).toMatchObject({ state: "Uncertain", codeRequired: false });
  expect(controller.currentApprovalCode()).toBeUndefined();
  await controller.dispatchKey("a");
  expect(controller.state.approvalPrompt).toBe(false);
  result.resolve({ state: "Sent" });
  await submitting;
  expect(approvals).toBe(1);
  expect(controller.state.views.approvals.data[0]?.state).toBe("Uncertain");
  controller.stop();
});

test.each([false, true])("rejected approval exits Sending without replay even if refresh fails (%s)", async (refreshFails) => {
  let approvals = 0;
  const controller = createTuiController({ client: {
    ready: true, start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      if (method === "safety.intent.listPending") {
        if (approvals && refreshFails) throw new Error("refresh unavailable");
        return { intents: [{ intent_id: "rejected", actor: "operator", scope: slack, state: "Proposed" }] };
      }
      if (method === "safety.intent.approve") { approvals++; throw new Error("invalid approval code"); }
      return {};
    },
  } });
  await controller.start();
  await controller.dispatchKey("4"); await controller.dispatchKey("a");
  for (const key of "999999") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(controller.state.views.approvals.data[0]?.state).toBe(refreshFails ? "Refresh required" : "Code unavailable");
  expect(controller.state.notice).toContain("invalid approval code");
  expect(controller.state.codeBuffer).toBe("");
  expect(approvals).toBe(1);
  controller.stop();
});

test.each([undefined, false, true])("compose requires observed daemon send capability (%s), not Slack name", async (send) => {
  let proposals = 0;
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      if (method === "system.status") return send === undefined ? {} : { send_capable: send };
      if (method === "safety.intent.create") { proposals++; throw new Error("server policy denied"); }
      return {};
    },
  } });
  await controller.start(); controller.setActiveChat(slack);
  await controller.dispatchKey("3"); await controller.dispatchKey("c");
  expect(controller.state.composeActive).toBe(send === true);
  if (send === true) {
    await controller.dispatchKey("x"); await controller.dispatchKey("Enter");
    expect(controller.state.notice).toContain("server policy denied");
    expect(proposals).toBe(1);
  } else {
    expect(controller.state.notice).toContain("send capability");
    expect(proposals).toBe(0);
  }
  controller.stop();
});

test("failed diagnostic probes remain unknown rather than fabricating negative authentication", async () => {
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      if (method === "auth.status" || method === "sync.status") throw new Error("probe unavailable");
      return {};
    },
  } });
  await controller.start();
  await controller.dispatchKey("5");
  const text = renderScreen(controller.state, { width: 80, height: 24 });
  expect(text).toContain("Authentication: unknown");
  expect(text).toContain("probe unavailable");
  expect(text).not.toContain("authenticated=false");
  controller.stop();
});

test("Doctor renders structured encryption auth sync and isolation without promoting unknown to healthy", async () => {
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      if (method === "system.status") return {
        ready: true, encryption: { ready: true, cipher_version: "4.9.0", schema_version: 2 },
        auth: { slack: "unknown" }, sync: { slack: { state: "degraded" } },
        isolation: { grade: "b", protected: false, warning: "same-user access is outside isolation" },
      };
      if (method === "auth.status") return { authenticated: false };
      if (method === "sync.status") return { state: "idle" };
      return {};
    },
  } });
  await controller.start();
  await controller.dispatchKey("5");
  for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
    const text = renderScreen(controller.state, size);
    for (const fact of ["SQLCipher ready=true", "Cipher: 4.9.0", "Schema: 2", "Authentication: slack=unknown", "Sync: slack=degraded", "grade=b protected=false", "same-user access is outside isolation"]) expect(text).toContain(fact);
    expect(text).not.toContain("healthy");
    expect(text).not.toContain("Encryption: unknown");
  }
  controller.disconnected();
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("stale response retained");
  controller.stop();
});

test("Inbox discovers explicit chats before recent retrieval and preserves its opaque aggregate query across pages", async () => {
  const calls: { method: string; params: JsonObject }[] = [];
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "chat.list") return params.cursor === "discover:opaque"
        ? { chats: [empty] } : { chats: [slack], next_cursor: "discover:opaque" };
      if (method === "message.recent") return {
        messages: [{ ...slack, msg_id: params.cursor ? "second" : "first", body: "recent body", edited_at: null, deleted_at: null }],
        ...(params.cursor ? {} : { next_cursor: "aggregate:opaque+/=" }),
      };
      return {};
    },
  } });
  await controller.start();
  const first = calls.find(call => call.method === "message.recent");
  expect(first).toBeDefined();
  expect(first!.params.chats).toEqual([slack, empty]);
  const interval = first!.params.interval as { from_ts: number; to_ts: number };
  expect(interval.to_ts).toBeGreaterThan(interval.from_ts);
  expect(calls.slice(0, 3).map(call => call.method)).toEqual(["chat.list", "chat.list", "message.recent"]);
  expect(controller.state.views.inbox.data.find(row => row.id === "first")).toMatchObject({ chat: slack, body: "recent body", edited: false, deleted: false });
  expect(controller.state.views.inbox.nextCursor).toBe("aggregate:opaque+/=");
  await Promise.all([controller.dispatchKey("n"), controller.dispatchKey("n")]);
  const pages = calls.filter(call => call.method === "message.recent");
  expect(pages).toHaveLength(2);
  expect(pages[1]!.params).toEqual({ ...first!.params, cursor: "aggregate:opaque+/=" });
  expect(controller.state.views.inbox.data.filter(row => row.body === "recent body").map(row => row.id)).toEqual(["first", "second"]);
  expect(controller.state.views.inbox.nextCursor).toBeUndefined();
  controller.stop();
});

test("Inbox fails closed above 100 discovered chats without oversized RPC or stale continuation", async () => {
  const calls: { method: string; params: JsonObject }[] = [];
  let oversized = false;
  const chats = Array.from({ length: 101 }, (_, index) => ({ ...slack, chat_id: `chat-${index}` }));
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "chat.list") return oversized
        ? params.cursor ? { chats: chats.slice(100) } : { chats: chats.slice(0, 100), next_cursor: "discovery-page-2" }
        : { chats: [slack] };
      if (method === "message.recent") return { messages: [{ ...slack, msg_id: "old", body: "previous scope" }], next_cursor: "stale-page" };
      return {};
    },
  } });
  await controller.start();
  expect(controller.state.views.inbox.nextCursor).toBe("stale-page");
  oversized = true;
  await controller.receiveEvent("coverage.changed");
  expect(calls.filter(call => call.method === "chat.list")).toHaveLength(3);
  expect(calls.filter(call => call.method === "message.recent")).toHaveLength(1);
  expect(controller.state.views.inbox).toMatchObject({ status: "error", data: [], coverage: { freshness: "partial", chats: 0 } });
  expect(controller.state.views.inbox.nextCursor).toBeUndefined();
  for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
    const text = renderScreen(controller.state, size);
    expect(text).toContain("partial");
    expect(text).toContain("100-chat limit");
    expect(text).toContain("Recovery: configure at most 100 chats.");
    expect(text).toContain("Restart daemon and TUI to reload scope.");
    expect(text).not.toContain("retry query");
    expect(text).not.toContain("previous scope");
  }
  await controller.dispatchKey("n");
  expect(calls.filter(call => call.method === "message.recent")).toHaveLength(1);
  controller.stop();
});

test("Inbox bounds discovery pages even when unique cursors return duplicate chats", async () => {
  let pages = 0;
  let recentCalls = 0;
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      if (method === "chat.list") {
        pages++;
        return { chats: [slack], ...(pages <= 100 ? { next_cursor: `unique-${pages}` } : {}) };
      }
      if (method === "message.recent") recentCalls++;
      return {};
    },
  } });
  await controller.start();
  expect(pages).toBe(100);
  expect(recentCalls).toBe(0);
  expect(controller.state.views.inbox).toMatchObject({ status: "error", data: [], coverage: { freshness: "partial", chats: 0 } });
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("discovery page limit");
  controller.stop();
});

test("Inbox retains per-chat coverage and sourced unread evidence including configured uncollected chats", async () => {
  const interval = { from_ts: 10, to_ts: 20 };
  const packet = {
    messages: [{ ...slack, msg_id: "latest", author_id: "self", body: "latest body" }],
    coverage: [
      { target: { chat: slack, interval }, covered: [{ interval, kind: "backfill" }], gaps: [], freshness: [], limits: [] },
      { target: { chat: empty, interval }, covered: [], gaps: [{ interval, reason: "unknown" }], freshness: [], limits: [] },
    ],
    unread: [
      { chat: slack, status: "known", source: "platform", count: 0, observed_at: 21 },
      { chat: empty, status: "unknown", source: "unknown", count: null, reason: "unobserved", observed_at: null },
    ],
    identities: [{ platform: slack.platform, account: slack.account, status: "known", self_id: "self", source: "authenticated_adapter", observed_at: 21 }],
  };
  const controller = createTuiController({ client: {
    start: async () => {}, stop: () => {},
    request: async method => {
      if (method === "safety.intent.claimApprovalCode") return { code: "123456" };
      if (method === "chat.list") return { chats: [slack, empty] };
      if (method === "message.recent") return packet;
      if (method === "message.inbox") return { messages: [], coverage: packet.coverage[0]! };
      return {};
    },
  } });
  controller.setActiveChat(slack);
  await controller.start();
  expect(controller.state.views.inbox).toMatchObject({
    evidence: { coverage: packet.coverage, unread: packet.unread, identities: packet.identities },
    coverage: { chats: 2, gaps: 1, freshness: "partial" },
  });
  for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
    expect(renderScreen(controller.state, size)).toContain("2 chats / 1 gaps");
    expect(renderScreen(controller.state, size)).toContain("Unread: 0 (platform)");
  }
  await controller.dispatchKey("j");
  await controller.dispatchKey("Enter");
  for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
    const text = renderScreen(controller.state, size);
    expect(text).toContain("Unread: ? (unknown)");
    expect(text).toContain("unobserved");
    expect(text).toContain("uncollected");
    expect(text).toContain("Gap reasons: unknown");
    expect(text).toContain("Self: self (authenticated_adapter)");
  }
  controller.stop();
});
