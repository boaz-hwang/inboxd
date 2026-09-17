import { expect, test } from "bun:test";
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { cpus, release } from "node:os";

import { connectUdsTransport } from "../../cli/src/transport.ts";
import { createDaemon } from "../../daemon/src/main.ts";
import { createDaemonFixture } from "../../daemon/test/fixtures/daemon-fixture.ts";
import { createAgentProtocolRequester } from "../../mcp/src/index.ts";
import { applySyncBatch, readSyncState } from "../src/apply.ts";
import { migrateDatabase } from "../src/migrations.ts";
import type { SearchMessagesResult } from "../src/queries.ts";
import { openSqlCipherDatabase } from "../src/sqlcipher.ts";

// Deliberate local acceptance, not part of the fast unit-test gate:
// bun run build:native
// INBOXD_RUN_100K_ACCEPTANCE=1 NODE_ENV=test SQLCIPHER_PATH="$(brew --prefix sqlcipher)/lib/libsqlcipher.dylib" bun test packages/store/test/performance-100k.test.ts
// Synthetic corpus, warm real UDS connection/cache, first page of 50; no live providers.
// Ingestion uses production applySyncBatch; query timing excludes ingestion/startup/handshake.
const acceptance = process.env.INBOXD_RUN_100K_ACCEPTANCE === "1" ? test : test.skip;
const ROW_COUNT = 100_000;
const PAGE_SIZE = 50;
const ROUNDS = 20;
const P95_TARGET_MS = 300;
const BATCH_SIZE = 1_000;
const INGEST_BUDGET_MS = 120_000;

interface SearchCorpus {
  messages: { id: string; body: string }[];
  positive_cases: { name: string; query: string; expected_ids: string[] }[];
  negative_cases: { name: string; query: string }[];
}

// Nearest-rank percentiles: no interpolation and no removal of slow samples.
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

acceptance("100k production ingestion + encrypted real UDS search: per-query and aggregate p95 <= 300ms", async () => {
  const corpus: SearchCorpus = JSON.parse(readFileSync(new URL("../../../fixtures/ko-search/acceptance.json", import.meta.url), "utf8"));
  expect(corpus.positive_cases).toHaveLength(25);
  expect(corpus.negative_cases).toHaveLength(8);
  const value = createDaemonFixture();
  const chat = { platform: "test-platform", account: "account-1", chat_id: "chat-1" };
  let database: ReturnType<typeof openSqlCipherDatabase> | undefined;
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  let requester: ReturnType<typeof createAgentProtocolRequester> | undefined;
  try {
    database = openSqlCipherDatabase({ filename: value.databasePath, keyProvider: value.keyProvider });
    migrateDatabase(database);
    const interval = { from_ts: 0, to_ts: ROW_COUNT };
    const coverage = {
      chat, interval, kind: "backfill" as const,
      collected_at: ROW_COUNT + 1, mutations_verified_at: null,
    };
    const messageId = (index: number) => `bench-${index.toString().padStart(6, "0")}`;
    const ingestStart = performance.now();
    const ingestBatches: number[] = [];
    for (let start = 0; start < ROW_COUNT; start += BATCH_SIZE) {
      const batchStart = performance.now();
      const end = Math.min(start + BATCH_SIZE, ROW_COUNT);
      applySyncBatch(database, {
        events: Array.from({ length: end - start }, (_, offset) => {
          const index = start + offset;
          return { kind: "create", revision: { source: "adapter", value: 1 }, message: {
            key: { ...chat, msg_id: messageId(index) }, author_id: "benchmark-person", ts: index,
            body: corpus.messages[index % corpus.messages.length]!.body, attachments: [],
          } };
        }),
        expected_page_sequence: start / BATCH_SIZE,
        sync: { chat, cursor: String(end), updated_at: ROW_COUNT + 1 },
        // Commit coverage with the final page; do not bypass production evidence persistence.
        coverage: end === ROW_COUNT ? [coverage] : [],
      });
      ingestBatches.push(performance.now() - batchStart);
      if (end % 10_000 === 0) console.log(JSON.stringify({ phase: "ingesting", rows: end, elapsed_ms: performance.now() - ingestStart }));
      // A hard inter-batch budget makes reintroduced quadratic work fail rather than hang.
      expect(performance.now() - ingestStart, `production ingestion exceeded ${INGEST_BUDGET_MS}ms at ${end} rows`).toBeLessThanOrEqual(INGEST_BUDGET_MS);
    }
    const ingestMs = performance.now() - ingestStart;
    console.log(JSON.stringify({ benchmark: "encrypted-production-search-100k", phase: "ingested", rows: ROW_COUNT, ingest_ms: ingestMs,
      batch_p50_ms: percentile(ingestBatches, 0.5), batch_p95_ms: percentile(ingestBatches, 0.95) }));
    expect(database.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: ROW_COUNT });
    expect(database.query("SELECT COUNT(*) AS count FROM messages_fts").get()).toEqual({ count: ROW_COUNT });
    expect(readSyncState(database, chat)).toMatchObject({ cursor: String(ROW_COUNT), page_sequence: ROW_COUNT / BATCH_SIZE });
    const cipherVersion = database.query("PRAGMA cipher_version").get();
    const sqliteVersion = database.query("SELECT sqlite_version() AS version").get();
    expect(cipherVersion).toBeTruthy();
    expect(Object.values(cipherVersion as Record<string, unknown>)[0]).toEqual(expect.any(String));
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close();
    database = undefined;
    const descriptor = openSync(value.databasePath, "r");
    try {
      const header = Buffer.alloc(16);
      expect(readSync(descriptor, header, 0, header.length, 0)).toBe(16);
      expect(header.toString("ascii")).not.toBe("SQLite format 3\0");
    } finally {
      closeSync(descriptor);
    }

    // Reopen the persisted encrypted store via the real daemon composition root. The
    // requester uses the production agent handshake, framing and UDS client decoder.
    daemon = await createDaemon({ socketPath: value.socketPath, databasePath: value.databasePath, keyProvider: value.keyProvider });
    requester = createAgentProtocolRequester(() => connectUdsTransport(value.socketPath));

    const workloads = [
      ...corpus.positive_cases,
      ...corpus.negative_cases.map((item) => ({ ...item, expected_ids: [] as string[] })),
      // Missing short queries force LIKE to visit the full 100k-row chat, not stop after 50 hits.
      { name: "absent-one-code-point", query: "힣", expected_ids: [] as string[] },
      { name: "absent-two-code-points", query: "힣힣", expected_ids: [] as string[] },
    ].map((item) => {
      const expected: string[] = [];
      for (let index = 0; index < ROW_COUNT && expected.length < PAGE_SIZE; index++) {
        if (item.expected_ids.includes(corpus.messages[index % corpus.messages.length]!.id)) expected.push(messageId(index));
      }
      return { ...item, expected, samples: [] as number[] };
    });
    const run = async (workload: typeof workloads[number], measured: boolean) => {
      const start = performance.now();
      const result = await requester!.request("message.search", { chat, interval, query: workload.query, limit: PAGE_SIZE }) as unknown as SearchMessagesResult;
      // Stops only after the daemon response is framed, transported and materialized
      // by the actual client, including the daemon's durable read audit.
      const elapsed = performance.now() - start;
      if (measured) workload.samples.push(elapsed);
      expect(result.messages.map((message) => message.msg_id)).toEqual(workload.expected);
      expect(result.coverage).toEqual({
        target: { chat, interval }, covered: [coverage], gaps: [], limits: [],
        freshness: [{ interval, collected_at: coverage.collected_at, mutations_verified_at: null }],
      });
      if (workload.expected.length === PAGE_SIZE) expect(result.next_cursor).toEqual(expect.any(String));
      else expect(result.next_cursor).toBeUndefined();

    };
    // Fail fast after a complete distribution for the first violating query, rather than
    // spending hours on later queries when the production query plan already misses the gate.
    for (const workload of workloads) {
      console.log(JSON.stringify({ phase: "measuring", query: workload.query, name: workload.name }));
      await run(workload, false);
      for (let round = 0; round < ROUNDS; round++) await run(workload, true);
      const distribution = {
        phase: "query-result", name: workload.name, query: workload.query, samples: workload.samples.length,
        p50_ms: percentile(workload.samples, 0.5), p95_ms: percentile(workload.samples, 0.95),
        max_ms: Math.max(...workload.samples), target_p95_ms: P95_TARGET_MS,
      };
      console.log(JSON.stringify(distribution));
      expect(distribution.p95_ms, `p95 for ${workload.name}; remaining queries not measured if this gate fails`).toBeLessThanOrEqual(P95_TARGET_MS);
    }
    const samples = workloads.flatMap((workload) => workload.samples);
    const perQuery = workloads.map((workload) => ({
      name: workload.name, query: workload.query, samples: workload.samples.length,
      p50_ms: percentile(workload.samples, 0.5), p95_ms: percentile(workload.samples, 0.95),
      max_ms: Math.max(...workload.samples),
    }));
    const report = {
      benchmark: "encrypted-production-search-100k", corpus: "anonymous-synthetic-ko-mixed",
      runtime: Bun.version, platform: process.platform, arch: process.arch, os_release: release(), cpu: cpus()[0]?.model,
      cipher_version: cipherVersion, sqlite_version: sqliteVersion,
      rows: ROW_COUNT, page_size: PAGE_SIZE, ingest_ms: ingestMs,
      ingestion: { path: "applySyncBatch", batch_size: BATCH_SIZE, batches: ingestBatches.length, budget_ms: INGEST_BUDGET_MS,
        batch_p50_ms: percentile(ingestBatches, 0.5), batch_p95_ms: percentile(ingestBatches, 0.95) },
      warmup_per_query: 1, rounds: ROUNDS, samples: samples.length, target_p95_ms: P95_TARGET_MS,
      timing: "real daemon UDS message.search round trip; warm connection/cache; includes framing, SQLCipher, audit and client materialization; ingestion, startup, warmup and assertions excluded",
      topology: "in-process daemon and client connected through a real Unix-domain socket; no live providers",
      p50_ms: percentile(samples, 0.5), p95_ms: percentile(samples, 0.95), per_query: perQuery,
    };
    // Emit before asserting so a failed performance gate retains its diagnostic evidence.
    console.log(JSON.stringify(report, null, 2));
    expect(samples).toHaveLength(workloads.length * ROUNDS);
    expect(report.p95_ms).toBeLessThanOrEqual(P95_TARGET_MS);
    for (const result of perQuery) {
      expect(result.samples).toBe(ROUNDS);
      expect(result.p95_ms, `p95 for ${result.name}`).toBeLessThanOrEqual(P95_TARGET_MS);
    }
    requester.stop();
    requester = undefined;
    await daemon.stop();
    daemon = undefined;
    database = openSqlCipherDatabase({ filename: value.databasePath, keyProvider: value.keyProvider });
    const audits = database.query("SELECT payload_json FROM audit WHERE action = 'read.search'").all() as { payload_json: string }[];
    expect(audits).toHaveLength(workloads.length * (ROUNDS + 1));
    expect(audits.every(row => JSON.parse(row.payload_json).role === "agent")).toBeTrue();
  } finally {
    requester?.stop();
    await daemon?.stop();
    database?.close();
    value.dispose();
  }
}, 600_000);
