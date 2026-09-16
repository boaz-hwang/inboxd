import { createServer, type Server, type Socket } from "node:net";
import { chmodSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import type { Database } from "bun:sqlite";
import { getMessage, inboxMessages, searchMessages } from "../../store/src/queries.ts";
import { createSafetyService, type SafetyService, type SendScope } from "../../safety/src/index.ts";
import { encodeJsonLine, JsonLinesDecoder } from "../../protocol/src/framing.ts";
import { approverTokenFromHandshake, parseRequest, parseRole, type ClientRole, type ProtocolEvent, type ProtocolEventMethod, type ProtocolMethod, type ProtocolResponse } from "../../protocol/src/schema.ts";
import { SubscriptionQueue } from "../../protocol/src/subscriptions.ts";

export interface DaemonServer {
  listen(socketPath: string): Promise<void>;
  close(): Promise<void>;
  publish(event: ProtocolEvent): void;
}

export type TrustedApproverSessionAuthorizer = (session: { readonly socket: Socket; readonly role: "approver"; readonly approverToken?: string }) => boolean;

export interface DaemonServerOptions {
  readonly safety?: SafetyService;
  readonly backfill?: (request: { readonly chat: { readonly platform: string; readonly account: string; readonly chat_id: string }; readonly interval: { readonly from_ts: number; readonly to_ts: number } }) => Promise<Record<string, unknown>>;
  /** Defaults to deny: a claimed protocol role is not trusted local authorization. */
  readonly isTrustedApproverSession?: TrustedApproverSessionAuthorizer;
}

interface Connection {
  readonly sessionId: string;
  readonly socket: Socket;
  role?: ClientRole;
  trustedApprover: boolean;
  readonly topics: Set<ProtocolEventMethod>;
  readonly queue: SubscriptionQueue;
}

class BadRequestError extends Error {
  constructor(message: string) { super(message); this.name = "BadRequestError"; }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BadRequestError(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new BadRequestError(`${label} must be a non-empty string`);
  return value;
}
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new BadRequestError(`${label} must be a finite number`);
  return value;
}
function chat(params: Record<string, unknown>): { platform: string; account: string; chat_id: string } {
  const value = object(params.chat, "chat");
  return { platform: string(value.platform, "chat.platform"), account: string(value.account, "chat.account"), chat_id: string(value.chat_id, "chat.chat_id") };
}
function interval(params: Record<string, unknown>): { from_ts: number; to_ts: number } {
  // Older local clients asked for the full retained chat without an interval.
  // Preserve that read shape while still returning explicit evidence.
  if (params.interval === undefined) return { from_ts: 0, to_ts: Number.MAX_SAFE_INTEGER };
  const value = object(params.interval, "interval");
  const from_ts = number(value.from_ts, "interval.from_ts");
  const to_ts = number(value.to_ts, "interval.to_ts");
  if (from_ts >= to_ts) throw new BadRequestError("interval.from_ts must be before interval.to_ts");
  return { from_ts, to_ts };
}
function parseBackfillRequest(params: Record<string, unknown>): { chat: { platform: string; account: string; chat_id: string }; interval: { from_ts: number; to_ts: number } } {
  if (params.chat !== undefined) return { chat: chat(params), interval: interval(params) };
  const from_ts = number(params.from_ts, "from_ts");
  const to_ts = number(params.to_ts, "to_ts");
  if (from_ts >= to_ts) throw new BadRequestError("from_ts must be before to_ts");
  return {
    chat: { platform: string(params.platform, "platform"), account: string(params.account, "account"), chat_id: string(params.chat_id, "chat_id") },
    interval: { from_ts, to_ts },
  };
}
function page(params: Record<string, unknown>): { limit?: number; cursor?: string } {
  const limit = params.limit === undefined ? undefined : number(params.limit, "limit");
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    throw new BadRequestError("limit must be an integer from 1 to 100");
  }
  const cursor = params.cursor === undefined ? undefined : string(params.cursor, "cursor");
  if (cursor !== undefined && (cursor.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new BadRequestError("cursor is malformed");
  return { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
}

const chatCursorScope = "chat.list:v1";
interface ChatCursor { readonly v: 1; readonly scope: string; readonly platform: string; readonly account: string; readonly chat_id: string; }
function encodeChatCursor(row: Omit<ChatCursor, "v" | "scope">): string {
  const { platform, account, chat_id } = row;
  return Buffer.from(JSON.stringify({ v: 1, scope: chatCursorScope, platform, account, chat_id } satisfies ChatCursor)).toString("base64url");
}
function decodeChatCursor(value: string | undefined): ChatCursor | undefined {
  if (value === undefined) return undefined;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new BadRequestError("cursor is malformed"); }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new BadRequestError("cursor is malformed");
  const cursor = decoded as Partial<ChatCursor>;
  const fields = [cursor.platform, cursor.account, cursor.chat_id];
  if (cursor.v !== 1 || cursor.scope !== chatCursorScope || fields.some((field) => typeof field !== "string" || field.length === 0)) {
    throw new BadRequestError("cursor does not match chat.list");
  }
  const stable: ChatCursor = { v: 1, scope: chatCursorScope, platform: cursor.platform!, account: cursor.account!, chat_id: cursor.chat_id! };
  if (encodeChatCursor(stable) !== value) throw new BadRequestError("cursor is malformed");
  return stable;
}
function scope(value: unknown): SendScope {
  const parsed = object(value, "scope");
  return { platform: string(parsed.platform, "scope.platform"), account: string(parsed.account, "scope.account"), chat_id: string(parsed.chat_id, "scope.chat_id") };
}
function response(id: string, method: ProtocolMethod, result: Record<string, unknown>): ProtocolResponse {
  return { type: "response", id, method, ok: true, result };
}
function failure(id: string, method: ProtocolMethod, code: string, message: string): ProtocolResponse {
  return { type: "response", id, method, ok: false, error: { code, message } };
}

/** UDS-only protocol surface. Database ownership never crosses this boundary. */
export function createDaemonServer(database: Database, maxQueuedEvents?: number, options: DaemonServerOptions = {}): DaemonServer {
  const safety = options.safety ?? createSafetyService(database);
  const authorizeApprover = options.isTrustedApproverSession ?? (() => false);
  const connections = new Set<Connection>();

  function publish(event: ProtocolEvent): void {
    for (const connection of connections) {
      if (connection.topics.has(event.method)) connection.queue.enqueue(event);
    }
  }

  function publishSafety(intentId: string): void {
    const intent = safety.getIntent(intentId);
    if (intent !== undefined) publish({ type: "event", method: "safety.intent.changed", params: { intent_id: intentId, state: intent.state } });
  }

  function auditRead(connection: Connection, action: string, subject: string, resultCount: number): void {
    database.run(
      "INSERT INTO audit (action, subject, payload_json, created_at) VALUES (?, ?, ?, ?)",
      [action, createHash("sha256").update(subject).digest("hex"), JSON.stringify({ role: connection.role, session_id: connection.sessionId, result_count: resultCount }), Date.now()],
    );
  }

  const server: Server = createServer((socket) => {
    const decoder = new JsonLinesDecoder();
    const connection: Connection = {
      sessionId: randomUUID(),
      socket,
      trustedApprover: false,
      topics: new Set(),
      queue: new SubscriptionQueue({
        maxQueuedEvents,
        onEvent: (event) => { if (!socket.destroyed) socket.write(encodeJsonLine(event)); },
        onOverflow: () => socket.destroy(),
      }),
    };
    connections.add(connection);
    socket.on("close", () => connections.delete(connection));
    socket.on("error", () => connections.delete(connection));
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) void handle(connection, frame);
      } catch (error) {
        socket.write(encodeJsonLine(failure("invalid", "system.ping", "BAD_REQUEST", error instanceof Error ? error.message : "invalid protocol request")));
        socket.destroy();
      }
    });
  });

  async function handle(connection: Connection, frame: unknown): Promise<void> {
    let request: ReturnType<typeof parseRequest>;
    try { request = parseRequest(frame, connection.role); } catch (error) {
      const raw = frame as { id?: unknown; method?: unknown };
      const method = typeof raw?.method === "string" ? raw.method as ProtocolMethod : "system.ping";
      connection.socket.write(encodeJsonLine(failure(typeof raw?.id === "string" ? raw.id : "invalid", method, "BAD_REQUEST", error instanceof Error ? error.message : "invalid protocol request")));
      return;
    }
    try {
      const result = await dispatch(connection, request.method, request.params);
      connection.socket.write(encodeJsonLine(response(request.id, request.method, result)));
    } catch (error) {
      connection.socket.write(encodeJsonLine(failure(request.id, request.method, error instanceof BadRequestError ? "BAD_REQUEST" : "UNSUPPORTED", error instanceof Error ? error.message : "unsupported request")));
    }
  }

  function assertTrustedApprover(connection: Connection): void {
    if (connection.role !== "approver") throw new Error("approver role is required");
    if (!connection.trustedApprover) throw new Error("trusted local approver authorization is required");
  }

  async function dispatch(connection: Connection, method: ProtocolMethod, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method === "system.hello") {
      const role = parseRole(params.role);
      connection.role = role;
      connection.trustedApprover = role === "approver" && authorizeApprover({ socket: connection.socket, role, approverToken: approverTokenFromHandshake(params) });
      return { protocol: "inboxd", ready: true };
    }
    if (!connection.role) throw new Error("system.hello is required before API requests");
    switch (method) {
      case "system.ping": return { pong: true };
      case "system.status": return { ready: true, owner: "daemon" };
      case "chat.list": {
        const requested = page(params);
        const limit = requested.limit ?? 50;
        const cursor = decodeChatCursor(requested.cursor);
        const cursorWhere = cursor === undefined ? "" : " WHERE (platform > ? OR (platform = ? AND account > ?) OR (platform = ? AND account = ? AND chat_id > ?))";
        const rows = database.query(`SELECT platform, account, chat_id, display_name FROM chats${cursorWhere} ORDER BY platform, account, chat_id LIMIT ?`)
          .all(...(cursor === undefined ? [] : [cursor.platform, cursor.platform, cursor.account, cursor.platform, cursor.account, cursor.chat_id]), limit + 1) as { platform: string; account: string; chat_id: string; display_name: string | null }[];
        const chats = rows.slice(0, limit);
        const final = chats.at(-1);
        auditRead(connection, "read.chat_list", "all-chats", chats.length);
        return { chats, ...(rows.length > limit && final !== undefined ? { next_cursor: encodeChatCursor(final) } : {}) };
      }
      case "message.inbox": {
        const key = chat(params);
        const found = inboxMessages(database, { chat: key, interval: interval(params), ...page(params) });
        auditRead(connection, "read.inbox", `${key.platform}\0${key.account}\0${key.chat_id}`, found.messages.length);
        return { messages: found.messages, coverage: found.coverage, ...(found.next_cursor === undefined ? {} : { next_cursor: found.next_cursor }) };
      }
      case "message.get": {
        const key = { ...chat(params), msg_id: string(params.msg_id, "msg_id") };
        const message = getMessage(database, key);
        auditRead(connection, "read.message", `${key.platform}\0${key.account}\0${key.chat_id}\0${key.msg_id}`, message === null ? 0 : 1);
        return { message };
      }
      case "message.search": {
        const key = chat(params);
        const found = searchMessages(database, { chat: key, interval: interval(params), query: string(params.query, "query"), ...page(params) });
        auditRead(connection, "read.search", `${key.platform}\0${key.account}\0${key.chat_id}`, found.messages.length);
        return { messages: found.messages, coverage: found.coverage, ...(found.next_cursor === undefined ? {} : { next_cursor: found.next_cursor }) };
      }
      case "sync.backfill": {
        if (options.backfill === undefined) throw new Error("sync.backfill is unavailable because no adapter is configured");
        const requested = parseBackfillRequest(params);
        const result = await options.backfill(requested);
        publish({ type: "event", method: "coverage.changed", params: { chat: requested.chat } });
        return result;
      }
      case "sync.status": return { state: "idle" };
      case "auth.status": return { authenticated: false };
      case "safety.intent.create": {
        const created = safety.propose({ actor: string(params.actor, "actor"), scope: scope(params.scope), body: string(params.body, "body"), ...(params.parent_id === undefined ? {} : { parent_id: string(params.parent_id, "parent_id") }) });
        publishSafety(created.intent_id);
        // Deliberately return only the non-secret proposal receipt; code stays at the approver boundary.
        return { ...created };
      }
      case "safety.intent.listPending": {
        assertTrustedApprover(connection);
        const found = safety.listPendingPage(page(params));
        auditRead(connection, "read.safety_intent_list", "pending-intents", found.intents.length);
        return { intents: found.intents, ...(found.next_cursor === undefined ? {} : { next_cursor: found.next_cursor }) };
      }
      case "safety.intent.approve": {
        assertTrustedApprover(connection);
        const intentId = string(params.intent_id, "intent_id");
        const approved = await safety.approve({ intentId, code: string(params.code, "code"), actor: string(params.actor, "actor"), scope: scope(params.scope) });
        publishSafety(intentId);
        const outcome = safety.hasTransport() ? await safety.execute(intentId) : approved;
        publishSafety(intentId);
        return { ...outcome };
      }
      case "safety.intent.reject": {
        assertTrustedApprover(connection);
        const intentId = string(params.intent_id, "intent_id");
        const rejected = safety.reject(intentId);
        publishSafety(intentId);
        return { ...rejected };
      }
      case "send.status": {
        const row = database.query("SELECT id, state, created_at FROM sends WHERE id = ?").get(string(params.id, "id")) as { id: string; state: string; created_at: number } | null;
        return row === null ? { state: "missing" } : row;
      }
      case "subscribe": {
        const topics = params.topics;
        if (!Array.isArray(topics) || topics.some((topic) => topic !== "message.upserted" && topic !== "coverage.changed" && topic !== "safety.intent.changed")) throw new Error("subscribe topics must be protocol event methods");
        connection.topics.clear();
        for (const topic of topics) connection.topics.add(topic as ProtocolEventMethod);
        return { subscribed: [...connection.topics] };
      }
      default: throw new Error(`${method} is unsupported by this daemon`);
    }
  }

  return {
    listen: (socketPath) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        try {
          // UDS requests contain message content and approval operations. Do not
          // rely on an inherited umask to keep other local users out.
          chmodSync(socketPath, 0o600);
          server.removeListener("error", reject);
          resolve();
        } catch (error) {
          server.close(() => reject(error));
        }
      });
    }),
    close: () => new Promise((resolve, reject) => {
      for (const connection of connections) connection.socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
    publish,
  };
}
