import {
  validateKakaoTemplateEnvelope,
  type KakaoOfficialDestination,
} from "./template-envelope.ts";
import {
  parseWorkerRequest,
  parseWorkerResponse,
  type WorkerRequestForOperationV1,
  type WorkerRequestV1,
  type WorkerResponseV1,
} from "../../../packages/protocol/src/index.ts";

export type KakaoAccessState = "granted" | "denied" | "unknown";
export type KakaoTrustedAuthState = "authenticated" | "revoked" | "unknown";

export interface KakaoConsentPermissionObservation {
  readonly talk_message_consent: KakaoAccessState;
  readonly friends_message_permission: KakaoAccessState;
  readonly observed_at: number;
}

/** Trusted result of Kakao's access-token information endpoint. */
export interface KakaoTrustedAuthObservation {
  readonly source: "kakao_access_token_info";
  readonly state: KakaoTrustedAuthState;
  readonly observed_at: number;
}

export interface KakaoHttpRequest {
  readonly method: "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeout_ms: number;
  readonly max_response_bytes: number;
}

export interface KakaoHttpResponse {
  readonly status: number;
  readonly body: string;
}

export type KakaoHttpTransport = (request: KakaoHttpRequest) => Promise<KakaoHttpResponse>;

export interface KakaoMessageWorkerOptions {
  readonly bindingId: string;
  readonly account: string;
  readonly recipientUuidAllowlist: readonly string[];
  readonly templateIdAllowlist: readonly string[];
  readonly observation: KakaoConsentPermissionObservation;
  readonly trustedAuthObservation?: KakaoTrustedAuthObservation;
  readonly authObservationMaxAgeSeconds: number;
  readonly now?: () => number;
  readonly transport: KakaoHttpTransport;
}

const KAKAO_SEND_URL = "https://kapi.kakao.com/v1/api/talk/friends/message/send";
const CONTENT_TYPE = "application/x-www-form-urlencoded;charset=utf-8";
const MAX_ALLOWLIST_ENTRIES = 1_000;
const MAX_AUTH_OBSERVATION_AGE_SECONDS = 3_600;
const DEFINITE_REJECTION_ERROR_CODES = new Set([
  -2, -3, -4, -5, -6, -8, -9, -12, -13, -401, -501, -502, -530, -903,
]);
const QUOTA_ERROR_CODES = new Set([-10, -11, -532, -533, -536]);
const encoder = new TextEncoder();

interface FixedWorkerOptions {
  readonly bindingId: string;
  readonly account: string;
  readonly recipientUuids: ReadonlySet<string>;
  readonly templateIds: ReadonlySet<string>;
  readonly observation: KakaoConsentPermissionObservation;
  readonly trustedAuthObservation: KakaoTrustedAuthObservation | undefined;
  readonly authObservationMaxAgeSeconds: number;
  readonly now: () => number;
  readonly transport: KakaoHttpTransport;
}

function boundedIdentifier(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0
    || encoder.encode(value).byteLength > maximumBytes
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a bounded non-empty identifier without control characters`);
  }
  return value;
}

function boundedAllowlist(
  value: readonly string[],
  label: string,
  maximumEntryBytes: number,
): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ALLOWLIST_ENTRIES) {
    throw new TypeError(`${label} allowlist must contain 1 to ${MAX_ALLOWLIST_ENTRIES} entries`);
  }
  const parsed = new Set<string>();
  for (const entry of value) {
    const identifier = boundedIdentifier(entry, `${label} allowlist entry`, maximumEntryBytes);
    if (parsed.has(identifier)) throw new TypeError(`${label} allowlist contains a duplicate entry`);
    parsed.add(identifier);
  }
  return parsed;
}

function parseTrustedAuthObservation(value: unknown): KakaoTrustedAuthObservation | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Kakao trusted auth observation must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (keys.length !== 3
    || !keys.every((key) => typeof key === "string" && ["source", "state", "observed_at"].includes(key))) {
    throw new TypeError("Kakao trusted auth observation contains an unsupported field");
  }
  if (record.source !== "kakao_access_token_info"
    || (record.state !== "authenticated" && record.state !== "revoked" && record.state !== "unknown")
    || typeof record.observed_at !== "number"
    || !Number.isFinite(record.observed_at)
    || record.observed_at < 0) {
    throw new TypeError("Kakao trusted auth observation is invalid");
  }
  return {
    source: "kakao_access_token_info",
    state: record.state,
    observed_at: record.observed_at,
  };
}

function fixedOptions(options: KakaoMessageWorkerOptions): FixedWorkerOptions {
  const states = new Set<KakaoAccessState>(["granted", "denied", "unknown"]);
  if (!states.has(options.observation?.talk_message_consent)
    || !states.has(options.observation?.friends_message_permission)
    || typeof options.observation?.observed_at !== "number"
    || !Number.isFinite(options.observation.observed_at)
    || options.observation.observed_at < 0) {
    throw new TypeError("Kakao consent/permission observation is invalid");
  }
  if (!Number.isSafeInteger(options.authObservationMaxAgeSeconds)
    || options.authObservationMaxAgeSeconds < 1
    || options.authObservationMaxAgeSeconds > MAX_AUTH_OBSERVATION_AGE_SECONDS) {
    throw new RangeError(
      `Kakao auth observation maximum age must be 1 to ${MAX_AUTH_OBSERVATION_AGE_SECONDS} seconds`,
    );
  }
  const now = options.now ?? (() => Date.now() / 1_000);
  if (typeof now !== "function") throw new TypeError("Kakao worker clock is required");
  if (typeof options.transport !== "function") throw new TypeError("Kakao HTTP transport is required");
  return {
    bindingId: boundedIdentifier(options.bindingId, "Kakao binding id", 512),
    account: boundedIdentifier(options.account, "Kakao account", 512),
    recipientUuids: boundedAllowlist(options.recipientUuidAllowlist, "Kakao recipient UUID", 512),
    templateIds: boundedAllowlist(options.templateIdAllowlist, "Kakao template id", 1_024),
    observation: {
      talk_message_consent: options.observation.talk_message_consent,
      friends_message_permission: options.observation.friends_message_permission,
      observed_at: options.observation.observed_at,
    },
    trustedAuthObservation: parseTrustedAuthObservation(options.trustedAuthObservation),
    authObservationMaxAgeSeconds: options.authObservationMaxAgeSeconds,
    now,
    transport: options.transport,
  };
}

function healthResult(options: FixedWorkerOptions) {
  const currentTime = options.now();
  const observation = options.trustedAuthObservation;
  if (typeof currentTime !== "number" || !Number.isFinite(currentTime) || currentTime < 0) {
    return {
      state: "degraded" as const,
      auth: {
        state: "unknown" as const,
        reason: "access_token_auth_clock_invalid",
        observed_at: observation?.observed_at ?? 0,
      },
    };
  }
  if (observation === undefined) {
    return {
      state: "degraded" as const,
      auth: {
        state: "unknown" as const,
        reason: "access_token_auth_observation_missing",
        observed_at: currentTime,
      },
    };
  }
  const observationAge = currentTime - observation.observed_at;
  if (observationAge < 0 || observationAge > options.authObservationMaxAgeSeconds) {
    return {
      state: "degraded" as const,
      auth: {
        state: "unknown" as const,
        reason: "access_token_auth_observation_stale",
        observed_at: observation.observed_at,
      },
    };
  }
  if (observation.state === "revoked") {
    return {
      state: "degraded" as const,
      auth: {
        state: "unauthenticated" as const,
        reason: "access_token_revoked",
        observed_at: observation.observed_at,
      },
    };
  }
  if (observation.state === "unknown") {
    return {
      state: "degraded" as const,
      auth: {
        state: "unknown" as const,
        reason: "access_token_auth_unknown",
        observed_at: observation.observed_at,
      },
    };
  }
  const auth = {
    state: "authenticated" as const,
    reason: null,
    observed_at: observation.observed_at,
  };
  if (options.observation.talk_message_consent !== "granted"
    || options.observation.friends_message_permission !== "granted") {
    return { state: "unavailable" as const, auth };
  }
  return { state: "ready" as const, auth };
}

function successResponse(
  request: WorkerRequestV1,
  result: unknown,
): WorkerResponseV1 {
  return parseWorkerResponse({
    v: 1,
    type: "worker_response",
    request_id: request.request_id,
    generation: request.generation,
    operation: request.operation.op,
    ok: true,
    result,
  }, request);
}

function errorResponse(
  request: WorkerRequestV1,
  code: string,
  message: string,
  mayHaveSent = false,
): WorkerResponseV1 {
  return parseWorkerResponse({
    v: 1,
    type: "worker_response",
    request_id: request.request_id,
    generation: request.generation,
    operation: request.operation.op,
    ok: false,
    error: { code, message, retryable: false, may_have_sent: mayHaveSent },
  }, request);
}

function ambiguousSend(
  request: WorkerRequestForOperationV1<"send">,
  message: string,
): WorkerResponseV1<"send"> {
  return errorResponse(request, "send_ambiguous", message, true) as WorkerResponseV1<"send">;
}

function providerErrorCode(body: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  const message = (value as Record<string, unknown>).msg;
  return Number.isSafeInteger(code) && (code as number) < 0
    && typeof message === "string" && message.length > 0 && encoder.encode(message).byteLength <= 4_096
    ? code as number
    : null;
}

function isExactAcknowledgement(value: unknown, expectedDestinationId: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  return keys.length === 1
    && keys[0] === "successful_receiver_uuids"
    && Array.isArray(record.successful_receiver_uuids)
    && record.successful_receiver_uuids.length === 1
    && record.successful_receiver_uuids[0] === expectedDestinationId;
}

async function sendTemplate(
  request: WorkerRequestForOperationV1<"send">,
  options: FixedWorkerOptions,
): Promise<WorkerResponseV1<"send">> {
  const candidate = request.operation.envelope;
  const health = healthResult(options);
  if (health.auth.state !== "authenticated") {
    return errorResponse(
      request,
      "authentication_unavailable",
      "Kakao access-token authentication is not freshly observed",
    ) as WorkerResponseV1<"send">;
  }
  if (
    options.observation.talk_message_consent !== "granted"
    || options.observation.friends_message_permission !== "granted"
  ) {
    return errorResponse(
      request,
      "access_not_observed",
      "Kakao Message consent and friends-message permission must both be observed",
    ) as WorkerResponseV1<"send">;
  }
  if (candidate.reply !== undefined) {
    return errorResponse(
      request,
      "reply_unsupported",
      "Official Kakao Message does not support replies",
    ) as WorkerResponseV1<"send">;
  }
  if (candidate.content.mode !== "approved_template") {
    return errorResponse(
      request,
      "free_text_unsupported",
      "Official Kakao Message accepts approved templates only",
    ) as WorkerResponseV1<"send">;
  }
  if (
    candidate.destination.kind !== "destination"
    || candidate.destination.platform !== "kakao"
    || candidate.destination.account !== options.account
    || !options.recipientUuids.has(candidate.destination.destination_id)
  ) {
    return errorResponse(
      request,
      "scope_denied",
      "Kakao recipient must match the fixed account and UUID allowlist",
    ) as WorkerResponseV1<"send">;
  }
  if (!options.templateIds.has(candidate.content.template_id)) {
    return errorResponse(
      request,
      "template_not_allowed",
      "Kakao template ID is not allowlisted",
    ) as WorkerResponseV1<"send">;
  }
  const destination: KakaoOfficialDestination = {
    v: 1,
    kind: "destination",
    platform: "kakao",
    account: candidate.destination.account,
    destination_id: candidate.destination.destination_id,
  };
  let envelope;
  try {
    envelope = validateKakaoTemplateEnvelope(candidate, {
      destination,
      approved_template_id: candidate.content.template_id,
    });
  } catch {
    return errorResponse(
      request,
      "invalid_template",
      "Kakao template envelope failed provider-local validation",
    ) as WorkerResponseV1<"send">;
  }
  const body = new URLSearchParams();
  body.set("receiver_uuids", JSON.stringify([envelope.destination.destination_id]));
  body.set("template_id", envelope.content.template_id);
  body.set("template_args", JSON.stringify(envelope.content.arguments));

  let response: KakaoHttpResponse;
  try {
    response = await options.transport({
      method: "POST",
      url: KAKAO_SEND_URL,
      headers: { "content-type": CONTENT_TYPE },
      body: body.toString(),
      timeout_ms: request.limits.timeout_ms,
      max_response_bytes: request.limits.max_response_bytes,
    });
  } catch {
    return ambiguousSend(request, "Kakao send transport ended after dispatch");
  }

  if (!Number.isInteger(response?.status) || typeof response?.body !== "string"
    || encoder.encode(response.body).byteLength > request.limits.max_response_bytes) {
    return ambiguousSend(request, "Kakao send returned an invalid or oversized response after dispatch");
  }
  if (response.status !== 200) {
    if (response.status >= 400 && response.status < 500) {
      const code = providerErrorCode(response.body);
      if (code !== null && QUOTA_ERROR_CODES.has(code)) {
        return errorResponse(
          request,
          "quota_exceeded",
          "Kakao API rejected the send because a quota was exceeded",
        ) as WorkerResponseV1<"send">;
      }
      if (code !== null && DEFINITE_REJECTION_ERROR_CODES.has(code)) {
        return errorResponse(
          request,
          "api_rejected",
          `Kakao API rejected the send with provider code ${code}`,
        ) as WorkerResponseV1<"send">;
      }
    }
    return ambiguousSend(request, "Kakao send returned a non-definitive HTTP status or error body after dispatch");
  }

  let acknowledgment: unknown;
  try {
    acknowledgment = JSON.parse(response.body);
  } catch {
    return ambiguousSend(request, "Kakao send returned malformed JSON after dispatch");
  }
  if (!isExactAcknowledgement(acknowledgment, envelope.destination.destination_id)) {
    return ambiguousSend(request, "Kakao send acknowledgement did not match the exact destination");
  }
  return successResponse(request, {
    outcome: "sent",
    receipt_id: `kakao-api-ack:${request.operation.idempotency_key}`,
  }) as WorkerResponseV1<"send">;
}

export function createKakaoMessageWorker(workerOptions: KakaoMessageWorkerOptions) {
  const options = fixedOptions(workerOptions);
  return {
    async handleRequest(value: unknown): Promise<WorkerResponseV1> {
      const request = parseWorkerRequest(value);
      if (request.binding_id !== options.bindingId) {
        return errorResponse(
          request,
          "binding_mismatch",
          "Kakao worker binding does not match its fixed configuration",
        );
      }
      if (request.operation.op === "send") {
        return sendTemplate(request as WorkerRequestForOperationV1<"send">, options);
      }
      if (request.operation.op === "read_page" || request.operation.op === "read_receipt") {
        return errorResponse(
          request,
          "unsupported",
          `Official Kakao Message ${request.operation.op} is unsupported for its write-only destination`,
        );
      }
      if (request.operation.op !== "health") {
        return errorResponse(request, "unsupported", "Kakao worker operation is not implemented");
      }
      return successResponse(request, healthResult(options));
    },
  };
}
