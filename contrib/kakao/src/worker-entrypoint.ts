import {
  parseWorkerRequestFrame,
  PROTOCOL_LIMITS,
  type WorkerRequestV1,
} from "../../../packages/protocol/src/schema.ts";
import {
  createKakaoLocalReadWorker,
  type KakaoLocalReadWorker,
  type KakaoLocalReadWorkerOptions,
} from "./worker-core.ts";
import {
  createAgentMessengerKakaoReader,
  type AgentMessengerKakaoClient,
} from "./agent-messenger-reader.ts";

export interface KakaoLocalReadWorkerProcessIo {
  readonly input: AsyncIterable<Uint8Array>;
  readonly write: (bytes: Uint8Array) => Promise<void>;
}

export interface KakaoLocalReadJsonLinesOptions extends KakaoLocalReadWorkerOptions, KakaoLocalReadWorkerProcessIo {}

export const KAKAO_LOCAL_READ_CONFIG_ENV = "INBOXD_KAKAO_LOCAL_READ_CONFIG";

type Environment = Readonly<Record<string, string | undefined>>;

interface KakaoLocalReadFixedConfig {
  readonly schema_version: "kakao-local-read-worker/v1";
  readonly binding_id: string;
  readonly allowed_chat: KakaoLocalReadWorkerOptions["allowed_chat"];
  readonly measurement: unknown;
  readonly max_measurement_age: number;
  readonly max_items: number;
  readonly max_raw_bytes: number;
  readonly reader: {
    readonly kind: "agent-messenger";
    readonly transport_account_id: string;
    readonly transport_chat_id: string;
    readonly page_size: number;
  };
}

const CONFIG_MAX_BYTES = 1_048_576;
const RAW_PAGE_MAX_BYTES = 16_777_216;
const AGENT_MESSENGER_KAKAO_MODULE = "agent-messenger/kakaotalk";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && new TextEncoder().encode(value).byteLength <= maximum;
}

function positiveIntegerAtMost(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function validMeasurementConfig(value: unknown): boolean {
  if (value === null) return true;
  const measurement = record(value);
  return measurement !== null
    && hasExactKeys(measurement, [
      "schema_version",
      "kind",
      "status",
      "observation",
      "source",
      "observed_at",
      "send",
      "supported_read_fields",
    ])
    && measurement.send === false;
}

function parseFixedConfig(value: unknown): KakaoLocalReadFixedConfig {
  const config = record(value);
  const allowedChat = record(config?.allowed_chat);
  const reader = record(config?.reader);
  if (
    config === null
    || !hasExactKeys(config, [
      "schema_version",
      "binding_id",
      "allowed_chat",
      "measurement",
      "max_measurement_age",
      "max_items",
      "max_raw_bytes",
      "reader",
    ])
    || config.schema_version !== "kakao-local-read-worker/v1"
    || !boundedString(config.binding_id, 512)
    || allowedChat === null
    || !hasExactKeys(allowedChat, ["v", "kind", "platform", "account", "chat_id"])
    || allowedChat.v !== 1
    || allowedChat.kind !== "chat"
    || allowedChat.platform !== "kakao"
    || typeof allowedChat.account !== "string"
    || !/^stable:[A-Za-z0-9_-]{1,128}$/.test(allowedChat.account)
    || typeof allowedChat.chat_id !== "string"
    || !/^stable:[A-Za-z0-9_-]{1,128}$/.test(allowedChat.chat_id)
    || !validMeasurementConfig(config.measurement)
    || !positiveIntegerAtMost(config.max_measurement_age, Number.MAX_SAFE_INTEGER)
    || !positiveIntegerAtMost(config.max_items, 100)
    || !positiveIntegerAtMost(config.max_raw_bytes, RAW_PAGE_MAX_BYTES)
    || reader === null
    || !hasExactKeys(reader, ["kind", "transport_account_id", "transport_chat_id", "page_size"])
    || reader.kind !== "agent-messenger"
    || !boundedString(reader.transport_account_id, 512)
    || !boundedString(reader.transport_chat_id, 512)
    || !positiveIntegerAtMost(reader.page_size, 100)
  ) {
    throw new TypeError("Kakao local read worker configuration is invalid");
  }
  return {
    schema_version: "kakao-local-read-worker/v1",
    binding_id: config.binding_id,
    allowed_chat: {
      v: 1,
      kind: "chat",
      platform: "kakao",
      account: allowedChat.account,
      chat_id: allowedChat.chat_id,
    },
    measurement: config.measurement,
    max_measurement_age: config.max_measurement_age,
    max_items: config.max_items,
    max_raw_bytes: config.max_raw_bytes,
    reader: {
      kind: "agent-messenger",
      transport_account_id: reader.transport_account_id,
      transport_chat_id: reader.transport_chat_id,
      page_size: reader.page_size,
    },
  };
}

export function loadKakaoLocalReadFixedConfig(environment: Environment): KakaoLocalReadFixedConfig {
  const raw = environment[KAKAO_LOCAL_READ_CONFIG_ENV];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("Kakao local read worker configuration is required");
  }
  if (new TextEncoder().encode(raw).byteLength > CONFIG_MAX_BYTES) {
    throw new RangeError("Kakao local read worker configuration exceeds its byte limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TypeError("Kakao local read worker configuration must be valid JSON");
  }
  return parseFixedConfig(value);
}

async function createDefaultAgentMessengerClient(transportAccountId: string): Promise<AgentMessengerKakaoClient> {
  const imported: unknown = await import(AGENT_MESSENGER_KAKAO_MODULE);
  const module = record(imported);
  const Constructor = module?.KakaoTalkClient;
  if (typeof Constructor !== "function") throw new TypeError("Agent Messenger KakaoTalk client is unavailable");
  const client = new (Constructor as new () => {
    login(credentials?: undefined, accountId?: string): Promise<unknown>;
  })();
  const loggedIn = await client.login(undefined, transportAccountId);
  const candidate = record(loggedIn);
  if (candidate === null || typeof candidate.getMessagePage !== "function" || typeof candidate.close !== "function") {
    throw new TypeError("Agent Messenger KakaoTalk client is invalid");
  }
  return loggedIn as AgentMessengerKakaoClient;
}

export function createKakaoLocalReadOptionsFromEnvironment(
  environment: Environment,
  createClient: (transportAccountId: string) => Promise<AgentMessengerKakaoClient> = createDefaultAgentMessengerClient,
  now: () => number = () => Math.floor(Date.now() / 1_000),
): KakaoLocalReadWorkerOptions {
  const config = loadKakaoLocalReadFixedConfig(environment);
  return {
    binding_id: config.binding_id,
    allowed_chat: config.allowed_chat,
    measurement: config.measurement,
    max_measurement_age: config.max_measurement_age,
    max_items: config.max_items,
    max_raw_bytes: config.max_raw_bytes,
    now,
    reader: createAgentMessengerKakaoReader({
      bindings: [{
        account: config.allowed_chat.account,
        chat_id: config.allowed_chat.chat_id,
        transport_account_id: config.reader.transport_account_id,
        transport_chat_id: config.reader.transport_chat_id,
      }],
      page_size: config.reader.page_size,
      createClient,
    }),
  };
}

function appendChunk(chunks: Uint8Array[], chunk: Uint8Array, currentLength: number): number {
  const nextLength = currentLength + chunk.byteLength;
  if (nextLength > PROTOCOL_LIMITS.worker_frame_bytes) {
    throw new RangeError(`worker request frame exceeds the ${PROTOCOL_LIMITS.worker_frame_bytes} byte frame limit`);
  }
  if (chunk.byteLength > 0) chunks.push(chunk.slice());
  return nextLength;
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const frame = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    frame.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return frame;
}

async function* requestFrames(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let frameLength = 0;
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("worker request stream must contain bytes");
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      frameLength = appendChunk(chunks, chunk.subarray(start, index), frameLength);
      if (frameLength === 0) throw new TypeError("worker request stream must not contain empty frames");
      yield concatenate(chunks, frameLength);
      chunks = [];
      frameLength = 0;
      start = index + 1;
    }
    frameLength = appendChunk(chunks, chunk.subarray(start), frameLength);
  }
  if (frameLength !== 0) {
    throw new TypeError("worker request stream ended before its JSON-line terminator");
  }
}

function encodeResponseLine(response: unknown, request: WorkerRequestV1): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(response));
  if (encoded.byteLength > request.limits.max_response_bytes) {
    throw new RangeError("worker response frame exceeds its negotiated encoded UTF-8 byte limit");
  }
  const line = new Uint8Array(encoded.byteLength + 1);
  line.set(encoded);
  line[line.byteLength - 1] = 0x0a;
  return line;
}

export async function handleKakaoLocalReadWorkerFrame(
  worker: KakaoLocalReadWorker,
  frame: Uint8Array,
): Promise<Uint8Array> {
  const request = parseWorkerRequestFrame(frame);
  const response = await worker.handle(request);
  return encodeResponseLine(response, request);
}

/** Runs bounded JSON-lines exchanges over an injected measured reader. */
export async function runKakaoLocalReadJsonLinesWorker(options: KakaoLocalReadJsonLinesOptions): Promise<void> {
  const worker = createKakaoLocalReadWorker(options);
  for await (const frame of requestFrames(options.input)) {
    await options.write(await handleKakaoLocalReadWorkerFrame(worker, frame));
  }
}

async function writeStdout(bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await Bun.stdout.write(bytes.subarray(offset));
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error("Kakao local worker stdout did not accept the response frame");
    }
    offset += written;
  }
}

function defaultIo(): KakaoLocalReadWorkerProcessIo {
  return {
    input: Bun.stdin.stream() as AsyncIterable<Uint8Array>,
    write: writeStdout,
  };
}

/** Runs the JSON-lines worker on Bun stdin/stdout. */
export async function runKakaoLocalReadWorker(
  options: KakaoLocalReadWorkerOptions,
  io: KakaoLocalReadWorkerProcessIo = defaultIo(),
): Promise<void> {
  await runKakaoLocalReadJsonLinesWorker({ ...options, ...io });
}

export async function main(environment: Environment = process.env): Promise<void> {
  await runKakaoLocalReadWorker(createKakaoLocalReadOptionsFromEnvironment(environment));
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    process.stderr.write("Kakao local read worker terminated: invalid configuration or worker failure\n");
    process.exitCode = 1;
  }
}
