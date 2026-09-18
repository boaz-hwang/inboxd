import { expect, test } from "bun:test";

import {
  createInitialState,
  createTuiController,
  mountInteractiveTui,
  reduce,
  renderScreen,
  type TuiState,
} from "../src/index.ts";
import type { ResourceCapabilityV1 } from "../../protocol/src/schema.ts";

const capabilities: ResourceCapabilityV1[] = [
  {
    v: 1,
    resource: { v: 1, kind: "chat", platform: "slack", account: "work", chat_id: "ops" },
    read: { mode: "bounded_history", limits: { max_page_size: 100, max_pages: 1, cursor: "opaque" } },
    write: { mode: "send", content_mode: "text", reply: true },
    receipt: { level: "independent_readback" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_000 },
  },
  {
    v: 1,
    resource: { v: 1, kind: "chat", platform: "telegram", account: "personal", chat_id: "-100123" },
    read: { mode: "bounded_history", limits: { max_page_size: 50, max_pages: 2, cursor: "opaque" } },
    write: { mode: "send", content_mode: "text", reply: true },
    receipt: { level: "independent_readback" },
    auth: { state: "unknown", reason: "tdlib_not_configured", observed_at: 1_726_650_001 },
  },
];

function connectedState(screen: "inbox" | "chat" = "inbox"): TuiState {
  let state = createInitialState({ screen });
  state = reduce(state, { type: "connected", generation: 1 });
  state = reduce(state, { type: "subscribed", generation: 1 });
  state = reduce(state, { type: "capabilitySucceeded", generation: 1, data: capabilities });
  return state;
}

test("mixed-provider rows keep exact identity and an empty Chat never falls back to aggregate Inbox", () => {
  let state = connectedState();
  state = reduce(state, {
    type: "querySucceeded",
    generation: 1,
    screen: "inbox",
    data: [
      { id: "s1", resource: capabilities[0]!.resource, chat: { platform: "slack", account: "work", chat_id: "ops" }, author: "Ari", body: "SLACK-ONLY" },
      { id: "t1", resource: capabilities[1]!.resource, chat: { platform: "telegram", account: "personal", chat_id: "-100123" }, author: "민수", body: "TELEGRAM-ONLY" },
    ],
  });

  const inbox = renderScreen(state, { width: 120, height: 40 });
  expect(inbox).toContain("slack › work › chat:ops");
  expect(inbox).toContain("telegram › personal › chat:-100123");
  expect(inbox).toContain("READ bounded_history max_page=100 pages=1 cursor=opaque");
  expect(inbox).toContain("WRITE send content=text reply=yes");
  expect(inbox).toContain("RECEIPT independent_readback");
  expect(inbox).toContain("AUTH authenticated reason=none observed_at=1726650000");

  state = { ...state, screen: "chat", activeResource: capabilities[0]!.resource, activeChat: { platform: "slack", account: "work", chat_id: "ops" } };
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "chat", data: [] });
  const chat = renderScreen(state, { width: 80, height: 24 });
  expect(chat).toContain("No messages");
  expect(chat).not.toContain("SLACK-ONLY");
  expect(chat).not.toContain("TELEGRAM-ONLY");

  state = { ...state, screen: "inbox" };
  state = reduce(state, { type: "key", key: "d" });
  expect(state.detailOpen).toBe(true);
  state = reduce(state, { type: "key", key: "Escape" });
  state = reduce(state, { type: "key", key: "Enter" });
  expect(state.detailOpen).toBe(false);
  expect(state.selected.inbox).toBe(0);
});

test("initial, reconnect, and event capability discovery force refresh while obsolete generations stay rejected", async () => {
  const first = Promise.withResolvers<Record<string, unknown>>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let capabilityCall = 0;
  let subscribed: readonly string[] = [];
  const refreshed = [{
    ...capabilities[1]!,
    auth: { state: "authenticated" as const, reason: null, observed_at: 1_726_650_100 },
  }];
  const controller = createTuiController({ client: {
    start: async topics => { subscribed = topics; },
    stop: () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "capability.list") {
        capabilityCall++;
        if (capabilityCall === 1) return first.promise;
        if (capabilityCall === 2) return { v: 1, resources: capabilities };
        return { v: 1, resources: refreshed };
      }
      if (method === "chat.list") return { chats: [] };
      if (method === "safety.intent.listPending") return { intents: [] };
      return {};
    },
  } });

  const obsoleteStart = controller.start();
  for (let turn = 0; turn < 20 && !calls.some(call => call.method === "capability.list"); turn++) await Promise.resolve();
  expect(calls.some(call => call.method === "capability.list")).toBe(true);
  controller.disconnected();
  first.resolve({ v: 1, resources: [capabilities[0]!] });
  await obsoleteStart;
  expect(controller.state.capabilities.data).toEqual([]);

  await controller.start();
  expect(subscribed).toContain("capability.changed");
  expect(controller.state.capabilities.data).toEqual(capabilities);
  await controller.receiveEvent("capability.changed");
  expect(controller.state.capabilities.data).toEqual(refreshed);
  expect(calls.filter(call => call.method === "capability.list").map(call => call.params)).toEqual([
    { refresh: true },
    { refresh: true },
    { refresh: true },
  ]);
});

test("compose reply and backfill fail closed while capabilities refresh and after revocation", async () => {
  const refreshed = Promise.withResolvers<Record<string, unknown>>();
  const mutations: string[] = [];
  let capabilityCalls = 0;
  const controller = createTuiController({ client: {
    start: async () => {},
    stop: () => {},
    request: async method => {
      if (method === "capability.list") {
        capabilityCalls++;
        if (capabilityCalls === 1) return { v: 1, resources: [capabilities[0]!] };
        return refreshed.promise;
      }
      if (method === "chat.list") return { chats: [] };
      if (method === "message.inbox") return { messages: [{ msg_id: "parent-1", body: "parent" }] };
      if (method === "safety.intent.listPending") return { intents: [] };
      if (method === "safety.intent.create" || method === "sync.backfill") {
        mutations.push(method);
        return {};
      }
      return {};
    },
  } });
  await controller.start();
  controller.setActiveResource(capabilities[0]!.resource);
  await controller.dispatchKey("3");

  const refresh = controller.receiveEvent("capability.changed");
  for (let turn = 0; turn < 20 && capabilityCalls < 2; turn++) await Promise.resolve();
  expect(controller.state.requeryCapabilities).toBe(true);
  expect(controller.state.capabilities.status).toBe("loading");
  for (const key of ["c", "r", "b"]) await controller.dispatchKey(key);
  expect(controller.state.composeActive).toBe(false);
  expect(controller.state.notice).toContain("capability refresh");
  expect(mutations).toEqual([]);

  refreshed.resolve({ v: 1, resources: [] });
  await refresh;
  expect(controller.state.capabilities.status).toBe("empty");
  for (const key of ["c", "r", "b"]) await controller.dispatchKey(key);
  expect(controller.state.composeActive).toBe(false);
  expect(controller.state.notice).toContain("capability unavailable");
  expect(mutations).toEqual([]);
});

test("backfill targets the exact resource displayed in detail when hidden focus moves", async () => {
  const telegram = {
    ...capabilities[1]!,
    auth: { state: "authenticated" as const, reason: null, observed_at: 1_726_650_002 },
  };
  const calls: Record<string, unknown>[] = [];
  const controller = createTuiController({ client: {
    start: async () => {},
    stop: () => {},
    request: async (method, params) => {
      if (method === "capability.list") return { v: 1, resources: [capabilities[0]!, telegram] };
      if (method === "chat.list") return { chats: [capabilities[0]!.resource, telegram.resource] };
      if (method === "message.recent") return { messages: [
        { platform: "slack", account: "work", chat_id: "ops", msg_id: "s1", body: "slack" },
        { platform: "telegram", account: "personal", chat_id: "-100123", msg_id: "t1", body: "telegram" },
      ] };
      if (method === "safety.intent.listPending") return { intents: [] };
      if (method === "sync.backfill") { calls.push(params); return {}; }
      return {};
    },
  } });
  await controller.start();
  controller.setActiveResource(capabilities[0]!.resource);
  controller.setSearch({ chat: { platform: "slack", account: "work", chat_id: "ops" }, interval: { from_ts: 10, to_ts: 20 }, query: "" });
  await controller.dispatchKey("d");
  await controller.dispatchKey("j");

  expect(controller.state.detailOpen).toBe(true);
  expect(controller.state.selected.inbox).toBe(0);
  expect(controller.state.focus).toBe(1);
  const detail = renderScreen(controller.state, { width: 80, height: 24 });
  expect(detail).toContain("Detail — Inbox");
  expect(detail).toContain("Message: slack");
  expect(detail).not.toContain("Message: telegram");

  await controller.dispatchKey("b");
  expect(calls).toEqual([{ platform: "slack", account: "work", chat_id: "ops", from_ts: 10, to_ts: 20 }]);
});

test("native Chat resource directory selects a DestinationRef and composes its approved template", async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const local: ResourceCapabilityV1 = {
    v: 1,
    resource: { v: 1, kind: "chat", platform: "kakao", account: "local", chat_id: "room-7" },
    read: { mode: "measured_local", limits: { max_page_size: 100, max_pages: 1, cursor: "none" } },
    write: { mode: "none", content_mode: "none", reply: false },
    receipt: { level: "none" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_010 },
  };
  const destination: ResourceCapabilityV1 = {
    v: 1,
    resource: { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" },
    read: { mode: "none", limits: null },
    write: { mode: "send", content_mode: "approved_template", reply: false },
    receipt: { level: "ack_only" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_011 },
  };
  const proposals: Record<string, unknown>[] = [];
  const controller = createTuiController({ actor: "tui:native", client: {
    start: async () => {},
    stop: () => {},
    request: async (method, params) => {
      if (method === "capability.list") return { v: 1, resources: [capabilities[0]!, capabilities[1]!, local, destination] };
      if (method === "chat.list") return { chats: [] };
      if (method === "safety.intent.listPending") return { intents: [] };
      if (method === "safety.intent.create") { proposals.push(params); return { intent_id: "template-native" }; }
      return {};
    },
  } });
  const harness = await createTestRenderer({ width: 80, height: 24 });
  const mounted = await mountInteractiveTui(harness.renderer, controller);
  try {
    await controller.start();
    await harness.mockInput.typeText("3");
    await Promise.resolve();
    expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("destination:friend-uuid");
    for (let index = 0; index < 3; index++) harness.mockInput.pressArrow("down");
    harness.mockInput.pressEnter();
    await Promise.resolve();
    expect(controller.state.activeResource).toEqual(destination.resource);

    await harness.mockInput.typeText("cnotice-7");
    harness.mockInput.pressEnter();
    await harness.mockInput.typeText('{"amount":1000}');
    harness.mockInput.pressEnter();
    await harness.mockInput.typeText("approved preview");
    harness.mockInput.pressEnter();
    for (let turn = 0; turn < 20 && proposals.length === 0; turn++) await Promise.resolve();
    expect(proposals).toEqual([{ actor: "tui:native", envelope: {
      v: 2,
      destination: destination.resource,
      content: { mode: "approved_template", template_id: "notice-7", arguments: { amount: 1000 }, preview: "approved preview" },
    } }]);
  } finally {
    mounted.destroy();
    controller.stop();
    harness.renderer.destroy();
  }
});

test("native compose accepts multi-code-unit keys and paste and backspaces one grapheme", async () => {
  const { createTestRenderer } = await import("@opentui/core/testing");
  const controller = createTuiController({ client: {
    start: async () => {},
    stop: () => {},
    request: async method => {
      if (method === "capability.list") return { v: 1, resources: [capabilities[0]!] };
      if (method === "chat.list") return { chats: [] };
      if (method === "message.inbox") return { messages: [] };
      if (method === "safety.intent.listPending") return { intents: [] };
      return {};
    },
  } });
  const harness = await createTestRenderer({ width: 80, height: 24 });
  const mounted = await mountInteractiveTui(harness.renderer, controller);
  try {
    await controller.start();
    controller.setActiveResource(capabilities[0]!.resource);
    await harness.mockInput.typeText("3c");
    harness.mockInput.pressKey("👩‍💻");
    harness.mockInput.pressKey("𠮷");
    await harness.mockInput.pasteBracketedText("안녕 é");
    await Promise.resolve();
    expect(controller.state.draft).toBe("👩‍💻𠮷안녕 é");

    harness.mockInput.pressBackspace();
    await Promise.resolve();
    expect(controller.state.draft).toBe("👩‍💻𠮷안녕 ");
  } finally {
    mounted.destroy();
    controller.stop();
    harness.renderer.destroy();
  }
});

test("text and reply compose are gated by the selected exact chat capability", async () => {
  const readOnlySlack: ResourceCapabilityV1 = {
    ...capabilities[0]!,
    resource: { ...capabilities[0]!.resource, kind: "chat", chat_id: "audit" },
    write: { mode: "none", content_mode: "none", reply: false },
    receipt: { level: "none" },
  };
  const telegram = {
    ...capabilities[1]!,
    auth: { state: "authenticated" as const, reason: null, observed_at: 1_726_650_002 },
  };
  const directory = [capabilities[0]!, readOnlySlack, telegram];
  const proposals: Record<string, unknown>[] = [];
  const controller = createTuiController({ actor: "tui:operator", client: {
    start: async () => {},
    stop: () => {},
    request: async (method, params) => {
      if (method === "capability.list") return { v: 1, resources: directory };
      if (method === "chat.list") return { chats: [] };
      if (method === "message.inbox") return { messages: [{ msg_id: "parent-1", body: "parent" }] };
      if (method === "safety.intent.listPending") return { intents: [] };
      if (method === "safety.intent.create") { proposals.push(params); return { intent_id: `p-${proposals.length}` }; }
      return {};
    },
  } });
  await controller.start();

  controller.setActiveResource(capabilities[0]!.resource);
  await controller.dispatchKey("3");
  await controller.dispatchKey("c");
  for (const key of "hello slack") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(proposals[0]).toEqual({
    actor: "tui:operator",
    envelope: {
      v: 2,
      destination: capabilities[0]!.resource,
      content: { mode: "text", body: "hello slack" },
    },
  });

  await controller.dispatchKey("r");
  for (const key of "thread reply") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(proposals[1]).toEqual({
    actor: "tui:operator",
    envelope: {
      v: 2,
      destination: capabilities[0]!.resource,
      content: { mode: "text", body: "thread reply" },
      reply: { parent_id: "parent-1" },
    },
  });

  controller.setActiveResource(telegram.resource);
  await controller.dispatchKey("3");
  await controller.dispatchKey("r");
  expect(controller.state.composeActive).toBe(true);
  for (const key of "telegram reply") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(proposals[2]).toEqual({
    actor: "tui:operator",
    envelope: {
      v: 2,
      destination: telegram.resource,
      content: { mode: "text", body: "telegram reply" },
      reply: { parent_id: "parent-1" },
    },
  });

  controller.setActiveResource(readOnlySlack.resource);
  await controller.dispatchKey("c");
  expect(controller.state.composeActive).toBe(false);
  expect(controller.state.notice).toContain("exact resource is read-only");
});

test("Kakao local is read-only while official destinations compose templates with a Sent ceiling", async () => {
  const local: ResourceCapabilityV1 = {
    v: 1,
    resource: { v: 1, kind: "chat", platform: "kakao", account: "local", chat_id: "room-7" },
    read: { mode: "measured_local", limits: { max_page_size: 100, max_pages: 1, cursor: "none" } },
    write: { mode: "none", content_mode: "none", reply: false },
    receipt: { level: "none" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_010 },
  };
  const official: ResourceCapabilityV1 = {
    v: 1,
    resource: { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" },
    read: { mode: "none", limits: null },
    write: { mode: "send", content_mode: "approved_template", reply: false },
    receipt: { level: "ack_only" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_011 },
  };
  const proposals: Record<string, unknown>[] = [];
  const approvals: Record<string, unknown>[] = [];
  const envelope = {
    v: 2,
    destination: official.resource,
    content: { mode: "approved_template", template_id: "notice-7", arguments: { amount: 1000 }, preview: "승인: 1000" },
  };
  const controller = createTuiController({ actor: "tui:operator", client: {
    start: async () => {},
    stop: () => {},
    request: async (method, params) => {
      if (method === "capability.list") return { v: 1, resources: [local, official] };
      if (method === "chat.list") return { chats: [] };
      if (method === "safety.intent.listPending") return { intents: [{ intent_id: "template-1", actor: "tui:operator", envelope, state: "Proposed", expires_at: 20 }] };
      if (method === "safety.intent.claimApprovalCode") return { code: "654321" };
      if (method === "safety.intent.create") { proposals.push(params); return { intent_id: "template-1" }; }
      if (method === "safety.intent.approve") { approvals.push(params); return { state: "Verified" }; }
      return {};
    },
  } });
  await controller.start();

  controller.setActiveResource(local.resource);
  await controller.dispatchKey("3");
  await controller.dispatchKey("c");
  expect(controller.state.composeActive).toBe(false);
  expect(controller.state.notice).toContain("exact resource is read-only");

  controller.setActiveResource(official.resource);
  await controller.dispatchKey("3");
  await controller.dispatchKey("c");
  expect(controller.state.composeActive).toBe(true);
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("Template ID: _");
  for (const key of "notice-7") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  for (const key of "not-json") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(controller.state.composeActive).toBe(true);
  expect(controller.state.notice).toContain("JSON object");
  for (let index = 0; index < "not-json".length; index++) await controller.dispatchKey("Backspace");
  for (const key of '{"amount":1000}') await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  for (const key of "승인: 1000") await controller.dispatchKey(key);
  const compose = renderScreen(controller.state, { width: 120, height: 40 });
  expect(compose).toContain("Template ID: notice-7");
  expect(compose).toContain('Arguments JSON: {"amount":1000}');
  expect(compose).toContain("Preview: 승인: 1000_");
  await controller.dispatchKey("Enter");
  expect(proposals).toEqual([{ actor: "tui:operator", envelope }]);

  await controller.dispatchKey("4");
  await controller.dispatchKey("a");
  for (const key of "654321") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  expect(approvals).toEqual([{ intent_id: "template-1", code: "654321", actor: "tui:operator", resource: official.resource }]);
  expect(controller.state.views.approvals.data[0]?.state).toBe("Sent");
  const outcome = renderScreen(controller.state, { width: 120, height: 40 });
  expect(outcome).toContain("acknowledged; not verified");
  expect(outcome).not.toContain("destination read-back matched");
});

test("DestinationRef Verified is clamped to Sent after its capability disappears", async () => {
  const destination: ResourceCapabilityV1 = {
    v: 1,
    resource: { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" },
    read: { mode: "none", limits: null },
    write: { mode: "send", content_mode: "approved_template", reply: false },
    receipt: { level: "ack_only" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_011 },
  };
  let capabilityCalls = 0;
  const controller = createTuiController({ client: {
    start: async () => {},
    stop: () => {},
    request: async method => {
      if (method === "capability.list") return { v: 1, resources: capabilityCalls++ === 0 ? [destination] : [] };
      if (method === "chat.list") return { chats: [] };
      if (method === "safety.intent.listPending") return { intents: [{
        intent_id: "destination-1",
        actor: "tui:operator",
        envelope: { v: 2, destination: destination.resource, content: { mode: "approved_template", template_id: "notice", arguments: {}, preview: "notice" } },
        state: "Proposed",
        expires_at: 20,
      }] };
      if (method === "safety.intent.claimApprovalCode") return { code: "654321" };
      if (method === "safety.intent.approve") return { state: "Verified" };
      return {};
    },
  } });
  await controller.start();
  await controller.receiveEvent("capability.changed");
  expect(controller.state.capabilities.status).toBe("empty");
  await controller.dispatchKey("4");
  await controller.dispatchKey("a");
  await controller.dispatchKey("654321");
  await controller.dispatchKey("Enter");

  expect(controller.state.views.approvals.data[0]?.state).toBe("Sent");
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("acknowledged; not verified");
});
