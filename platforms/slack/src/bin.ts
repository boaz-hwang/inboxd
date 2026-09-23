import {
  PROTOCOL_LIMITS,
  ProtocolSchemaError,
  encodeJsonLine,
  parseWorkerRequestFrame,
  parseWorkerResponse,
  type WorkerRequestV1,
} from "../../../packages/protocol/src/index.ts";
import { createRecoveringSlackTransport } from "./recovering-transport.ts";
import { createSlackWorker, type SlackWorker } from "./worker.ts";

export const SLACK_WORKER_ENV = Object.freeze({
  token: "INBOXD_SLACK_BOT_TOKEN",
  bindingId: "INBOXD_SLACK_BINDING_ID",
  account: "INBOXD_SLACK_ACCOUNT",
  teamId: "INBOXD_SLACK_TEAM_ID",
  allowedChatIdsJson: "INBOXD_SLACK_ALLOWED_CHAT_IDS_JSON",
} as const);

interface SlackWorkerConfig {
  readonly token: string;
  readonly cookie?: string;
  readonly bindingId: string;
  readonly account: string;
  readonly teamId: string;
  readonly allowedChatIds: readonly string[];
}

type Environment = Readonly<Record<string, string | undefined>>;
type TerminationReason = "invalid request frame" | "incomplete request frame" | "response bound exceeded" | "worker failure";

class SlackWorkerProcessError extends Error {
  constructor(readonly reason: TerminationReason) {
    super(reason);
  }
}

function requiredEnvironment(env: Environment, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new TypeError("missing Slack worker configuration");
  return value;
}

export function loadSlackWorkerConfig(env: Environment): SlackWorkerConfig {
  const token = requiredEnvironment(env, SLACK_WORKER_ENV.token);
  const bindingId = requiredEnvironment(env, SLACK_WORKER_ENV.bindingId);
  const account = requiredEnvironment(env, SLACK_WORKER_ENV.account);
  const teamId = requiredEnvironment(env, SLACK_WORKER_ENV.teamId);
  let allowedChatIds: unknown;
  try {
    allowedChatIds = JSON.parse(requiredEnvironment(env, SLACK_WORKER_ENV.allowedChatIdsJson));
  } catch {
    throw new TypeError("invalid Slack worker configuration");
  }
  if (!Array.isArray(allowedChatIds) || allowedChatIds.some((value) => typeof value !== "string")) {
    throw new TypeError("invalid Slack worker configuration");
  }
  return { token, bindingId, account, teamId, allowedChatIds, cookie: env.INBOXD_SLACK_SESSION_COOKIE };
}

function responseBoundFailure(error: unknown): boolean {
  return error instanceof ProtocolSchemaError && /worker response frame.*exceeds/i.test(error.message);
}

async function processFrame(worker: SlackWorker, rawFrame: Uint8Array, write: (line: string) => Promise<void>): Promise<void> {
  let request: WorkerRequestV1;
  try {
    request = parseWorkerRequestFrame(rawFrame);
  } catch {
    throw new SlackWorkerProcessError("invalid request frame");
  }

  let response;
  try {
    response = await worker.handle(request);
    response = parseWorkerResponse(response, request);
  } catch (error) {
    throw new SlackWorkerProcessError(responseBoundFailure(error) ? "response bound exceeded" : "worker failure");
  }

  let line: string;
  try {
    line = encodeJsonLine(response, request.limits.max_response_bytes);
  } catch {
    throw new SlackWorkerProcessError("response bound exceeded");
  }
  try {
    await write(line);
  } catch {
    throw new SlackWorkerProcessError("worker failure");
  }
}

export async function runSlackWorkerFrames(
  worker: SlackWorker,
  input: ReadableStream<Uint8Array>,
  write: (line: string) => Promise<void>,
): Promise<void> {
  const maximum = PROTOCOL_LIMITS.worker_frame_bytes;
  let pending = new Uint8Array(0);
  let pendingLength = 0;

  const append = (part: Uint8Array): void => {
    if (part.byteLength > maximum - pendingLength) {
      throw new SlackWorkerProcessError("invalid request frame");
    }
    const required = pendingLength + part.byteLength;
    if (required > pending.byteLength) {
      const doubled = pending.byteLength === 0 ? Math.min(4_096, maximum) : pending.byteLength * 2;
      const capacity = Math.min(maximum, Math.max(required, doubled));
      const grown = new Uint8Array(capacity);
      grown.set(pending.subarray(0, pendingLength));
      pending = grown;
    }
    pending.set(part, pendingLength);
    pendingLength = required;
  };

  for await (const chunk of input) {
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      append(chunk.subarray(start, index));
      let end = pendingLength;
      if (end > 0 && pending[end - 1] === 0x0d) end -= 1;
      if (end === 0) throw new SlackWorkerProcessError("invalid request frame");
      await processFrame(worker, pending.subarray(0, end), write);
      pendingLength = 0;
      start = index + 1;
    }
    append(chunk.subarray(start));
  }
  if (pendingLength !== 0) throw new SlackWorkerProcessError("incomplete request frame");
}

async function writeStandardOutput(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(line, (error) => error ? reject(error) : resolve());
  });
}

function terminate(message: string, code: number): number {
  process.stderr.write(`Slack worker terminated: ${message}\n`);
  return code;
}

export async function main(env: Environment = process.env): Promise<number> {
  let config: SlackWorkerConfig;
  try {
    config = loadSlackWorkerConfig(env);
    if (env === process.env) { delete process.env[SLACK_WORKER_ENV.token]; delete process.env.INBOXD_SLACK_SESSION_COOKIE; }
  } catch {
    return terminate("invalid configuration", 64);
  }

  let worker: SlackWorker;
  try {
    worker = createSlackWorker({
      bindingId: config.bindingId,
      account: config.account,
      expectedTeamId: config.teamId,
      allowedChatIds: config.allowedChatIds,
      transport: createRecoveringSlackTransport({ bot_token: config.token, session_cookie: config.cookie, team_id: config.teamId }),
    });
  } catch {
    return terminate("invalid configuration", 64);
  }

  try {
    await runSlackWorkerFrames(worker, Bun.stdin.stream(), writeStandardOutput);
    return 0;
  } catch (error) {
    if (error instanceof SlackWorkerProcessError) return terminate(error.reason, error.reason.includes("request frame") ? 65 : 74);
    return terminate("worker failure", 74);
  }
}

if (import.meta.main) process.exitCode = await main();
