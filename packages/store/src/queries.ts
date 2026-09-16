import type { Database } from "bun:sqlite";

import type { Coverage, CoverageTarget } from "../../core/src/coverage.ts";
import type { ChatKey, MessageKey } from "../../core/src/models.ts";
import { coverageFor } from "./coverage.ts";

export interface StoredMessage {
  readonly platform: string; readonly account: string; readonly chat_id: string; readonly msg_id: string;
  readonly author_id: string | null; readonly ts: number; readonly body: string | null;
  readonly edited_at: number | null; readonly deleted_at: number | null; readonly revision: string | number;
}
export interface PageInput { readonly limit?: number; readonly cursor?: string; }
export interface SearchMessagesInput extends CoverageTarget, PageInput { readonly query: string; }
export interface SearchMessagesResult { readonly messages: readonly StoredMessage[]; readonly coverage: Coverage; readonly next_cursor?: string; }
export interface InboxMessagesInput extends CoverageTarget, PageInput {}
export interface InboxMessagesResult { readonly messages: readonly StoredMessage[]; readonly coverage: Coverage; readonly next_cursor?: string; }

interface MessageRow extends Omit<StoredMessage, "revision"> { readonly revision_kind: "number" | "string"; readonly revision_value: string; }
function messageFromRow(row: MessageRow): StoredMessage {
  const { revision_kind, revision_value, ...message } = row;
  return { ...message, revision: revision_kind === "number" ? Number(revision_value) : revision_value };
}
function chatValues(chat: ChatKey): [string, string, string] { return [chat.platform, chat.account, chat.chat_id]; }
function ftsPhrase(query: string): string { return `"${query.replaceAll('"', '""')}"`; }
function escapeLike(query: string): string { return query.replace(/[\\%_]/g, "\\$&"); }

const defaultPageLimit = 50;
const maximumPageLimit = 100;
const maximumCursorLength = 4_096;
const maximumQueryCodePoints = 1_024;
interface CursorPayload { readonly v: 1; readonly scope: string; readonly ts: number; readonly msg_id: string; }

function pageLimit(value: number | undefined): number {
  if (value === undefined) return defaultPageLimit;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumPageLimit) {
    throw new Error(`limit must be an integer from 1 to ${maximumPageLimit}`);
  }
  return value;
}

function cursorScope(input: CoverageTarget, query?: string): string {
  return JSON.stringify({ chat: input.chat, interval: input.interval, ...(query === undefined ? {} : { query }) });
}

function encodeCursor(scope: string, row: MessageRow): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, ts: row.ts, msg_id: row.msg_id } satisfies CursorPayload)).toString("base64url");
}

function decodeCursor(cursor: string | undefined, scope: string): CursorPayload | undefined {
  if (cursor === undefined) return undefined;
  if (cursor.length === 0 || cursor.length > maximumCursorLength || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("cursor is malformed");
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("cursor is malformed"); }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("cursor is malformed");
  const value = payload as Partial<CursorPayload>;
  if (value.v !== 1 || value.scope !== scope || !Number.isFinite(value.ts) || typeof value.msg_id !== "string" || value.msg_id.length === 0) {
    throw new Error("cursor does not match this query");
  }
  // Reject non-canonical aliases so callers cannot smuggle oversized or ambiguous encodings.
  if (encodeCursor(scope, { ...value, ts: value.ts, msg_id: value.msg_id } as MessageRow) !== cursor) throw new Error("cursor is malformed");
  return value as CursorPayload;
}

function pagedResult(rows: MessageRow[], limit: number, scope: string): { readonly messages: readonly StoredMessage[]; readonly next_cursor?: string } {
  const page = rows.slice(0, limit);
  const final = page.at(-1);
  return { messages: page.map(messageFromRow), ...(rows.length > limit && final !== undefined ? { next_cursor: encodeCursor(scope, final) } : {}) };
}

export function getMessage(database: Database, key: MessageKey): StoredMessage | null {
  const row = database.query(`SELECT platform, account, chat_id, msg_id, author_id, ts, body, edited_at, deleted_at, revision_kind, revision_value
    FROM messages WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?`).get(key.platform, key.account, key.chat_id, key.msg_id) as MessageRow | null;
  return row === null ? null : messageFromRow(row);
}

/** Lists visible messages and preserves evidence for exactly the requested interval. */
export function inboxMessages(database: Database, input: InboxMessagesInput): InboxMessagesResult {
  const limit = pageLimit(input.limit);
  const scope = cursorScope(input);
  const cursor = decodeCursor(input.cursor, scope);
  const cursorWhere = cursor === undefined ? "" : " AND (ts > ? OR (ts = ? AND msg_id > ?))";
  const rows = database.query(`SELECT platform, account, chat_id, msg_id, author_id, ts, body, edited_at, deleted_at, revision_kind, revision_value
    FROM messages WHERE platform = ? AND account = ? AND chat_id = ? AND ts >= ? AND ts < ? AND deleted_at IS NULL${cursorWhere} ORDER BY ts, msg_id LIMIT ?`)
    .all(...chatValues(input.chat), input.interval.from_ts, input.interval.to_ts, ...(cursor === undefined ? [] : [cursor.ts, cursor.ts, cursor.msg_id]), limit + 1) as MessageRow[];
  return { ...pagedResult(rows, limit, scope), coverage: coverageFor(database, input) };
}

/** Searches visible messages and always returns coverage for the same half-open target. */
export function searchMessages(database: Database, input: SearchMessagesInput): SearchMessagesResult {
  const codePoints = Array.from(input.query).length;
  if (codePoints === 0 || codePoints > maximumQueryCodePoints) {
    throw new Error(`query must contain from 1 to ${maximumQueryCodePoints} Unicode code points`);
  }
  const limit = pageLimit(input.limit);
  const scope = cursorScope(input, input.query);
  const cursor = decodeCursor(input.cursor, scope);
  const where = `m.platform = ? AND m.account = ? AND m.chat_id = ? AND m.ts >= ? AND m.ts < ? AND m.deleted_at IS NULL${cursor === undefined ? "" : " AND (m.ts > ? OR (m.ts = ? AND m.msg_id > ?))"}`;
  const parameters: (string | number)[] = [...chatValues(input.chat), input.interval.from_ts, input.interval.to_ts];
  if (cursor !== undefined) parameters.push(cursor.ts, cursor.ts, cursor.msg_id);
  let sql = `SELECT m.platform, m.account, m.chat_id, m.msg_id, m.author_id, m.ts, m.body, m.edited_at, m.deleted_at, m.revision_kind, m.revision_value FROM messages m`;
  if (codePoints >= 3) {
    sql += ` JOIN messages_fts ON messages_fts.platform = m.platform AND messages_fts.account = m.account AND messages_fts.chat_id = m.chat_id AND messages_fts.msg_id = m.msg_id WHERE ${where} AND messages_fts MATCH ?`;
    parameters.push(ftsPhrase(input.query));
  } else {
    sql += ` WHERE ${where} AND m.body LIKE ? ESCAPE '\\'`;
    parameters.push(`%${escapeLike(input.query)}%`);
  }
  sql += " ORDER BY m.ts, m.msg_id LIMIT ?";
  parameters.push(limit + 1);
  const rows = database.query(sql).all(...parameters) as MessageRow[];
  return { ...pagedResult(rows, limit, scope), coverage: coverageFor(database, input) };
}
