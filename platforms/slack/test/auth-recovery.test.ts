import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackAuthStore, slackAuthRequired } from "../src/auth-store.ts";
import { createSlackAccount } from "../src/account.ts";
import { dispatch } from "../../../packages/accounts/src/dispatch.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const credentials = { bot_token: "old", session_cookie: "cookie", team_id: "T123" };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "slack-auth-")); dirs.push(dir);
  const path = join(dir, "credentials.json");
  writeFileSync(path, JSON.stringify({ workspaces: { T123: { workspace_id: "T123", workspace_name: "fixture", token: "old", cookie: "cookie" } } }), { mode: 0o600 });
  return path;
}
test("Slack web refresh coalesces, verifies identity and persists the token", async () => {
  const path = fixture(); let web = 0;
  const fetcher = (async (url: string | URL) => {
    if (String(url).endsWith("auth.test")) return Response.json({ ok: true, team_id: "T123", user_id: "U123", url: "https://fixture.slack.com/" });
    web++; return new Response('"api_token":"xoxc-fresh"');
  }) as typeof fetch;
  const store = new SlackAuthStore(fetcher, path); await store.remember(credentials);
  const result = await Promise.all([store.recover(credentials), new SlackAuthStore(fetcher, path).recover(credentials)]);
  expect(web).toBe(1); expect(result.map(r => r.bot_token)).toEqual(["xoxc-fresh", "xoxc-fresh"]);
  expect(JSON.parse(readFileSync(path, "utf8")).workspaces.T123.token).toBe("xoxc-fresh");
});

test.each(["foreign_redirect", "different_user", "expired_cookie"])("Slack rejects %s and latches failed recovery", async mode => {
  const path = fixture(); let recovering = false, web = 0;
  const fetcher = (async (url: string | URL) => {
    if (String(url).endsWith("auth.test")) return Response.json({ ok: true, team_id: "T123", user_id: recovering && mode === "different_user" ? "U999" : "U123", url: "https://fixture.slack.com/" });
    web++; expect(new URL(url).hostname).toBe("fixture.slack.com");
    if (mode === "foreign_redirect") return new Response(null, { status: 302, headers: { location: "https://untrusted.example/steal" } });
    return new Response(mode === "expired_cookie" ? "login required" : '"api_token":"xoxc-fresh"');
  }) as typeof fetch;
  const store = new SlackAuthStore(fetcher, path); await store.remember(credentials); recovering = true;
  for (let i = 0; i < 2; i++) await expect(new SlackAuthStore(fetcher, path).recover(credentials)).rejects.toMatchObject({ code: "slack_auth_required" });
  expect(web).toBe(1); expect(JSON.parse(readFileSync(path, "utf8")).workspaces.T123.token).toBe("old");
});

test("Slack expired reads recover once while sends are never replayed", async () => {
  let refreshes = 0, sends = 0, reads = 0;
  const fetcher = (async (url: string, options: RequestInit) => {
    if (String(url).endsWith("chat.postMessage")) { sends++; return Response.json({ ok: false, error: "token_expired" }); }
    reads++; return Response.json((options.headers as any).authorization === "Bearer fresh" ? { ok: true, members: [] } : { ok: false, error: "invalid_auth" });
  }) as typeof fetch;
  const auth = { async remember() {}, async recover() { refreshes++; await new Promise(r => setTimeout(r, 5)); return { ...credentials, bot_token: "fresh" }; } };
  const adapter = createSlackAccount(credentials, fetcher, undefined, auth);
  await Promise.all([dispatch(adapter, { op: "slack.users.list", params: { limit: 100, cursor: "" } }), dispatch(adapter, { op: "slack.users.list", params: { limit: 100, cursor: "" } })]);
  expect(refreshes).toBe(1); expect(reads).toBe(4);
  await expect(dispatch(adapter, { op: "slack.chat.postMessage", params: { channel: "C1", text: "hello", client_msg_id: "id" } })).rejects.toThrow();
  expect(sends).toBe(1); expect(refreshes).toBe(1);
});

test("Slack network failure does not invoke authentication recovery", async () => {
  let recoveries = 0;
  const adapter = createSlackAccount(credentials, (async () => { throw new Error("offline"); }) as unknown as typeof fetch, undefined, { async remember() {}, async recover() { recoveries++; throw slackAuthRequired(); } });
  await expect(dispatch(adapter, { op: "slack.users.list", params: { limit: 100, cursor: "" } })).rejects.toThrow("offline");
  expect(recoveries).toBe(0);
});

test("fixed-binding Slack transport adopts refreshed credentials and never replays writes", async () => {
  const { createRecoveringSlackTransport } = await import("../src/recovering-transport.ts");
  let refreshes = 0, reads = 0, sends = 0;
  const store = { current: (c: typeof credentials) => c, async recover() { refreshes++; return { ...credentials, bot_token: "fresh" }; } } as unknown as SlackAuthStore;
  const transport = createRecoveringSlackTransport(credentials, store, c => ({ async call(call) {
    if (call.method === "chat.postMessage") sends++; else reads++;
    return { status: 200, headers: {}, body: { ok: c.bot_token === "fresh" && call.method !== "chat.postMessage", error: "invalid_auth" } };
  } }));
  await transport.call({ method: "auth.test", payload: {}, signal: new AbortController().signal });
  await transport.call({ method: "chat.postMessage", payload: {}, signal: new AbortController().signal });
  expect({ refreshes, reads, sends }).toEqual({ refreshes: 1, reads: 2, sends: 1 });
});
