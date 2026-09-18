import { encodeJsonLine } from "../../../packages/protocol/src/framing.ts";
import {
  PROTOCOL_LIMITS,
  parseWorkerRequestFrame,
  type WorkerResponseV1,
} from "../../../packages/protocol/src/schema.ts";
import { createKakaoFetchTransport, type KakaoFetch } from "./fetch-transport.ts";
import {
  createKakaoMessageWorker,
  type KakaoTrustedAuthObservation,
} from "./worker.ts";

export interface KakaoEntrypointEnvironment {
  readonly INBOXD_KAKAO_BINDING_ID?: string;
  readonly INBOXD_KAKAO_ACCOUNT?: string;
  readonly INBOXD_KAKAO_RECIPIENT_UUID_ALLOWLIST?: string;
  readonly INBOXD_KAKAO_TEMPLATE_ID_ALLOWLIST?: string;
  readonly INBOXD_KAKAO_TALK_MESSAGE_CONSENT?: string;
  readonly INBOXD_KAKAO_FRIENDS_MESSAGE_PERMISSION?: string;
  readonly INBOXD_KAKAO_OBSERVED_AT?: string;
  readonly INBOXD_KAKAO_AUTH_OBSERVATION?: string;
  readonly INBOXD_KAKAO_AUTH_MAX_AGE_SECONDS?: string;
  readonly INBOXD_KAKAO_ACCESS_TOKEN?: string;
  readonly [name: string]: string | undefined;
}

export interface KakaoRequestHandler {
  handleRequest(value: unknown): Promise<WorkerResponseV1>;
}

export interface KakaoEntrypointOptions {
  readonly worker: KakaoRequestHandler;
  readonly input: AsyncIterable<Uint8Array>;
  readonly write: (line: string) => void | Promise<void>;
  readonly maxRequestFrameBytes?: number;
}

const MAX_ENV_LIST_BYTES = 65_536;
const MAX_AUTH_OBSERVATION_BYTES = 4_096;
const MAX_AUTH_OBSERVATION_AGE_SECONDS = 3_600;
const encoder = new TextEncoder();

function requiredEnvironmentValue(
  environment: KakaoEntrypointEnvironment,
  name: keyof KakaoEntrypointEnvironment,
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Kakao worker environment ${String(name)} is required`);
  }
  return value;
}

function parseStringList(
  environment: KakaoEntrypointEnvironment,
  name: "INBOXD_KAKAO_RECIPIENT_UUID_ALLOWLIST" | "INBOXD_KAKAO_TEMPLATE_ID_ALLOWLIST",
): readonly string[] {
  const raw = requiredEnvironmentValue(environment, name);
  if (encoder.encode(raw).byteLength > MAX_ENV_LIST_BYTES) {
    throw new RangeError(`Kakao worker environment ${name} exceeds its byte limit`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError(`Kakao worker environment ${name} must be a JSON string array`);
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`Kakao worker environment ${name} must be a JSON string array`);
  }
  return value;
}

function parseAccessState(
  environment: KakaoEntrypointEnvironment,
  name: "INBOXD_KAKAO_TALK_MESSAGE_CONSENT" | "INBOXD_KAKAO_FRIENDS_MESSAGE_PERMISSION",
): "granted" | "denied" | "unknown" {
  const value = requiredEnvironmentValue(environment, name);
  if (value !== "granted" && value !== "denied" && value !== "unknown") {
    throw new TypeError(`Kakao worker environment ${name} has an invalid access state`);
  }
  return value;
}

function parseObservedAt(environment: KakaoEntrypointEnvironment): number {
  const raw = requiredEnvironmentValue(environment, "INBOXD_KAKAO_OBSERVED_AT");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new TypeError("Kakao observed_at must be a canonical non-negative number");
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new TypeError("Kakao observed_at must be finite");
  return value;
}

function parseTrustedAuthObservation(
  environment: KakaoEntrypointEnvironment,
): KakaoTrustedAuthObservation {
  const raw = requiredEnvironmentValue(environment, "INBOXD_KAKAO_AUTH_OBSERVATION");
  if (encoder.encode(raw).byteLength > MAX_AUTH_OBSERVATION_BYTES) {
    throw new RangeError("Kakao auth observation exceeds its byte limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("Kakao auth observation must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Kakao auth observation must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.length !== 3
    || !keys.every((key) => typeof key === "string" && ["source", "state", "observed_at"].includes(key))
    || record.source !== "kakao_access_token_info"
    || (record.state !== "authenticated" && record.state !== "revoked" && record.state !== "unknown")
    || typeof record.observed_at !== "number"
    || !Number.isFinite(record.observed_at)
    || record.observed_at < 0) {
    throw new TypeError("Kakao auth observation is invalid");
  }
  return {
    source: "kakao_access_token_info",
    state: record.state,
    observed_at: record.observed_at,
  };
}

function parseAuthObservationMaxAgeSeconds(environment: KakaoEntrypointEnvironment): number {
  const raw = requiredEnvironmentValue(environment, "INBOXD_KAKAO_AUTH_MAX_AGE_SECONDS");
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new TypeError("Kakao auth observation maximum age must be a canonical positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_AUTH_OBSERVATION_AGE_SECONDS) {
    throw new RangeError(
      `Kakao auth observation maximum age must be 1 to ${MAX_AUTH_OBSERVATION_AGE_SECONDS} seconds`,
    );
  }
  return value;
}

export function createKakaoMessageWorkerFromEnvironment(
  environment: KakaoEntrypointEnvironment,
  fetchImpl: KakaoFetch = globalThis.fetch,
  now: () => number = () => Date.now() / 1_000,
): KakaoRequestHandler {
  const transport = createKakaoFetchTransport(
    requiredEnvironmentValue(environment, "INBOXD_KAKAO_ACCESS_TOKEN"),
    fetchImpl,
  );
  return createKakaoMessageWorker({
    bindingId: requiredEnvironmentValue(environment, "INBOXD_KAKAO_BINDING_ID"),
    account: requiredEnvironmentValue(environment, "INBOXD_KAKAO_ACCOUNT"),
    recipientUuidAllowlist: parseStringList(environment, "INBOXD_KAKAO_RECIPIENT_UUID_ALLOWLIST"),
    templateIdAllowlist: parseStringList(environment, "INBOXD_KAKAO_TEMPLATE_ID_ALLOWLIST"),
    observation: {
      talk_message_consent: parseAccessState(environment, "INBOXD_KAKAO_TALK_MESSAGE_CONSENT"),
      friends_message_permission: parseAccessState(environment, "INBOXD_KAKAO_FRIENDS_MESSAGE_PERMISSION"),
      observed_at: parseObservedAt(environment),
    },
    trustedAuthObservation: parseTrustedAuthObservation(environment),
    authObservationMaxAgeSeconds: parseAuthObservationMaxAgeSeconds(environment),
    now,
    transport,
  });
}

function appendBounded(
  pending: Uint8Array,
  next: Uint8Array,
  maximumBytes: number,
): Uint8Array {
  if (pending.byteLength + next.byteLength > maximumBytes) {
    throw new RangeError(`Kakao worker request frame exceeds the ${maximumBytes} byte limit`);
  }
  if (pending.byteLength === 0) return next.slice();
  if (next.byteLength === 0) return pending;
  const combined = new Uint8Array(pending.byteLength + next.byteLength);
  combined.set(pending);
  combined.set(next, pending.byteLength);
  return combined;
}

/**
 * Runs a serial JSON-lines worker. Raw bytes are bounded before JSON parsing;
 * serial dispatch keeps the executable queue at one operation.
 */
export async function runKakaoMessageWorkerEntrypoint(options: KakaoEntrypointOptions): Promise<void> {
  const maximumBytes = options.maxRequestFrameBytes ?? PROTOCOL_LIMITS.worker_frame_bytes;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || maximumBytes > PROTOCOL_LIMITS.worker_frame_bytes) {
    throw new RangeError("Kakao worker request frame limit is invalid");
  }
  let pending: Uint8Array = new Uint8Array(0);

  for await (const chunk of options.input) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("Kakao worker stdin must provide byte chunks");
    let segmentStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const frame = appendBounded(pending, chunk.subarray(segmentStart, index), maximumBytes);
      if (frame.byteLength === 0) throw new TypeError("Kakao worker received an empty JSON-lines frame");
      const request = parseWorkerRequestFrame(frame);
      const response = await options.worker.handleRequest(request);
      const responseLine = encodeJsonLine(response, request.limits.max_response_bytes);
      if (encoder.encode(responseLine).byteLength > request.limits.max_response_bytes) {
        throw new RangeError("Kakao worker response including its line terminator exceeds the negotiated byte limit");
      }
      await options.write(responseLine);
      pending = new Uint8Array(0);
      segmentStart = index + 1;
    }
    pending = appendBounded(pending, chunk.subarray(segmentStart), maximumBytes);
  }

  if (pending.byteLength !== 0) {
    throw new TypeError("Kakao worker stdin reached EOF before the JSON-lines frame terminator");
  }
}

async function writeStdout(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(line, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main(): Promise<void> {
  const worker = createKakaoMessageWorkerFromEnvironment(process.env);
  await runKakaoMessageWorkerEntrypoint({
    worker,
    input: process.stdin,
    write: writeStdout,
  });
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    process.stderr.write("Kakao Message worker terminated because a bounded configuration, input, or transport check failed\n");
    process.exitCode = 1;
  }
}