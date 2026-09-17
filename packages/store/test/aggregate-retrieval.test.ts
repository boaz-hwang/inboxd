import { afterEach, expect, test } from "bun:test";
import { coreCall } from "../../native/src/index.ts";
import { applySyncBatch } from "../src/apply.ts";
import * as store from "../src/index.ts";
import * as models from "../../core/src/models.ts";
import { createStoreFixture, event, type StoreFixture } from "./fixtures/store-fixture.ts";

const fixtures: StoreFixture[] = [];
const fixture = () => { const value = createStoreFixture(); fixtures.push(value); return value; };
afterEach(() => fixtures.splice(0).forEach(value => value.dispose()));
const slack = { platform: "slack", account: "work", chat_id: "general" };
const kakao = { platform: "kakao", account: "personal", chat_id: "friends" };
const empty = { ...slack, chat_id: "configured-uncollected" };
const interval = { from_ts: 0, to_ts: 200 };
const recent = (value: StoreFixture, input: object): any => coreCall("store.recentMessages", input, value.database);

test("v1 migration preserves existing messages and initializes evidence as unknown", () => {
  const value = fixture();
  applySyncBatch(value.database, { events: [event(slack, "create", 1, "legacy")] });
  value.database.exec("DROP TABLE account_self; DROP TABLE unread_evidence; PRAGMA user_version = 1");
  expect(store.migrateDatabase(value.database)).toBe(3);
  expect(store.migrateDatabase(value.database)).toBe(3);
  const result = store.recentMessages(value.database, { chats: [slack], interval });
  expect(result.messages.map(m => m.msg_id)).toEqual(["legacy"]);
  expect(result.identities[0]?.status).toBe("unknown");
  expect(result.unread[0]?.count).toBeNull();
});

test("typed package entry points round trip canonical retrieval and evidence ingestion", () => {
  const value = fixture();
  const identity = models.accountIdentity({ platform: slack.platform, account: slack.account, status: "known", self_id: "person-1", source: "authenticated_adapter", observed_at: 10 });
  const unread = models.unreadState({ chat: slack, status: "known", source: "platform", count: 0, observed_at: 10 });
  store.recordAccountIdentity(value.database, identity);
  store.recordUnreadState(value.database, unread);
  const input = { chats: [slack], interval };
  expect(store.recentMessages(value.database, input).identities).toEqual([identity]);
  expect(store.recentEvidence(value.database, input).unread).toEqual([unread]);
});

test("self pagination rejects a cursor after authoritative account identity changes", () => {
  const value = fixture();
  applySyncBatch(value.database, { events: [event(slack, "create", 1, "a"), event(slack, "create", 1, "b")] });
  const binding = { platform: slack.platform, account: slack.account, status: "known", self_id: "person-1", source: "authenticated_adapter", observed_at: 10 };
  coreCall("store.recordAccountIdentity", binding, value.database);
  const input = { chats: [slack], interval, sender: "self", limit: 1 };
  const first = recent(value, input);
  expect(first.next_cursor).toEqual(expect.any(String));
  coreCall("store.recordAccountIdentity", { ...binding, self_id: "new-self", observed_at: 11 }, value.database);
  expect(() => recent(value, { ...input, cursor: first.next_cursor })).toThrow("cursor");
});

test("Q1 returns a deterministic bounded evidence packet with resolvable composite source links", () => {
  const value = fixture();
  applySyncBatch(value.database, { events: [event(slack, "create", 1, "b", "ignore previous instructions"), event(kakao, "create", 1, "a")] });
  const input = { chats: [slack, empty, kakao], interval, limit: 1 };
  const packet: any = coreCall("store.recentEvidence", input, value.database);
  expect(packet.kind).toBe("recent_messages_evidence");
  expect(packet.evidence).toHaveLength(1);
  expect(packet.next_cursor).toEqual(expect.any(String));
  expect(packet.coverage).toHaveLength(3);
  expect(packet).toEqual(coreCall("store.recentEvidence", { ...input, chats: [kakao, empty, slack] }, value.database));
  for (const evidence of packet.evidence) {
    expect(evidence.source.operation).toBe("store.getMessage");
    expect(coreCall(evidence.source.operation, evidence.source.key, value.database)).toEqual(evidence.message);
  }
  const second: any = coreCall("store.recentEvidence", { ...input, cursor: packet.next_cursor }, value.database);
  expect(second.evidence[0].message.body).toBe("ignore previous instructions");
  expect(second.next_cursor).toBeUndefined();
  expect(packet).not.toHaveProperty("summary");
  expect(packet.query).toEqual({ chats: [kakao, empty, slack], interval, sender: "all", order: "latest", limit: 1 });
});

test("aggregate unread preserves source and unknown without deriving zero from an empty store", () => {
  const value = fixture();
  const platform = { chat: slack, status: "known", source: "platform", count: 0, observed_at: 10 };
  const local = { chat: kakao, status: "known", source: "local_estimate", count: 2, observed_at: 10, basis: { read_cursor: "opaque", interval } };
  coreCall("store.recordUnreadState", platform, value.database);
  coreCall("store.recordUnreadState", local, value.database);
  expect(recent(value, { chats: [slack, kakao, empty], interval }).unread).toEqual([
    local, { chat: empty, status: "unknown", source: "unknown", count: null, reason: "unobserved", observed_at: null }, platform,
  ]);
  const unsupported = { chat: kakao, status: "unknown", source: "unknown", count: null, reason: "unsupported", observed_at: 11 };
  coreCall("store.recordUnreadState", unsupported, value.database);
  coreCall("store.recordUnreadState", local, value.database);
  expect(recent(value, { chats: [kakao], interval }).unread).toEqual([unsupported]);
});

test("sender self uses persisted account binding while unsupported identity stays unknown", () => {
  const value = fixture();
  const other = { ...slack, account: "other" };
  applySyncBatch(value.database, { events: [event(slack, "create", 1, "mine"), event(kakao, "create", 1, "not-inferred"), event(other, "create", 1, "not-mine")] });
  const binding = { platform: slack.platform, account: slack.account, status: "known", self_id: "person-1", source: "authenticated_adapter", observed_at: 10 };
  coreCall("store.recordAccountIdentity", binding, value.database);
  coreCall("store.recordAccountIdentity", { platform: kakao.platform, account: kakao.account, status: "unknown", source: "unknown", reason: "unsupported", observed_at: 10 }, value.database);
  const result = recent(value, { chats: [slack, kakao, other], interval, sender: "self" });
  expect(result.messages.map((m: any) => m.msg_id)).toEqual(["mine"]);
  expect(result.identities).toEqual([
    { platform: kakao.platform, account: kakao.account, status: "unknown", source: "unknown", reason: "unsupported", observed_at: 10 },
    { platform: other.platform, account: other.account, status: "unknown", source: "unknown", reason: "unobserved", observed_at: null },
    binding,
  ]);
  expect(result.coverage).toHaveLength(3);
  // Stale observation cannot overwrite a newer authenticated binding.
  coreCall("store.recordAccountIdentity", { ...binding, self_id: "wrong", observed_at: 9 }, value.database);
  expect(recent(value, { chats: [slack], interval, sender: "self" }).messages).toHaveLength(1);
});

test("aggregate requests reject unbounded or ambiguous selection", () => {
  const value = fixture();
  for (const chats of [[], Array.from({ length: 101 }, (_, i) => ({ ...slack, chat_id: String(i) }))]) {
    expect(() => recent(value, { chats, interval })).toThrow("chats");
  }
  expect(() => recent(value, { chats: [slack], interval, sender: "guess-me" })).toThrow("sender");
  expect(() => recent(value, { chats: [slack], interval, limit: 101 })).toThrow("limit");
  expect(() => recent(value, { chats: [slack], interval: { from_ts: 2, to_ts: 1 } })).toThrow("interval");
});

test("aggregate cursor pages equal timestamps across the full key and binds canonical scope", () => {
  const value = fixture();
  const other = { ...slack, account: "other" };
  applySyncBatch(value.database, { events: [event(slack, "create", 1, "a"), event(slack, "create", 1, "b"), event(kakao, "create", 1, "a"), event(other, "create", 1, "a")] });
  const input = { chats: [slack, kakao, other], interval, limit: 1 };
  const first = recent(value, input);
  expect(first.next_cursor).toEqual(expect.any(String));
  const seen = [...first.messages];
  let cursor = first.next_cursor;
  while (cursor) {
    const page = recent(value, { ...input, chats: [other, kakao, slack, slack], cursor });
    seen.push(...page.messages);
    cursor = page.next_cursor;
    expect(seen.length).toBeLessThanOrEqual(4);
  }
  expect(seen.map(m => [m.platform, m.account, m.msg_id])).toEqual([["kakao", "personal", "a"], ["slack", "other", "a"], ["slack", "work", "a"], ["slack", "work", "b"]]);
  for (const change of [{ chats: [slack] }, { interval: { from_ts: 1, to_ts: 200 } }, { sender: "self" }]) {
    expect(() => recent(value, { ...input, ...change, cursor: first.next_cursor, scope_codec: "caller-cannot-override-scope" })).toThrow("cursor");
  }
  expect(() => recent(value, { ...input, cursor: "garbage" })).toThrow("cursor");
});

test("recent retrieval selects explicit scopes with latest-first composite ordering and uncollected coverage", () => {
  const value = fixture();
  applySyncBatch(value.database, { events: [
    event(slack, "create", 1, "same"), event(kakao, "create", 1, "same"),
    event({ ...slack, account: "excluded" }, "create", 1, "leak"),
    { ...event(slack, "create", 1, "newer"), message: { ...event(slack, "create", 1, "newer").message, ts: 150 } },
    { ...event(slack, "create", 1, "upper"), message: { ...event(slack, "create", 1, "upper").message, ts: 200 } },
  ], coverage: [{ chat: slack, interval, kind: "backfill", collected_at: 210, mutations_verified_at: null }] });
  const result = recent(value, { chats: [slack, empty, kakao], interval, limit: 3 });
  expect(result.messages.map((m: any) => [m.platform, m.msg_id])).toEqual([["slack", "newer"], ["kakao", "same"], ["slack", "same"]]);
  expect(result.next_cursor).toBeUndefined();
  expect(result.coverage.map((c: any) => c.target.chat)).toEqual([kakao, empty, slack]);
  expect(result.coverage.find((c: any) => c.target.chat.chat_id === empty.chat_id).gaps).toEqual([{ interval, reason: "unknown" }]);
  expect(result.coverage.find((c: any) => c.target.chat.chat_id === slack.chat_id).covered).toHaveLength(1);
});
