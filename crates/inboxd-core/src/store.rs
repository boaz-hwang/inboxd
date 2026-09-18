use serde_json::{Map, Value, json};

use crate::domain;
use crate::{CoreError, CoreResult, Host, SqlHost};

pub const SCHEMA_VERSION: i64 = 3;

pub const INITIAL_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS chats (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  display_name TEXT, PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS unread_evidence (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL, observed_at REAL NOT NULL,
  PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS account_self (
  platform TEXT NOT NULL, account TEXT NOT NULL, evidence_json TEXT NOT NULL, observed_at REAL NOT NULL,
  PRIMARY KEY (platform, account)
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
CREATE TABLE IF NOT EXISTS sync_page_sequence (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0 AND sequence <= 9007199254740991),
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
"#;

// Pinned independently from `INITIAL_SCHEMA`: version 3 is shared with the
// pre-R1 Bun store, so a same-column constraint/index/FTS rewrite is drift,
// not an implicit migration. Whitespace and keyword case are normalized when
// these definitions are compared with sqlite_master.
const CANONICAL_SCHEMA_DEFINITIONS: &[(&str, &str, &str)] = &[
    (
        "table",
        "chats",
        "CREATE TABLE chats (platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, display_name TEXT, PRIMARY KEY (platform, account, chat_id)) WITHOUT ROWID",
    ),
    (
        "table",
        "unread_evidence",
        "CREATE TABLE unread_evidence (platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, evidence_json TEXT NOT NULL, observed_at REAL NOT NULL, PRIMARY KEY (platform, account, chat_id)) WITHOUT ROWID",
    ),
    (
        "table",
        "account_self",
        "CREATE TABLE account_self (platform TEXT NOT NULL, account TEXT NOT NULL, evidence_json TEXT NOT NULL, observed_at REAL NOT NULL, PRIMARY KEY (platform, account)) WITHOUT ROWID",
    ),
    (
        "table",
        "identities",
        "CREATE TABLE identities (platform TEXT NOT NULL, account TEXT NOT NULL, identity_id TEXT NOT NULL, display_name TEXT, PRIMARY KEY (platform, account, identity_id)) WITHOUT ROWID",
    ),
    (
        "table",
        "messages",
        "CREATE TABLE messages (platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, msg_id TEXT NOT NULL, author_id TEXT, ts REAL NOT NULL, body TEXT, parent_platform TEXT, parent_account TEXT, parent_chat_id TEXT, parent_msg_id TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', edited_at REAL, deleted_at REAL, revision_kind TEXT NOT NULL CHECK (revision_kind IN ('number', 'string')), revision_value TEXT NOT NULL, PRIMARY KEY (platform, account, chat_id, msg_id), CHECK ((deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL))) WITHOUT ROWID",
    ),
    (
        "index",
        "messages_by_chat_timestamp",
        "CREATE INDEX messages_by_chat_timestamp ON messages(platform, account, chat_id, ts)",
    ),
    (
        "table",
        "messages_fts",
        "CREATE VIRTUAL TABLE messages_fts USING fts5(platform UNINDEXED, account UNINDEXED, chat_id UNINDEXED, msg_id UNINDEXED, body, tokenize = 'trigram')",
    ),
    (
        "table",
        "messages_fts_config",
        "CREATE TABLE 'messages_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID",
    ),
    (
        "table",
        "messages_fts_content",
        "CREATE TABLE 'messages_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4)",
    ),
    (
        "table",
        "messages_fts_data",
        "CREATE TABLE 'messages_fts_data'(id INTEGER PRIMARY KEY, block BLOB)",
    ),
    (
        "table",
        "messages_fts_docsize",
        "CREATE TABLE 'messages_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB)",
    ),
    (
        "table",
        "messages_fts_idx",
        "CREATE TABLE 'messages_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID",
    ),
    (
        "table",
        "read_cursors",
        "CREATE TABLE read_cursors (platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, cursor TEXT NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY (platform, account, chat_id)) WITHOUT ROWID",
    ),
    (
        "table",
        "sync_state",
        "CREATE TABLE sync_state (platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, cursor TEXT NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY (platform, account, chat_id)) WITHOUT ROWID",
    ),
    (
        "table",
        "sync_page_sequence",
        "CREATE TABLE sync_page_sequence (platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0 AND sequence <= 9007199254740991), PRIMARY KEY (platform, account, chat_id)) WITHOUT ROWID",
    ),
    (
        "table",
        "sync_coverage",
        "CREATE TABLE sync_coverage (id INTEGER PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, from_ts REAL NOT NULL, to_ts REAL NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('backfill', 'watch', 'verified_empty')), collected_at REAL NOT NULL, mutations_verified_at REAL, UNIQUE (platform, account, chat_id, from_ts, to_ts, kind), CHECK (from_ts < to_ts))",
    ),
    (
        "table",
        "sync_limits",
        "CREATE TABLE sync_limits (id INTEGER PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, from_ts REAL NOT NULL, to_ts REAL NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('retention', 'permission', 'rate_limit', 'unsupported', 'unknown')), observed_at REAL NOT NULL, resolved_at REAL, UNIQUE (platform, account, chat_id, from_ts, to_ts, reason), CHECK (from_ts < to_ts))",
    ),
    (
        "table",
        "intents",
        "CREATE TABLE intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL)",
    ),
    (
        "table",
        "approvals",
        "CREATE TABLE approvals (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, approved_at REAL, payload_json TEXT NOT NULL)",
    ),
    (
        "table",
        "sends",
        "CREATE TABLE sends (id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL)",
    ),
    (
        "table",
        "quota",
        "CREATE TABLE quota (scope TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL)",
    ),
    (
        "table",
        "audit",
        "CREATE TABLE audit (id INTEGER PRIMARY KEY, action TEXT NOT NULL, subject TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL)",
    ),
];

// SQLCipher's pinned SQLite 3.53.4 creates these unavoidable NULL-SQL
// autoindexes for rowid-table PRIMARY KEY and UNIQUE constraints. They are the
// only sqlite_* schema objects accepted by schema v3.
const CANONICAL_SCHEMA_AUTO_INDEXES: &[(&str, &str)] = &[
    ("sqlite_autoindex_approvals_1", "approvals"),
    ("sqlite_autoindex_intents_1", "intents"),
    ("sqlite_autoindex_quota_1", "quota"),
    ("sqlite_autoindex_sends_1", "sends"),
    ("sqlite_autoindex_sends_2", "sends"),
    ("sqlite_autoindex_sync_coverage_1", "sync_coverage"),
    ("sqlite_autoindex_sync_limits_1", "sync_limits"),
];

fn object<'a>(value: &'a Value, label: &str) -> CoreResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| CoreError::new("TypeError", format!("{label} must be an object")))
}

fn field<'a>(value: &'a Map<String, Value>, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn string(value: &Value, label: &str) -> CoreResult<String> {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| CoreError::new("TypeError", format!("{label} must be a string")))
}

fn chat_params(chat: &Value) -> CoreResult<Vec<Value>> {
    let chat = object(chat, "chat")?;
    Ok(vec![
        field(chat, "platform").clone(),
        field(chat, "account").clone(),
        field(chat, "chat_id").clone(),
    ])
}

fn host_string(host: &dyn Host, method: &str, value: Value) -> CoreResult<String> {
    host.call(method, value)?
        .as_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| CoreError::new("HostError", format!("{method} must return a string")))
}

fn json_stringify(host: &dyn Host, value: Value) -> CoreResult<String> {
    host_string(host, "host.jsonStringify", value)
}

fn json_parse(host: &dyn Host, value: &str) -> CoreResult<Value> {
    host.call("host.jsonParse", Value::String(value.to_owned()))
}

fn number_to_string(host: &dyn Host, value: &Value) -> CoreResult<String> {
    host_string(host, "host.numberToString", value.clone())
}

fn revision_parts(host: &dyn Host, revision: &Value) -> CoreResult<(&'static str, String)> {
    let revision = object(revision, "adapter revision")?;
    let value = field(revision, "value");
    if value.is_number() {
        Ok(("number", number_to_string(host, value)?))
    } else {
        Ok(("string", string(value, "adapter revision value")?))
    }
}

fn ensure_chat(sql: &SqlHost<'_>, chat: &Value) -> CoreResult<()> {
    sql.run(
        "INSERT OR IGNORE INTO chats (platform, account, chat_id) VALUES (?, ?, ?)",
        &chat_params(chat)?,
    )?;
    Ok(())
}

fn key_params(key: &Value) -> CoreResult<Vec<Value>> {
    let key = object(key, "message key")?;
    Ok(vec![
        field(key, "platform").clone(),
        field(key, "account").clone(),
        field(key, "chat_id").clone(),
        field(key, "msg_id").clone(),
    ])
}

fn remove_from_fts(sql: &SqlHost<'_>, key: &Value) -> CoreResult<()> {
    sql.run("DELETE FROM messages_fts WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?", &key_params(key)?)?;
    Ok(())
}

fn index_message(sql: &SqlHost<'_>, key: &Value, body: &Value, replacing: bool) -> CoreResult<()> {
    // Fresh keys have no FTS row: scanning UNINDEXED key columns for every new
    // message makes initial ingestion quadratic. Replacements still remove it
    // inside the same transaction as the message write.
    if replacing {
        remove_from_fts(sql, key)?;
    }
    let mut params = key_params(key)?;
    params.push(body.clone());
    sql.run("INSERT INTO messages_fts (platform, account, chat_id, msg_id, body) VALUES (?, ?, ?, ?, ?)", &params)?;
    Ok(())
}

fn existing_message(sql: &SqlHost<'_>, key: &Value) -> CoreResult<Option<Value>> {
    let value = sql.get("SELECT revision_kind, revision_value, deleted_at FROM messages WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?", &key_params(key)?)?;
    Ok((!value.is_null()).then_some(value))
}

fn utf16_compare(host: &dyn Host, left: &str, right: &str) -> CoreResult<i64> {
    host.call("host.utf16Compare", json!({ "left": left, "right": right }))?
        .as_i64()
        .ok_or_else(|| CoreError::new("HostError", "host.utf16Compare must return an integer"))
}

fn compare_revision(host: &dyn Host, stored: &Value, incoming: &Value) -> CoreResult<i32> {
    let stored = object(stored, "stored message")?;
    let incoming_object = object(incoming, "adapter revision")?;
    if field(incoming_object, "source").as_str() == Some("observation") {
        return Ok(if field(stored, "deleted_at").is_null() {
            1
        } else {
            -1
        });
    }
    let (kind, value) = revision_parts(host, incoming)?;
    if field(stored, "revision_kind").as_str() != Some(kind) {
        return Err(CoreError::new(
            "TypeError",
            "adapter revision type changed for an existing message",
        ));
    }
    let previous = field(stored, "revision_value").as_str().unwrap_or_default();
    if kind == "number" {
        let next = value.parse::<f64>().unwrap_or(f64::NAN);
        let old = previous.parse::<f64>().unwrap_or(f64::NAN);
        return Ok(if next - old > 0.0 {
            1
        } else if next - old < 0.0 {
            -1
        } else {
            0
        });
    }
    Ok(utf16_compare(host, &value, previous)?.signum() as i32)
}

fn event_key(event: &Map<String, Value>) -> Value {
    match field(event, "kind").as_str() {
        Some("create") => field(object(field(event, "message"), "message").unwrap(), "key").clone(),
        Some("edit") => field(event, "key").clone(),
        _ => field(
            object(field(event, "tombstone"), "tombstone").unwrap(),
            "key",
        )
        .clone(),
    }
}

fn apply_event(sql: &SqlHost<'_>, host: &dyn Host, event: &Value) -> CoreResult<()> {
    let event = domain::normalize_message_event(event)?;
    let event = object(&event, "message event")?;
    let kind = field(event, "kind").as_str().unwrap();
    let key = event_key(event);
    ensure_chat(sql, &key)?;
    let existing = existing_message(sql, &key)?;
    if existing
        .as_ref()
        .is_some_and(|row| !row.get("deleted_at").unwrap_or(&Value::Null).is_null())
        && kind != "delete"
    {
        return Ok(());
    }
    if kind == "delete" {
        if existing
            .as_ref()
            .is_some_and(|row| !row.get("deleted_at").unwrap_or(&Value::Null).is_null())
        {
            return Ok(());
        }
        if let Some(row) = &existing {
            if compare_revision(host, row, field(event, "revision"))? < 0 {
                return Ok(());
            }
        }
        let (revision_kind, revision_value) = revision_parts(host, field(event, "revision"))?;
        let tombstone = object(field(event, "tombstone"), "tombstone")?;
        if existing.is_some() {
            remove_from_fts(sql, &key)?;
            let mut params = vec![
                field(tombstone, "deleted_at").clone(),
                Value::String(revision_kind.into()),
                Value::String(revision_value),
            ];
            params.extend(key_params(&key)?);
            sql.run("UPDATE messages SET body = NULL, deleted_at = ?, revision_kind = ?, revision_value = ? WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?", &params)?;
        } else {
            let mut params = key_params(&key)?;
            params.extend([
                field(tombstone, "deleted_at").clone(),
                field(tombstone, "deleted_at").clone(),
                Value::String(revision_kind.into()),
                Value::String(revision_value),
            ]);
            sql.run("INSERT INTO messages (platform, account, chat_id, msg_id, ts, body, deleted_at, revision_kind, revision_value) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)", &params)?;
        }
        return Ok(());
    }
    if let Some(row) = &existing {
        if compare_revision(host, row, field(event, "revision"))? <= 0 {
            return Ok(());
        }
    }
    let (revision_kind, revision_value) = revision_parts(host, field(event, "revision"))?;
    if kind == "edit" {
        if existing.is_none() {
            return Ok(());
        }
        let mut params = vec![
            field(event, "body").clone(),
            field(event, "edited_at").clone(),
            Value::String(revision_kind.into()),
            Value::String(revision_value),
        ];
        params.extend(key_params(&key)?);
        sql.run("UPDATE messages SET body = ?, edited_at = ?, revision_kind = ?, revision_value = ? WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?", &params)?;
        index_message(sql, &key, field(event, "body"), true)?;
        return Ok(());
    }
    let message = object(field(event, "message"), "message")?;
    let parent = message.get("parent_id").and_then(Value::as_object);
    let attachments = json_stringify(host, field(message, "attachments").clone())?;
    let mut params = key_params(&key)?;
    params.extend([
        field(message, "author_id").clone(),
        field(message, "ts").clone(),
        field(message, "body").clone(),
        parent
            .map(|value| field(value, "platform").clone())
            .unwrap_or(Value::Null),
        parent
            .map(|value| field(value, "account").clone())
            .unwrap_or(Value::Null),
        parent
            .map(|value| field(value, "chat_id").clone())
            .unwrap_or(Value::Null),
        parent
            .map(|value| field(value, "msg_id").clone())
            .unwrap_or(Value::Null),
        Value::String(attachments),
        message.get("edited_at").cloned().unwrap_or(Value::Null),
        Value::String(revision_kind.into()),
        Value::String(revision_value),
    ]);
    sql.run(r#"INSERT INTO messages (
      platform, account, chat_id, msg_id, author_id, ts, body, parent_platform, parent_account, parent_chat_id, parent_msg_id,
      attachments_json, edited_at, deleted_at, revision_kind, revision_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(platform, account, chat_id, msg_id) DO UPDATE SET
      author_id = excluded.author_id, ts = excluded.ts, body = excluded.body,
      parent_platform = excluded.parent_platform, parent_account = excluded.parent_account, parent_chat_id = excluded.parent_chat_id, parent_msg_id = excluded.parent_msg_id,
      attachments_json = excluded.attachments_json, edited_at = excluded.edited_at, revision_kind = excluded.revision_kind, revision_value = excluded.revision_value"#, &params)?;
    index_message(sql, &key, field(message, "body"), existing.is_some())?;
    Ok(())
}

fn persist_coverage(sql: &SqlHost<'_>, segment: &Value) -> CoreResult<()> {
    let segment = object(segment, "coverage segment")?;
    let chat = field(segment, "chat");
    let interval = object(field(segment, "interval"), "coverage interval")?;
    ensure_chat(sql, chat)?;
    let mut params = chat_params(chat)?;
    params.extend([
        field(interval, "from_ts").clone(),
        field(interval, "to_ts").clone(),
        field(segment, "kind").clone(),
        field(segment, "collected_at").clone(),
        field(segment, "mutations_verified_at").clone(),
    ]);
    sql.run("INSERT INTO sync_coverage (platform, account, chat_id, from_ts, to_ts, kind, collected_at, mutations_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, account, chat_id, from_ts, to_ts, kind) DO UPDATE SET collected_at = excluded.collected_at, mutations_verified_at = excluded.mutations_verified_at", &params)?;
    Ok(())
}

fn persist_limit(sql: &SqlHost<'_>, limit: &Value) -> CoreResult<()> {
    let limit = object(limit, "coverage limit")?;
    let chat = field(limit, "chat");
    let interval = object(field(limit, "interval"), "coverage interval")?;
    ensure_chat(sql, chat)?;
    let mut params = chat_params(chat)?;
    params.extend([
        field(interval, "from_ts").clone(),
        field(interval, "to_ts").clone(),
        field(limit, "reason").clone(),
        field(limit, "observed_at").clone(),
        limit.get("resolved_at").cloned().unwrap_or(Value::Null),
    ]);
    sql.run("INSERT INTO sync_limits (platform, account, chat_id, from_ts, to_ts, reason, observed_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, account, chat_id, from_ts, to_ts, reason) DO UPDATE SET observed_at = MIN(sync_limits.observed_at, excluded.observed_at), resolved_at = CASE WHEN excluded.reason = 'rate_limit' AND excluded.resolved_at IS NULL AND excluded.observed_at >= sync_limits.resolved_at THEN NULL ELSE COALESCE(excluded.resolved_at, sync_limits.resolved_at) END", &params)?;
    Ok(())
}

fn optional_collection<'a>(input: &'a Map<String, Value>, field: &str) -> CoreResult<&'a [Value]> {
    match input.get(field) {
        None => Ok(&[]),
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| CoreError::new("TypeError", format!("{field} must be an array"))),
    }
}

fn apply_sync_batch(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    let input = object(input, "sync batch")?;
    let events = optional_collection(input, "events")?;
    let coverage = optional_collection(input, "coverage")?;
    let limits = optional_collection(input, "limits")?;
    let sql = SqlHost::new(host);
    sql.transaction(|sql| {
        // BEGIN IMMEDIATE + per-chat CAS defines committed page order, including
        // timestamp ties. Provider cursor equality is not a sequence (ABA/retries).
        let committed_page = input.contains_key("expected_page_sequence");
        if !committed_page && (input.contains_key("identity") || input.contains_key("unread")) {
            return Err(CoreError::new("Error", "Trusted metadata requires a sync page sequence"));
        }
        if let Some(sync) = input.get("sync") {
            let sync = object(sync, "sync cursor")?;
            let chat = domain::chat_key(field(sync, "chat"))?;
            if !committed_page && !sql.get("SELECT sequence FROM sync_page_sequence WHERE platform = ? AND account = ? AND chat_id = ?", &chat_params(&chat)?)?.is_null() {
                return Err(CoreError::new("Error", "Tracked cursor requires a sync page sequence"));
            }
            if let Some(identity) = input.get("identity") {
                let identity = domain::account_identity(identity)?;
                if identity["platform"] != chat["platform"] || identity["account"] != chat["account"] {
                    return Err(CoreError::new("Error", "Identity page scope mismatch"));
                }
            }
            if let Some(unread) = input.get("unread") {
                if domain::unread_state(unread)?["chat"] != chat {
                    return Err(CoreError::new("Error", "Unread page scope mismatch"));
                }
            }
        }
        if let Some(expected) = input.get("expected_page_sequence") {
            let expected = expected.as_u64().filter(|v| *v < 9_007_199_254_740_991)
                .ok_or_else(|| CoreError::new("Error", "Invalid sync page sequence"))?;
            let sync = object(field(input, "sync"), "sync cursor")?;
            let mut params = chat_params(field(sync, "chat"))?;
            let row = sql.get("SELECT sequence FROM sync_page_sequence WHERE platform = ? AND account = ? AND chat_id = ?", &params)?;
            if row["sequence"].as_u64().unwrap_or(0) != expected {
                return Err(CoreError::new("Error", "Stale sync page"));
            }
            params.push(json!(expected + 1));
            sql.run("INSERT INTO sync_page_sequence (platform, account, chat_id, sequence) VALUES (?, ?, ?, ?) ON CONFLICT(platform, account, chat_id) DO UPDATE SET sequence = excluded.sequence", &params)?;
        }
        if let Some(identity) = input.get("identity") { persist_account_identity(host, identity, committed_page)?; }
        if let Some(unread) = input.get("unread") { persist_unread_state(host, unread, committed_page)?; }
        for event in events {
            apply_event(sql, host, event)?;
        }
        if let Some(sync) = input.get("sync") {
            let sync = object(sync, "sync cursor")?;
            let chat = field(sync, "chat");
            ensure_chat(sql, chat)?;
            let mut params = chat_params(chat)?;
            params.extend([field(sync, "cursor").clone(), field(sync, "updated_at").clone()]);
            sql.run("INSERT INTO sync_state (platform, account, chat_id, cursor, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(platform, account, chat_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at", &params)?;
        }
        for segment in coverage { persist_coverage(sql, segment)?; }
        for limit in limits { persist_limit(sql, limit)?; }
        Ok(Value::Null)
    })
}

fn read_sync_state(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    let row = SqlHost::new(host).get("SELECT cursor, updated_at FROM sync_state WHERE platform = ? AND account = ? AND chat_id = ?", &chat_params(input)?)?;
    if row.is_null() {
        return Ok(Value::Null);
    }
    let sequence = SqlHost::new(host).get("SELECT sequence FROM sync_page_sequence WHERE platform = ? AND account = ? AND chat_id = ?", &chat_params(input)?)?;
    let mut result = json!({ "chat": input, "cursor": row["cursor"].clone(), "updated_at": row["updated_at"].clone() });
    if let Some(sequence) = sequence["sequence"].as_u64() {
        result["page_sequence"] = json!(sequence);
    }
    Ok(result)
}

fn normalized_schema_sql(source: &str) -> String {
    let mut normalized = String::with_capacity(source.len());
    let mut in_string = false;
    for character in source.chars() {
        if character == '\'' {
            in_string = !in_string;
            normalized.push(character);
        } else if in_string {
            normalized.push(character);
        } else if !character.is_ascii_whitespace() {
            normalized.push(character.to_ascii_lowercase());
        }
    }
    normalized
}

fn schema_is_valid(sql: &SqlHost<'_>) -> CoreResult<bool> {
    let objects = sql.all(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger')",
        &[],
    )?;
    if objects.len() != CANONICAL_SCHEMA_DEFINITIONS.len() + CANONICAL_SCHEMA_AUTO_INDEXES.len() {
        return Ok(false);
    }
    for (kind, name, expected) in CANONICAL_SCHEMA_DEFINITIONS {
        let expected_table = if *kind == "index" { "messages" } else { *name };
        let Some(actual) = objects.iter().find(|row| {
            row.get("type").and_then(Value::as_str) == Some(*kind)
                && row.get("name").and_then(Value::as_str) == Some(*name)
                && row.get("tbl_name").and_then(Value::as_str) == Some(expected_table)
        }) else {
            return Ok(false);
        };
        let Some(actual) = actual.get("sql").and_then(Value::as_str) else {
            return Ok(false);
        };
        if normalized_schema_sql(actual) != normalized_schema_sql(expected) {
            return Ok(false);
        }
    }
    for (name, table) in CANONICAL_SCHEMA_AUTO_INDEXES {
        let Some(actual) = objects.iter().find(|row| {
            row.get("type").and_then(Value::as_str) == Some("index")
                && row.get("name").and_then(Value::as_str) == Some(*name)
                && row.get("tbl_name").and_then(Value::as_str) == Some(*table)
        }) else {
            return Ok(false);
        };
        if !actual.get("sql").is_some_and(Value::is_null) {
            return Ok(false);
        }
    }
    let check = sql.get("PRAGMA quick_check", &[])?;
    Ok(check
        .as_object()
        .and_then(|row| row.values().next())
        .and_then(Value::as_str)
        == Some("ok"))
}

fn invalid_schema() -> CoreError {
    CoreError::new(
        "StoreSchemaError",
        format!("Store schema {SCHEMA_VERSION} failed validation"),
    )
}

fn migrate(host: &dyn Host) -> CoreResult<Value> {
    let sql = SqlHost::new(host);
    let current = sql.get("PRAGMA user_version", &[])?;
    let version = current
        .get("user_version")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err(CoreError::new(
            "Error",
            format!("Store schema {version} is newer than this application"),
        ));
    }
    if version == SCHEMA_VERSION {
        return if schema_is_valid(&sql)? {
            Ok(json!(SCHEMA_VERSION))
        } else {
            Err(invalid_schema())
        };
    }
    sql.transaction(|sql| {
        sql.exec(INITIAL_SCHEMA)?;
        sql.run(&format!("PRAGMA user_version = {SCHEMA_VERSION}"), &[])?;
        if !schema_is_valid(sql)? {
            return Err(invalid_schema());
        }
        Ok(json!(SCHEMA_VERSION))
    })
}

fn diagnose(host: &dyn Host) -> CoreResult<Value> {
    let sql = SqlHost::new(host);
    let cipher = sql.get("PRAGMA cipher_version", &[])?;
    let cipher_version = cipher
        .as_object()
        .and_then(|value| value.values().next())
        .and_then(Value::as_str)
        .unwrap_or("");
    let version = sql.get("PRAGMA user_version", &[])?;
    let schema_version = version
        .get("user_version")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let schema_valid = schema_version == SCHEMA_VERSION && schema_is_valid(&sql)?;
    Ok(json!({
        "cipher_version": cipher_version,
        "schema_version": schema_version,
        "schema_valid": schema_valid,
        "ready": !cipher_version.is_empty() && schema_valid,
    }))
}

fn coverage_for(host: &dyn Host, target: &Value) -> CoreResult<Value> {
    let target_object = object(target, "coverage target")?;
    let chat = field(target_object, "chat");
    let interval = object(field(target_object, "interval"), "coverage interval")?;
    let mut params = chat_params(chat)?;
    params.extend([
        field(interval, "to_ts").clone(),
        field(interval, "from_ts").clone(),
    ]);
    let sql = SqlHost::new(host);
    let covered_rows = sql.all("SELECT platform, account, chat_id, from_ts, to_ts, kind, collected_at, mutations_verified_at FROM sync_coverage WHERE platform = ? AND account = ? AND chat_id = ? AND from_ts < ? AND to_ts > ? ORDER BY from_ts, to_ts, id", &params)?;
    let covered = covered_rows.into_iter().map(|row| json!({
        "chat": { "platform": row["platform"].clone(), "account": row["account"].clone(), "chat_id": row["chat_id"].clone() },
        "interval": { "from_ts": row["from_ts"].clone(), "to_ts": row["to_ts"].clone() },
        "kind": row["kind"].clone(), "collected_at": row["collected_at"].clone(), "mutations_verified_at": row["mutations_verified_at"].clone(),
    })).collect::<Vec<_>>();
    let limit_rows = sql.all("SELECT platform, account, chat_id, from_ts, to_ts, reason, observed_at, resolved_at FROM sync_limits WHERE platform = ? AND account = ? AND chat_id = ? AND from_ts < ? AND to_ts > ? ORDER BY from_ts, to_ts, id", &params)?;
    let limits = limit_rows.into_iter().map(|row| {
        let mut result = json!({
            "chat": { "platform": row["platform"].clone(), "account": row["account"].clone(), "chat_id": row["chat_id"].clone() },
            "interval": { "from_ts": row["from_ts"].clone(), "to_ts": row["to_ts"].clone() },
            "reason": row["reason"].clone(), "observed_at": row["observed_at"].clone(),
        });
        if !row.get("resolved_at").unwrap_or(&Value::Null).is_null() { result["resolved_at"] = row["resolved_at"].clone(); }
        result
    }).collect::<Vec<_>>();
    domain::build_coverage(&json!({ "target": target, "covered": covered, "limits": limits }))
}

fn message_from_row(row: Value) -> Value {
    let mut row = row.as_object().cloned().unwrap_or_default();
    let kind = row
        .remove("revision_kind")
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default();
    let raw = row
        .remove("revision_value")
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default();
    row.insert(
        "revision".into(),
        if kind == "number" {
            raw.parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        } else {
            Value::String(raw)
        },
    );
    Value::Object(row)
}

fn get_message(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    let row = SqlHost::new(host).get("SELECT platform, account, chat_id, msg_id, author_id, ts, body, edited_at, deleted_at, revision_kind, revision_value FROM messages WHERE platform = ? AND account = ? AND chat_id = ? AND msg_id = ?", &key_params(input)?)?;
    Ok(if row.is_null() {
        Value::Null
    } else {
        message_from_row(row)
    })
}

fn page_limit(value: Option<&Value>) -> CoreResult<usize> {
    match value {
        None => Ok(50),
        Some(value)
            if value
                .as_u64()
                .is_some_and(|value| (1..=100).contains(&value)) =>
        {
            Ok(value.as_u64().unwrap() as usize)
        }
        _ => Err(CoreError::new(
            "Error",
            "limit must be an integer from 1 to 100",
        )),
    }
}

fn base64url_encode(host: &dyn Host, value: &str) -> CoreResult<String> {
    host_string(
        host,
        "host.base64urlEncode",
        Value::String(value.to_owned()),
    )
}

fn base64url_decode(host: &dyn Host, value: &str) -> CoreResult<String> {
    host_string(
        host,
        "host.base64urlDecode",
        Value::String(value.to_owned()),
    )
}

fn encode_cursor(host: &dyn Host, scope: &str, row: &Value) -> CoreResult<String> {
    let encoded = json_stringify(
        host,
        json!({ "v": 1, "scope": scope, "ts": row["ts"].clone(), "msg_id": row["msg_id"].clone() }),
    )?;
    base64url_encode(host, &encoded)
}

fn decode_cursor(
    host: &dyn Host,
    cursor: Option<&Value>,
    scope: &str,
) -> CoreResult<Option<Value>> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let cursor = cursor.as_str().unwrap_or("");
    if cursor.is_empty()
        || cursor.len() > 4096
        || !cursor
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-')
    {
        return Err(CoreError::new("Error", "cursor is malformed"));
    }
    let payload = base64url_decode(host, cursor)
        .and_then(|value| json_parse(host, &value))
        .map_err(|_| CoreError::new("Error", "cursor is malformed"))?;
    let valid = payload.get("v").and_then(Value::as_i64) == Some(1)
        && payload.get("scope").and_then(Value::as_str) == Some(scope)
        && payload
            .get("ts")
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite)
        && payload
            .get("msg_id")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty());
    if !valid {
        return Err(CoreError::new("Error", "cursor does not match this query"));
    }
    if encode_cursor(host, scope, &payload)? != cursor {
        return Err(CoreError::new("Error", "cursor is malformed"));
    }
    Ok(Some(payload))
}

fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

fn escape_like(query: &str) -> String {
    let mut result = String::new();
    for character in query.chars() {
        if matches!(character, '\\' | '%' | '_') {
            result.push('\\');
        }
        result.push(character);
    }
    result
}

fn query_messages(host: &dyn Host, input: &Value, search: bool) -> CoreResult<Value> {
    let input = object(input, "message query")?;
    let search_query = if search {
        let query = string(field(input, "query"), "query")?;
        let length = host
            .call("host.codePointLength", Value::String(query.clone()))?
            .as_u64()
            .unwrap_or(0);
        if length == 0 || length > 1024 {
            return Err(CoreError::new(
                "Error",
                "query must contain from 1 to 1024 Unicode code points",
            ));
        }
        Some((query, length))
    } else {
        None
    };
    let limit = page_limit(input.get("limit"))?;
    let scope = string(field(input, "scope_codec"), "scope_codec")?;
    let cursor = decode_cursor(host, input.get("cursor"), &scope)?;
    let chat = field(input, "chat");
    let interval = object(field(input, "interval"), "interval")?;
    let chat_query_params = chat_params(chat)?;
    let mut params = chat_query_params.clone();
    params.extend([
        field(interval, "from_ts").clone(),
        field(interval, "to_ts").clone(),
    ]);
    let cursor_where = if cursor.is_some() {
        " AND (m.ts > ? OR (m.ts = ? AND m.msg_id > ?))"
    } else {
        ""
    };
    if let Some(cursor) = &cursor {
        params.extend([
            cursor["ts"].clone(),
            cursor["ts"].clone(),
            cursor["msg_id"].clone(),
        ]);
    }
    let mut sql_text = "SELECT m.platform, m.account, m.chat_id, m.msg_id, m.author_id, m.ts, m.body, m.edited_at, m.deleted_at, m.revision_kind, m.revision_value FROM messages m".to_owned();
    if let Some((query, length)) = search_query {
        let where_clause = format!(
            "m.platform = ? AND m.account = ? AND m.chat_id = ? AND m.ts >= ? AND m.ts < ? AND m.deleted_at IS NULL{cursor_where}"
        );
        if length >= 3 {
            // CROSS JOIN fixes the FTS virtual table as the outer loop. Without
            // this, SQLite can choose the timestamp index first and execute an
            // FTS lookup for every message in a large chat.
            sql_text = "SELECT m.platform, m.account, m.chat_id, m.msg_id, m.author_id, m.ts, m.body, m.edited_at, m.deleted_at, m.revision_kind, m.revision_value FROM messages_fts CROSS JOIN messages m".to_owned();
            sql_text.push_str(&format!(" WHERE messages_fts MATCH ? AND messages_fts.platform = ? AND messages_fts.account = ? AND messages_fts.chat_id = ? AND m.platform = messages_fts.platform AND m.account = messages_fts.account AND m.chat_id = messages_fts.chat_id AND m.msg_id = messages_fts.msg_id AND m.ts >= ? AND m.ts < ? AND m.deleted_at IS NULL{cursor_where}"));
            params = vec![Value::String(fts_phrase(&query))];
            params.extend(chat_query_params);
            params.extend([
                field(interval, "from_ts").clone(),
                field(interval, "to_ts").clone(),
            ]);
            if let Some(cursor) = &cursor {
                params.extend([
                    cursor["ts"].clone(),
                    cursor["ts"].clone(),
                    cursor["msg_id"].clone(),
                ]);
            }
        } else {
            sql_text.push_str(&format!(
                " WHERE {where_clause} AND m.body LIKE ? ESCAPE '\\'"
            ));
            params.push(Value::String(format!("%{}%", escape_like(&query))));
        }
    } else {
        sql_text.push_str(&format!(" WHERE m.platform = ? AND m.account = ? AND m.chat_id = ? AND m.ts >= ? AND m.ts < ? AND m.deleted_at IS NULL{cursor_where}"));
    }
    sql_text.push_str(" ORDER BY m.ts, m.msg_id LIMIT ?");
    params.push(json!(limit + 1));
    let rows = SqlHost::new(host).all(&sql_text, &params)?;
    let page = rows.iter().take(limit).cloned().collect::<Vec<_>>();
    let next_cursor = if rows.len() > limit {
        page.last()
            .map(|row| encode_cursor(host, &scope, row))
            .transpose()?
    } else {
        None
    };
    let target = json!({ "chat": chat, "interval": field(input, "interval") });
    let mut result = json!({ "messages": page.into_iter().map(message_from_row).collect::<Vec<_>>(), "coverage": coverage_for(host, &target)? });
    if let Some(cursor) = next_cursor {
        result["next_cursor"] = Value::String(cursor);
    }
    Ok(result)
}

fn record_unread_state(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    persist_unread_state(host, input, false)
}

fn persist_unread_state(host: &dyn Host, input: &Value, committed_page: bool) -> CoreResult<Value> {
    let evidence = domain::unread_state(input)?;
    let mut params = chat_params(&evidence["chat"])?;
    params.extend([
        json!(json_stringify(host, evidence.clone())?),
        evidence["observed_at"].clone(),
        json!(i32::from(committed_page)),
    ]);
    SqlHost::new(host).run("INSERT INTO unread_evidence (platform, account, chat_id, evidence_json, observed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(platform, account, chat_id) DO UPDATE SET evidence_json = excluded.evidence_json, observed_at = excluded.observed_at WHERE excluded.observed_at > unread_evidence.observed_at OR (? = 1 AND excluded.observed_at = unread_evidence.observed_at)", &params)?;
    Ok(Value::Null)
}

fn unread_for(host: &dyn Host, chat: &Value) -> CoreResult<Value> {
    let row = SqlHost::new(host).get("SELECT evidence_json FROM unread_evidence WHERE platform = ? AND account = ? AND chat_id = ?", &chat_params(chat)?)?;
    if let Some(text) = row["evidence_json"].as_str() {
        return json_parse(host, text);
    }
    Ok(
        json!({ "chat": chat, "status": "unknown", "source": "unknown", "count": null, "reason": "unobserved", "observed_at": null }),
    )
}

fn record_account_identity(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    persist_account_identity(host, input, false)
}

fn persist_account_identity(
    host: &dyn Host,
    input: &Value,
    committed_page: bool,
) -> CoreResult<Value> {
    let evidence = domain::account_identity(input)?;
    SqlHost::new(host).run("INSERT INTO account_self (platform, account, evidence_json, observed_at) VALUES (?, ?, ?, ?) ON CONFLICT(platform, account) DO UPDATE SET evidence_json = excluded.evidence_json, observed_at = excluded.observed_at WHERE excluded.observed_at > account_self.observed_at OR (? = 1 AND excluded.observed_at = account_self.observed_at)", &[
        evidence["platform"].clone(), evidence["account"].clone(), json!(json_stringify(host, evidence.clone())?), evidence["observed_at"].clone(), json!(i32::from(committed_page)),
    ])?;
    Ok(Value::Null)
}

fn account_identity_for(host: &dyn Host, chat: &Value) -> CoreResult<Value> {
    let row = SqlHost::new(host).get(
        "SELECT evidence_json FROM account_self WHERE platform = ? AND account = ?",
        &[chat["platform"].clone(), chat["account"].clone()],
    )?;
    if let Some(text) = row["evidence_json"].as_str() {
        return json_parse(host, text);
    }
    Ok(
        json!({ "platform": chat["platform"], "account": chat["account"], "status": "unknown", "source": "unknown", "reason": "unobserved", "observed_at": null }),
    )
}

fn recent_messages(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    let input = object(input, "recent messages input")?;
    let mut chats = field(input, "chats")
        .as_array()
        .ok_or_else(|| CoreError::new("TypeError", "chats must be an explicit array"))?
        .iter()
        .map(domain::chat_key)
        .collect::<CoreResult<Vec<_>>>()?;
    if chats.is_empty() || chats.len() > 100 {
        return Err(CoreError::new(
            "RangeError",
            "chats must contain from 1 to 100 explicit scopes",
        ));
    }
    if !matches!(
        input.get("sender").map(Value::as_str),
        None | Some(Some("all" | "self"))
    ) {
        return Err(CoreError::new("TypeError", "sender must be all or self"));
    }
    chats.sort_by_key(|chat| {
        ["platform", "account", "chat_id"].map(|key| chat[key].as_str().unwrap().to_owned())
    });
    chats.dedup();
    let interval = field(input, "interval");
    let interval = domain::half_open_interval(
        interval["from_ts"].as_f64().unwrap_or(f64::NAN),
        interval["to_ts"].as_f64().unwrap_or(f64::NAN),
    )?;
    let limit = page_limit(input.get("limit"))?;
    let bindings = chats
        .iter()
        .map(|chat| account_identity_for(host, chat))
        .collect::<CoreResult<Vec<_>>>()?;
    let mut identities = bindings.clone();
    identities.dedup();
    // Scope is derived in the canonical core, never accepted from the caller.
    let scope = host_string(
        host,
        "host.canonicalSha256",
        json!({
            "kind": "recent:v1", "chats": chats, "interval": interval,
            "sender": input.get("sender").cloned().unwrap_or(json!("all")),
            "identities": if input.get("sender").and_then(Value::as_str) == Some("self") { json!(identities) } else { Value::Null },
        }),
    )?;
    let cursor = if let Some(raw) = input.get("cursor") {
        let raw = string(raw, "cursor")?;
        if raw.len() > 4096 {
            return Err(CoreError::new("Error", "cursor is malformed"));
        }
        let parsed = base64url_decode(host, &raw)
            .and_then(|text| json_parse(host, &text))
            .map_err(|_| CoreError::new("Error", "cursor is malformed"))?;
        if parsed["v"] != json!(1)
            || parsed["scope"] != scope
            || !parsed["ts"].as_f64().is_some_and(f64::is_finite)
            || domain::message_key(&parsed).is_err()
            || base64url_encode(host, &json_stringify(host, parsed.clone())?)? != raw
        {
            return Err(CoreError::new("Error", "cursor does not match this query"));
        }
        Some(parsed)
    } else {
        None
    };
    let mut params = Vec::new();
    let mut scopes = Vec::new();
    let mut coverage = Vec::new();
    let mut unread = Vec::new();
    for (chat, identity) in chats.iter().zip(&bindings) {
        unread.push(unread_for(host, chat)?);
        if input.get("sender").and_then(Value::as_str) != Some("self") {
            scopes.push("(platform = ? AND account = ? AND chat_id = ?)");
            params.extend(chat_params(chat)?);
        } else if identity["status"] == "known" {
            scopes.push("(platform = ? AND account = ? AND chat_id = ? AND author_id = ?)");
            params.extend(chat_params(chat)?);
            params.push(identity["self_id"].clone());
        }
        coverage.push(coverage_for(
            host,
            &json!({ "chat": chat, "interval": interval }),
        )?);
    }
    params.extend([interval["from_ts"].clone(), interval["to_ts"].clone()]);
    let cursor_where = if let Some(cursor) = &cursor {
        params.extend([
            cursor["ts"].clone(),
            cursor["ts"].clone(),
            cursor["platform"].clone(),
            cursor["account"].clone(),
            cursor["chat_id"].clone(),
            cursor["msg_id"].clone(),
        ]);
        " AND (ts < ? OR (ts = ? AND (platform, account, chat_id, msg_id) > (?, ?, ?, ?)))"
    } else {
        ""
    };
    params.push(json!(limit + 1));
    let rows = SqlHost::new(host).all(&format!(
        "SELECT platform, account, chat_id, msg_id, author_id, ts, body, edited_at, deleted_at, revision_kind, revision_value FROM messages WHERE ({}) AND ts >= ? AND ts < ? AND deleted_at IS NULL{cursor_where} ORDER BY ts DESC, platform, account, chat_id, msg_id LIMIT ?",
        if scopes.is_empty() { "0".into() } else { scopes.join(" OR ") }
    ), &params)?;
    let mut result = json!({ "messages": rows.iter().take(limit).cloned().map(message_from_row).collect::<Vec<_>>(), "coverage": coverage, "identities": identities, "unread": unread });
    if rows.len() > limit {
        let row = &rows[limit - 1];
        let mut payload = domain::message_key(row)?;
        payload["v"] = json!(1);
        payload["scope"] = json!(scope);
        payload["ts"] = row["ts"].clone();
        result["next_cursor"] = json!(base64url_encode(host, &json_stringify(host, payload)?)?);
    }
    Ok(result)
}

fn recent_evidence(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    let mut result = recent_messages(host, input)?;
    let messages = result.as_object_mut().unwrap().remove("messages").unwrap();
    result["kind"] = json!("recent_messages_evidence");
    result["evidence"] = json!(messages.as_array().unwrap().iter().map(|message| {
        Ok(json!({ "source": { "operation": "store.getMessage", "key": domain::message_key(message)? }, "message": message }))
    }).collect::<CoreResult<Vec<_>>>()?);
    result["query"] = json!({
        "chats": result["coverage"].as_array().unwrap().iter().map(|coverage| coverage["target"]["chat"].clone()).collect::<Vec<_>>(),
        "interval": result["coverage"][0]["target"]["interval"],
        "sender": input.get("sender").cloned().unwrap_or(json!("all")),
        "order": "latest", "limit": page_limit(input.get("limit"))?,
    });
    Ok(result)
}

fn recover_interrupted_sends(host: &dyn Host) -> CoreResult<Value> {
    SqlHost::new(host).transaction(|sql| {
        let result = sql.run("UPDATE sends SET state = 'Uncertain' WHERE state = 'Sending'", &[])?;
        sql.run("UPDATE intents SET payload_json = json_set(payload_json, '$.state', 'Uncertain') WHERE json_extract(payload_json, '$.state') = 'Sending'", &[])?;
        Ok(result.get("changes").cloned().unwrap_or(json!(0)))
    })
}

const CHAT_CURSOR_SCOPE: &str = "chat.list:v1";

fn encode_chat_cursor(host: &dyn Host, row: &Value) -> CoreResult<String> {
    let encoded = json_stringify(
        host,
        json!({
            "v": 1, "scope": CHAT_CURSOR_SCOPE,
            "platform": row["platform"].clone(), "account": row["account"].clone(), "chat_id": row["chat_id"].clone(),
        }),
    )?;
    base64url_encode(host, &encoded)
}

fn decode_chat_cursor(host: &dyn Host, value: Option<&Value>) -> CoreResult<Option<Value>> {
    let Some(value) = value else { return Ok(None) };
    let cursor = value
        .as_str()
        .ok_or_else(|| CoreError::new("BadRequestError", "cursor is malformed"))?;
    let parsed = base64url_decode(host, cursor)
        .and_then(|decoded| json_parse(host, &decoded))
        .map_err(|_| CoreError::new("BadRequestError", "cursor is malformed"))?;
    let valid = parsed.get("v").and_then(Value::as_i64) == Some(1)
        && parsed.get("scope").and_then(Value::as_str) == Some(CHAT_CURSOR_SCOPE)
        && ["platform", "account", "chat_id"].iter().all(|field| {
            parsed
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        });
    if !valid {
        return Err(CoreError::new(
            "BadRequestError",
            "cursor does not match chat.list",
        ));
    }
    if encode_chat_cursor(host, &parsed)? != cursor {
        return Err(CoreError::new("BadRequestError", "cursor is malformed"));
    }
    Ok(Some(parsed))
}

fn chat_list(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    let input = object(input, "chat list input")?;
    let limit = page_limit(input.get("limit"))?;
    let cursor = decode_chat_cursor(host, input.get("cursor"))?;
    let cursor_where = if cursor.is_some() {
        " WHERE (platform > ? OR (platform = ? AND account > ?) OR (platform = ? AND account = ? AND chat_id > ?))"
    } else {
        ""
    };
    let params = cursor
        .as_ref()
        .map(|cursor| {
            vec![
                cursor["platform"].clone(),
                cursor["platform"].clone(),
                cursor["account"].clone(),
                cursor["platform"].clone(),
                cursor["account"].clone(),
                cursor["chat_id"].clone(),
                json!(limit + 1),
            ]
        })
        .unwrap_or_else(|| vec![json!(limit + 1)]);
    let rows = SqlHost::new(host).all(&format!("SELECT platform, account, chat_id, display_name FROM chats{cursor_where} ORDER BY platform, account, chat_id LIMIT ?"), &params)?;
    let chats = rows.iter().take(limit).cloned().collect::<Vec<_>>();
    let mut result = json!({ "chats": chats });
    if rows.len() > limit {
        if let Some(final_row) = rows.get(limit - 1) {
            result["next_cursor"] = Value::String(encode_chat_cursor(host, final_row)?);
        }
    }
    Ok(result)
}

fn audit_read(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    let input = object(input, "read audit input")?;
    let subject = string(field(input, "subject"), "subject")?;
    let subject_hash = host_string(host, "host.sha256Text", Value::String(subject))?;
    let created_at = host.call("host.now", Value::Null)?;
    let payload = json_stringify(
        host,
        json!({
            "role": input.get("role").cloned().unwrap_or(Value::Null),
            "session_id": field(input, "session_id").clone(),
            "result_count": field(input, "result_count").clone(),
        }),
    )?;
    SqlHost::new(host).run(
        "INSERT INTO audit (action, subject, payload_json, created_at) VALUES (?, ?, ?, ?)",
        &[
            field(input, "action").clone(),
            Value::String(subject_hash),
            Value::String(payload),
            created_at,
        ],
    )?;
    Ok(Value::Null)
}

fn send_status(host: &dyn Host, input: &Value) -> CoreResult<Value> {
    let id = object(input, "send status input")
        .map(|value| field(value, "id").clone())
        .unwrap_or_else(|_| input.clone());
    let row = SqlHost::new(host).get(
        "SELECT id, state, created_at FROM sends WHERE id = ?",
        &[id],
    )?;
    Ok(if row.is_null() {
        json!({ "state": "missing" })
    } else {
        row
    })
}

pub fn dispatch(op: &str, input: &Value, host: &dyn Host) -> Option<CoreResult<Value>> {
    Some(match op {
        "store.schema" => Ok(json!({ "version": SCHEMA_VERSION, "sql": INITIAL_SCHEMA })),
        "store.migrate" => migrate(host),
        "store.diagnose" => diagnose(host),
        "store.applySyncBatch" => apply_sync_batch(host, input),
        "store.readSyncState" => read_sync_state(host, input),
        "store.coverageFor" => coverage_for(host, input),
        "store.getMessage" => get_message(host, input),
        "store.recordUnreadState" => record_unread_state(host, input),
        "store.recordAccountIdentity" => record_account_identity(host, input),
        "store.recentEvidence" => recent_evidence(host, input),
        "store.recentMessages" => recent_messages(host, input),
        "store.inboxMessages" => query_messages(host, input, false),
        "store.searchMessages" => query_messages(host, input, true),
        "daemon.recoverInterruptedSends" => recover_interrupted_sends(host),
        "daemon.chatList" => chat_list(host, input),
        "daemon.auditRead" => audit_read(host, input),
        "daemon.sendStatus" => send_status(host, input),
        _ => return None,
    })
}
