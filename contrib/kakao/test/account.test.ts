import { expect, test } from "bun:test";
import { createKakaoAccount } from "../src/account.ts";
import type { PersonalCredentials } from "../src/personal-session.ts";

test("Kakao resolves provider author names and shows the latest page after forward history traversal", async () => {
  const pages: string[] = [];
  const client = {
    async getChats() {
      return [
        {
          chat_id: "room",
          title: "메신저 원래 이름",
          unread_count: 1,
          last_message: { sent_at: 60, message: "latest" },
        },
      ];
    },
    async getMessagePage(_: string, options: { from?: string }) {
      pages.push(options.from ?? "0");
      return {
        messages: Array.from({ length: 30 }, (_, i) => {
          const n = i + (options.from ? 31 : 1);
          return {
            log_id: String(n),
            author_id: 7,
            author_name: null,
            sent_at: n,
            message: `message ${n}`,
          };
        }),
        next_cursor: options.from ? null : "30",
        complete: !!options.from,
      };
    },
    async getMembersByIds() {
      return [{ user_id: "7", nickname: "카카오 표시 이름" }];
    },
    async sendMessage() {
      return { success: true, log_id: "receipt" };
    },
    close() {},
  };
  const adapter = await createKakaoAccount(
    {} as PersonalCredentials,
    client as never,
  );
  const result = await adapter.run({ op: "messages", chat_id: "room" });
  expect(pages).toEqual(["0", "30"]);
  expect(result.messages).toHaveLength(30);
  expect(result.messages?.[0]?.id).toBe("31");
  expect(result.messages?.at(-1)?.id).toBe("60");
  expect(
    result.messages?.every((m) => m.author_name === "카카오 표시 이름"),
  ).toBe(true);
  const context = await adapter.run({
    op: "messages",
    chat_id: "room",
    message_id: "12",
  });
  expect(context.messages?.some((m) => m.id === "12")).toBe(true);
  const search = await adapter.run({ op: "search", query: "message 60" });
  expect(search.messages?.map((m) => m.id)).toEqual(["60"]);
  expect(search.next_cursor).toBeUndefined();
  await adapter.close();
});

test("Kakao self-chat and own messages use the provider membership name when MEMBER omits self", async () => {
  const client = {
    async getChats() {
      return [
        {
          chat_id: "self",
          type: "MemoChat",
          title: null,
          display_name: null,
          unread_count: 0,
        },
      ];
    },
    async getMembers() {
      return [{ user_id: "7", nickname: "원래 프로필 이름" }];
    },
    async getMembersByIds() {
      return [];
    },
    async getMessagePage() {
      return {
        messages: [{ log_id: "1", author_id: 7, sent_at: 1, message: "hello" }],
        complete: true,
        next_cursor: null,
      };
    },
    close() {},
  };
  const adapter = await createKakaoAccount(
    { userId: "7" } as PersonalCredentials,
    client as never,
  );
  expect((await adapter.run({ op: "chats" })).chats?.[0]?.title).toBe(
    "원래 프로필 이름",
  );
  expect(
    (await adapter.run({ op: "messages", chat_id: "self" })).messages?.[0]
      ?.author_name,
  ).toBe("원래 프로필 이름");
});

test("repeated Kakao search shares raw pages and resolves names only for matches", async () => {
  let reads = 0, names = 0;
  const adapter = await createKakaoAccount({ userId: "self" } as PersonalCredentials, {
    async getChats() { return [{ chat_id: "r", title: "원래 이름" }]; },
    async getMessagePage() { reads++; return { messages: [{ log_id: "1", author_id: 7, message: "needle", sent_at: 1 }], complete: true, next_cursor: null }; },
    async getMembersByIds() { names++; return [{ user_id: "7", nickname: "실제 이름" }]; }, close() {},
  } as never);
  expect((await adapter.run({ op: "search", query: "absent" })).messages).toHaveLength(0);
  expect(names).toBe(0);
  expect((await adapter.run({ op: "search", query: "needle" })).messages?.[0]?.author_name).toBe("실제 이름");
  expect(reads).toBe(1); expect(names).toBe(1);
  await adapter.close();
});

test("cold reads use provider-supplied author names without MEMBER calls", async () => {
  let memberRequests = 0;
  const adapter = await createKakaoAccount({ userId: "self" } as PersonalCredentials, {
    async getMessagePage() { return { messages: [{ log_id: "1", author_id: 7, author_name: "응답에 들어온 실제 이름", sent_at: 1, message: "body" }], complete: true }; },
    async getMembersByIds() { memberRequests++; return []; }, close() {},
  } as never);
  expect((await adapter.run({ op: "messages", chat_id: "r" })).messages?.[0]?.author_name).toBe("응답에 들어온 실제 이름");
  expect(memberRequests).toBe(0); await adapter.close();
});

test("cold directory reuses MemoChat detail instead of four-call member snapshot", async () => {
  let members = 0, details = 0;
  const adapter = await createKakaoAccount({ userId: "self" } as PersonalCredentials, {
    async getChats() { return [{ chat_id: "self", type: "MemoChat", title: null, display_name: null }]; },
    async getChat() { details++; return { chat_id: "self", type: "MemoChat", title: null, display_name: "원래 내 이름" }; },
    async getChatTitle() { throw new Error("unnecessary second title call"); },
    async getMembers() { members++; return []; }, close() {},
  } as never);
  expect((await adapter.run({ op: "chats" })).chats?.[0]?.title).toBe("원래 내 이름");
  expect(details).toBe(1); expect(members).toBe(0); await adapter.close();
});

test("explicit refresh bypasses cached Kakao history and returns changed content", async () => {
  let reads = 0, body = "before";
  const adapter = await createKakaoAccount({ userId: "self" } as PersonalCredentials, {
    async getMessagePage() { reads++; return { messages: [{ log_id: "1", author_id: 7, author_name: "이름", sent_at: 1, message: body }], complete: true }; }, close() {},
  } as never);
  await adapter.run({ op: "messages", chat_id: "r" }); body = "after";
  const result = await adapter.run({ op: "messages", chat_id: "r", refresh: true });
  expect(reads).toBe(2); expect(result.messages?.[0]?.body).toBe("after"); await adapter.close();
});

test("a search hit near the beginning of a 100-message batch remains in its context", async () => {
  const adapter = await createKakaoAccount({ userId: "self" } as PersonalCredentials, {
    async getMessagePage() { return { messages: Array.from({ length: 100 }, (_, i) => ({ log_id: String(i + 1), author_id: 7, author_name: "이름", sent_at: i, message: "body" })), complete: true }; }, close() {},
  } as never);
  const result = await adapter.run({ op: "messages", chat_id: "r", message_id: "12" });
  expect(result.messages?.some(m => m.id === "12")).toBe(true);
  expect(result.messages!.length).toBeLessThanOrEqual(60); await adapter.close();
});
