import { expect, test } from "bun:test";
import { createSlackAccount } from "../src/account.ts";

test("bulk names retain external DM fallback; unchanged covered rooms skip history", async () => {
  const calls: string[] = [];
  let invalid = false;
  const account = createSlackAccount({ bot_token: "fixture" }, (async (url: string, options: RequestInit) => {
    const method = url.split("/").at(-1)!;
    calls.push(method);
    const params = new URLSearchParams(String(options.body));
    const results: Record<string, unknown> = {
      "users.list": { members: [{ id: "u", profile: { display_name: "원래 이름" } }] },
      "users.info": { user: { profile: { display_name: "외부 이름" } } },
      "conversations.list": { channels: [{ id: "a", is_im: true, user: "u" }, { id: "b", is_im: true, user: "external" }] },
      "client.counts": { ims: [{ id: "a", latest: "42", updated: "1", history_invalid: invalid }] },
      "conversations.history": { messages: [{ ts: "42", text: params.get("channel") }] },
    };
    return new Response(JSON.stringify({ ok: true, ...results[method] as object }));
  }) as typeof fetch);
  const first = await account.run({ op: "chats" });
  expect(first.chats?.map(c => c.title)).toEqual(["원래 이름", "외부 이름"]);
  expect(calls.filter(c => c === "users.info")).toHaveLength(1);
  await account.run({ op: "chats" }); // establish change-watermark baseline without adding a cold-start request
  calls.length = 0;
  await account.run({ op: "chats" });
  expect(calls.sort()).toEqual(["client.counts", "conversations.history", "conversations.list"].sort());
  invalid = true; calls.length = 0;
  await account.run({ op: "chats" });
  expect(calls.filter(c => c === "conversations.history")).toHaveLength(2);
});

test("concurrent repeated senders share a single profile lookup", async () => {
  let users = 0;
  const account = createSlackAccount({ bot_token: "fixture" }, (async (url: string) => {
    if (url.endsWith("users.info")) { users++; await new Promise(r => setTimeout(r, 5)); return Response.json({ ok: true, user: { name: "actual" } }); }
    return Response.json({ ok: true, messages: Array.from({ length: 10 }, (_, i) => ({ ts: String(i), user: "same", text: "body" })) });
  }) as typeof fetch);
  const result = await account.run({ op: "messages", chat_id: "a" });
  expect(users).toBe(1);
  expect(result.messages).toHaveLength(10);
});
