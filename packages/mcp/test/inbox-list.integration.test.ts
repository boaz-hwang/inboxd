import { afterEach, describe, expect, test } from "bun:test";

import { connectUdsTransport } from "../../cli/src/transport.ts";
import {
  RustDaemonHarness,
  type RustDaemonSeed,
} from "../../../test/helpers/rust-daemon-harness.ts";

import { createAgentProtocolRequester, createToolHandlers } from "../src/index.ts";

const harnesses: RustDaemonHarness[] = [];
const requesters: { stop(): void }[] = [];
const describeWithRustDaemon = process.env.INBOXD_DAEMON_BIN ? describe : describe.skip;

const chat = { platform: "test", account: "agent", chat_id: "room" } as const;
const empty = { ...chat, chat_id: "uncollected" } as const;
const interval = { from_ts: 0, to_ts: 100 } as const;

function seed(messages: readonly Record<string, unknown>[]): RustDaemonSeed {
  return {
    identity: {
      platform: chat.platform,
      account: chat.account,
      status: "known",
      self_id: "self",
      source: "authenticated_adapter",
      observed_at: 100,
    },
    unread: {
      chat,
      status: "known",
      count: 1,
      source: "platform",
      observed_at: 100,
    },
    batch: {
      events: messages.map((message, index) => ({
        kind: "create",
        message,
        revision: { source: "adapter", value: index + 1 },
      })),
      coverage: [{ chat, interval, kind: "backfill", collected_at: 100, mutations_verified_at: 100 }],
    },
  };
}

function messages(body: (index: number) => string): Record<string, unknown>[] {
  return Array.from({ length: 51 }, (_, index) => ({
    key: { ...chat, msg_id: `m${String(index + 1).padStart(3, "0")}` },
    author_id: index === 0 ? "self" : "author",
    ts: index + 1,
    body: body(index),
    attachments: [],
  }));
}

async function fixture(value: RustDaemonSeed): Promise<RustDaemonHarness> {
  const harness = new RustDaemonHarness();
  harnesses.push(harness);
  harness.assertPrivateFixtureRoot();
  harness.seedFixture(value);
  await harness.start();
  return harness;
}

afterEach(async () => {
  for (const requester of requesters.splice(0)) requester.stop();
  while (harnesses.length > 0) await harnesses.pop()!.dispose();
});

function containsForbiddenField(value: unknown): boolean {
  const forbidden = new Set(["code", "approval_code", "approvalcode", "secret", "password", "token", "access_token", "accesstoken"]);
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => forbidden.has(key.toLowerCase()) || containsForbiddenField(nested));
}

function requesterFor(harness: RustDaemonHarness) {
  const requester = createAgentProtocolRequester(() => connectUdsTransport(harness.socketPath));
  requesters.push(requester);
  return requester;
}

async function inspectAudit(harness: RustDaemonHarness, action: string): Promise<Array<{ subject: string; payload_json: string }>> {
  await harness.stop();
  return harness.queryRows(
    "SELECT subject, payload_json FROM audit WHERE action = ? ORDER BY rowid",
    [action],
  ) as Array<{ subject: string; payload_json: string }>;
}

describeWithRustDaemon("MCP inbox_list release Rust daemon integration", () => {
  test("aggregate tools default to bounded pages and audit agent reads without secrets", async () => {
    const harness = await fixture(seed(messages(() => "synthetic private content")));
    const requester = requesterFor(harness);
    const tools = createToolHandlers(requester);
    for (const [tool, field] of [[tools.inbox_recent, "messages"], [tools.inbox_evidence, "evidence"]] as const) {
      const first = await tool({ chats: [chat, empty], interval });
      expect(first[field] as unknown[]).toHaveLength(50);
      expect(first.next_cursor).toEqual(expect.any(String));
      expect(first.coverage).toMatchObject([
        { target: { chat, interval }, covered: [{ interval, kind: "backfill" }], gaps: [] },
        { target: { chat: empty, interval }, covered: [], gaps: [{ interval, reason: "unknown" }] },
      ]);
      expect(containsForbiddenField(first)).toBeFalse();
      const second = await tool({ chats: [chat, empty], interval, cursor: first.next_cursor });
      expect(second[field] as unknown[]).toHaveLength(1);
      expect(second.next_cursor).toBeUndefined();
      expect(containsForbiddenField(second)).toBeFalse();
    }
    requester.stop();
    requesters.splice(requesters.indexOf(requester), 1);
    await harness.stop();
    for (const action of ["read.recent", "read.evidence"]) {
      const rows = harness.queryRows(
        "SELECT subject, payload_json FROM audit WHERE action = ? ORDER BY rowid",
        [action],
      ) as Array<{ subject: string; payload_json: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => JSON.parse(row.payload_json))).toMatchObject([{ role: "agent", result_count: 50 }, { role: "agent", result_count: 1 }]);
      expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.subject))).toBeTrue();
      expect(JSON.stringify(rows)).not.toContain("synthetic private content");
    }
  });

  test("aggregate cursor query mismatch reaches MCP as a BAD_REQUEST daemon error", async () => {
    const harness = await fixture(seed(messages(() => "content")));
    const tools = createToolHandlers(requesterFor(harness));

    for (const [tool, method] of [[tools.inbox_recent, "message.recent"], [tools.inbox_evidence, "message.evidence"]] as const) {
      const first = await tool({ chats: [chat], interval });
      await expect(tool({ chats: [chat], interval: { from_ts: 1, to_ts: 100 }, cursor: first.next_cursor })).rejects.toMatchObject({
        name: "McpDaemonError",
        code: "BAD_REQUEST",
        method,
      });
    }
  });

  test("lists through an encrypted Rust daemon as agent with coverage, no secrets, and a bounded page", async () => {
    const harness = await fixture(seed(messages((index) => `message ${index + 1}`)));
    const requester = requesterFor(harness);
    const result = await createToolHandlers(requester).inbox_list({ chat, interval });

    expect(result.messages as unknown[]).toHaveLength(50);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(result.coverage).toMatchObject({
      target: { chat, interval },
      covered: [{ interval, kind: "backfill" }],
      gaps: [],
    });
    expect(containsForbiddenField(result)).toBeFalse();

    requester.stop();
    requesters.splice(requesters.indexOf(requester), 1);
    const audit = await inspectAudit(harness, "read.inbox");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.payload_json)).toMatchObject({ role: "agent", result_count: 50 });
    expect(audit[0]!.subject).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(audit)).not.toContain("message 1");
  });
});
