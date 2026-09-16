import { afterEach, describe, expect, test } from "bun:test";

import { connectUdsTransport } from "../../cli/src/transport.ts";
import { createDaemon } from "../../daemon/src/main.ts";
import { createDaemonFixture } from "../../daemon/test/fixtures/daemon-fixture.ts";
import { openSqlCipherDatabase } from "../../store/src/sqlcipher.ts";

import { createAgentProtocolRequester, createToolHandlers } from "../src/index.ts";

const fixtures: ReturnType<typeof createDaemonFixture>[] = [];
const daemons: { stop(): Promise<void> }[] = [];
const requesters: { stop(): void }[] = [];

afterEach(async () => {
  for (const requester of requesters.splice(0)) requester.stop();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function fixture() {
  const state = createDaemonFixture();
  fixtures.push(state);
  return state;
}

function containsForbiddenField(value: unknown): boolean {
  const forbidden = new Set(["code", "approval_code", "approvalcode", "secret", "password", "token", "access_token", "accesstoken"]);
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => forbidden.has(key.toLowerCase()) || containsForbiddenField(nested));
}

describe("MCP inbox_list daemon integration", () => {
  test("lists through an encrypted daemon as agent with coverage, no secrets, and a bounded page", async () => {
    const state = fixture();
    const daemon = await createDaemon({
      socketPath: state.socketPath,
      databasePath: state.databasePath,
      keyProvider: state.keyProvider,
    });
    daemons.push(daemon);
    const chat = { platform: "test", account: "agent", chat_id: "room" };
    const interval = { from_ts: 0, to_ts: 100 };
    daemon.apply({
      events: Array.from({ length: 51 }, (_, index) => ({
        kind: "create" as const,
        message: {
          key: { ...chat, msg_id: `m${String(index + 1).padStart(3, "0")}` },
          author_id: "author",
          ts: index + 1,
          body: `message ${index + 1}`,
          attachments: [],
        },
        revision: { source: "adapter", value: index + 1 },
      })),
      coverage: [{ chat, interval, kind: "backfill", collected_at: 100, mutations_verified_at: 100 }],
    });

    const requester = createAgentProtocolRequester(() => connectUdsTransport(state.socketPath));
    requesters.push(requester);
    const result = await createToolHandlers(requester).inbox_list({ chat, interval });

    expect((result.messages as unknown[])).toHaveLength(50);
    expect(result.next_cursor).toEqual(expect.any(String));
    expect(result.coverage).toMatchObject({
      target: { chat, interval },
      covered: [{ interval, kind: "backfill" }],
      gaps: [],
    });
    expect(containsForbiddenField(result)).toBeFalse();

    requester.stop();
    requesters.splice(requesters.indexOf(requester), 1);
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
    const database = openSqlCipherDatabase({ filename: state.databasePath, keyProvider: state.keyProvider });
    const audit = database.query("SELECT payload_json FROM audit WHERE action = 'read.inbox'").get() as { payload_json: string };
    database.close();
    expect(JSON.parse(audit.payload_json)).toMatchObject({ role: "agent", result_count: 50 });
  });
});
