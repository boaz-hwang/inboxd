import type { KakaoHttpRequest, KakaoHttpResponse, KakaoHttpTransport } from "./worker.ts";

export type KakaoFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const KAKAO_SEND_URL = "https://kapi.kakao.com/v1/api/talk/friends/message/send";
const CONTENT_TYPE = "application/x-www-form-urlencoded;charset=utf-8";
const MAX_ACCESS_TOKEN_BYTES = 4_096;
const MAX_HTTP_BODY_BYTES = 1_048_576;
const MAX_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_BYTES = 16_777_216;
const encoder = new TextEncoder();

function boundedAccessToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0
    || encoder.encode(value).byteLength > MAX_ACCESS_TOKEN_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Kakao access token must be a bounded non-empty value without control characters");
  }
  return value;
}

function validateRequest(request: KakaoHttpRequest): void {
  if (request.method !== "POST" || request.url !== KAKAO_SEND_URL) {
    throw new TypeError("Kakao fetch transport only accepts the fixed custom-template send endpoint");
  }
  if (request.headers["content-type"] !== CONTENT_TYPE
    || Object.keys(request.headers).some((key) => key.toLowerCase() === "authorization")) {
    throw new TypeError("Kakao fetch transport requires its fixed content type and owns authorization");
  }
  if (typeof request.body !== "string" || encoder.encode(request.body).byteLength > MAX_HTTP_BODY_BYTES) {
    throw new RangeError("Kakao fetch request body exceeds its byte limit");
  }
  if (!Number.isSafeInteger(request.timeout_ms) || request.timeout_ms < 1 || request.timeout_ms > MAX_TIMEOUT_MS) {
    throw new RangeError("Kakao fetch timeout is outside the supported range");
  }
  if (!Number.isSafeInteger(request.max_response_bytes)
    || request.max_response_bytes < 1
    || request.max_response_bytes > MAX_RESPONSE_BYTES) {
    throw new RangeError("Kakao fetch response byte limit is outside the supported range");
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed > maximumBytes) {
      throw new RangeError("Kakao HTTP response exceeds the configured response byte limit");
    }
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("Kakao response byte limit exceeded");
        throw new RangeError("Kakao HTTP response exceeds the configured response byte limit");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}

/** Performs exactly one fetch. Callers classify every post-dispatch failure conservatively. */
export function createKakaoFetchTransport(
  accessTokenValue: unknown,
  fetchImpl: KakaoFetch = globalThis.fetch,
): KakaoHttpTransport {
  const accessToken = boundedAccessToken(accessTokenValue);
  if (typeof fetchImpl !== "function") throw new TypeError("Kakao fetch implementation is required");

  return async (request: KakaoHttpRequest): Promise<KakaoHttpResponse> => {
    validateRequest(request);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Kakao fetch transport exceeded its timeout deadline"));
      }, request.timeout_ms);
    });
    const attempt = (async (): Promise<KakaoHttpResponse> => {
      const response = await fetchImpl(request.url, {
        method: "POST",
        redirect: "error",
        headers: {
          ...request.headers,
          authorization: `Bearer ${accessToken}`,
        },
        body: request.body,
        signal: controller.signal,
      });
      return {
        status: response.status,
        body: await readBoundedBody(response, request.max_response_bytes),
      };
    })();
    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}