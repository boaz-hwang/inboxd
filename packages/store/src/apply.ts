import type { Database } from "bun:sqlite";

import { normalizeMessageEvent, type AdapterRevision, type ChatKey, type NormalizedMessageEvent } from "../../core/src/models.ts";
import type { CoverageLimit, CoverageSegment } from "../../core/src/coverage.ts";

export interface SyncCursorUpdate {
  readonly chat: ChatKey;
  readonly cursor: string;
  readonly updated_at: number;
}

export interface ApplySyncBatchInput {
  readonly events?: readonly unknown[];
  readonly sync?: SyncCursorUpdate;
  readonly coverage?: readonly CoverageSegment[];
  readonly limits?: readonly CoverageLimit[];
}

interface StoredMessage {
  readonly revision_kind: "number" | "string";
  readonly revision_value: string;
  readonly deleted_at: number | null;
}

function revisionParts(revision: AdapterRevision): { kind: "number" | "string"; value: string } {
  return typeof revision.value === "number"
    ? { kind: "number", value: String(revision.value) }
    : { kind: "string", value: revision.value };
}

function compareRevision(stored: StoredMessage, incoming: AdapterRevision): number {
  // A serialized revisionless reread is newer evidence for a live row, but it
  // cannot prove that a privacy-preserving tombstone should be resurrected.
  if (incoming.source === "observation") return stored.deleted_at === null ? 1 : -1;
  const next = revisionParts(incoming);
  if (stored.revision_kind !== next.kind) {
    throw new TypeError("adapter revision type changed for an existing message");
  }
  if (next.kind === "number") return Number(next.value) - Number(stored.revision_value);
  return next.value === stored.revision_value ? 0 : next.value > stored.revision_value ? 1 : -1;
}

function ensureChat(database: Database, chat: ChatKey): void {
  database.run("INSERT OR IGNORE INTO chats (platform, account, chat_id) VALUES (?, ?, ?)", [chat.platform, chat.account, chat.chat_id]);
}

function removeFromFts(database: Database, key: ChatKey & { msg_id: string }): void {
  database.run("DELETE FROM messages_fts WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?", [key.platform, key.account, key.chat_id, key.msg_id]);
}

function indexMessage(database: Database, key: ChatKey & { msg_id: string }, body: string): void {
  removeFromFts(database, key);
  database.run("INSERT INTO messages_fts (platform, account, chat_id, msg_id, body) VALUES (?, ?, ?, ?, ?)", [key.platform, key.account, key.chat_id, key.msg_id, body]);
}

function existingMessage(database: Database, key: ChatKey & { msg_id: string }): StoredMessage | null {
  return database.query("SELECT revision_kind, revision_value, deleted_at FROM messages WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?")
    .get(key.platform, key.account, key.chat_id, key.msg_id) as StoredMessage | null;
}

function applyEvent(database: Database, event: NormalizedMessageEvent): void {
  const key = event.kind === "create" ? event.message.key : event.kind === "edit" ? event.key : event.tombstone.key;
  ensureChat(database, key);
  const existing = existingMessage(database, key);

  // A tombstone never yields to a replayed create/edit; deletion is privacy-preserving state.
  if (existing !== null && existing.deleted_at !== null && event.kind !== "delete") return;

  if (event.kind === "delete") {
    if (existing !== null && existing.deleted_at !== null) return;
    if (existing !== null && compareRevision(existing, event.revision) < 0) return;
    const revision = revisionParts(event.revision);
    removeFromFts(database, key);
    if (existing) {
      database.run(`UPDATE messages SET body = NULL, deleted_at = ?, revision_kind = ?, revision_value = ?
        WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?`, [event.tombstone.deleted_at, revision.kind, revision.value, key.platform, key.account, key.chat_id, key.msg_id]);
    } else {
      database.run(`INSERT INTO messages (platform, account, chat_id, msg_id, ts, body, deleted_at, revision_kind, revision_value)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`, [key.platform, key.account, key.chat_id, key.msg_id, event.tombstone.deleted_at, event.tombstone.deleted_at, revision.kind, revision.value]);
    }
    return;
  }

  if (existing && compareRevision(existing, event.revision) <= 0) return;
  if (event.kind === "edit") {
    if (!existing) return;
    const revision = revisionParts(event.revision);
    database.run(`UPDATE messages SET body = ?, edited_at = ?, revision_kind = ?, revision_value = ?
      WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?`, [event.body, event.edited_at, revision.kind, revision.value, key.platform, key.account, key.chat_id, key.msg_id]);
    indexMessage(database, key, event.body);
    return;
  }

  const message = event.message;
  const revision = revisionParts(event.revision);
  database.run(`INSERT INTO messages (
      platform, account, chat_id, msg_id, author_id, ts, body, parent_platform, parent_account, parent_chat_id, parent_msg_id,
      attachments_json, edited_at, deleted_at, revision_kind, revision_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(platform, account, chat_id, msg_id) DO UPDATE SET
      author_id = excluded.author_id, ts = excluded.ts, body = excluded.body,
      parent_platform = excluded.parent_platform, parent_account = excluded.parent_account, parent_chat_id = excluded.parent_chat_id, parent_msg_id = excluded.parent_msg_id,
      attachments_json = excluded.attachments_json, edited_at = excluded.edited_at, revision_kind = excluded.revision_kind, revision_value = excluded.revision_value`, [
    key.platform, key.account, key.chat_id, key.msg_id, message.author_id, message.ts, message.body,
    message.parent_id?.platform ?? null, message.parent_id?.account ?? null, message.parent_id?.chat_id ?? null, message.parent_id?.msg_id ?? null,
    JSON.stringify(message.attachments), message.edited_at ?? null, revision.kind, revision.value,
  ]);
  indexMessage(database, key, message.body);
}

function persistCoverage(database: Database, segment: CoverageSegment): void {
  const { chat, interval } = segment;
  ensureChat(database, chat);
  database.run(`INSERT INTO sync_coverage (platform, account, chat_id, from_ts, to_ts, kind, collected_at, mutations_verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, account, chat_id, from_ts, to_ts, kind) DO UPDATE SET
      collected_at = excluded.collected_at, mutations_verified_at = excluded.mutations_verified_at`, [
    chat.platform, chat.account, chat.chat_id, interval.from_ts, interval.to_ts, segment.kind, segment.collected_at, segment.mutations_verified_at,
  ]);
}

function persistLimit(database: Database, limit: CoverageLimit): void {
  const { chat, interval } = limit;
  ensureChat(database, chat);
  database.run(`INSERT INTO sync_limits (platform, account, chat_id, from_ts, to_ts, reason, observed_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, account, chat_id, from_ts, to_ts, reason) DO UPDATE SET
      observed_at = MIN(sync_limits.observed_at, excluded.observed_at),
      resolved_at = COALESCE(excluded.resolved_at, sync_limits.resolved_at)`, [
    chat.platform, chat.account, chat.chat_id, interval.from_ts, interval.to_ts, limit.reason, limit.observed_at, limit.resolved_at ?? null,
  ]);
}

/** Atomically applies messages, cursor advancement, and coverage/limit evidence. */
export function applySyncBatch(database: Database, input: ApplySyncBatchInput): void {
  database.run("BEGIN IMMEDIATE");
  try {
    for (const raw of input.events ?? []) applyEvent(database, normalizeMessageEvent(raw));
    if (input.sync) {
      ensureChat(database, input.sync.chat);
      database.run(`INSERT INTO sync_state (platform, account, chat_id, cursor, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(platform, account, chat_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`, [
        input.sync.chat.platform, input.sync.chat.account, input.sync.chat.chat_id, input.sync.cursor, input.sync.updated_at,
      ]);
    }
    for (const segment of input.coverage ?? []) persistCoverage(database, segment);
    for (const limit of input.limits ?? []) persistLimit(database, limit);
    database.run("COMMIT");
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}

export function readSyncState(database: Database, chat: ChatKey): SyncCursorUpdate | null {
  const row = database.query("SELECT cursor, updated_at FROM sync_state WHERE platform = ? AND account = ? AND chat_id = ?")
    .get(chat.platform, chat.account, chat.chat_id) as { cursor: string; updated_at: number } | null;
  return row === null ? null : { chat, cursor: row.cursor, updated_at: row.updated_at };
}
