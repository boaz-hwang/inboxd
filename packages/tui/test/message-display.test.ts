import { expect, test } from "bun:test";
import { messageDisplayBody } from "../src/text.ts";
import { createTuiController, renderScreen } from "../src/index.ts";

const control = '{"logId":3935507181535623170,"targetRevision":2,"hidden":true,"feedType":25}';
test("Kakao internal revision envelopes show text when present and disappear without text", () => {
  expect(messageDisplayBody("kakao", control)).toBeNull();
  for (const key of ["message", "text", "body"]) {
    expect(messageDisplayBody("kakao", JSON.stringify({ ...JSON.parse(control), [key]: "실제 메시지\n둘째 줄" }))).toBe("실제 메시지\n둘째 줄");
  }
  expect(messageDisplayBody("kakao", JSON.stringify({ ...JSON.parse(control), message: { logId: "nested metadata" } }))).toBeNull();
  for (const text of ['{"message":"a user wrote JSON"}', '{"logId":"1","targetRevision":2}', "일반 메시지", "{broken"]) expect(messageDisplayBody("kakao", text)).toBe(text);
  expect(messageDisplayBody("slack", control)).toBe(control);
});

test("existing stored Kakao metadata is hidden in chat and inbox previews without hiding the room", async () => {
  const calls: string[] = [];
  const controller = createTuiController({ client: { start: async () => {}, stop() {}, async request(method) {
    calls.push(method);
    if (method === "account.list") return { available: true, chats: [{ platform: "kakao", account: "owner", chat_id: "room", display_name: "청년부 리더", latest_ts: 3, preview: control, can_send: true }], errors: [] };
    if (method === "account.messages") return { messages: [
      { id: "real", author_id: "other", author_name: "참여자", ts: 1, body: "실제 대화 내용" },
      { id: "feed-with-text", author_id: "other", author_name: "참여자", ts: 2, body: JSON.stringify({ ...JSON.parse(control), message: "표시할 본문" }) },
      { id: "feed-no-text", author_id: "other", author_name: "참여자", ts: 3, body: control },
    ] };
    return {};
  } } });
  try {
    await controller.start();
    expect(controller.state.directory).toHaveLength(1);
    expect(controller.state.views.inbox.data).toHaveLength(0);
    expect(renderScreen(controller.state, { width: 120, height: 40 })).not.toContain("targetRevision");
    await controller.selectConversation(0);
    expect(controller.state.views.chat.data.map(row => row.id)).toEqual(["real", "feed-with-text"]);
    const screen = renderScreen(controller.state, { width: 120, height: 40 });
    expect(screen).toContain("실제 대화 내용");
    expect(screen).toContain("표시할 본문");
    expect(screen).not.toContain("targetRevision");
    expect(calls).not.toContain("message.send");
    expect(calls).not.toContain("response.seen");
  } finally { controller.stop(); }
});

test("Kakao hidden feed without targetRevision is filtered too", () => {
  const feed = '{"logId":3934384549540935683,"byHost":false,"hidden":true,"feedType":14}';
  expect(messageDisplayBody("kakao", feed)).toBeNull();
  expect(messageDisplayBody("telegram", feed)).toBe(feed);
  expect(messageDisplayBody("kakao", JSON.stringify({ ...JSON.parse(feed), message: "실제 본문" }))).toBe("실제 본문");
});
