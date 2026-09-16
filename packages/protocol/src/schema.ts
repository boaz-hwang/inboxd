export const REQUEST_METHODS = [
  "system.hello",
  "system.ping",
  "system.status",
  "chat.list",
  "message.inbox",
  "message.get",
  "message.search",
  "sync.status",
  "sync.backfill",
  "auth.status",
  "safety.intent.create",
  "safety.intent.listPending",
  "safety.intent.approve",
  "safety.intent.reject",
  "send.status",
  "settings.get",
  "settings.update",
  "subscribe",
] as const;

export const EVENT_METHODS = [
  "message.upserted",
  "coverage.changed",
  "safety.intent.changed",
] as const;

export type ProtocolMethod = (typeof REQUEST_METHODS)[number];
export type ProtocolEventMethod = (typeof EVENT_METHODS)[number];
export type ClientRole = "reader" | "agent" | "mcp" | "approver";
export type JsonObject = Record<string, unknown>;

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

export function createHandshake(
  role: ClientRole,
  isTTY: () => boolean = () => Boolean((globalThis as { process?: { stdout?: { isTTY?: boolean } } }).process?.stdout?.isTTY),
): JsonObject {
  if (role === "approver" && !isTTY()) {
    throw new ProtocolSchemaError("approver role requires a local TTY");
  }
  return { role };
}

export function parseRequest(value: unknown, role?: ClientRole): ProtocolRequest {
  const frame = object(value, "request");
  if (frame.type !== "request") throw new ProtocolSchemaError("frame must be a request");
  const method = requestMethod(frame.method);
  assertApprovalAccess(method, role);
  const params = object(frame.params, "request params");
  if (method === "system.hello") parseRole(params.role);
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
  if (role !== undefined && role !== "approver" && containsApprovalCode(result)) {
    throw new ProtocolSchemaError("approval code may only be sent to an approver");
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
