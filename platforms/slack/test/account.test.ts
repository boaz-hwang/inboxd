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

test("RTM lifecycle invalidates on edits/deletes and tears down without HTTP polling or sends", async () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  let starts = 0, stops = 0;
  const events: unknown[] = [];
  const listener = {
    on(name: string, handler: (...args: any[]) => void) { handlers.set(name, handler); return this; },
    async start() { starts++; handlers.get("connected")!(); },
    stop() { stops++; },
  };
  const adapter = createSlackAccount({ bot_token: "synthetic", session_cookie: "synthetic" }, (async () => { throw new Error("push must not invoke reads or sends"); }) as unknown as typeof fetch, () => listener as never);
  const stop = await adapter.listen!(event => events.push(event));
  handlers.get("slack_event")!({ type: "user_typing" });
  for (const subtype of ["message_changed", "message_deleted"]) handlers.get("slack_event")!({ type: "message", subtype, text: "private" });
  handlers.get("error")!(new Error("private"));
  handlers.get("connected")!();
  expect(events).toEqual([{ event: "state", state: "connected" }, { event: "changed" }, { event: "changed" }, { event: "state", state: "disconnected" }, { event: "state", state: "connected" }]);
  handlers.get("slack_event")!({ type: "message", subtype: "message_deleted", channel: "self-room", deleted_ts: "42.001", previous_message: {text:"private"} });
  expect(events.at(-1)).toEqual({ event: "deleted", chat_id: "self-room", message_id: "42.001" });
  handlers.get("slack_event")!({ type: "message", channel: "self-room", ts: "43.001", text: "private" });
  expect(events.at(-1)).toEqual({ event: "changed", chat_id: "self-room", message_id: "43.001" });
  handlers.get("slack_event")!({ type: "message", subtype: "message_changed", channel: "self-room", ts: "50.001", message: { ts: "12.001", text: "private edit" } });
  expect(events.at(-1)).toEqual({ event: "changed", chat_id: "self-room", message_id: "12.001" });
  expect(starts).toBe(1);
  stop();
  expect(stops).toBe(1);
});
