import { createServer, type Server, type Socket } from "node:net";

import type { Database } from "bun:sqlite";
import { getMessage, searchMessages } from "../../store/src/queries.ts";
import { encodeJsonLine, JsonLinesDecoder } from "../../protocol/src/framing.ts";
import { parseRequest, parseRole, type ClientRole, type ProtocolEvent, type ProtocolEventMethod, type ProtocolMethod, type ProtocolResponse } from "../../protocol/src/schema.ts";
import { SubscriptionQueue } from "../../protocol/src/subscriptions.ts";

export interface DaemonServer {
  listen(socketPath: string): Promise<void>;
  close(): Promise<void>;
  publish(event: ProtocolEvent): void;
}

interface Connection {
  readonly socket: Socket;
  role?: ClientRole;
  readonly topics: Set<ProtocolEventMethod>;
  readonly queue: SubscriptionQueue;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}
function chat(params: Record<string, unknown>): { platform: string; account: string; chat_id: string } {
  const value = object(params.chat, "chat");
  return { platform: string(value.platform, "chat.platform"), account: string(value.account, "chat.account"), chat_id: string(value.chat_id, "chat.chat_id") };
}
function response(id: string, method: ProtocolMethod, result: Record<string, unknown>): ProtocolResponse {
  return { type: "response", id, method, ok: true, result };
}
function failure(id: string, method: ProtocolMethod, code: string, message: string): ProtocolResponse {
  return { type: "response", id, method, ok: false, error: { code, message } };
}

/** UDS-only protocol surface. Database ownership never crosses this boundary. */
export function createDaemonServer(database: Database, maxQueuedEvents?: number): DaemonServer {
  const connections = new Set<Connection>();
  const server: Server = createServer((socket) => {
    const decoder = new JsonLinesDecoder();
    const connection: Connection = {
      socket,
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
        for (const frame of decoder.push(chunk)) handle(connection, frame);
      } catch (error) {
        socket.write(encodeJsonLine(failure("invalid", "system.ping", "BAD_REQUEST", error instanceof Error ? error.message : "invalid protocol request")));
        socket.destroy();
      }
    });
  });

  function handle(connection: Connection, frame: unknown): void {
    let request: ReturnType<typeof parseRequest>;
    try { request = parseRequest(frame, connection.role); } catch (error) {
      const raw = frame as { id?: unknown; method?: unknown };
      const method = typeof raw?.method === "string" ? raw.method as ProtocolMethod : "system.ping";
      connection.socket.write(encodeJsonLine(failure(typeof raw?.id === "string" ? raw.id : "invalid", method, "BAD_REQUEST", error instanceof Error ? error.message : "invalid protocol request")));
      return;
    }
    try {
      const result = dispatch(connection, request.method, request.params);
      connection.socket.write(encodeJsonLine(response(request.id, request.method, result)));
    } catch (error) {
      connection.socket.write(encodeJsonLine(failure(request.id, request.method, "UNSUPPORTED", error instanceof Error ? error.message : "unsupported request")));
    }
  }

  function dispatch(connection: Connection, method: ProtocolMethod, params: Record<string, unknown>): Record<string, unknown> {
    if (method === "system.hello") {
      connection.role = parseRole(params.role);
      return { protocol: "inboxd", ready: true };
    }
    if (!connection.role) throw new Error("system.hello is required before API requests");
    switch (method) {
      case "system.ping": return { pong: true };
      case "system.status": return { ready: true, owner: "daemon" };
      case "chat.list": {
        const rows = database.query("SELECT platform, account, chat_id, display_name FROM chats ORDER BY platform, account, chat_id").all();
        return { chats: rows };
      }
      case "message.inbox": {
        const key = chat(params);
        const rows = database.query("SELECT platform, account, chat_id, msg_id, author_id, ts, body, edited_at, deleted_at, revision_kind, revision_value FROM messages WHERE platform = ? AND account = ? AND chat_id = ? AND deleted_at IS NULL ORDER BY ts, msg_id").all(key.platform, key.account, key.chat_id);
        return { messages: rows };
      }
      case "message.get": {
        const key = { ...chat(params), msg_id: string(params.msg_id, "msg_id") };
        return { message: getMessage(database, key) };
      }
      case "message.search": {
        const interval = object(params.interval, "interval");
        const found = searchMessages(database, { chat: chat(params), interval: { from_ts: number(interval.from_ts, "interval.from_ts"), to_ts: number(interval.to_ts, "interval.to_ts") }, query: string(params.query, "query") });
        return { messages: found.messages, coverage: found.coverage };
      }
      case "sync.status": return { state: "idle" };
      case "auth.status": return { authenticated: false };
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
      server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
    }),
    close: () => new Promise((resolve, reject) => {
      for (const connection of connections) connection.socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
    publish: (event) => {
      for (const connection of connections) {
        if (connection.topics.has(event.method)) connection.queue.enqueue(event);
      }
    },
  };
}
