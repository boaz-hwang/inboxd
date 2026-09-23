//! Partial account observations share the message/FTS index with bounded sync.
//! They never advance a sync cursor or assert coverage/deletion completeness.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use inboxd_core::{CoreError, CoreResult};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

fn error(message: &str) -> CoreError {
    CoreError::new("ObservationError", message)
}
fn sql_error(e: rusqlite::Error) -> CoreError {
    error(&e.to_string())
}
fn text<'a>(v: &'a Value, k: &str) -> CoreResult<&'a str> {
    v[k].as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16000)
        .ok_or_else(|| error("invalid observation field"))
}
pub(crate) fn observe(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let platform = text(input, "platform")?;
    let account = text(input, "account")?;
    let observed = input["observed_at"]
        .as_u64()
        .ok_or_else(|| error("observation order required"))?;
    let rows = input["messages"]
        .as_array()
        .filter(|m| m.len() <= 1000)
        .ok_or_else(|| error("invalid observation page"))?;
    let tx = connection.unchecked_transaction().map_err(sql_error)?;
    let mut stored = 0;
    let mut changed = 0;
    let mut inserted = Vec::new();
    let mut changed_chats = BTreeSet::new();
    for row in rows {
        let chat = text(row, "chat_id")?;
        let id = text(row, "id")?;
        let author = row["author_id"]
            .as_str()
            .ok_or_else(|| error("author required"))?;
        let body = row["body"]
            .as_str()
            .filter(|s| s.len() <= 65536)
            .ok_or_else(|| error("body too large"))?;
        let Some(body) = inboxd_core::message_body(platform, body) else {
            continue;
        };
        let body = body.as_str();
        stored += 1;
        let ts = row["ts"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.)
            .ok_or_else(|| error("invalid timestamp"))?;
        type Existing = (Option<f64>, String, Option<String>, Option<String>, f64);
        let existing: Option<Existing> = tx.query_row(
            "SELECT deleted_at, revision_value, body, author_id, ts FROM messages WHERE platform=? AND account=? AND chat_id=? AND msg_id=?",
            params![platform,account,chat,id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(sql_error)?;
        if let Some((deleted, revision, _, _, _)) = &existing {
            if deleted.is_some()
                || revision
                    .strip_prefix("observed:")
                    .and_then(|s| s.parse::<u64>().ok())
                    .is_some_and(|v| v > observed)
            {
                continue;
            }
        }
        if existing
            .as_ref()
            .is_none_or(|(_, _, old_body, old_author, old_ts)| {
                old_body.as_deref() != Some(body)
                    || old_author.as_deref() != Some(author)
                    || *old_ts != ts
            })
        {
            changed += 1;
            changed_chats.insert(chat.to_owned());
            if existing.is_none() {
                inserted.push(json!({"chat_id":chat,"id":id}));
            }
        }
        tx.execute(
            "INSERT OR IGNORE INTO chats(platform,account,chat_id) VALUES(?,?,?)",
            params![platform, account, chat],
        )
        .map_err(sql_error)?;
        // A display projection may omit replies/attachments/edit metadata. Do
        // not erase richer fields previously collected by a bounded worker.
        tx.execute("INSERT INTO messages(platform,account,chat_id,msg_id,author_id,ts,body,revision_kind,revision_value) VALUES(?,?,?,?,?,?,?,'string',?) ON CONFLICT(platform,account,chat_id,msg_id) DO UPDATE SET author_id=excluded.author_id, ts=excluded.ts, body=excluded.body, revision_kind=excluded.revision_kind, revision_value=excluded.revision_value", params![platform,account,chat,id,author,ts,body,format!("observed:{observed}")]).map_err(sql_error)?;
        tx.execute(
            "DELETE FROM messages_fts WHERE platform=? AND account=? AND chat_id=? AND msg_id=?",
            params![platform, account, chat, id],
        )
        .map_err(sql_error)?;
        tx.execute(
            "INSERT INTO messages_fts(platform,account,chat_id,msg_id,body) VALUES(?,?,?,?,?)",
            params![platform, account, chat, id, body],
        )
        .map_err(sql_error)?;
        if let Some(name) = row["author_name"].as_str().filter(|s| !s.is_empty()) {
            tx.execute("INSERT INTO identities(platform,account,identity_id,display_name) VALUES(?,?,?,?) ON CONFLICT(platform,account,identity_id) DO UPDATE SET display_name=excluded.display_name",params![platform,account,author,name]).map_err(sql_error)?;
        }
    }
    for chat in changed_chats {
        tx.execute(
            "UPDATE reply_suggestions SET status='stale' WHERE platform=? AND account=? AND chat_id=? AND status IN ('queued','generating','ready')",
            params![platform, account, chat],
        )
        .map_err(sql_error)?;
    }
    tx.commit().map_err(sql_error)?;
    Ok(json!({"stored":stored,"changed":changed,"inserted":inserted}))
}

/// Only daemon-validated authoritative provider deletions reach this operation.
/// A tombstone for an unseen ID also prevents a delayed history read resurrecting it.
pub(crate) fn delete(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let platform = text(input, "platform")?;
    let account = text(input, "account")?;
    let chat = text(input, "chat_id")?;
    let at = input["deleted_at"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.)
        .ok_or_else(|| error("deletion time required"))?;
    let ids = input["ids"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 1000)
        .ok_or_else(|| error("invalid deletion IDs"))?;
    let tx = connection.unchecked_transaction().map_err(sql_error)?;
    let mut changed = 0;
    tx.execute(
        "INSERT OR IGNORE INTO chats(platform,account,chat_id) VALUES(?,?,?)",
        params![platform, account, chat],
    )
    .map_err(sql_error)?;
    for id in ids {
        let id = id
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 16000)
            .ok_or_else(|| error("invalid deletion ID"))?;
        changed += tx.execute("INSERT INTO messages(platform,account,chat_id,msg_id,ts,body,deleted_at,revision_kind,revision_value) VALUES(?,?,?,?,?,NULL,?,'string','unversioned') ON CONFLICT(platform,account,chat_id,msg_id) DO UPDATE SET body=NULL,deleted_at=excluded.deleted_at,attachments_json='[]' WHERE messages.deleted_at IS NULL", params![platform,account,chat,id,at,at]).map_err(sql_error)?;
        tx.execute(
            "DELETE FROM messages_fts WHERE platform=? AND account=? AND chat_id=? AND msg_id=?",
            params![platform, account, chat, id],
        )
        .map_err(sql_error)?;
        tx.execute(
            "DELETE FROM response_unseen WHERE platform=? AND account=? AND chat_id=? AND msg_id=?",
            params![platform, account, chat, id],
        )
        .map_err(sql_error)?;
        tx.execute(
            "DELETE FROM response_seen WHERE platform=? AND account=? AND chat_id=? AND msg_id=?",
            params![platform, account, chat, id],
        )
        .map_err(sql_error)?;
    }
    tx.execute("DELETE FROM trajectory_steps WHERE suggestion_id IN (SELECT suggestion_id FROM reply_suggestions WHERE platform=? AND account=? AND chat_id=?)",params![platform,account,chat]).map_err(sql_error)?;
    tx.execute("DELETE FROM trajectory_evidence WHERE suggestion_id IN (SELECT suggestion_id FROM reply_suggestions WHERE platform=? AND account=? AND chat_id=?)",params![platform,account,chat]).map_err(sql_error)?;
    tx.execute("DELETE FROM trajectory_runs WHERE suggestion_id IN (SELECT suggestion_id FROM reply_suggestions WHERE platform=? AND account=? AND chat_id=?)",params![platform,account,chat]).map_err(sql_error)?;
    tx.execute("DELETE FROM response_trajectory WHERE suggestion_id IN (SELECT suggestion_id FROM reply_suggestions WHERE platform=? AND account=? AND chat_id=?)",params![platform,account,chat]).map_err(sql_error)?;
    tx.execute(
        "DELETE FROM reply_suggestions WHERE platform=? AND account=? AND chat_id=?",
        params![platform, account, chat],
    )
    .map_err(sql_error)?;
    tx.execute("UPDATE response_sessions SET suggestion_id=NULL,state=CASE WHEN state='open' THEN 'closed' ELSE state END,closed_at=CASE WHEN state='open' THEN ? ELSE closed_at END WHERE platform=? AND account=? AND chat_id=?",params![at,platform,account,chat]).map_err(sql_error)?;
    tx.commit().map_err(sql_error)?;
    Ok(json!({"changed":changed}))
}

pub(crate) fn search(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let platform = text(input, "platform")?;
    let account = text(input, "account")?;
    let query = text(input, "query")?;
    let chat = input["chat_id"].as_str();
    let interval = input
        .get("interval")
        .cloned()
        .unwrap_or(json!({"from_ts":0,"to_ts":9007199254740991u64}));
    let from = interval["from_ts"]
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| error("invalid interval"))?;
    let to = interval["to_ts"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > from)
        .ok_or_else(|| error("invalid interval"))?;
    let limit = input
        .get("limit")
        .map_or(Some(50), Value::as_u64)
        .filter(|n| (1..=80).contains(n))
        .ok_or_else(|| error("invalid limit"))? as usize;
    let scope = json!(format!(
        "{:x}",
        Sha256::digest(
            json!([platform, account, chat, query, interval, "local"])
                .to_string()
                .as_bytes()
        )
    ));
    let mut filter = String::from(
        "m.platform=? AND m.account=? AND m.ts>=? AND m.ts<? AND m.deleted_at IS NULL",
    );
    let mut args = vec![
        SqlValue::from(platform.to_owned()),
        SqlValue::from(account.to_owned()),
        SqlValue::Real(from),
        SqlValue::Real(to),
    ];
    if let Some(chat) = &chat {
        filter.push_str(" AND m.chat_id=?");
        args.push((*chat).to_owned().into());
    }
    if let Some(cursor) = input.get("cursor") {
        let raw = cursor
            .as_str()
            .filter(|s| s.len() <= 4096)
            .ok_or_else(|| error("invalid cursor"))?;
        let decoded = URL_SAFE_NO_PAD
            .decode(raw)
            .map_err(|_| error("invalid cursor"))?;
        let value: Value = serde_json::from_slice(&decoded).map_err(|_| error("invalid cursor"))?;
        if value["scope"] != scope {
            return Err(error("cursor scope mismatch"));
        }
        let ts = value["ts"]
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| error("invalid cursor"))?;
        filter.push_str(" AND (m.ts < ? OR (m.ts = ? AND (m.chat_id,m.msg_id) > (?,?)))");
        args.extend([
            SqlValue::Real(ts),
            SqlValue::Real(ts),
            text(&value, "chat_id")?.to_owned().into(),
            text(&value, "msg_id")?.to_owned().into(),
        ]);
    }
    let table = if query.chars().count() >= 3 {
        filter.push_str(" AND messages_fts MATCH ? AND messages_fts.platform=m.platform AND messages_fts.account=m.account AND messages_fts.chat_id=m.chat_id AND messages_fts.msg_id=m.msg_id");
        args.push(format!("\"{}\"", query.replace('"', "\"\"")).into());
        "messages_fts CROSS JOIN messages m"
    } else {
        filter.push_str(" AND m.body LIKE ? ESCAPE '\\'");
        args.push(
            format!(
                "%{}%",
                query
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            )
            .into(),
        );
        "messages m"
    };
    args.push(SqlValue::Integer((limit + 1) as i64));
    let sql = format!(
        "SELECT m.chat_id,m.msg_id,m.author_id,m.ts,m.body,m.edited_at,i.display_name FROM {table} LEFT JOIN identities i ON i.platform=m.platform AND i.account=m.account AND i.identity_id=m.author_id WHERE {filter} ORDER BY m.ts DESC,m.chat_id,m.msg_id LIMIT ?"
    );
    let mut statement = connection.prepare(&sql).map_err(sql_error)?;
    let rows = statement.query_map(params_from_iter(args),|r|Ok(json!({"platform":platform,"account":account,"chat_id":r.get::<_,String>(0)?,"msg_id":r.get::<_,String>(1)?,"author_id":r.get::<_,Option<String>>(2)?,"ts":r.get::<_,f64>(3)?,"body":r.get::<_,String>(4)?,"edited_at":r.get::<_,Option<f64>>(5)?,"author_name":r.get::<_,Option<String>>(6)?}))).map_err(sql_error)?.collect::<Result<Vec<_>,_>>().map_err(sql_error)?;
    let mut messages = Vec::new();
    let mut bytes = 0;
    for row in rows.iter().take(limit) {
        let size = serde_json::to_vec(row)
            .map_err(|_| error("invalid message"))?
            .len();
        if bytes + size > 48000 {
            if messages.is_empty() {
                return Err(error("stored message exceeds response budget"));
            }
            break;
        }
        bytes += size;
        messages.push(row.clone());
    }
    let next = if rows.len() > messages.len() {
        let row = messages.last().ok_or_else(|| error("empty page"))?;
        Some(URL_SAFE_NO_PAD.encode(json!({"scope":scope,"ts":row["ts"],"chat_id":row["chat_id"],"msg_id":row["msg_id"]}).to_string()))
    } else {
        None
    };
    // Account-wide partial observations do not establish interval completeness.
    Ok(
        json!({"messages":messages,"next_cursor":next,"source":"local","semantics":"substring","coverage":{"covered":[],"gaps":[{"interval":interval,"reason":"unknown"}],"limits":[],"freshness":[]}}),
    )
}

/// Remove old revision-only feed rows, without interpreting their target logId.
pub(crate) fn repair_internal_feeds(connection: &Connection) -> CoreResult<()> {
    let tx = connection.unchecked_transaction().map_err(sql_error)?;
    let rows = {
        let mut stmt = tx.prepare("SELECT account,chat_id,msg_id,body FROM messages WHERE platform='kakao' AND deleted_at IS NULL AND ltrim(body) LIKE '{%'").map_err(sql_error)?;
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?
    };
    for (account, chat, id, body) in rows {
        let normalized = inboxd_core::message_body("kakao", &body);
        if normalized.as_deref() == Some(body.as_str()) {
            continue;
        }
        tx.execute("DELETE FROM messages_fts WHERE platform='kakao' AND account=? AND chat_id=? AND msg_id=?",params![account,chat,id]).map_err(sql_error)?;
        if let Some(text) = normalized {
            tx.execute("UPDATE messages SET body=? WHERE platform='kakao' AND account=? AND chat_id=? AND msg_id=?",params![text,account,chat,id]).map_err(sql_error)?;
            tx.execute("INSERT INTO messages_fts(platform,account,chat_id,msg_id,body) VALUES('kakao',?,?,?,?)",params![account,chat,id,text]).map_err(sql_error)?;
        } else {
            for table in ["response_unseen", "response_seen", "messages"] {
                tx.execute(&format!("DELETE FROM {table} WHERE platform='kakao' AND account=? AND chat_id=? AND msg_id=?"),params![account,chat,id]).map_err(sql_error)?;
            }
        }
        // Context changed: old generated text must not reuse an internal feed.
        tx.execute("UPDATE reply_suggestions SET status='stale',text=NULL,generation_epoch=generation_epoch+1 WHERE platform='kakao' AND account=? AND chat_id=? AND status IN ('queued','generating','ready')",params![account,chat]).map_err(sql_error)?;
    }
    tx.commit().map_err(sql_error)?;
    Ok(())
}
