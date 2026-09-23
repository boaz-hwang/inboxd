import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KakaoAuthStore, authExpired } from "../src/auth-store.ts";
import { personalSession, type PersonalCredentials } from "../src/personal-session.ts";
import type { KakaoTalkClient } from "agent-messenger/kakaotalk";

const original: PersonalCredentials = { oauthToken: "expired", userId: "7", deviceUuid: "device", deviceType: "tablet" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "inboxd-auth-")); dirs.push(dir);
  const path = join(dir, "credentials.json");
  const document = { current_account: "mine", accounts: { mine: { user_id: "7", device_uuid: "device", device_type: "tablet", oauth_token: "expired", refresh_token: "refresh-old", untouched: true }, other: { user_id: "8", device_uuid: "other", device_type: "tablet", oauth_token: "other-token" } } };
  writeFileSync(path, JSON.stringify(document), { mode: 0o600 });
  return { path, document };
}

test("concurrent independent stores coalesce rotation and persist both tokens before returning", async () => {
  const { path } = fixture(); let calls = 0;
  const refresh = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { accessToken: "fresh", refreshToken: "refresh-new" }; };
  const stores = Array.from({ length: 6 }, () => new KakaoAuthStore(path, refresh));
  const result = await Promise.all(stores.map(s => s.recover(original)));
  expect(calls).toBe(1); expect(result.every(c => c.oauthToken === "fresh")).toBe(true);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.accounts.mine).toMatchObject({ oauth_token: "fresh", refresh_token: "refresh-new", untouched: true });
  expect(saved.accounts.other.oauth_token).toBe("other-token");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(new KakaoAuthStore(path).current(original).oauthToken).toBe("fresh");
});

test("rejected refresh is latched across workers until credentials change", async () => {
  const { path } = fixture(); let calls = 0;
  const refresh = async () => { calls++; throw Object.assign(new Error("secret response"), { code: "refresh_rejected" }); };
  for (let i = 0; i < 3; i++) await expect(new KakaoAuthStore(path, refresh).recover(original)).rejects.toMatchObject({ code: "invalid_access_token" });
  expect(calls).toBe(1); expect(readFileSync(path, "utf8")).not.toContain("secret response");
  const document = JSON.parse(readFileSync(path, "utf8")); document.accounts.mine.oauth_token = "reauthenticated";
  writeFileSync(path, JSON.stringify(document), { mode: 0o600 });
  expect((await new KakaoAuthStore(path, refresh).recover(original)).oauthToken).toBe("reauthenticated");
  expect(calls).toBe(1);
});

test("refresh never borrows another account or device's refresh token", async () => {
  const { path } = fixture(); let calls = 0;
  const store = new KakaoAuthStore(path, async () => { calls++; return { accessToken: "fresh", refreshToken: "new" }; });
  await expect(store.recover({ ...original, deviceUuid: "different" })).rejects.toMatchObject({ code: "invalid_access_token" });
  expect(calls).toBe(0);
});

function clients(options: { alwaysExpired?: boolean; network?: boolean } = {}) {
  let recoveries = 0, sends = 0, files = 0, marks = 0, reads = 0, creates = 0, closes = 0;
  const handlers: Set<Function>[] = [];
  const store = { current: (c: PersonalCredentials) => c, recover: async (c: PersonalCredentials) => { recoveries++; await new Promise(r => setTimeout(r, 5)); return { ...c, oauthToken: "fresh" }; } };
  const create = async (credentials: PersonalCredentials) => {
    creates++; const push = new Set<Function>(); handlers.push(push);
    return {
      async getChats() { reads++; if (options.network) throw new Error("network failed"); if (options.alwaysExpired || credentials.oauthToken === "expired") throw authExpired(); return []; },
      async sendMessage() { sends++; throw authExpired(); },
      async sendFile() { files++; throw authExpired(); },
      async markRead() { marks++; throw authExpired(); },
      onPush(handler: Function) { push.add(handler); return () => { push.delete(handler); }; },
      onSessionEvent() { return () => {}; },
      close() { closes++; },
    } as unknown as KakaoTalkClient;
  };
  return { store, create, handlers, counts: () => ({ recoveries, sends, files, marks, reads, creates, closes }) };
}

test("simultaneous expired reads share recovery, rebind push listeners and retry once", async () => {
  const fixture = clients(); const client = await personalSession(original, fixture);
  let pushes = 0; const off = client.onPush(() => { pushes++; });
  await Promise.all([client.getChats(), client.getChats(), client.getChats()]);
  expect(fixture.counts()).toMatchObject({ recoveries: 1, creates: 2, reads: 6, closes: 1 });
  expect(fixture.handlers[0]!.size).toBe(0);
  for (const handler of fixture.handlers[1]!) handler({});
  expect(pushes).toBe(1); off(); expect(fixture.handlers[1]!.size).toBe(0); client.close();
});

test("network errors and failed mutations never trigger refresh or replay", async () => {
  const fixture = clients({ network: true }); const client = await personalSession(original, fixture);
  await expect(client.getChats()).rejects.toThrow("network failed");
  await expect(client.sendMessage("room", "hello")).rejects.toThrow();
  await expect(client.sendFile("room", Buffer.from("file"), "test.txt")).rejects.toThrow();
  await expect(client.markRead("room", "1")).rejects.toThrow();
  expect(fixture.counts()).toMatchObject({ recoveries: 0, creates: 1, sends: 1, files: 1, marks: 1, reads: 1 }); client.close();
});

test("a failed retry terminates after one refresh and two read attempts", async () => {
  const fixture = clients({ alwaysExpired: true }); const client = await personalSession(original, fixture);
  await expect(client.getChats()).rejects.toMatchObject({ code: "invalid_access_token" });
  expect(fixture.counts()).toMatchObject({ recoveries: 1, reads: 2 }); client.close();
});

test("separate worker processes refresh an expired account only once", async () => {
  const { path } = fixture();
  const count = `${path}.calls`;
  const modulePath = new URL("../src/auth-store.ts", import.meta.url).pathname;
  const code = `import {KakaoAuthStore} from ${JSON.stringify(modulePath)};
    import {appendFileSync} from 'node:fs';
    const store = new KakaoAuthStore(process.env.AUTH_TEST_PATH, async () => {
      appendFileSync(process.env.AUTH_TEST_COUNT, 'refresh\\n');
      await new Promise(r => setTimeout(r, 40));
      return {accessToken:'fresh',refreshToken:'next'};
    });
    const result = await store.recover({oauthToken:'expired',userId:'7',deviceUuid:'device',deviceType:'tablet'});
    if(result.oauthToken !== 'fresh') process.exit(1);`;
  const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, AUTH_TEST_PATH: path, AUTH_TEST_COUNT: count }, stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(children.map(c => c.exited))).toEqual([0, 0, 0]);
  expect(readFileSync(count, "utf8")).toBe("refresh\n");
});

test("a refreshed token rejected by the provider stays blocked across sessions", async () => {
  const { path } = fixture(); let refreshes = 0;
  const store = new KakaoAuthStore(path, async () => { refreshes++; return { accessToken: "fresh-but-rejected", refreshToken: "next" }; });
  const create = async () => ({ getChats: async () => { throw authExpired(); }, close() {} }) as unknown as KakaoTalkClient;
  for (let i = 0; i < 2; i++) {
    const client = await personalSession(original, { store, create });
    await expect(client.getChats()).rejects.toMatchObject({ code: "invalid_access_token" }); client.close();
  }
  expect(refreshes).toBe(1);
});
