import { dispatch, dispatchWire } from "../../../packages/accounts/src/dispatch.ts";
import { describe, expect, test } from "bun:test";
import { createTelegramAdapter } from "../src/account.ts";
import type { TdlibUserClientPort } from "../src/tdlib-port.ts";

function fixture() {
  const calls: any[] = [];
  const message = { id: 20, chat_id: 10, sender_id: { user_id: 7 }, date: 123, content: { caption: { text: "caption" } } };
  const port = {
    accountQuery: async (q: any) => {
      calls.push(q);
      if (q._ === "loadChats") throw { code: 404 };
      if (q._ === "getChats") return { chat_ids: [10, 11] };
      if (q._ === "getUser") return { first_name: "First", last_name: "Last" };
      return { messages: [message], next_offset: "next" };
    },
    getChatHistory: async (q: any) => { calls.push(q); return [message]; },
    sendTextMessage: async (q: any) => { calls.push(q); return message; },
  } as unknown as TdlibUserClientPort;
  return { calls, adapter: createTelegramAdapter(port) };
}
describe("Telegram provider adapter", () => {
  test("performs a single directory load and translates exhaustion", async () => {
    const { calls, adapter } = fixture();
    expect(await dispatch(adapter, { op: "telegram_load_directory", params: { list: "archive" }, limit: 200 })).toEqual({ complete: true });
    expect(calls).toEqual([{ _: "loadChats", chat_list: { _: "chatListArchive" }, limit: 200 }]);
  });
  test("history preserves provider order and carries typed sender identity without lookup", async () => {
    const { calls, adapter } = fixture();
    const result = await dispatch(adapter, { op: "telegram_history", chat_id: "10", message_id: "9", limit: 30 });
    expect(calls).toHaveLength(1);
    expect(calls[0].from_message_id).toBe("9");
    expect(result.messages?.[0]).toMatchObject({ id: "20", author_id: "7", author_kind: "user", body: "caption" });
    expect("next_cursor" in result).toBe(false);
  });
  test("search maps both provider cursor formats without constructing public cursor", async () => {
    const { calls, adapter } = fixture();
    const result = await dispatch(adapter, { op: "telegram_search", query: "test", cursor: "opaque", limit: 100 });
    expect(calls[0]).toMatchObject({ _: "searchMessages", offset: "opaque", limit: 100 });
    expect(result.next_offset).toBe("next");
    await dispatch(adapter, { op: "telegram_search", chat_id: "10", query: "test", cursor: "20", limit: 100 });
    expect(calls[1]).toMatchObject({ _: "searchChatMessages", chat_id: 10, from_message_id: 20 });
  });
  test("rejects batch and policy operations at the provider boundary", async () => {
    const { calls, adapter } = fixture();
    for (const op of ["batch", "messages", "chats", "search", "send"]) {
      await expect(dispatchWire(adapter, { op })).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });
  test("send invokes the SDK exactly once without sender lookup", async () => {
    const { calls, adapter } = fixture();
    const result = await dispatch(adapter, { op: "telegram_send", chat_id: "10", body: "hello" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ chat_id: "10", text: "hello" });
    expect(result).toMatchObject({ state: "Sent", receipt: "20" });
  });
  test("rejects missing or malformed provider arrays instead of fabricating empty pages", async () => {
    for (const value of [undefined, null, {}, "wrong"]) {
      const adapter = createTelegramAdapter({
        accountQuery: async () => ({ chat_ids: value, messages: value }),
      } as unknown as TdlibUserClientPort);
      await expect(dispatch(adapter, { op: "telegram_list_directory", params: {list:"main"}, limit: 20000 })).rejects.toThrow("Malformed Telegram directory");
      await expect(dispatch(adapter, { op: "telegram_search", query: "term", limit: 100 })).rejects.toThrow("Malformed Telegram search results");
    }
  });

});

test("account updates cover new, edited and deleted messages without forwarding content", async () => {
  let listener: ((value: Record<string, unknown>) => void) | undefined;
  const events: unknown[] = [];
  const adapter = createTelegramAdapter({ onAccountUpdate(callback) { listener = callback; return () => { listener = undefined; }; } } as TdlibUserClientPort);
  const stop = await adapter.listen!(event => events.push(event));
  listener!({ "@type": "updateConnectionState", state: { "@type": "connectionStateReady" } });
  for (const type of ["updateNewMessage", "updateMessageContent", "updateDeleteMessages"]) listener!({ "@type": type, body: "private" });
  listener!({ "@type": "updateUserStatus" });
  listener!({ "@type": "updateAuthorizationState", authorization_state: { "@type": "authorizationStateClosed" } });
  expect(events).toEqual([{ event: "state", state: "disconnected" }, { event: "state", state: "connected" }, { event: "changed" }, { event: "changed" }, { event: "changed" }, { event: "state", state: "disconnected" }]);
  listener!({ "@type": "updateNewMessage", message: { chat_id: 42, id: 100, content: { text: "private" } } });
  expect(events.at(-1)).toEqual({ event: "changed", chat_id: "42", message_id: "100" });
  listener!({ "@type": "updateMessageContent", chat_id: 42, message_id: 10, new_content: { text: "private edit" } });
  expect(events.at(-1)).toEqual({ event: "changed", chat_id: "42", message_id: "10" });
  stop();
  expect(listener).toBeUndefined();
});


test("only authoritative permanent Telegram deletions create tombstone evidence", async () => {
  let listener: ((value: Record<string, unknown>) => void) | undefined;
  const events: unknown[] = [];
  const adapter = createTelegramAdapter({ onAccountUpdate(callback) { listener=callback; return () => {}; } } as TdlibUserClientPort);
  await adapter.listen!(event => events.push(event));
  const base = { "@type": "updateDeleteMessages", chat_id: 42, message_ids: [100,101] };
  listener!({...base,is_permanent:false,from_cache:false});
  listener!({...base,is_permanent:true,from_cache:true});
  expect(events.filter((e:any)=>e.event==="deleted")).toHaveLength(0);
  listener!({...base,is_permanent:true,from_cache:false});
  expect(events.slice(-2)).toEqual([{event:"deleted",chat_id:"42",message_id:"100"},{event:"deleted",chat_id:"42",message_id:"101"}]);
});

test("directory preserves the own inbox read cursor, not the outgoing read cursor", async () => {
  const adapter = createTelegramAdapter({ accountQuery: async () => ({ id: 42, title: "room", unread_count: 1, last_read_inbox_message_id: 10485760, last_read_outbox_message_id: 20971520 }) } as unknown as TdlibUserClientPort);
  const result = await dispatch(adapter, { op: "telegram_chat", chat_id: "42" });
  expect(result.chats?.[0]).toMatchObject({ unread: 1, read_through: "10485760" });
});

test("Telegram resumes one read after TDLib is ready and never replays a send", async () => {
  let reads = 0, sends = 0;
  const adapter = createTelegramAdapter({
    getAuthorizationState: async () => ({ "@type": "authorizationStateReady" }),
    accountQuery: async () => { if (++reads === 1) throw Object.assign(new Error("session"), { code: 401 }); return { chat_ids: [1] }; },
    sendTextMessage: async () => { sends++; throw Object.assign(new Error("session"), { code: 401 }); },
  } as never);
  expect(await dispatch(adapter, { op: "telegram_list_directory", limit: 10, params: { list: "main" } })).toEqual({ ids: ["1"] });
  expect(reads).toBe(2);
  await expect(dispatch(adapter, { op: "telegram_send", chat_id: "1", body: "hello" })).rejects.toMatchObject({ code: "telegram_auth_required" });
  expect(sends).toBe(1);
});

test("Telegram revoked sessions request reconnection without read loops", async () => {
  let reads = 0;
  const adapter = createTelegramAdapter({
    getAuthorizationState: async () => ({ "@type": "authorizationStateWaitPhoneNumber" }),
    accountQuery: async () => { reads++; throw Object.assign(new Error("session"), { code: 401 }); },
  } as never);
  await expect(dispatch(adapter, { op: "telegram_list_directory", limit: 10, params: { list: "main" } })).rejects.toMatchObject({ code: "telegram_auth_required" });
  expect(reads).toBe(1);
});
