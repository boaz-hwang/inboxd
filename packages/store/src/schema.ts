export const schemaVersion = 1;

/** Initial SQLCipher store schema. All data-bearing tables remain in the encrypted database. */
export const initialSchema = `
CREATE TABLE IF NOT EXISTS chats (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  display_name TEXT, PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS identities (
  platform TEXT NOT NULL, account TEXT NOT NULL, identity_id TEXT NOT NULL,
  display_name TEXT, PRIMARY KEY (platform, account, identity_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS messages (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, msg_id TEXT NOT NULL,
  author_id TEXT, ts REAL NOT NULL, body TEXT,
  parent_platform TEXT, parent_account TEXT, parent_chat_id TEXT, parent_msg_id TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]', edited_at REAL, deleted_at REAL,
  revision_kind TEXT NOT NULL CHECK (revision_kind IN ('number', 'string')),
  revision_value TEXT NOT NULL,
  PRIMARY KEY (platform, account, chat_id, msg_id),
  CHECK ((deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS messages_by_chat_timestamp ON messages(platform, account, chat_id, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  platform UNINDEXED, account UNINDEXED, chat_id UNINDEXED, msg_id UNINDEXED, body,
  tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS read_cursors (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  cursor TEXT NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_state (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  cursor TEXT NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_coverage (
  id INTEGER PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  from_ts REAL NOT NULL, to_ts REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('backfill', 'watch', 'verified_empty')),
  collected_at REAL NOT NULL, mutations_verified_at REAL,
  UNIQUE (platform, account, chat_id, from_ts, to_ts, kind), CHECK (from_ts < to_ts)
);
CREATE TABLE IF NOT EXISTS sync_limits (
  id INTEGER PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  from_ts REAL NOT NULL, to_ts REAL NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('retention', 'permission', 'rate_limit', 'unsupported', 'unknown')),
  observed_at REAL NOT NULL, resolved_at REAL,
  UNIQUE (platform, account, chat_id, from_ts, to_ts, reason), CHECK (from_ts < to_ts)
);
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, approved_at REAL, payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS quota (
  scope TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, action TEXT NOT NULL, subject TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL
);
`;
