import { describe, expect, test } from "bun:test";

import {
  createKakaoMessageWorkerFromEnvironment,
  runKakaoMessageWorkerEntrypoint,
  type KakaoEntrypointEnvironment,
} from "../src/bin.ts";

const encoder = new TextEncoder();

const environment: KakaoEntrypointEnvironment = {
  INBOXD_KAKAO_BINDING_ID: "kakao-official",
  INBOXD_KAKAO_ACCOUNT: "official-app",
  INBOXD_KAKAO_RECIPIENT_UUID_ALLOWLIST: '["friend-uuid"]',
  INBOXD_KAKAO_TEMPLATE_ID_ALLOWLIST: '["notice-7"]',
  INBOXD_KAKAO_TALK_MESSAGE_CONSENT: "granted",
  INBOXD_KAKAO_FRIENDS_MESSAGE_PERMISSION: "granted",
  INBOXD_KAKAO_OBSERVED_AT: "1726650003",
  INBOXD_KAKAO_AUTH_OBSERVATION: JSON.stringify({
    source: "kakao_access_token_info",
    state: "authenticated",
    observed_at: 1_726_650_003,
  }),
  INBOXD_KAKAO_AUTH_MAX_AGE_SECONDS: "300",
  INBOXD_KAKAO_ACCESS_TOKEN: "synthetic-access-token",
};
const now = () => 1_726_650_100;

function healthRequest(requestId = "health-1") {
  return {
    v: 1,
    type: "worker_request",
    request_id: requestId,
    generation: 3,
    binding_id: "kakao-official",
    limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 1 },
    operation: { op: "health" },
  } as const;
}

async function* chunks(values: readonly string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield encoder.encode(value);
}

async function* byteChunks(values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

describe("Kakao bounded JSON-lines entrypoint", () => {
  test("parses fragmented raw request lines, handles them serially, and emits one bounded response line each", async () => {
    const worker = createKakaoMessageWorkerFromEnvironment(environment, async () => {
      throw new Error("health must not fetch");
    }, now);
    const first = `${JSON.stringify(healthRequest("health-1"))}\n`;
    const second = `${JSON.stringify(healthRequest("health-2"))}\n`;
    const writes: string[] = [];

    await runKakaoMessageWorkerEntrypoint({
      worker,
      input: chunks([first.slice(0, 17), first.slice(17) + second]),
      write: (line) => { writes.push(line); },
    });

    expect(writes).toHaveLength(2);
    expect(writes.every((line) => line.endsWith("\n") && !line.slice(0, -1).includes("\n"))).toBe(true);
    expect(writes.map((line) => JSON.parse(line).request_id)).toEqual(["health-1", "health-2"]);
    expect(writes.map((line) => JSON.parse(line).result.state)).toEqual(["ready", "ready"]);
  });

  test("rejects oversized, malformed, and unterminated input without invoking the worker", async () => {
    let calls = 0;
    const worker = {
      async handleRequest(): Promise<never> {
        calls += 1;
        throw new Error("must not be invoked");
      },
    };
    const cases = [
      { input: chunks([`${"x".repeat(65)}\n`]), error: /byte|limit|frame/i },
      { input: chunks(["{not-json}\n"]), error: /JSON/i },
      { input: chunks(["{}"]), error: /EOF|terminat|newline/i },
      { input: byteChunks([Uint8Array.of(0xff, 0x0a)]), error: /UTF-8/i },
    ];

    for (const entry of cases) {
      await expect(runKakaoMessageWorkerEntrypoint({
        worker,
        input: entry.input,
        write: () => { throw new Error("must not write"); },
        maxRequestFrameBytes: 64,
      })).rejects.toThrow(entry.error);
    }
    expect(calls).toBe(0);
  });

  test("accepts exact raw-input and newline-inclusive output byte ceilings and rejects one byte over", async () => {
    const worker = createKakaoMessageWorkerFromEnvironment(environment, async () => {
      throw new Error("health must not fetch");
    }, now);
    const baseRequest = healthRequest("boundary-health");
    const rawFrame = JSON.stringify(baseRequest);
    const writes: string[] = [];

    await runKakaoMessageWorkerEntrypoint({
      worker,
      input: chunks([`${rawFrame}\n`]),
      write: (line) => { writes.push(line); },
      maxRequestFrameBytes: encoder.encode(rawFrame).byteLength,
    });
    expect(writes).toHaveLength(1);

    await expect(runKakaoMessageWorkerEntrypoint({
      worker,
      input: chunks([`${rawFrame}\n`]),
      write: () => { throw new Error("must not write"); },
      maxRequestFrameBytes: encoder.encode(rawFrame).byteLength - 1,
    })).rejects.toThrow(/byte|limit|frame/i);

    const expectedResponse = {
      v: 1,
      type: "worker_response",
      request_id: "response-boundary",
      generation: 3,
      operation: "health",
      ok: true,
      result: {
        state: "ready",
        auth: { state: "authenticated", reason: null, observed_at: 1_726_650_003 },
      },
    } as const;
    const outputBytes = encoder.encode(`${JSON.stringify(expectedResponse)}\n`).byteLength;
    const exactOutputRequest = {
      ...healthRequest("response-boundary"),
      limits: { ...healthRequest().limits, max_response_bytes: outputBytes },
    };
    await expect(runKakaoMessageWorkerEntrypoint({
      worker,
      input: chunks([`${JSON.stringify(exactOutputRequest)}\n`]),
      write: () => {},
    })).resolves.toBeUndefined();

    const oneUnderOutputRequest = {
      ...exactOutputRequest,
      limits: { ...exactOutputRequest.limits, max_response_bytes: outputBytes - 1 },
    };
    await expect(runKakaoMessageWorkerEntrypoint({
      worker,
      input: chunks([`${JSON.stringify(oneUnderOutputRequest)}\n`]),
      write: () => { throw new Error("must not write"); },
    })).rejects.toThrow(/terminator|response.*limit/i);
  });

  test("validates bounded environment configuration before constructing a worker", () => {
    expect(() => createKakaoMessageWorkerFromEnvironment({
      ...environment,
      INBOXD_KAKAO_RECIPIENT_UUID_ALLOWLIST: JSON.stringify(
        Array.from({ length: 1_001 }, (_, index) => `friend-${index}`),
      ),
    }, async () => new Response("{}", { status: 200 }), now)).toThrow(/allowlist|1000/i);

    expect(() => createKakaoMessageWorkerFromEnvironment({
      ...environment,
      INBOXD_KAKAO_OBSERVED_AT: "NaN",
    }, async () => new Response("{}", { status: 200 }), now)).toThrow(/observed/i);

    for (const invalidObservation of [
      "{not-json",
      JSON.stringify({ source: "static_consent", state: "authenticated", observed_at: 1_726_650_003 }),
      JSON.stringify({ source: "kakao_access_token_info", state: "granted", observed_at: 1_726_650_003 }),
      JSON.stringify({
        source: "kakao_access_token_info",
        state: "authenticated",
        observed_at: 1_726_650_003,
        token: "must-not-be-accepted",
      }),
    ]) {
      expect(() => createKakaoMessageWorkerFromEnvironment({
        ...environment,
        INBOXD_KAKAO_AUTH_OBSERVATION: invalidObservation,
      }, async () => new Response("{}", { status: 200 }), now)).toThrow(/auth observation/i);
    }

    for (const invalidMaximumAge of ["0", "3601", "1.5", "NaN"]) {
      expect(() => createKakaoMessageWorkerFromEnvironment({
        ...environment,
        INBOXD_KAKAO_AUTH_MAX_AGE_SECONDS: invalidMaximumAge,
      }, async () => new Response("{}", { status: 200 }), now)).toThrow(/auth observation.*age/i);
    }
  });

  test("the executable serves a health frame and exits naturally at clean stdin EOF", async () => {
    const entrypoint = new URL("../src/bin.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, entrypoint], {
      cwd: new URL("../../..", import.meta.url).pathname,
      env: {
        ...process.env,
        ...environment,
        INBOXD_KAKAO_AUTH_OBSERVATION: JSON.stringify({
          source: "kakao_access_token_info",
          state: "authenticated",
          observed_at: Math.floor(Date.now() / 1_000),
        }),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(`${JSON.stringify(healthRequest())}\n`);
    child.stdin.end();

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.endsWith("\n")).toBe(true);
    expect(JSON.parse(stdout)).toMatchObject({
      request_id: "health-1",
      operation: "health",
      ok: true,
      result: { state: "ready" },
    });
  });
});