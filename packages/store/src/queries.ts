import type { Database } from "bun:sqlite";

import type { Coverage, CoverageTarget } from "../../core/src/coverage.ts";
import type { ChatKey, MessageKey } from "../../core/src/models.ts";
import { coverageFor } from "./coverage.ts";

export interface StoredMessage {
  readonly platform: string; readonly account: string; readonly chat_id: string; readonly msg_id: string;
  readonly author_id: string | null; readonly ts: number; readonly body: string | null;
  readonly edited_at: number | null; readonly deleted_at: number | null; readonly revision: string | number;
}
export interface SearchMessagesInput extends CoverageTarget { readonly query: string; }
export interface SearchMessagesResult { readonly messages: readonly StoredMessage[]; readonly coverage: Coverage; }

interface MessageRow extends Omit<StoredMessage, "revision"> { readonly revision_kind: "number" | "string"; readonly revision_value: string; }
function messageFromRow(row: MessageRow): StoredMessage {
  const { revision_kind, revision_value, ...message } = row;
  return { ...message, revision: revision_kind === "number" ? Number(revision_value) : revision_value };
}
function chatValues(chat: ChatKey): [string, string, string] { return [chat.platform, chat.account, chat.chat_id]; }
function ftsPhrase(query: string): string { return `"${query.replaceAll('"', '""')}"`; }
function escapeLike(query: string): string { return query.replace(/[\\%_]/g, "\\$&"); }

export function getMessage(database: Database, key: MessageKey): StoredMessage | null {
  const row = database.query(`SELECT platform, account, chat_id, msg_id, author_id, ts, body, edited_at, deleted_at, revision_kind, revision_value
    FROM messages WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?`).get(key.platform, key.account, key.chat_id, key.msg_id) as MessageRow | null;
  return row === null ? null : messageFromRow(row);
}

/** Searches visible messages and always returns coverage for the same half-open target. */
export function searchMessages(database: Database, input: SearchMessagesInput): SearchMessagesResult {
  const codePoints = Array.from(input.query).length;
  const where = `m.platform = ? AND m.account = ? AND m.chat_id = ? AND m.ts >= ? AND m.ts < ? AND m.deleted_at IS NULL`;
  const parameters: (string | number)[] = [...chatValues(input.chat), input.interval.from_ts, input.interval.to_ts];
  let sql = `SELECT m.platform, m.account, m.chat_id, m.msg_id, m.author_id, m.ts, m.body, m.edited_at, m.deleted_at, m.revision_kind, m.revision_value FROM messages m`;
  if (codePoints >= 3) {
    sql += ` JOIN messages_fts ON messages_fts.platform = m.platform AND messages_fts.account = m.account AND messages_fts.chat_id = m.chat_id AND messages_fts.msg_id = m.msg_id WHERE ${where} AND messages_fts MATCH ?`;
    parameters.push(ftsPhrase(input.query));
  } else {
    sql += ` WHERE ${where} AND m.body LIKE ? ESCAPE '\\'`;
    parameters.push(`%${escapeLike(input.query)}%`);
  }
  sql += " ORDER BY m.ts, m.msg_id";
  const rows = database.query(sql).all(...parameters) as MessageRow[];
  return { messages: rows.map(messageFromRow), coverage: coverageFor(database, input) };
}
