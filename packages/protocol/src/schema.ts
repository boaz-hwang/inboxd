export const LEGACY_REQUEST_METHODS = [
  "system.hello",
  "system.ping",
  "system.status",
  "chat.list",
  "message.inbox",
  "message.recent",
  "message.evidence",
  "message.get",
  "message.search",
  "sync.status",
  "sync.backfill",
  "auth.status",
  "safety.intent.create",
  "safety.intent.listPending",
  "safety.intent.claimApprovalCode",
  "safety.intent.approve",
  "safety.intent.reject",
  "send.status",
  "settings.get",
  "settings.update",
  "subscribe",
] as const;

export const REQUEST_METHODS = [...LEGACY_REQUEST_METHODS, "capability.list"] as const;

export const LEGACY_EVENT_METHODS = [
  "message.upserted",
  "coverage.changed",
  "safety.intent.changed",
] as const;

export const EVENT_METHODS = [...LEGACY_EVENT_METHODS, "capability.changed"] as const;

/** Frozen host boundary implemented by both Bun and Rust compatibility hosts. */
export const HOST_OPERATIONS = [
  "host.now",
  "host.id",
  "host.approvalCode",
  "host.allowSend",
  "host.canonicalSha256",
  "host.canonicalJson",
  "host.sha256Text",
  "host.jsonStringify",
  "host.jsonParse",
  "host.numberToString",
  "host.utf16Compare",
  "host.codePointLength",
  "host.base64urlEncode",
  "host.base64urlDecode",
  "sql.run",
  "sql.get",
  "sql.all",
  "sql.exec",
  "sql.transaction.begin",
  "sql.transaction.commit",
  "sql.transaction.rollback",
] as const;

/** Prevent milliseconds used by safety from being confused with provider seconds. */
export const TIME_UNITS_V1 = {
  host_now: "milliseconds",
  safety_deadline: "milliseconds",
  adapter_timestamp: "seconds",
  adapter_retry_at: "seconds",
  worker_timeout: "milliseconds",
} as const;

export type ProtocolMethod = (typeof REQUEST_METHODS)[number];
export type ProtocolEventMethod = (typeof EVENT_METHODS)[number];
export type ClientRole = "reader" | "agent" | "mcp" | "approver";
export type JsonObject = Record<string, unknown>;

export interface ChatRefV1 {
  readonly v: 1;
  readonly kind: "chat";
  readonly platform: string;
  readonly account: string;
  readonly chat_id: string;
}

export interface DestinationRefV1 {
  readonly v: 1;
  readonly kind: "destination";
  readonly platform: string;
  readonly account: string;
  readonly destination_id: string;
}

export type ChatRef = ChatRefV1;
export type DestinationRef = DestinationRefV1;
export type ResourceRefV1 = ChatRefV1 | DestinationRefV1;
export type ReadMode = "none" | "bounded_history" | "measured_local";
export type WriteMode = "none" | "send";
export type ContentMode = "none" | "text" | "approved_template";
export type ReceiptLevel = "none" | "ack_only" | "independent_readback";
export type AuthState = "authenticated" | "unauthenticated" | "unknown";

export interface ReadLimitsV1 {
  readonly max_page_size: number;
  readonly max_pages: number;
  readonly cursor: "none" | "opaque";
}

export interface ResourceCapabilityV1 {
  readonly v: 1;
  readonly resource: ResourceRefV1;
  readonly read: { readonly mode: ReadMode; readonly limits: ReadLimitsV1 | null };
  readonly write: { readonly mode: WriteMode; readonly content_mode: ContentMode; readonly reply: boolean };
  readonly receipt: { readonly level: ReceiptLevel };
  readonly auth: { readonly state: AuthState; readonly reason: string | null; readonly observed_at: number };
}

export interface ResourceCapabilitiesV1 {
  readonly v: 1;
  readonly resources: readonly ResourceCapabilityV1[];
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface LegacySlackSendV1 {
  readonly scope: { readonly platform: "slack"; readonly account: string; readonly chat_id: string };
  readonly body: string;
  readonly parent_id?: string;
}

export type SendContentV2 =
  | { readonly mode: "text"; readonly body: string }
  | { readonly mode: "approved_template"; readonly template_id: string; readonly arguments: { readonly [key: string]: JsonValue }; readonly preview: string };

export interface SendEnvelopeV2 {
  readonly v: 2;
  readonly destination: ResourceRefV1;
  readonly content: SendContentV2;
  readonly reply?: { readonly parent_id: string };
}

export type SendApprovalBinding =
  | { readonly v: 1; readonly payload: LegacySlackSendV1 }
  | { readonly v: 2; readonly payload: SendEnvelopeV2 };

export interface NormalizedSendEnvelope {
  readonly envelope: SendEnvelopeV2;
  readonly approval: SendApprovalBinding;
}

export const WORKER_OPERATIONS = ["read_page", "send", "read_receipt", "health"] as const;
export type WorkerOperationName = (typeof WORKER_OPERATIONS)[number];

export const PROTOCOL_LIMITS = {
  worker_frame_bytes: 16_777_216,
  worker_queue_depth: 1_024,
  cursor_bytes: 4_096,
  send_body_bytes: 65_536,
  template_id_bytes: 1_024,
  template_preview_bytes: 65_536,
  template_arguments_bytes: 65_536,
  receipt_evidence_bytes: 131_072,
  json_depth: 32,
  json_nodes: 10_000,
  json_object_keys: 256,
  json_total_keys: 4_096,
  json_array_items: 1_000,
  json_key_bytes: 256,
  json_string_bytes: 65_536,
  json_total_string_bytes: 1_048_576,
} as const;

/**
 * Parsing proves these declarations are bounded; it does not enforce elapsed
 * time or scheduling. The worker supervisor must enforce timeout_ms against a
 * monotonic clock and refuse/terminate work above max_queue_depth.
 */
export interface WorkerLimitsV1 {
  readonly timeout_ms: number;
  readonly max_response_bytes: number;
  readonly max_queue_depth: number;
}

export type WorkerOperationV1 =
  | { readonly op: "read_page"; readonly chat: ChatRefV1; readonly interval: { readonly from_ts: number; readonly to_ts: number }; readonly limit: number; readonly cursor: string | null }
  | { readonly op: "send"; readonly envelope: SendEnvelopeV2; readonly idempotency_key: string }
  | { readonly op: "read_receipt"; readonly destination: ChatRefV1; readonly receipt_id: string; readonly expected: SendEnvelopeV2 & { readonly destination: ChatRefV1; readonly content: Extract<SendContentV2, { readonly mode: "text" }> } }
  | { readonly op: "health" };

export interface WorkerRequestV1 {
  readonly v: 1;
  readonly type: "worker_request";
  readonly request_id: string;
  readonly generation: number;
  readonly binding_id: string;
  readonly limits: WorkerLimitsV1;
  readonly operation: WorkerOperationV1;
}

export type WorkerRequestForOperationV1<O extends WorkerOperationName> = O extends WorkerOperationName
  ? Omit<WorkerRequestV1, "operation"> & { readonly operation: Extract<WorkerOperationV1, { readonly op: O }> }
  : never;

export type ReceiptEvidenceV1 = {
  readonly destination: ChatRefV1;
  readonly receipt_id: string;
  readonly content: Extract<SendContentV2, { readonly mode: "text" }>;
  readonly reply?: { readonly parent_id: string };
};

export interface WorkerResultByOperationV1 {
  readonly read_page: { readonly items: readonly { readonly [key: string]: JsonValue }[]; readonly next_cursor: string | null; readonly authoritative: boolean };
  readonly send:
    | { readonly outcome: "sent"; readonly receipt_id: string }
    | { readonly outcome: "failed" | "uncertain"; readonly reason: string };
  readonly read_receipt:
    | { readonly outcome: "verified"; readonly evidence: ReceiptEvidenceV1 }
    | { readonly outcome: "not_found" }
    | { readonly outcome: "unavailable"; readonly reason: string };
  readonly health: { readonly state: "ready" | "degraded" | "unavailable"; readonly auth: ResourceCapabilityV1["auth"] };
}

export type WorkerResultV1 = WorkerResultByOperationV1[WorkerOperationName];
export interface WorkerResponseErrorV1 {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly may_have_sent: boolean;
}

type WorkerResponseBaseV1<O extends WorkerOperationName> = {
  readonly v: 1;
  readonly type: "worker_response";
  readonly request_id: string;
  readonly generation: number;
  readonly operation: O;
};

export type WorkerResponseV1<O extends WorkerOperationName = WorkerOperationName> = O extends WorkerOperationName
  ? WorkerResponseBaseV1<O> & (
    | { readonly ok: true; readonly result: WorkerResultByOperationV1[O] }
    | { readonly ok: false; readonly error: WorkerResponseErrorV1 }
  )
  : never;

export interface RecentMessagesParams {
  readonly chats: readonly { readonly platform: string; readonly account: string; readonly chat_id: string }[];
  readonly interval: { readonly from_ts: number; readonly to_ts: number };
  readonly sender?: "all" | "self";
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ProtocolRequest {
  type: "request";
  id: string;
  method: ProtocolMethod;
  params: JsonObject;
}

export interface ProtocolResponse {
  type: "response";
  id: string;
  method: ProtocolMethod;
  ok: boolean;
  result?: JsonObject;
  error?: { code: string; message: string };
}

export interface ProtocolEvent {
  type: "event";
  method: ProtocolEventMethod;
  params: JsonObject;
}

export type ProtocolMessage = ProtocolRequest | ProtocolResponse | ProtocolEvent;

export class ProtocolSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolSchemaError";
  }
}

const requestMethods = new Set<string>(REQUEST_METHODS);
const eventMethods = new Set<string>(EVENT_METHODS);
const roles = new Set<string>(["reader", "agent", "mcp", "approver"]);
const utf8Encoder = new TextEncoder();

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolSchemaError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolSchemaError(`${label} must be a non-empty string`);
  }
  return value;
}

function requestMethod(value: unknown): ProtocolMethod {
  const method = nonEmptyString(value, "request method");
  if (!requestMethods.has(method)) {
    throw new ProtocolSchemaError(`unknown request method: ${method}`);
  }
  return method as ProtocolMethod;
}

function containsApprovalCode(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsApprovalCode);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as JsonObject).some(([key, nested]) =>
    key === "code" || key === "approval_code" || key === "approvalCode" || containsApprovalCode(nested),
  );
}

function assertApprovalAccess(method: ProtocolMethod, role?: ClientRole): void {
  if (role !== undefined && role !== "approver" && (
    method === "safety.intent.listPending"
    || method === "safety.intent.claimApprovalCode"
    || method === "safety.intent.approve"
    || method === "safety.intent.reject"
  )) {
    throw new ProtocolSchemaError(`${method} requires an approver role`);
  }
}

export function parseRole(value: unknown): ClientRole {
  const role = nonEmptyString(value, "role");
  if (!roles.has(role)) throw new ProtocolSchemaError(`unknown client role: ${role}`);
  return role as ClientRole;
}

export function approverTokenFromHandshake(params: JsonObject): string | undefined {
  const token = params.approver_token;
  if (token === undefined) return undefined;
  if (typeof token !== "string" || token.length < 1 || token.length > 4_096) {
    throw new ProtocolSchemaError("approver token must be a non-empty string");
  }
  return token;
}

export function createHandshake(
  role: ClientRole,
  isTTY: () => boolean = () => Boolean((globalThis as { process?: { stdout?: { isTTY?: boolean } } }).process?.stdout?.isTTY),
  approverToken?: string,
): JsonObject {
  if (role === "approver" && !isTTY()) {
    throw new ProtocolSchemaError("approver role requires a local TTY");
  }
  if (approverToken !== undefined && role !== "approver") {
    throw new ProtocolSchemaError("approver token may only be supplied by an approver");
  }
  if (approverToken !== undefined) approverTokenFromHandshake({ approver_token: approverToken });
  return { role, ...(approverToken === undefined ? {} : { approver_token: approverToken }) };
}

function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ProtocolSchemaError(`${label} contains an unknown field`);
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ProtocolSchemaError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  const parsed = nonEmptyString(value, label);
  if (parsed.length > maximum) throw new ProtocolSchemaError(`${label} exceeds ${maximum} characters`);
  return parsed;
}

function boundedUtf8String(value: unknown, label: string, maximum: number): string {
  const parsed = nonEmptyString(value, label);
  if (utf8Encoder.encode(parsed).byteLength > maximum) throw new ProtocolSchemaError(`${label} exceeds ${maximum} UTF-8 bytes`);
  return parsed;
}

function encodedJsonByteLength(value: unknown, label: string): number {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); }
  catch { throw new ProtocolSchemaError(`${label} must be JSON serializable`); }
  if (encoded === undefined) throw new ProtocolSchemaError(`${label} must be JSON serializable`);
  return utf8Encoder.encode(encoded).byteLength;
}

function assertEncodedJsonBytes(value: unknown, label: string, maximum: number): void {
  if (encodedJsonByteLength(value, label) > maximum) throw new ProtocolSchemaError(`${label} exceeds ${maximum} encoded UTF-8 bytes`);
}

export function parseChatRef(value: unknown): ChatRefV1 {
  const ref = object(value, "chat ref");
  exactKeys(ref, ["v", "kind", "platform", "account", "chat_id"], "chat ref");
  if (ref.v !== 1 || ref.kind !== "chat") throw new ProtocolSchemaError("chat ref must be a version 1 chat");
  return {
    v: 1,
    kind: "chat",
    platform: nonEmptyString(ref.platform, "chat ref platform"),
    account: nonEmptyString(ref.account, "chat ref account"),
    chat_id: nonEmptyString(ref.chat_id, "chat ref chat_id"),
  };
}

export function parseDestinationRef(value: unknown): DestinationRefV1 {
  const ref = object(value, "destination ref");
  exactKeys(ref, ["v", "kind", "platform", "account", "destination_id"], "destination ref");
  if (ref.v !== 1 || ref.kind !== "destination") throw new ProtocolSchemaError("destination ref must be a version 1 destination");
  return {
    v: 1,
    kind: "destination",
    platform: nonEmptyString(ref.platform, "destination ref platform"),
    account: nonEmptyString(ref.account, "destination ref account"),
    destination_id: nonEmptyString(ref.destination_id, "destination ref destination_id"),
  };
}

export function parseResourceRef(value: unknown): ResourceRefV1 {
  const ref = object(value, "resource ref");
  if (ref.kind === "chat") return parseChatRef(ref);
  if (ref.kind === "destination") return parseDestinationRef(ref);
  throw new ProtocolSchemaError("resource ref kind must be chat or destination");
}

function parseReadCapability(value: unknown): ResourceCapabilityV1["read"] {
  const read = object(value, "read capability");
  exactKeys(read, ["mode", "limits"], "read capability");
  if (read.mode !== "none" && read.mode !== "bounded_history" && read.mode !== "measured_local") {
    throw new ProtocolSchemaError("read mode is invalid");
  }
  if (read.mode === "none") {
    if (read.limits !== null) throw new ProtocolSchemaError("read limits must be null when read mode is none");
    return { mode: "none", limits: null };
  }
  const limits = object(read.limits, "read limits");
  exactKeys(limits, ["max_page_size", "max_pages", "cursor"], "read limits");
  const parsed: ReadLimitsV1 = {
    max_page_size: positiveInteger(limits.max_page_size, "read max_page_size", 10_000),
    max_pages: positiveInteger(limits.max_pages, "read max_pages", 100),
    cursor: limits.cursor === "none" || limits.cursor === "opaque"
      ? limits.cursor
      : (() => { throw new ProtocolSchemaError("read cursor mode is invalid"); })(),
  };
  if (read.mode === "measured_local" && (parsed.max_pages !== 1 || parsed.cursor !== "none")) {
    throw new ProtocolSchemaError("measured local reads are one page without a cursor");
  }
  return { mode: read.mode, limits: parsed };
}

function parseWriteCapability(value: unknown): ResourceCapabilityV1["write"] {
  const write = object(value, "write capability");
  exactKeys(write, ["mode", "content_mode", "reply"], "write capability");
  if (write.mode !== "none" && write.mode !== "send") throw new ProtocolSchemaError("write mode is invalid");
  if (write.content_mode !== "none" && write.content_mode !== "text" && write.content_mode !== "approved_template") {
    throw new ProtocolSchemaError("content mode is invalid");
  }
  if (typeof write.reply !== "boolean") throw new ProtocolSchemaError("write reply support must be boolean");
  if (write.mode === "none" && (write.content_mode !== "none" || write.reply)) {
    throw new ProtocolSchemaError("disabled writes cannot claim content or reply support");
  }
  if (write.mode === "send" && write.content_mode === "none") throw new ProtocolSchemaError("enabled writes require a content mode");
  if (write.content_mode === "approved_template" && write.reply) throw new ProtocolSchemaError("approved templates cannot claim reply support");
  return { mode: write.mode, content_mode: write.content_mode, reply: write.reply };
}

function parseReceiptCapability(value: unknown): ResourceCapabilityV1["receipt"] {
  const receipt = object(value, "receipt capability");
  exactKeys(receipt, ["level"], "receipt capability");
  if (receipt.level !== "none" && receipt.level !== "ack_only" && receipt.level !== "independent_readback") {
    throw new ProtocolSchemaError("receipt level is invalid");
  }
  return { level: receipt.level };
}

function parseAuthCapability(value: unknown): ResourceCapabilityV1["auth"] {
  const auth = object(value, "auth capability");
  exactKeys(auth, ["state", "reason", "observed_at"], "auth capability");
  if (auth.state !== "authenticated" && auth.state !== "unauthenticated" && auth.state !== "unknown") {
    throw new ProtocolSchemaError("auth state is invalid");
  }
  if (typeof auth.observed_at !== "number" || !Number.isFinite(auth.observed_at) || auth.observed_at < 0) {
    throw new ProtocolSchemaError("auth observed_at must be a non-negative finite number");
  }
  const reason = auth.reason === null ? null : nonEmptyString(auth.reason, "auth reason");
  if (auth.state === "authenticated" ? reason !== null : reason === null) {
    throw new ProtocolSchemaError("auth reason must be null only when authenticated");
  }
  return { state: auth.state, reason, observed_at: auth.observed_at };
}

export function parseResourceCapability(value: unknown): ResourceCapabilityV1 {
  const capability = object(value, "resource capability");
  exactKeys(capability, ["v", "resource", "read", "write", "receipt", "auth"], "resource capability");
  if (capability.v !== 1) throw new ProtocolSchemaError("resource capability version must be 1");
  const resource = parseResourceRef(capability.resource);
  const read = parseReadCapability(capability.read);
  const write = parseWriteCapability(capability.write);
  const receipt = parseReceiptCapability(capability.receipt);
  const auth = parseAuthCapability(capability.auth);
  if (resource.kind === "destination" && read.mode !== "none") throw new ProtocolSchemaError("destinations are write-only resources");
  if (read.mode === "measured_local" && write.mode !== "none") throw new ProtocolSchemaError("measured local resources are read-only");
  if (write.mode === "send" && resource.kind === "chat" && write.content_mode !== "text") {
    throw new ProtocolSchemaError("chat sends require text content");
  }
  if (write.mode === "send" && resource.kind === "destination" && write.content_mode !== "approved_template") {
    throw new ProtocolSchemaError("destination sends require approved template content");
  }
  if (write.mode === "none" && receipt.level !== "none") throw new ProtocolSchemaError("read-only resources cannot claim send receipts");
  if (receipt.level === "independent_readback" && (resource.kind !== "chat" || read.mode === "none")) {
    throw new ProtocolSchemaError("independent readback requires a readable chat");
  }
  return { v: 1, resource, read, write, receipt, auth };
}

export function parseResourceCapabilities(value: unknown): ResourceCapabilitiesV1 {
  const directory = object(value, "resource capabilities");
  exactKeys(directory, ["v", "resources"], "resource capabilities");
  if (directory.v !== 1) throw new ProtocolSchemaError("resource capabilities version must be 1");
  if (!Array.isArray(directory.resources) || directory.resources.length > 1_000) {
    throw new ProtocolSchemaError("resource capabilities must contain at most 1000 entries");
  }
  const resources = directory.resources.map(parseResourceCapability);
  const identities = new Set(resources.map(entry => JSON.stringify(entry.resource)));
  if (identities.size !== resources.length) throw new ProtocolSchemaError("resource capabilities contain a duplicate resource");
  return { v: 1, resources };
}

interface JsonParseBudget {
  nodes: number;
  keys: number;
  stringBytes: number;
}

function jsonParseBudget(): JsonParseBudget {
  return { nodes: 0, keys: 0, stringBytes: 0 };
}

function parseJsonValue(
  value: unknown,
  label: string,
  budget: JsonParseBudget = jsonParseBudget(),
  seen = new Set<object>(),
  depth = 0,
): JsonValue {
  if (depth > PROTOCOL_LIMITS.json_depth) throw new ProtocolSchemaError(`${label} exceeds the JSON depth limit`);
  budget.nodes += 1;
  if (budget.nodes > PROTOCOL_LIMITS.json_nodes) throw new ProtocolSchemaError(`${label} exceeds the aggregate JSON node limit`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const bytes = utf8Encoder.encode(value).byteLength;
    if (bytes > PROTOCOL_LIMITS.json_string_bytes) throw new ProtocolSchemaError(`${label} exceeds the JSON string byte limit`);
    budget.stringBytes += bytes;
    if (budget.stringBytes > PROTOCOL_LIMITS.json_total_string_bytes) throw new ProtocolSchemaError(`${label} exceeds the aggregate JSON string byte limit`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProtocolSchemaError(`${label} must contain only finite JSON numbers`);
    return value;
  }
  if (typeof value !== "object") throw new ProtocolSchemaError(`${label} must contain only JSON values`);
  if (seen.has(value)) throw new ProtocolSchemaError(`${label} must not contain cycles`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > PROTOCOL_LIMITS.json_array_items) throw new ProtocolSchemaError(`${label} exceeds the JSON array item limit`);
      return value.map((entry, index) => parseJsonValue(entry, `${label}[${index}]`, budget, seen, depth + 1));
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > PROTOCOL_LIMITS.json_object_keys) throw new ProtocolSchemaError(`${label} exceeds the JSON object key limit`);
    budget.keys += keys.length;
    if (budget.keys > PROTOCOL_LIMITS.json_total_keys) throw new ProtocolSchemaError(`${label} exceeds the aggregate JSON key limit`);
    const parsed = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys) {
      if (utf8Encoder.encode(key).byteLength > PROTOCOL_LIMITS.json_key_bytes) throw new ProtocolSchemaError(`${label} contains a JSON key above the byte limit`);
      Object.defineProperty(parsed, key, {
        value: parseJsonValue(record[key], `${label}.${key}`, budget, seen, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return parsed;
  } finally {
    seen.delete(value);
  }
}

function parseLegacySlackSend(value: unknown): LegacySlackSendV1 {
  const send = object(value, "v1 Slack send");
  exactKeys(send, ["scope", "body", "parent_id"], "v1 Slack send");
  const scope = object(send.scope, "v1 Slack scope");
  exactKeys(scope, ["platform", "account", "chat_id"], "v1 Slack scope");
  if (scope.platform !== "slack") throw new ProtocolSchemaError("v1 send scope platform must be slack");
  const parsedScope: LegacySlackSendV1["scope"] = {
    platform: "slack",
    account: nonEmptyString(scope.account, "v1 Slack scope account"),
    chat_id: nonEmptyString(scope.chat_id, "v1 Slack scope chat_id"),
  };
  const body = boundedUtf8String(send.body, "v1 Slack send body", PROTOCOL_LIMITS.send_body_bytes);
  const parentId = send.parent_id === undefined ? undefined : nonEmptyString(send.parent_id, "v1 Slack parent_id");
  return { scope: parsedScope, body, ...(parentId === undefined ? {} : { parent_id: parentId }) };
}

export function parseSendEnvelopeV2(value: unknown): SendEnvelopeV2 {
  const envelope = object(value, "send envelope");
  exactKeys(envelope, ["v", "destination", "content", "reply"], "send envelope");
  if (envelope.v !== 2) throw new ProtocolSchemaError("send envelope version must be 2");
  const destination = parseResourceRef(envelope.destination);
  const content = object(envelope.content, "send content");
  let parsedContent: SendContentV2;
  if (content.mode === "text") {
    exactKeys(content, ["mode", "body"], "text send content");
    if (destination.kind !== "chat") throw new ProtocolSchemaError("text sends require a chat destination");
    parsedContent = { mode: "text", body: boundedUtf8String(content.body, "text send body", PROTOCOL_LIMITS.send_body_bytes) };
  } else if (content.mode === "approved_template") {
    exactKeys(content, ["mode", "template_id", "arguments", "preview"], "template send content");
    if (destination.kind !== "destination") throw new ProtocolSchemaError("approved template sends require a write-only destination");
    const argumentsValue = parseJsonValue(content.arguments, "template arguments");
    if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
      throw new ProtocolSchemaError("template arguments must be a JSON object");
    }
    assertEncodedJsonBytes(argumentsValue, "template arguments", PROTOCOL_LIMITS.template_arguments_bytes);
    parsedContent = {
      mode: "approved_template",
      template_id: boundedUtf8String(content.template_id, "template_id", PROTOCOL_LIMITS.template_id_bytes),
      arguments: argumentsValue as { readonly [key: string]: JsonValue },
      preview: boundedUtf8String(content.preview, "template preview", PROTOCOL_LIMITS.template_preview_bytes),
    };
  } else {
    throw new ProtocolSchemaError("send content mode is invalid");
  }
  let reply: SendEnvelopeV2["reply"];
  if (envelope.reply !== undefined) {
    const value = object(envelope.reply, "send reply");
    exactKeys(value, ["parent_id"], "send reply");
    if (parsedContent.mode !== "text") throw new ProtocolSchemaError("approved template sends do not support replies");
    reply = { parent_id: nonEmptyString(value.parent_id, "send reply parent_id") };
  }
  return { v: 2, destination, content: parsedContent, ...(reply === undefined ? {} : { reply }) };
}

export function normalizeSendEnvelope(value: unknown): NormalizedSendEnvelope {
  const input = object(value, "send input");
  if (input.v === 2) {
    const envelope = parseSendEnvelopeV2(input);
    return { envelope, approval: { v: 2, payload: envelope } };
  }
  const legacy = parseLegacySlackSend(input);
  const envelope: SendEnvelopeV2 = {
    v: 2,
    destination: { v: 1, kind: "chat", platform: "slack", account: legacy.scope.account, chat_id: legacy.scope.chat_id },
    content: { mode: "text", body: legacy.body },
    ...(legacy.parent_id === undefined ? {} : { reply: { parent_id: legacy.parent_id } }),
  };
  return { envelope, approval: { v: 1, payload: legacy } };
}

function parseNormalizedSendEnvelope(value: unknown): NormalizedSendEnvelope {
  const normalized = object(value, "normalized send");
  exactKeys(normalized, ["envelope", "approval"], "normalized send");
  const envelope = parseSendEnvelopeV2(normalized.envelope);
  const approval = object(normalized.approval, "send approval binding");
  exactKeys(approval, ["v", "payload"], "send approval binding");
  if (approval.v === 1) {
    const payload = parseLegacySlackSend(approval.payload);
    if (JSON.stringify(normalizeSendEnvelope(payload).envelope) !== JSON.stringify(envelope)) {
      throw new ProtocolSchemaError("v1 approval payload does not match the normalized envelope");
    }
    return { envelope, approval: { v: 1, payload } };
  }
  if (approval.v === 2) {
    const payload = parseSendEnvelopeV2(approval.payload);
    if (JSON.stringify(payload) !== JSON.stringify(envelope)) throw new ProtocolSchemaError("v2 approval payload does not match the normalized envelope");
    return { envelope, approval: { v: 2, payload } };
  }
  throw new ProtocolSchemaError("send approval binding version must be 1 or 2");
}

/** Returns the immutable approval-hash input. V1 property order and values are intentionally unchanged. */
export function sendApprovalPayload(actor: unknown, value: unknown): JsonObject {
  const parsedActor = nonEmptyString(actor, "send actor");
  const normalized = parseNormalizedSendEnvelope(value);
  if (normalized.approval.v === 1) {
    const payload = normalized.approval.payload;
    return {
      actor: parsedActor,
      scope: payload.scope,
      body: payload.body,
      ...(payload.parent_id === undefined ? {} : { parent_id: payload.parent_id }),
    };
  }
  return { actor: parsedActor, envelope: normalized.approval.payload };
}

function parseWorkerOperation(value: unknown): WorkerOperationV1 {
  const operation = object(value, "worker operation");
  if (operation.op === "read_page") {
    exactKeys(operation, ["op", "chat", "interval", "limit", "cursor"], "read_page operation");
    const interval = object(operation.interval, "read_page interval");
    exactKeys(interval, ["from_ts", "to_ts"], "read_page interval");
    const { from_ts, to_ts } = interval;
    if (typeof from_ts !== "number" || typeof to_ts !== "number" || !Number.isFinite(from_ts) || !Number.isFinite(to_ts) || from_ts >= to_ts) {
      throw new ProtocolSchemaError("read_page interval must have finite from_ts before to_ts");
    }
    const cursor = operation.cursor === null
      ? null
      : boundedUtf8String(operation.cursor, "read_page cursor", PROTOCOL_LIMITS.cursor_bytes);
    return {
      op: "read_page",
      chat: parseChatRef(operation.chat),
      interval: { from_ts, to_ts },
      limit: positiveInteger(operation.limit, "read_page limit", 100),
      cursor,
    };
  }
  if (operation.op === "send") {
    exactKeys(operation, ["op", "envelope", "idempotency_key"], "send operation");
    const idempotencyKey = nonEmptyString(operation.idempotency_key, "send idempotency_key");
    if (!/^[0-9a-f]{64}$/.test(idempotencyKey)) throw new ProtocolSchemaError("send idempotency_key must be a lowercase SHA-256 digest");
    return { op: "send", envelope: parseSendEnvelopeV2(operation.envelope), idempotency_key: idempotencyKey };
  }
  if (operation.op === "read_receipt") {
    exactKeys(operation, ["op", "destination", "receipt_id", "expected"], "read_receipt operation");
    const destination = parseResourceRef(operation.destination);
    const expected = parseSendEnvelopeV2(operation.expected);
    if (destination.kind !== "chat" || expected.destination.kind !== "chat" || expected.content.mode !== "text") {
      throw new ProtocolSchemaError("read_receipt independent readback requires a readable chat");
    }
    if (JSON.stringify(destination) !== JSON.stringify(expected.destination)) {
      throw new ProtocolSchemaError("read_receipt destination must match the expected send destination");
    }
    const readableExpected = expected as SendEnvelopeV2 & {
      readonly destination: ChatRefV1;
      readonly content: Extract<SendContentV2, { readonly mode: "text" }>;
    };
    return {
      op: "read_receipt",
      destination,
      receipt_id: boundedString(operation.receipt_id, "read_receipt receipt_id", 4_096),
      expected: readableExpected,
    };
  }
  if (operation.op === "health") {
    exactKeys(operation, ["op"], "health operation");
    return { op: "health" };
  }
  throw new ProtocolSchemaError("worker operation must be read_page, send, read_receipt, or health");
}

export function parseWorkerRequest(value: unknown): WorkerRequestV1 {
  assertEncodedJsonBytes(value, "worker request frame", PROTOCOL_LIMITS.worker_frame_bytes);
  const request = object(value, "worker request");
  exactKeys(request, ["v", "type", "request_id", "generation", "binding_id", "limits", "operation"], "worker request");
  if (request.v !== 1 || request.type !== "worker_request") throw new ProtocolSchemaError("worker request must be a version 1 worker_request");
  const limits = object(request.limits, "worker limits");
  exactKeys(limits, ["timeout_ms", "max_response_bytes", "max_queue_depth"], "worker limits");
  return {
    v: 1,
    type: "worker_request",
    request_id: boundedString(request.request_id, "worker request_id", 512),
    generation: positiveInteger(request.generation, "worker generation", Number.MAX_SAFE_INTEGER),
    binding_id: boundedString(request.binding_id, "worker binding_id", 512),
    limits: {
      timeout_ms: positiveInteger(limits.timeout_ms, "worker timeout_ms", 300_000),
      max_response_bytes: positiveInteger(limits.max_response_bytes, "worker max_response_bytes", PROTOCOL_LIMITS.worker_frame_bytes),
      max_queue_depth: positiveInteger(limits.max_queue_depth, "worker max_queue_depth", PROTOCOL_LIMITS.worker_queue_depth),
    },
    operation: parseWorkerOperation(request.operation),
  };
}

function parseRawWorkerFrame(frame: string | Uint8Array, label: string, maxBytes: number): unknown {
  const bytes = typeof frame === "string" ? utf8Encoder.encode(frame) : frame;
  if (bytes.byteLength > maxBytes) throw new ProtocolSchemaError(`${label} exceeds the ${maxBytes} byte frame limit`);
  let text: string;
  try {
    text = typeof frame === "string" ? frame : new TextDecoder("utf-8", { fatal: true }).decode(frame);
  } catch {
    throw new ProtocolSchemaError(`${label} must be valid UTF-8`);
  }
  if (text.includes("\n") || text.includes("\r")) {
    throw new ProtocolSchemaError(`${label} must be one JSON line without a line terminator`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolSchemaError(`${label} must contain valid JSON`);
  }
}

/** Parse the received request line before JSON decoding can erase wire-byte inflation. */
export function parseWorkerRequestFrame(frame: string | Uint8Array): WorkerRequestV1 {
  return parseWorkerRequest(parseRawWorkerFrame(frame, "worker request frame", PROTOCOL_LIMITS.worker_frame_bytes));
}

function jsonObjectValue(value: unknown, label: string, budget = jsonParseBudget()): { readonly [key: string]: JsonValue } {
  const parsed = parseJsonValue(value, label, budget);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ProtocolSchemaError(`${label} must be a JSON object`);
  return parsed as { readonly [key: string]: JsonValue };
}

function equalJsonValues(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((entry, index) => equalJsonValues(entry, right[index]!));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(right)) return false;
  const leftObject = left as { readonly [key: string]: JsonValue };
  const rightObject = right as { readonly [key: string]: JsonValue };
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && equalJsonValues(leftObject[key]!, rightObject[key]!));
}

function parseReceiptEvidence(value: unknown, request: WorkerRequestForOperationV1<"read_receipt">): ReceiptEvidenceV1 {
  assertEncodedJsonBytes(value, "receipt evidence", PROTOCOL_LIMITS.receipt_evidence_bytes);
  const evidence = object(value, "receipt evidence");
  exactKeys(evidence, ["destination", "receipt_id", "content", "reply"], "receipt evidence");
  const receiptId = boundedString(evidence.receipt_id, "receipt evidence receipt_id", 4_096);
  const candidate = parseSendEnvelopeV2({
    v: 2,
    destination: evidence.destination,
    content: evidence.content,
    ...(evidence.reply === undefined ? {} : { reply: evidence.reply }),
  });
  if (receiptId !== request.operation.receipt_id) throw new ProtocolSchemaError("receipt evidence receipt_id does not match the request");
  if (!equalJsonValues(candidate as unknown as JsonValue, request.operation.expected as unknown as JsonValue)) {
    throw new ProtocolSchemaError("receipt evidence destination, content, or reply does not match the request");
  }
  if (candidate.destination.kind !== "chat" || candidate.content.mode !== "text") {
    throw new ProtocolSchemaError("verified receipt evidence requires an independently readable chat");
  }
  return {
    destination: candidate.destination,
    receipt_id: receiptId,
    content: candidate.content,
    ...(candidate.reply === undefined ? {} : { reply: candidate.reply }),
  };
}

function parseWorkerResult<O extends WorkerOperationName>(
  operation: O,
  value: unknown,
  request: WorkerRequestForOperationV1<O>,
): WorkerResultByOperationV1[O] {
  const result = object(value, `${operation} worker result`);
  if (operation === "read_page") {
    exactKeys(result, ["items", "next_cursor", "authoritative"], "read_page worker result");
    const requestedLimit = (request as WorkerRequestForOperationV1<"read_page">).operation.limit;
    if (!Array.isArray(result.items) || result.items.length > requestedLimit) {
      throw new ProtocolSchemaError(`read_page items must be an array within the requested limit of ${requestedLimit}`);
    }
    const budget = jsonParseBudget();
    const items = result.items.map((item, index) => jsonObjectValue(item, `read_page item ${index}`, budget));
    const nextCursor = result.next_cursor === null
      ? null
      : boundedUtf8String(result.next_cursor, "read_page next_cursor", PROTOCOL_LIMITS.cursor_bytes);
    if (typeof result.authoritative !== "boolean") throw new ProtocolSchemaError("read_page authoritative must be boolean");
    return { items, next_cursor: nextCursor, authoritative: result.authoritative } as unknown as WorkerResultByOperationV1[O];
  }
  if (operation === "send") {
    if (result.outcome === "sent") {
      exactKeys(result, ["outcome", "receipt_id"], "sent worker result");
      return { outcome: "sent", receipt_id: boundedString(result.receipt_id, "send receipt_id", 4_096) } as unknown as WorkerResultByOperationV1[O];
    }
    if (result.outcome === "failed" || result.outcome === "uncertain") {
      exactKeys(result, ["outcome", "reason"], `${result.outcome} worker result`);
      return { outcome: result.outcome, reason: boundedString(result.reason, `send ${result.outcome} reason`, 4_096) } as unknown as WorkerResultByOperationV1[O];
    }
    throw new ProtocolSchemaError("send worker outcome must be sent, failed, or uncertain");
  }
  if (operation === "read_receipt") {
    if (result.outcome === "verified") {
      exactKeys(result, ["outcome", "evidence"], "verified receipt result");
      return {
        outcome: "verified",
        evidence: parseReceiptEvidence(result.evidence, request as WorkerRequestForOperationV1<"read_receipt">),
      } as unknown as WorkerResultByOperationV1[O];
    }
    if (result.outcome === "not_found") {
      exactKeys(result, ["outcome"], "not_found receipt result");
      return { outcome: "not_found" } as unknown as WorkerResultByOperationV1[O];
    }
    if (result.outcome === "unavailable") {
      exactKeys(result, ["outcome", "reason"], "unavailable receipt result");
      return { outcome: "unavailable", reason: boundedString(result.reason, "receipt unavailable reason", 4_096) } as unknown as WorkerResultByOperationV1[O];
    }
    throw new ProtocolSchemaError("read_receipt worker outcome must be verified, not_found, or unavailable");
  }
  exactKeys(result, ["state", "auth"], "health worker result");
  if (result.state !== "ready" && result.state !== "degraded" && result.state !== "unavailable") {
    throw new ProtocolSchemaError("health worker state is invalid");
  }
  return { state: result.state, auth: parseAuthCapability(result.auth) } as unknown as WorkerResultByOperationV1[O];
}

export function parseWorkerResponse<O extends WorkerOperationName = WorkerOperationName>(
  value: unknown,
  requestValue: unknown,
): WorkerResponseV1<O> {
  const request = parseWorkerRequest(requestValue) as WorkerRequestForOperationV1<O>;
  assertEncodedJsonBytes(value, "worker response frame", request.limits.max_response_bytes);
  const response = object(value, "worker response");
  exactKeys(response, ["v", "type", "request_id", "generation", "operation", "ok", "result", "error"], "worker response");
  if (response.v !== 1 || response.type !== "worker_response") throw new ProtocolSchemaError("worker response must be a version 1 worker_response");
  const requestId = boundedString(response.request_id, "worker response request_id", 512);
  const generation = positiveInteger(response.generation, "worker response generation", Number.MAX_SAFE_INTEGER);
  if (typeof response.operation !== "string" || !WORKER_OPERATIONS.includes(response.operation as WorkerOperationName)) {
    throw new ProtocolSchemaError("worker response operation is invalid");
  }
  const operation = response.operation as O;
  if (requestId !== request.request_id) throw new ProtocolSchemaError("worker response request_id does not match the request");
  if (generation !== request.generation) throw new ProtocolSchemaError("worker response generation does not match the request");
  if (operation !== request.operation.op) throw new ProtocolSchemaError("worker response operation does not match the request");
  if (response.ok === true) {
    if (response.error !== undefined) throw new ProtocolSchemaError("successful worker response must not contain error");
    if (response.result === undefined) throw new ProtocolSchemaError("successful worker response requires result");
    return {
      v: 1,
      type: "worker_response",
      request_id: requestId,
      generation,
      operation,
      ok: true,
      result: parseWorkerResult(operation, response.result, request),
    } as WorkerResponseV1<O>;
  }
  if (response.ok !== false) throw new ProtocolSchemaError("worker response ok must be boolean");
  if (response.result !== undefined) throw new ProtocolSchemaError("failed worker response must not contain result");
  const error = object(response.error, "worker response error");
  exactKeys(error, ["code", "message", "retryable", "may_have_sent"], "worker response error");
  if (typeof error.retryable !== "boolean" || typeof error.may_have_sent !== "boolean") {
    throw new ProtocolSchemaError("worker response error flags must be boolean");
  }
  if (operation !== "send" && error.may_have_sent) throw new ProtocolSchemaError("may_have_sent is valid only for send failures");
  if (error.may_have_sent && error.retryable) throw new ProtocolSchemaError("a possibly sent operation must not be marked retryable");
  return {
    v: 1,
    type: "worker_response",
    request_id: requestId,
    generation,
    operation,
    ok: false,
    error: {
      code: boundedString(error.code, "worker error code", 256),
      message: boundedString(error.message, "worker error message", 4_096),
      retryable: error.retryable,
      may_have_sent: error.may_have_sent,
    },
  } as WorkerResponseV1<O>;
}

/** Parse the received response line against its request's negotiated raw-byte ceiling. */
export function parseWorkerResponseFrame<O extends WorkerOperationName = WorkerOperationName>(
  frame: string | Uint8Array,
  requestValue: unknown,
): WorkerResponseV1<O> {
  const request = parseWorkerRequest(requestValue);
  const value = parseRawWorkerFrame(frame, "worker response frame", request.limits.max_response_bytes);
  return parseWorkerResponse<O>(value, request);
}

/** Aggregate scope is always explicit; cursor contents belong only to the store. */
export function parseRecentMessagesParams(value: unknown): RecentMessagesParams {
  const params = object(value, "recent params");
  exactKeys(params, ["chats", "interval", "sender", "limit", "cursor"], "recent params");
  if (!Array.isArray(params.chats) || params.chats.length < 1 || params.chats.length > 100) {
    throw new ProtocolSchemaError("chats must contain 1 to 100 explicit chat keys");
  }
  const chats = params.chats.map(value => {
    const key = object(value, "chat");
    exactKeys(key, ["platform", "account", "chat_id"], "chat");
    return { platform: nonEmptyString(key.platform, "chat.platform"), account: nonEmptyString(key.account, "chat.account"), chat_id: nonEmptyString(key.chat_id, "chat.chat_id") };
  });
  const interval = object(params.interval, "interval");
  exactKeys(interval, ["from_ts", "to_ts"], "interval");
  const { from_ts, to_ts } = interval;
  if (typeof from_ts !== "number" || typeof to_ts !== "number" || !Number.isFinite(from_ts) || !Number.isFinite(to_ts) || from_ts >= to_ts) {
    throw new ProtocolSchemaError("interval must have finite from_ts before to_ts");
  }
  const { sender, limit, cursor } = params;
  if (sender !== undefined && sender !== "all" && sender !== "self") throw new ProtocolSchemaError("sender must be all or self");
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)) throw new ProtocolSchemaError("limit must be an integer from 1 to 100");
  if (cursor !== undefined && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new ProtocolSchemaError("cursor is malformed");
  return { chats, interval: { from_ts, to_ts }, ...(sender === undefined ? {} : { sender }), ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
}

export function parseRequest(value: unknown, role?: ClientRole): ProtocolRequest {
  const frame = object(value, "request");
  if (frame.type !== "request") throw new ProtocolSchemaError("frame must be a request");
  const method = requestMethod(frame.method);
  assertApprovalAccess(method, role);
  const params = object(frame.params, "request params");
  if (method === "message.recent" || method === "message.evidence") parseRecentMessagesParams(params);
  if (method === "system.hello") {
    const declaredRole = parseRole(params.role);
    if (params.approver_token !== undefined) {
      if (declaredRole !== "approver") throw new ProtocolSchemaError("approver token may only be supplied by an approver");
      approverTokenFromHandshake(params);
    }
  }
  return {
    type: "request",
    id: nonEmptyString(frame.id, "request id"),
    method,
    params,
  };
}

export function parseResponse(value: unknown, role?: ClientRole): ProtocolResponse {
  const frame = object(value, "response");
  if (frame.type !== "response") throw new ProtocolSchemaError("frame must be a response");
  const method = requestMethod(frame.method);
  const ok = frame.ok;
  if (typeof ok !== "boolean") throw new ProtocolSchemaError("response ok must be boolean");
  const result = frame.result === undefined ? undefined : object(frame.result, "response result");
  if (
    containsApprovalCode(result)
    && (method !== "safety.intent.claimApprovalCode" || (role !== undefined && role !== "approver"))
  ) {
    throw new ProtocolSchemaError("approval code requires the dedicated approver claim response");
  }
  const error = frame.error === undefined ? undefined : object(frame.error, "response error");
  if (error !== undefined) {
    nonEmptyString(error.code, "response error code");
    nonEmptyString(error.message, "response error message");
  }
  if (ok && result === undefined) throw new ProtocolSchemaError("successful response requires a result object");
  if (!ok && error === undefined) throw new ProtocolSchemaError("failed response requires an error object");
  return { type: "response", id: nonEmptyString(frame.id, "response id"), method, ok, result, error: error as ProtocolResponse["error"] };
}

export function parseEvent(value: unknown): ProtocolEvent {
  const frame = object(value, "event");
  if (frame.type !== "event") throw new ProtocolSchemaError("frame must be an event");
  const method = nonEmptyString(frame.method, "event method");
  if (!eventMethods.has(method)) throw new ProtocolSchemaError(`unknown event method: ${method}`);
  return { type: "event", method: method as ProtocolEventMethod, params: object(frame.params, "event params") };
}

export function parseMessage(value: unknown, role?: ClientRole): ProtocolMessage {
  const frame = object(value, "frame");
  switch (frame.type) {
    case "request": return parseRequest(frame, role);
    case "response": return parseResponse(frame, role);
    case "event": return parseEvent(frame);
    default: throw new ProtocolSchemaError("frame type must be request, response, or event");
  }
}
