import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { PROTOCOL_LIMITS } from "../../../packages/protocol/src/index.ts";
import { SLACK_WORKER_ENV, runSlackWorkerFrames } from "../src/bin.ts";

const entrypoint = resolve(import.meta.dir, "../src/bin.ts");
const secret = "xoxb-synthetic-entrypoint-secret";
const configuredEnv = {
  [SLACK_WORKER_ENV.token]: secret,
  [SLACK_WORKER_ENV.bindingId]: "slack-work",
  [SLACK_WORKER_ENV.account]: "work",
  [SLACK_WORKER_ENV.teamId]: "T123",
  [SLACK_WORKER_ENV.allowedChatIdsJson]: '["C123"]',
};

const request = {
  v: 1,
  type: "worker_request",
  request_id: "process-health-1",
  generation: 3,
  binding_id: "wrong-binding",
  limits: { timeout_ms: 1_000, max_response_bytes: 65_536, max_queue_depth: 1 },
  operation: { op: "health" },
};

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runEntrypoint(
  input: string | Uint8Array,
  envOverrides: Record<string, string | undefined> = configuredEnv,
): Promise<ProcessResult> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of Object.values(SLACK_WORKER_ENV)) delete env[name];
  Object.assign(env, envOverrides);
  const child = Bun.spawn({
    cmd: [process.execPath, entrypoint],
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(input);
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("Slack JSON-lines worker entrypoint", () => {
  test("processes complete raw frames sequentially, emits one validated line each, and exits at EOF", async () => {
    const input = `${JSON.stringify(request)}\n${JSON.stringify({ ...request, request_id: "process-health-2" })}\n`;
    const result = await runEntrypoint(input);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines).toEqual([
      expect.objectContaining({ request_id: "process-health-1", generation: 3, operation: "health", ok: false,
        error: expect.objectContaining({ code: "binding_mismatch", retryable: false, may_have_sent: false }) }),
      expect.objectContaining({ request_id: "process-health-2", generation: 3, operation: "health", ok: false,
        error: expect.objectContaining({ code: "binding_mismatch", retryable: false, may_have_sent: false }) }),
    ]);
    expect(result.stdout).not.toContain(secret);
  });

  test("fails closed on malformed, unterminated, and oversized raw input without echoing bytes or secrets", async () => {
    const malformed = await runEntrypoint('{"private":"raw-secret"}\n');
    expect(malformed.code).not.toBe(0);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toBe("Slack worker terminated: invalid request frame\n");
    expect(malformed.stderr).not.toContain("raw-secret");
    expect(malformed.stderr).not.toContain(secret);

    const partial = await runEntrypoint(JSON.stringify(request));
    expect(partial.code).not.toBe(0);
    expect(partial.stdout).toBe("");
    expect(partial.stderr).toBe("Slack worker terminated: incomplete request frame\n");

    const malformedUtf8 = await runEntrypoint(new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]));
    expect(malformedUtf8.code).not.toBe(0);
    expect(malformedUtf8.stdout).toBe("");
    expect(malformedUtf8.stderr).toBe("Slack worker terminated: invalid request frame\n");
    expect(malformedUtf8.stderr).not.toContain(secret);

    const oversized = new Uint8Array(PROTOCOL_LIMITS.worker_frame_bytes + 2).fill(0x20);
    oversized[oversized.length - 1] = 0x0a;
    const overflow = await runEntrypoint(oversized);
    expect(overflow.code).not.toBe(0);
    expect(overflow.stdout).toBe("");
    expect(overflow.stderr).toBe("Slack worker terminated: invalid request frame\n");
    expect(overflow.stderr).not.toContain(secret);
  }, 20_000);

  test("rejects a fragmented oversized frame before allocating pending plus the next chunk", async () => {
    const NativeUint8Array = globalThis.Uint8Array;
    const first = new NativeUint8Array(PROTOCOL_LIMITS.worker_frame_bytes).fill(0x20);
    const second = new NativeUint8Array([0x20, 0x0a]);
    const input = {
      async *[Symbol.asyncIterator]() {
        yield first;
        yield second;
      },
    } as unknown as ReadableStream<Uint8Array>;
    const attemptedAllocations: number[] = [];
    const globals = globalThis as typeof globalThis & { Uint8Array: Uint8ArrayConstructor };
    globals.Uint8Array = new Proxy(NativeUint8Array, {
      construct(target, argumentsList, newTarget) {
        const requested = argumentsList[0];
        if (typeof requested === "number") {
          attemptedAllocations.push(requested);
          if (requested > PROTOCOL_LIMITS.worker_frame_bytes) throw new Error("oversized allocation attempted");
        }
        return Reflect.construct(target, argumentsList, newTarget) as Uint8Array;
      },
    });
    try {
      await expect(runSlackWorkerFrames(
        { async handle() { throw new Error("oversized frame reached worker"); } },
        input,
        async () => {},
      )).rejects.toThrow("invalid request frame");
    } finally {
      globals.Uint8Array = NativeUint8Array;
    }
    expect(attemptedAllocations.every((size) => size <= PROTOCOL_LIMITS.worker_frame_bytes)).toBe(true);
  }, 20_000);

  test("emits no partial response when the negotiated output bound is too small", async () => {
    const bounded = { ...request, limits: { ...request.limits, max_response_bytes: 1 } };
    const result = await runEntrypoint(`${JSON.stringify(bounded)}\n`);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Slack worker terminated: response bound exceeded\n");
    expect(result.stderr).not.toContain(secret);
  });

  test("rejects missing or malformed fixed configuration without logging the token", async () => {
    const result = await runEntrypoint(`${JSON.stringify(request)}\n`, {
      ...configuredEnv,
      [SLACK_WORKER_ENV.allowedChatIdsJson]: "not-json",
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Slack worker terminated: invalid configuration\n");
    expect(result.stderr).not.toContain(secret);
  });
});
