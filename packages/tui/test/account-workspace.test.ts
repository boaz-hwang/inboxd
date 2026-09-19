import { expect, test } from "bun:test";
import { createTuiController, renderScreen } from "../src/index.ts";
import { conversationRows } from "../src/workspace-model.ts";
import type { JsonObject } from "../../protocol/src/schema.ts";

function setup(send?: () => Promise<JsonObject>) {
  const calls: { method: string; params: JsonObject }[] = [];
  const rooms = Array.from({ length: 45 }, (_, i) => ({
    platform: i % 2 ? "telegram" : "slack",
    account: "personal",
    chat_id: String(i),
    display_name: `원래 이름 ${i}`,
    latest_ts: 100 + i,
    preview: `최근 대화 ${i}`,
    can_send: true,
  }));
  const controller = createTuiController({
    client: {
      start: async () => {},
      stop() {},
      async request(method, params) {
        calls.push({ method, params });
        if (method === "account.list")
          return {
            available: true,
            chats: params.cursor ? rooms.slice(40) : rooms.slice(0, 40),
            next_cursor: params.cursor ? null : "page2",
            errors: [],
          };
        if (method === "account.messages")
          return {
            messages: [
              {
                id: "context",
                platform: params.platform,
                account: params.account,
                chat_id: params.chat_id,
                author_name: "메신저 표시 이름",
                author_id: "opaque",
                ts: 90,
                body: "이전 대화",
              },
              {
                id: "hit",
                platform: params.platform,
                account: params.account,
                chat_id: params.chat_id,
                author_name: "원래 보낸 사람",
                author_id: "opaque",
                ts: 95,
                body: "찾는 메시지",
              },
            ],
          };
        if (method === "message.search" && params.mode === "remote")
          return {
            messages:
              params.platform === "telegram"
                ? [
                    {
                      id: "hit",
                      platform: "telegram",
                      account: "personal",
                      chat_id: "3",
                      author_name: "원래 보낸 사람",
                      ts: 95,
                      body: "찾는 메시지",
                    },
                  ]
                : [],
          };
        if (method === "message.send")
          return send ? send() : { state: "Sent", receipt: "receipt" };
        return {};
      },
    },
  });
  return { controller, calls };
}

test("loads every directory page, keeps provider names and sorts by latest activity", async () => {
  const { controller, calls } = setup();
  await controller.start();
  expect(controller.state.accountMode).toBe(true);
  const rooms = conversationRows(controller.state);
  expect(rooms).toHaveLength(45);
  expect(rooms[0]?.resource).toMatchObject({ chat_id: "44" });
  expect(rooms.at(-1)?.resource).toMatchObject({ chat_id: "0" });
  expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain(
    "원래 이름 44",
  );
  expect(
    calls.filter((c) => c.method === "account.list").map((c) => c.params),
  ).toEqual([{ background: true }, { cursor: "page2" }]);
  controller.stop();
});

test("Tab cycles rooms, messages and filters; arrows select a messenger", async () => {
  const { controller } = setup();
  await controller.start();
  await controller.dispatchKey("Tab");
  expect(controller.state.pane).toBe("messages");
  await controller.dispatchKey("Tab");
  expect(controller.state.pane).toBe("filters");
  await controller.dispatchKey("ArrowRight");
  expect(controller.state.platform).toBe("slack");
  expect(
    conversationRows(controller.state).every(
      (r) => r.resource.platform === "slack",
    ),
  ).toBe(true);
  await controller.dispatchKey("Tab");
  expect(controller.state.pane).toBe("rooms");
  controller.stop();
});

test("search input opens, results retain sender names, selecting hit restores its exact chat and focus", async () => {
  const { controller, calls } = setup();
  await controller.start();
  await controller.dispatchKey("/");
  expect(controller.state.searchActive).toBe(true);
  expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain(
    "메시지 검색",
  );
  await controller.dispatchPaste("찾는");
  await controller.dispatchKey("Enter");
  expect(controller.state.screen).toBe("search");
  expect(controller.state.views.search.data).toHaveLength(1);
  expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain(
    "원래 보낸 사람",
  );
  await controller.dispatchKey("Enter");
  expect(controller.state.screen).toBe("chat");
  expect(controller.state.activeChat).toEqual({
    platform: "telegram",
    account: "personal",
    chat_id: "3",
  });
  expect(controller.state.views.chat.data[controller.state.focus]?.id).toBe(
    "hit",
  );
  expect(
    calls.find((c) => c.method === "account.messages")?.params.message_id,
  ).toBe("hit");
  expect(renderScreen(controller.state, { width: 120, height: 40 })).toContain(
    "찾는 메시지",
  );
  controller.stop();
});

test("owner compose sends once without approval codes even if Enter repeats while pending", async () => {
  let finish!: (value: JsonObject) => void;
  const pending = new Promise<JsonObject>((resolve) => (finish = resolve));
  const { controller, calls } = setup(() => pending);
  await controller.start();
  await controller.selectConversation(0);
  await controller.dispatchKey("Enter");
  expect(controller.state.composeActive).toBe(true);
  await controller.dispatchPaste("직접 보낼 내용");
  const sending = controller.dispatchKey("Enter");
  expect(controller.state.sendPending).toBe(true);
  await controller.dispatchKey("Enter");
  expect(calls.filter((c) => c.method === "message.send")).toHaveLength(1);
  expect(calls.some((c) => c.method.startsWith("safety."))).toBe(false);
  expect(calls.find((c) => c.method === "message.send")?.params).toMatchObject({
    envelope: { destination: { platform: "slack", account: "personal", chat_id: "44" }, content: { mode: "text", body: "직접 보낼 내용" } },
  });
  finish({ state: "Sent" });
  await sending;
  expect(controller.state.sendPending).toBe(false);
  expect(controller.state.screen).toBe("chat");
  controller.stop();
});

test('reconnect reloads directory authority without replaying a send', async () => {
  const {controller,calls}=setup();await controller.start();
  controller.disconnected();await controller.start();
  expect(controller.state.capabilities.status).toBe('ready');
  expect(controller.state.requeryCapabilities).toBe(false);
  expect(calls.filter(c=>c.method==='account.list')).toHaveLength(4);
  expect(calls.some(c=>c.method==='account.send')).toBe(false);
  controller.stop();
});

test("publishes partial accounts and polls without losing the selected room", async () => {
  let calls = 0;
  const room = { platform: "telegram", account: "personal", chat_id: "a", display_name: "이름", latest_ts: 1, can_send: true };
  const controller = createTuiController({ client: {
    start: async () => {}, stop() {},
    async request(method) {
      if (method !== "account.list") return {};
      calls++;
      return { available: true, chats: calls === 1 ? [] : [room], errors: [], refreshing: calls < 2 };
    },
  } });
  await controller.start();
  expect(controller.state.directoryRefreshing).toBe(true);
  expect(renderScreen(controller.state, { width: 80, height: 24 })).toContain("대화 불러오는 중");
  await new Promise(r => setTimeout(r, 150));
  expect(controller.state.directory).toHaveLength(1);
  expect(controller.state.directoryRefreshing).toBe(false);
  controller.stop();
  const stoppedCalls = calls;
  await new Promise(r => setTimeout(r, 150));
  expect(calls).toBe(stoppedCalls);
});

test("account searches start independently before a slow provider completes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  const started: string[] = [];
  const controller = createTuiController({ client: {
    start: async () => {}, stop() {},
    async request(method, params) {
      if (method === "account.list") return { available: true, errors: [], chats: ["slack", "telegram"].map(platform => ({ platform, account: "a", chat_id: "r", display_name: "이름", latest_ts: 1 })) };
      if (method === "message.search" && params.mode === "remote") { started.push(String(params.platform)); if (params.platform === "slack") await gate; return { messages: [] }; }
      return {};
    },
  } });
  await controller.start(); await controller.dispatchKey("/"); await controller.dispatchPaste("query");
  const search = controller.dispatchKey("Enter");
  await new Promise(r => setTimeout(r, 0));
  expect(started.sort()).toEqual(["slack", "telegram"]);
  release(); await search; controller.stop();
});

test("confirmed send returns the conversation viewport to its newest message", async () => {
  const { controller, calls } = setup(async () => ({ state: "Verified" }));
  await controller.start(); await controller.selectConversation(0);
  await controller.dispatchKey("ArrowUp");
  expect(controller.state.focus).toBe(0);
  await controller.dispatchKey("c"); await controller.dispatchPaste("new message"); await controller.dispatchKey("Enter");
  expect(calls.filter(call => call.method === "message.send")).toHaveLength(1);
  expect(controller.state.focus).toBe(controller.state.views.chat.data.length - 1);
  expect(controller.state.selected.chat).toBe(controller.state.focus);
  controller.stop();
});

test("account search renders local evidence before remote completes and keeps it on remote failure", async () => {
  let rejectRemote!: (reason: Error) => void;
  const remote = new Promise<JsonObject>((_, reject) => { rejectRemote = reject; });
  const modes: unknown[] = [];
  const controller = createTuiController({ client: {
    start: async () => {}, stop() {},
    async request(method, params) {
      if (method === "account.list") return { available: true, errors: [], chats: [{ platform: "slack", account: "a", chat_id: "r", display_name: "Room", latest_ts: 1 }] };
      if (method === "message.search") {
        modes.push(params.mode);
        if (params.mode === "remote") return remote;
        return { source: "local", next_cursor: params.cursor ? undefined : "saved-next", messages: [{ platform: "slack", account: "a", chat_id: "r", msg_id: params.cursor ? "saved2" : "saved", ts: 1, body: params.cursor ? "saved second" : "saved needle" }] };
      }
      return {};
    },
  } });
  await controller.start(); await controller.dispatchKey("/"); await controller.dispatchPaste("needle");
  const searching = controller.dispatchKey("Enter");
  for (let i = 0; i < 30 && modes.length < 2; i++) await Promise.resolve();
  expect(controller.state.views.search.data[0]?.body).toBe("saved needle");
  expect(modes).toEqual(["local", "remote"]);
  rejectRemote(new Error("offline")); await searching;
  expect(controller.state.views.search.data[0]?.body).toBe("saved needle");
  expect(controller.state.notice).toContain("원격 확인 실패");
  expect(controller.state.views.search.nextCursor).toBeDefined();
  await controller.dispatchKey("n");
  expect(controller.state.views.search.data.some(row => row.body === "saved second")).toBe(true);
  controller.stop();
});
