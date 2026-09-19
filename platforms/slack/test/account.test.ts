import { dispatch, dispatchWire } from "../../../packages/accounts/src/dispatch.ts";
import { expect, test } from "bun:test";
import { createSlackAccount } from "../src/account.ts";

test("provider primitives forward exactly one API call with authentication", async () => {
  const calls: string[] = [];
  const account = createSlackAccount({ bot_token: "fixture", session_cookie: "session" }, (async (url: string, options: RequestInit) => {
    calls.push(url);
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer fixture");
    expect(new Headers(options.headers).get("cookie")).toBe("d=session");
    expect(new URLSearchParams(String(options.body)).get("cursor")).toBe("next");
    return Response.json({ ok: true, members: [{ id: "u" }], response_metadata: { next_cursor: "another" } });
  }) as typeof fetch);
  const result = await dispatch(account, { op: "slack.users.list", params: { cursor: "next", limit: 200 } });
  expect(result.data as unknown).toEqual({ ok: true, members: [{ id: "u" }], response_metadata: { next_cursor: "another" } });
  expect(calls).toEqual(["https://slack.com/api/users.list"]);
});

test("send makes a single mutation and returns receipt without enrichment", async () => {
  let calls = 0;
  const account = createSlackAccount({ bot_token: "fixture" }, (async (_url: string, options: RequestInit) => {
    calls++;
    const params = new URLSearchParams(String(options.body));
    expect(params.get("client_msg_id")).toBe("dedup");
    return Response.json({ ok: true, ts: "42", message: { user: "unknown" } });
  }) as typeof fetch);
  expect((await dispatch(account, { op: "slack.chat.postMessage", params: { channel: "c", text: "body", client_msg_id: "dedup" } })).data as unknown).toEqual({ ok: true, ts: "42", message: { user: "unknown" } });
  expect(calls).toBe(1);
});

test("unsupported operations and provider errors fail without retries", async () => {
  let calls = 0;
  const account = createSlackAccount({ bot_token: "fixture" }, (async (_url: string) => { calls++; return Response.json({ ok: false }); }) as typeof fetch);
  await expect(dispatchWire(account, { op: "chats" })).rejects.toThrow("unsupported primitive");
  expect(calls).toBe(0);
  await expect(dispatch(account, { op: "slack.chat.postMessage", params: {channel:"c",text:"hello",client_msg_id:"request"} })).rejects.toThrow("Slack 조회 실패");
  expect(calls).toBe(1);
});
