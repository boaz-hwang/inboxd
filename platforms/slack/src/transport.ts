import type {
  SlackApiCall,
  SlackApiMethod,
  SlackApiResponse,
  SlackApiTransport,
} from "./worker.ts";

export const SLACK_WEB_API_ORIGIN = "https://slack.com/api";
export const SLACK_WEB_API_REQUEST_BYTES = 131_072;
export const SLACK_WEB_API_RESPONSE_BYTES = 8_388_608;

const encoder = new TextEncoder();
const methods = new Set<SlackApiMethod>([
  "auth.test",
  "conversations.history",
  "conversations.info",
  "conversations.replies",
  "chat.postMessage",
]);

type SlackFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SlackWebApiTransportOptions {
  readonly token: string;
  readonly fetch?: SlackFetch;
  /** Trusted constructor seam for exact synthetic boundary tests. */
  readonly maxResponseBytes?: number;
}

class SlackResponseBoundError extends Error {}

function fixedToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > 8_192
    || !/^[\u0021-\u007e]+$/.test(value)) {
    throw new TypeError("Slack bot token must be a bounded printable ASCII value");
  }
  return value;
}

function responseByteLimit(value: number | undefined): number {
  const parsed = value ?? SLACK_WEB_API_RESPONSE_BYTES;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > SLACK_WEB_API_RESPONSE_BYTES) {
    throw new RangeError(`Slack response byte limit must be 1..${SLACK_WEB_API_RESPONSE_BYTES}`);
  }
  return parsed;
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > maximum) {
      throw new SlackResponseBoundError();
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* The bound verdict is already final. */ }
        throw new SlackResponseBoundError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function encodePayload(call: SlackApiCall): string {
  if (!methods.has(call.method)) throw new TypeError("Slack Web API method is not allowed");
  let body: string | undefined;
  try {
    body = JSON.stringify(call.payload);
  } catch {
    throw new TypeError("Slack Web API request was not JSON serializable");
  }
  if (body === undefined || encoder.encode(body).byteLength > SLACK_WEB_API_REQUEST_BYTES) {
    throw new RangeError("Slack Web API request exceeded its byte limit");
  }
  return body;
}

/** One fetch per call, fixed Slack origin, no redirects and no transport retry. */
export function createSlackWebApiTransport(options: SlackWebApiTransportOptions): SlackApiTransport {
  const token = fixedToken(options.token);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("Slack Web API fetch implementation is unavailable");
  const maximum = responseByteLimit(options.maxResponseBytes);

  return {
    async call(call): Promise<SlackApiResponse> {
      const body = encodePayload(call);
      let response: Response;
      try {
        response = await fetchImpl(`${SLACK_WEB_API_ORIGIN}/${call.method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body,
          signal: call.signal,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
      } catch {
        throw new Error("Slack Web API request failed");
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBody(response, maximum);
      } catch (error) {
        if (error instanceof SlackResponseBoundError) {
          throw new Error("Slack Web API response exceeded its byte limit");
        }
        throw new Error("Slack Web API response was unavailable");
      }

      let parsed: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error("Slack Web API response was malformed");
      }
      const retryAfter = response.headers.get("retry-after");
      return {
        status: response.status,
        headers: retryAfter === null ? {} : { "retry-after": retryAfter },
        body: parsed,
      };
    },
  };
}
