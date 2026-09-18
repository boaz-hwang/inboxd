import { expect, test } from "bun:test";

import {
  parseWorkerResponseFrame,
  PROTOCOL_LIMITS,
  type WorkerRequestV1,
} from "../../../packages/protocol/src/schema.ts";

const chat = {
  v: 1,
  kind: "chat",
  platform: "kakao",
  account: "stable:kakao_account_alpha",
  chat_id: "stable:kakao_chat_alpha",
} as const;

function request(
  operation: WorkerRequestV1["operation"],
  requestId = "process-request-1",
  generation = 9,
): WorkerRequestV1 {
  return {
    v: 1,
    type: "worker_request",
    request_id: requestId,
    generation,
    binding_id: "kakao-local-alpha",
    limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 1 },
    operation,
  };
}

const entrypointPath = new URL("../src/worker-entrypoint.ts", import.meta.url).pathname;
const fixedReaderEntrypointPath = new URL("./fixtures/fixed-reader-launcher.ts", import.meta.url).pathname;
const configEnvironmentName = "INBOXD_KAKAO_LOCAL_READ_CONFIG";
const launcherNow = Math.floor(Date.now() / 1_000);
const measurement = {
  schema_version: "kakao-contrib-read-measurement/v1",
  kind: "kakao-read-field-measurement",
  status: "VALIDATED",
  observation: "observed",
  source: "authorized-live-measurement",
  observed_at: launcherNow,
  send: false,
  supported_read_fields: ["account_id", "chat_id", "message_id", "author_id", "ts", "body", "revision"],
} as const;

function fixedConfig(activeMeasurement: unknown = measurement) {
  return {
    schema_version: "kakao-local-read-worker/v1",
    binding_id: "kakao-local-alpha",
    allowed_chat: chat,
    measurement: activeMeasurement,
    max_measurement_age: 200,
    max_items: 1,
    max_raw_bytes: 65_536,
    reader: {
      kind: "agent-messenger",
      transport_account_id: "private-account",
      transport_chat_id: "private-chat",
      page_size: 1,
    },
  };
}

function runWorker(
  entrypoint: string,
  stdin: Uint8Array,
  config?: unknown,
) {
  return Bun.spawnSync({
    cmd: [process.execPath, entrypoint],
    cwd: new URL("../../..", import.meta.url).pathname,
    env: config === undefined
      ? process.env
      : { ...process.env, [configEnvironmentName]: JSON.stringify(config) },
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function responseLines(stdout: Uint8Array): Uint8Array[] {
  const text = new TextDecoder().decode(stdout);
  if (text.length === 0) return [];
  expect(text.endsWith("\n")).toBe(true);
  return text.slice(0, -1).split("\n").map((line) => new TextEncoder().encode(line));
}

test("direct import.meta.main launcher returns unsupported without loading a reader and continues", () => {
  const envelope = {
    v: 2,
    destination: chat,
    content: { mode: "text", body: "must not be sent" },
  } as const;
  const unsupported = request({ op: "send", envelope, idempotency_key: "a".repeat(64) });
  const health = request({ op: "health" }, "process-request-2", 10);
  const input = new TextEncoder().encode(`${JSON.stringify(unsupported)}\n${JSON.stringify(health)}\n`);
  const child = runWorker(entrypointPath, input, fixedConfig());

  expect(new TextDecoder().decode(child.stderr)).toBe("");
  expect(child.exitCode).toBe(0);
  const lines = responseLines(new Uint8Array(child.stdout));
  expect(lines).toHaveLength(2);
  expect(parseWorkerResponseFrame(lines[0]!, unsupported)).toMatchObject({
    operation: "send",
    ok: false,
    error: { code: "unsupported", retryable: false, may_have_sent: false },
  });
  expect(parseWorkerResponseFrame(lines[1]!, health)).toMatchObject({
    operation: "health",
    ok: true,
    result: { state: "degraded" },
  });
});

test("direct import.meta.main launcher emits missing and stale measurement failures without terminating", () => {
  const read = request({
    op: "read_page",
    chat,
    interval: { from_ts: launcherNow - 10, to_ts: launcherNow + 10 },
    limit: 1,
    cursor: null,
  });
  const health = request({ op: "health" }, "process-request-2", 10);
  const unavailableMeasurements = [
    null,
    { ...measurement, observed_at: launcherNow - 201 },
  ];

  for (const unavailable of unavailableMeasurements) {
    const child = runWorker(
      entrypointPath,
      new TextEncoder().encode(`${JSON.stringify(read)}\n${JSON.stringify(health)}\n`),
      fixedConfig(unavailable),
    );

    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(child.exitCode).toBe(0);
    const lines = responseLines(new Uint8Array(child.stdout));
    expect(lines).toHaveLength(2);
    expect(parseWorkerResponseFrame(lines[0]!, read)).toMatchObject({
      operation: "read_page",
      ok: false,
      error: { code: "measurement_unavailable", retryable: false, may_have_sent: false },
    });
    expect(parseWorkerResponseFrame(lines[1]!, health)).toMatchObject({
      operation: "health",
      ok: true,
      result: { state: "unavailable" },
    });
  }
});

test("fixed reader process returns success, contains reader failure, and handles the next frame", () => {
  const first = request({
    op: "read_page", chat, interval: { from_ts: 10, to_ts: 20 }, limit: 1, cursor: null,
  });
  const second = request({
    op: "read_page", chat, interval: { from_ts: 30, to_ts: 40 }, limit: 1, cursor: null,
  }, "process-request-2", 10);
  const third = request({ op: "health" }, "process-request-3", 11);
  const input = new TextEncoder().encode(
    `${JSON.stringify(first)}\n${JSON.stringify(second)}\n${JSON.stringify(third)}\n`,
  );
  const child = runWorker(fixedReaderEntrypointPath, input);

  expect(new TextDecoder().decode(child.stderr)).toBe("");
  expect(child.exitCode).toBe(0);
  const lines = responseLines(new Uint8Array(child.stdout));
  expect(lines).toHaveLength(3);
  expect(parseWorkerResponseFrame(lines[0]!, first)).toMatchObject({
    operation: "read_page",
    ok: true,
    result: { items: [{ messages: [{ message: { body: "한🙂" } }] }] },
  });
  expect(parseWorkerResponseFrame(lines[1]!, second)).toMatchObject({
    operation: "read_page",
    ok: false,
    error: { code: "reader_unavailable", retryable: true, may_have_sent: false },
  });
  expect(parseWorkerResponseFrame(lines[2]!, third)).toMatchObject({ operation: "health", ok: true });
});

test("fixed reader process emits a bounded failure below the successful response size", () => {
  const operation = {
    op: "read_page",
    chat,
    interval: { from_ts: 10, to_ts: 20 },
    limit: 1,
    cursor: null,
  } as const;
  const unconstrained = request(operation);
  const first = runWorker(
    fixedReaderEntrypointPath,
    new TextEncoder().encode(`${JSON.stringify(unconstrained)}\n`),
  );
  expect(first.exitCode).toBe(0);
  const successBytes = first.stdout.byteLength - 1;
  const bounded = {
    ...unconstrained,
    limits: { ...unconstrained.limits, max_response_bytes: successBytes - 1 },
  };
  const second = runWorker(
    fixedReaderEntrypointPath,
    new TextEncoder().encode(`${JSON.stringify(bounded)}\n`),
  );

  expect(second.exitCode).toBe(0);
  const lines = responseLines(new Uint8Array(second.stdout));
  expect(lines).toHaveLength(1);
  expect(lines[0]!.byteLength).toBeLessThanOrEqual(bounded.limits.max_response_bytes);
  expect(parseWorkerResponseFrame(lines[0]!, bounded)).toMatchObject({
    operation: "read_page",
    ok: false,
    error: { code: "bounds_exceeded", retryable: false, may_have_sent: false },
  });
});

test("direct launcher rejects unknown credential or send configuration before output", () => {
  const marker = "must-not-appear";
  const health = request({ op: "health" });
  const base = fixedConfig();
  const invalidConfigs = [
    { ...base, access_token: marker, send: true },
    { ...base, reader: { ...base.reader, password: marker } },
    { ...base, measurement: { ...measurement, access_token: marker } },
    { ...base, measurement: { ...measurement, send: true } },
  ];

  for (const invalid of invalidConfigs) {
    const child = runWorker(
      entrypointPath,
      new TextEncoder().encode(`${JSON.stringify(health)}\n`),
      invalid,
    );

    expect(child.exitCode).not.toBe(0);
    expect(child.stdout.byteLength).toBe(0);
    const stderr = new TextDecoder().decode(child.stderr);
    expect(stderr).not.toContain(marker);
    expect(stderr).toBe("Kakao local read worker terminated: invalid configuration or worker failure\n");
  }
});

test("direct launcher rejects unterminated, invalid UTF-8, and oversized request frames before output", () => {
  const health = request({ op: "health" });
  const compact = new TextEncoder().encode(JSON.stringify(health));
  const carriageReturn = new TextEncoder().encode(`${JSON.stringify(health)}\r\n`);
  const invalidUtf8 = new Uint8Array([0xff, 0x0a]);
  const oversized = new Uint8Array(PROTOCOL_LIMITS.worker_frame_bytes + 2);
  oversized.fill(0x20, 0, oversized.byteLength - compact.byteLength - 1);
  oversized.set(compact, oversized.byteLength - compact.byteLength - 1);
  oversized[oversized.byteLength - 1] = 0x0a;

  for (const input of [compact, carriageReturn, invalidUtf8, oversized]) {
    const child = runWorker(entrypointPath, input, fixedConfig());
    expect(child.exitCode).not.toBe(0);
    expect(child.stdout.byteLength).toBe(0);
  }
});
