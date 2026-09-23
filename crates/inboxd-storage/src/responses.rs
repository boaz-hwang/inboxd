use inboxd_core::{CoreError, CoreResult};
use rusqlite::{Connection, OptionalExtension, named_params, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const PROMPT_VERSION: &str = "reply-v2";

fn fail(message: impl Into<String>) -> CoreError {
    CoreError::new("ResponseStorageError", message)
}
fn sql(_: rusqlite::Error) -> CoreError {
    fail("response state operation failed")
}
fn now() -> CoreResult<f64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| fail("clock error"))?
        .as_secs_f64())
}
fn field<'a>(value: &'a Value, key: &str) -> CoreResult<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16_000)
        .ok_or_else(|| fail(format!("invalid {key}")))
}
fn chat(value: &Value) -> CoreResult<(&str, &str, &str)> {
    Ok((
        field(value, "platform")?,
        field(value, "account")?,
        field(value, "chat_id")?,
    ))
}
fn self_id(connection: &Connection, platform: &str, account: &str) -> CoreResult<Option<String>> {
    let evidence: Option<String> = connection
        .query_row(
            "SELECT evidence_json FROM account_self WHERE platform=? AND account=?",
            params![platform, account],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    Ok(evidence
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(|v| v["status"] == "known")
        .and_then(|v| v["self_id"].as_str().map(str::to_owned)))
}

// System/unknown-author records are not evidence that the other person replied.
// Check the full room, not only the bounded prompt context or unread subset.
fn latest_human_is_self(
    connection: &Connection,
    platform: &str,
    account: &str,
    chat_id: &str,
    own: &str,
) -> CoreResult<bool> {
    let author: Option<String> = connection
        .query_row(
            "SELECT author_id FROM messages WHERE platform=? AND account=? AND chat_id=? AND deleted_at IS NULL AND author_id IS NOT NULL ORDER BY ts DESC,msg_id DESC LIMIT 1",
            params![platform, account, chat_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    Ok(author.as_deref() == Some(own))
}

fn context_has_new_latest_message(
    connection: &Connection,
    platform: &str,
    account: &str,
    chat_id: &str,
    stored_context: &str,
) -> CoreResult<bool> {
    let stored_latest = serde_json::from_str::<Value>(stored_context)
        .ok()
        .and_then(|v| v.as_array().and_then(|rows| rows.last().cloned()))
        .and_then(|v| v["message_id"].as_str().map(str::to_owned));
    let actual_latest: Option<String> = connection
        .query_row(
            "SELECT msg_id FROM messages WHERE platform=? AND account=? AND chat_id=? AND deleted_at IS NULL ORDER BY ts DESC,msg_id DESC LIMIT 1",
            params![platform, account, chat_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    Ok(matches!((stored_latest, actual_latest), (Some(stored), Some(actual)) if stored != actual))
}

fn invalidate_changed_context(connection: &Connection, id: &str) -> CoreResult<()> {
    connection
        .execute(
            "UPDATE reply_suggestions SET status='stale',text=NULL,error='context_changed',generation_epoch=generation_epoch+1 WHERE suggestion_id=? AND status IN ('queued','generating','ready')",
            [id],
        )
        .map_err(sql)?;
    Ok(())
}

fn invalidate_after_self(
    connection: &Connection,
    platform: &str,
    account: &str,
    chat_id: &str,
) -> CoreResult<()> {
    connection
        .execute(
            "UPDATE reply_suggestions SET status='abstained',text=NULL,error='no_reply_target',generation_epoch=generation_epoch+1 WHERE platform=? AND account=? AND chat_id=? AND status IN ('queued','generating','ready')",
            params![platform, account, chat_id],
        )
        .map_err(sql)?;
    Ok(())
}

// Decimal message IDs are compared without floating point or SQLite integer casts.
// Only provider boundaries with an ordered numeric own-read cursor supply this field.
fn numeric_id(value: &str) -> Option<&str> {
    if value.is_empty() || value.len() > 64 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(value.trim_start_matches('0'))
}
fn read_through(value: &Value) -> Option<&str> {
    value["read_through"].as_str().and_then(numeric_id)
}
fn covered_by_read(id: &str, cursor: Option<&str>) -> bool {
    match (
        numeric_id(
            id.strip_prefix("telegram:message:")
                .and_then(|s| s.rsplit_once(':').map(|(_, id)| id))
                .unwrap_or(id),
        ),
        cursor,
    ) {
        (Some(id), Some(cursor)) => (id.len(), id) <= (cursor.len(), cursor),
        _ => false,
    }
}
fn provider_evidence(connection: &Connection, p: &str, a: &str, c: &str) -> CoreResult<Value> {
    let raw: Option<String> = connection.query_row("SELECT evidence_json FROM unread_evidence WHERE platform=? AND account=? AND chat_id=?", params![p,a,c], |r| r.get(0)).optional().map_err(sql)?;
    Ok(raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null))
}
fn after_provider_read() -> String {
    // Shared storage uses scoped Telegram message keys; compare their numeric
    // suffix only within the already-constrained platform/account/chat scope.
    let id = "(CASE WHEN m.platform='telegram' THEN substr(m.msg_id,length('telegram:message:' || substr(m.chat_id,length('telegram:chat:')+1) || ':')+1) ELSE m.msg_id END)";
    "(:cursor IS NULL OR m.msg_id='' OR m.msg_id GLOB '*[^0-9]*' OR length(m.msg_id)>64 OR length(ltrim(m.msg_id,'0'))>length(:cursor) OR (length(ltrim(m.msg_id,'0'))=length(:cursor) AND ltrim(m.msg_id,'0')>:cursor))".replace("m.msg_id", id)
}

pub(crate) fn unread(connection: &Connection, scope: &Value) -> CoreResult<Value> {
    let (platform, account, chat_id) = chat(scope)?;
    let after_provider_read = after_provider_read();
    let identity = self_id(connection, platform, account)?;
    let evidence: Option<(String, f64)> = connection.query_row(
        "SELECT evidence_json,observed_at FROM unread_evidence WHERE platform=? AND account=? AND chat_id=?",
        params![platform,account,chat_id], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
    let provider = evidence
        .as_ref()
        .and_then(|(raw, _)| serde_json::from_str::<Value>(raw).ok());
    let cursor = provider.as_ref().and_then(read_through);
    let provider_count = provider
        .as_ref()
        .filter(|v| v["status"] == "known")
        .and_then(|v| v["count"].as_u64());
    // A room-entry read consumes count-only history too. Preserve the provider
    // evidence for rollback; newer directory evidence replaces this snapshot.
    let all_read = if let Some(operation) = provider
        .as_ref()
        .and_then(|v| v["read_all_operation_id"].as_str())
    {
        connection.query_row("SELECT 1 FROM provider_read_sync WHERE platform=? AND account=? AND chat_id=? AND operation_id=? AND state IN ('pending','synced')",params![platform,account,chat_id,operation], |_| Ok(true)).optional().map_err(sql)?.unwrap_or(false)
    } else {
        false
    };
    // Provider evidence bounds the initial unseen set. This prevents the first
    // local observation from reclassifying the entire retained history as unread.
    // Seen IDs consume that evidence locally, even if the provider count remains
    // stale until its next refresh.
    let provider_remaining = if all_read {
        Some(0)
    } else if let Some(limit) = provider_count {
        if let Some(me) = identity.as_deref() {
            let query = format!(
                "SELECT count(*),sum(CASE WHEN s.msg_id IS NULL THEN 1 ELSE 0 END) FROM (SELECT * FROM messages m WHERE m.platform=:platform AND m.account=:account AND m.chat_id=:chat AND m.deleted_at IS NULL AND m.author_id<>:self AND {after_provider_read} ORDER BY m.ts DESC,m.msg_id DESC LIMIT :limit) m LEFT JOIN response_seen s ON s.platform=m.platform AND s.account=m.account AND s.chat_id=m.chat_id AND s.msg_id=m.msg_id"
            );
            let (available, unseen): (i64, i64) = connection
                .query_row(
                    &query,
                    named_params!{":platform":platform, ":account":account, ":chat":chat_id, ":self":me, ":limit":limit as i64, ":cursor":cursor},
                    |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
                )
                .map_err(sql)?;
            // Messages not yet collected remain count-only evidence. Collected seen
            // messages reduce the stale provider number without erasing that remainder.
            Some(unseen.max(0) as u64 + limit.saturating_sub(available.max(0) as u64))
        } else {
            // Without authenticated self identity, no retained message can safely
            // be classified as incoming. Preserve the provider's count-only fact.
            Some(limit)
        }
    } else {
        None
    };
    let explicit: i64 = connection.query_row(
        &format!("SELECT count(*) FROM response_unseen m LEFT JOIN response_seen s ON s.platform=m.platform AND s.account=m.account AND s.chat_id=m.chat_id AND s.msg_id=m.msg_id WHERE m.platform=:platform AND m.account=:account AND m.chat_id=:chat AND s.msg_id IS NULL AND {after_provider_read}"),
        named_params!{":platform":platform, ":account":account, ":chat":chat_id, ":cursor":cursor}, |r| r.get(0)).map_err(sql)?;
    let explicit = explicit.max(0) as u64;
    let count = provider_remaining
        .map(|remaining| remaining.max(explicit))
        .or((explicit > 0).then_some(explicit));
    let source = if provider_count.is_some() && identity.is_some() {
        "combined"
    } else if provider_count.is_some() {
        "provider"
    } else if explicit > 0 {
        "observed"
    } else {
        "unknown"
    };
    let status = if provider_count.is_some() {
        "known"
    } else if explicit > 0 {
        "at_least"
    } else {
        "unknown"
    };
    let observed_at = evidence.map(|(_, at)| at).unwrap_or(0.0);
    Ok(
        json!({"count":count,"source":source,"status":status,"observed_at":observed_at,
        "local_unseen_count":count,"provider":provider.unwrap_or(Value::Null)}),
    )
}

fn reply_context_version(context: &str, runtime: &str, sources: &[String]) -> CoreResult<String> {
    let mut hash = Sha256::new();
    hash.update(context.as_bytes());
    hash.update([0]);
    hash.update(runtime.as_bytes());
    hash.update(serde_json::to_vec(sources).map_err(|_| fail("source serialization failed"))?);
    Ok(format!("{:x}", hash.finalize()))
}

pub(crate) fn prepare(connection: &Connection, scope: &Value) -> CoreResult<Value> {
    let (platform, account, chat_id) = chat(scope)?;
    let own = self_id(connection, platform, account)?;
    let mut statement = connection.prepare(
        "SELECT msg_id,author_id,ts,body,parent_msg_id FROM messages WHERE platform=? AND account=? AND chat_id=? AND deleted_at IS NULL ORDER BY ts DESC,msg_id DESC LIMIT 40"
    ).map_err(sql)?;
    let mut rows = statement
        .query_map(params![platform, account, chat_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    rows.reverse();
    if rows.is_empty() {
        return Ok(json!({"status":"abstained","reason":"no_context"}));
    }
    if own.is_none() {
        return Ok(json!({"status":"abstained","reason":"self_identity_unavailable"}));
    }
    if latest_human_is_self(
        connection,
        platform,
        account,
        chat_id,
        own.as_deref().unwrap(),
    )? {
        invalidate_after_self(connection, platform, account, chat_id)?;
        return Ok(json!({"status":"abstained","reason":"no_reply_target"}));
    }
    let latest_incoming_ts = connection
        .query_row(
            "SELECT max(ts) FROM messages WHERE platform=? AND account=? AND chat_id=? AND deleted_at IS NULL AND author_id<>?",
            params![platform, account, chat_id, own.as_deref().unwrap_or_default()],
            |r| r.get::<_, Option<f64>>(0),
        )
        .map_err(sql)?
        .unwrap_or(0.0);
    // Resolve the latest explicit reply chain before inference, within the same
    // account/chat only. Keep unread accounting on the original recent window.
    let mut context_rows = rows.clone();
    let mut parent = rows.last().and_then(|row| row.4.clone());
    for _ in 0..8 {
        let Some(id) = parent.take() else { break };
        if context_rows.iter().any(|row| row.0 == id) {
            break;
        }
        let found = connection.query_row(
            "SELECT msg_id,author_id,ts,body,parent_msg_id FROM messages WHERE platform=? AND account=? AND chat_id=? AND msg_id=? AND deleted_at IS NULL",
            params![platform, account, chat_id, id], |r| Ok((
                r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?,
                r.get::<_, f64>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?
            ))).optional().map_err(sql)?;
        let Some(found) = found else { break };
        parent = found.4.clone();
        context_rows.push(found);
    }
    context_rows.sort_by(|a, b| a.2.total_cmp(&b.2).then_with(|| a.0.cmp(&b.0)));
    let context: Vec<Value> = context_rows.iter().map(|(id,author,ts,body,parent)| json!({
        "message_id":id,"author_role":match (own.as_deref(),author.as_deref()) { (Some(a),Some(b)) if a==b=>"self", (Some(_),Some(_))=>"other", _=>"unknown" },
        "author_id":author,"body":body,"ts":ts,"reply_to":parent
    })).collect();
    let evidence = provider_evidence(connection, platform, account, chat_id)?;
    let cursor = read_through(&evidence);
    let provider_count = (evidence["status"] == "known")
        .then(|| evidence["count"].as_u64())
        .flatten();
    let mut unseen_statement = connection
        .prepare("SELECT msg_id FROM response_unseen WHERE platform=? AND account=? AND chat_id=?")
        .map_err(sql)?;
    let explicit = unseen_statement
        .query_map(params![platform, account, chat_id], |r| {
            r.get::<_, String>(0)
        })
        .map_err(sql)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(sql)?;
    let mut incoming_position = 0usize;
    let mut sources: Vec<String> = rows.iter().rev().filter_map(|(id,author,_,_,_)| {
            if covered_by_read(id, cursor) || own.as_deref().is_some_and(|me| author.as_deref()==Some(me)){return None;}
            let within_provider=incoming_position < provider_count.unwrap_or(0) as usize;
            incoming_position+=1;
            if !within_provider && !explicit.contains(id){return None;}
            let seen_at=connection.query_row("SELECT seen_at FROM response_seen WHERE platform=? AND account=? AND chat_id=? AND msg_id=?",params![platform,account,chat_id,id], |r|r.get::<_,f64>(0)).optional().ok().flatten();
            let consumed=seen_at.is_some();
            (!consumed).then_some(id.clone())
        }).collect();
    sources.reverse();
    let context_json =
        serde_json::to_string(&context).map_err(|_| fail("context serialization failed"))?;
    let runtime_version = scope["runtime_version"].as_str().unwrap_or("legacy");
    // Reading consumes unread evidence, not the obligation to reply. Reuse the
    // prepared source set while its context/runtime remain identical and unsent.
    let mut retained = connection.prepare("SELECT r.suggestion_id,r.status,r.generation_epoch,r.source_json,r.context_version,r.error,(SELECT t.suggested_text FROM trajectory_runs t WHERE t.suggestion_id=r.suggestion_id AND t.output_status='ready') FROM reply_suggestions r WHERE r.platform=? AND r.account=? AND r.chat_id=? AND r.context_json=? AND r.prompt_version=? AND (r.status IN ('queued','generating','ready','failed','abstained') OR (r.error='provider_read_advanced' AND EXISTS (SELECT 1 FROM trajectory_runs t WHERE t.suggestion_id=r.suggestion_id AND t.output_status='ready' AND t.suggested_text IS NOT NULL))) AND NOT EXISTS (SELECT 1 FROM response_sessions s WHERE s.suggestion_id=r.suggestion_id AND s.state IN ('sent','uncertain')) ORDER BY r.created_at DESC LIMIT 32").map_err(sql)?;
    let candidates = retained
        .query_map(
            params![platform, account, chat_id, context_json, PROMPT_VERSION],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    for (id, mut status, mut epoch, raw_sources, version, error, recorded_text) in candidates {
        let retained_sources: Vec<String> =
            serde_json::from_str(&raw_sources).map_err(|_| fail("invalid stored reply sources"))?;
        if reply_context_version(&context_json, runtime_version, &retained_sources)? == version {
            // Read evidence may change the source set without changing the
            // conversation. A terminal generation remains terminal in either
            // direction so phone/local reads cannot silently retry it.
            if matches!(status.as_str(), "failed" | "abstained")
                && error.as_deref() != Some("provider_read_advanced")
            {
                return Ok(
                    json!({"status":status,"suggestion_id":id,"generation_epoch":epoch,"chat":scope,"context_version":version,"source_message_ids":retained_sources,"context":context,"prompt_version":PROMPT_VERSION,"unread":unread(connection,&scope)?,"latest_incoming_ts":latest_incoming_ts}),
                );
            }
            if !sources
                .iter()
                .all(|source| retained_sources.contains(source))
            {
                continue;
            }
            if !matches!(status.as_str(), "queued" | "generating" | "ready") {
                // Recover only text removed by the old read-invalidation path,
                // after validating the exact current context/runtime and unsent state.
                let text = recorded_text
                    .as_deref()
                    .filter(|text| !text.trim().is_empty());
                if text.is_none() {
                    continue;
                }
                connection.execute("UPDATE reply_suggestions SET status='ready',text=?,error=NULL,generation_epoch=generation_epoch+1 WHERE suggestion_id=? AND error='provider_read_advanced'", params![text,id]).map_err(sql)?;
                status = "ready".into();
                epoch += 1;
            }
            return Ok(
                json!({"status":status,"suggestion_id":id,"generation_epoch":epoch,"chat":scope,"context_version":version,"source_message_ids":retained_sources,"context":context,"prompt_version":PROMPT_VERSION,"unread":unread(connection,&scope)?,"latest_incoming_ts":latest_incoming_ts}),
            );
        }
    }
    // Read conversations still generate a next turn, but never relabel our own
    // last message as an incoming/unseen message just to enable generation.
    let context_version = reply_context_version(&context_json, runtime_version, &sources)?;
    let source_json =
        serde_json::to_string(&sources).map_err(|_| fail("source serialization failed"))?;
    let existing: Option<(String, String, i64)> = connection.query_row(
        "SELECT suggestion_id,status,generation_epoch FROM reply_suggestions WHERE platform=? AND account=? AND chat_id=? AND context_version=? AND prompt_version=?",
        params![platform,account,chat_id,context_version,PROMPT_VERSION], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(sql)?;
    let (suggestion_id, status, mut generation_epoch) =
        existing.unwrap_or_else(|| (Uuid::new_v4().to_string(), "queued".into(), 0));
    // A failed generation is evidence about this exact context, not a transient
    // queue state. Keep it visible until the conversation/runtime changes so
    // reopening a room cannot silently spend more inference on the same input.
    let should_requeue = status == "stale";
    if should_requeue {
        connection.execute("UPDATE reply_suggestions SET status='queued',text=NULL,error=NULL,model_version=NULL,generated_at=NULL,generation_epoch=generation_epoch+1,created_at=? WHERE suggestion_id=?",params![now()?,suggestion_id]).map_err(sql)?;
        generation_epoch += 1;
    }
    let status = if should_requeue {
        "queued".to_owned()
    } else {
        status
    };
    connection.execute("UPDATE reply_suggestions SET status='stale' WHERE platform=? AND account=? AND chat_id=? AND context_version<>? AND status IN ('queued','generating','ready')",params![platform,account,chat_id,context_version]).map_err(sql)?;
    connection.execute("INSERT OR IGNORE INTO reply_suggestions(suggestion_id,platform,account,chat_id,context_version,source_json,context_json,status,prompt_version,created_at) VALUES(?,?,?,?,?,?,?,?,'reply-v2',?)",
        params![suggestion_id,platform,account,chat_id,context_version,source_json,context_json,status,now()?]).map_err(sql)?;
    Ok(
        json!({"status":status,"suggestion_id":suggestion_id,"generation_epoch":generation_epoch,"chat":scope,"context_version":context_version,"source_message_ids":sources,"context":context,"prompt_version":PROMPT_VERSION,"unread":unread(connection,&scope)?,"latest_incoming_ts":latest_incoming_ts}),
    )
}

fn suggestion(connection: &Connection, id: &str) -> CoreResult<Value> {
    let row: Option<(String,String,Option<String>,Option<String>,String,Option<String>)> = connection.query_row(
        "SELECT status,context_version,text,model_version,prompt_version,error FROM reply_suggestions WHERE suggestion_id=?",[id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(sql)?;
    Ok(row.map_or(Value::Null, |(status,context_version,text,model_version,prompt_version,error)|
        json!({"id":id,"status":status,"text":text,"context_version":context_version,"model_version":model_version,"prompt_version":prompt_version,"error":error})))
}

fn session(connection: &Connection, id: &str) -> CoreResult<Value> {
    let row: Option<(String,String,String,String,String,String,Option<String>,String)> = connection.query_row(
        "SELECT platform,account,chat_id,incoming_version,source_json,state,suggestion_id,send_outcome_json FROM response_sessions WHERE session_id=?",[id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get::<_,Option<String>>(7)?.unwrap_or("null".into())))).optional().map_err(sql)?;
    let Some((platform, account, chat_id, incoming_version, source, state, suggestion_id, outcome)) =
        row
    else {
        return Err(fail("unknown response session"));
    };
    let scope = json!({"platform":platform,"account":account,"chat_id":chat_id});
    let no_reply_target = if state == "open" {
        match self_id(connection, &platform, &account)? {
            Some(own) if latest_human_is_self(connection, &platform, &account, &chat_id, &own)? => {
                invalidate_after_self(connection, &platform, &account, &chat_id)?;
                true
            }
            _ => false,
        }
    } else {
        false
    };
    let evidence = provider_evidence(connection, &platform, &account, &chat_id)?;
    let mut source_ids: Vec<String> = serde_json::from_str(&source).unwrap_or_default();
    source_ids.retain(|id| !covered_by_read(id, read_through(&evidence)));
    let suggestion_value = match suggestion_id.as_deref() {
        Some(id) => suggestion(connection, id)?,
        None => Value::Null,
    };
    let status = if state == "open" && no_reply_target {
        "abstained".to_owned()
    } else if state == "open" {
        suggestion_value["status"]
            .as_str()
            .unwrap_or("abstained")
            .to_owned()
    } else {
        state.clone()
    };
    Ok(
        json!({"response_session_id":id,"chat":scope,"incoming_version":incoming_version,
        "source_message_ids":source_ids,"status":status,
        "suggestion":suggestion_value,"error":if no_reply_target {Some("no_reply_target")} else {None},
        "unread":unread(connection,&scope)?,"send_outcome":serde_json::from_str::<Value>(&outcome).unwrap_or(Value::Null)}),
    )
}

fn open(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let mut scope = input["chat"].clone();
    scope["runtime_version"] = input["runtime_version"].clone();
    let prepared = prepare(connection, &scope)?;
    let (platform, account, chat_id) = chat(&input["chat"])?;
    let id = Uuid::new_v4().to_string();
    let version = prepared["context_version"].as_str().unwrap_or("none");
    let source = serde_json::to_string(&prepared["source_message_ids"]).unwrap_or("[]".into());
    connection.execute("INSERT INTO response_sessions(session_id,platform,account,chat_id,incoming_version,source_json,suggestion_id,state,created_at) VALUES(?,?,?,?,?,?,?,'open',?)",
        params![id,platform,account,chat_id,version,source,prepared["suggestion_id"].as_str(),now()?]).map_err(sql)?;
    session(connection, &id)
}

fn seen(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let id = field(input, "response_session_id")?;
    let current = session(connection, id)?;
    let (platform, account, chat_id) = chat(&current["chat"])?;
    let tx = connection.unchecked_transaction().map_err(sql)?;
    let all_ids;
    let ids = if input["all"] == true {
        let mut statement = tx.prepare("SELECT msg_id FROM messages WHERE platform=? AND account=? AND chat_id=? AND deleted_at IS NULL").map_err(sql)?;
        all_ids = statement
            .query_map(params![platform, account, chat_id], |r| {
                r.get::<_, String>(0).map(Value::String)
            })
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        &all_ids
    } else {
        input["message_ids"]
            .as_array()
            .filter(|v| v.len() <= 1000)
            .ok_or_else(|| fail("invalid message_ids"))?
    };
    if ids.is_empty() {
        return Ok(json!({"unread":unread(&tx,&current["chat"])?}));
    }
    let mut newly_seen = Vec::new();
    let mut cursor: Option<u128> = None;
    for value in ids {
        let msg = value
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| fail("invalid message id"))?;
        let belongs: Option<i32> = tx
            .query_row(
                "SELECT 1 FROM messages WHERE platform=? AND account=? AND chat_id=? AND msg_id=?",
                params![platform, account, chat_id, msg],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        if belongs.is_none() {
            return Err(fail("message is outside response session"));
        }
        if platform == "kakao" {
            let numeric = msg
                .parse::<u128>()
                .map_err(|_| fail("invalid Kakao message id"))?;
            cursor = Some(cursor.map_or(numeric, |old| old.max(numeric)));
        }
        if tx.execute("INSERT OR IGNORE INTO response_seen(platform,account,chat_id,msg_id,seen_at) VALUES(?,?,?,?,?)",params![platform,account,chat_id,msg,now()?]).map_err(sql)? > 0 {
            newly_seen.push(msg.to_owned());
        }
    }
    let mut read_sync = json!({"status":"unsupported"});
    let mut task = Value::Null;
    if platform == "kakao" {
        let requested_cursor = cursor.ok_or_else(|| fail("empty Kakao read cursor"))?;
        let existing: Option<(String,i64,String,Option<String>,String,String)> = tx.query_row(
            "SELECT operation_id,revision,cursor,confirmed_cursor,rollback_ids_json,state FROM provider_read_sync WHERE platform=? AND account=? AND chat_id=?",
            params![platform,account,chat_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(sql)?;
        {
            let mut rollback: HashSet<String> = existing
                .as_ref()
                .filter(|row| row.5 == "pending")
                .and_then(|row| serde_json::from_str::<Vec<String>>(&row.4).ok())
                .unwrap_or_default()
                .into_iter()
                .collect();
            rollback.extend(newly_seen);
            let mut rollback = rollback.into_iter().collect::<Vec<_>>();
            rollback.sort_by(|a, b| {
                a.parse::<u128>()
                    .unwrap_or(0)
                    .cmp(&b.parse::<u128>().unwrap_or(0))
            });
            let cursor = existing
                .as_ref()
                .filter(|row| row.5 == "pending")
                .and_then(|row| row.2.parse::<u128>().ok())
                .map_or(requested_cursor, |old| old.max(requested_cursor))
                .to_string();
            let revision = existing.as_ref().map_or(1, |row| row.1.saturating_add(1));
            let operation_id = Uuid::new_v4().to_string();
            let confirmed_cursor = existing.as_ref().and_then(|row| row.3.clone());
            tx.execute("INSERT INTO provider_read_sync(platform,account,chat_id,operation_id,revision,cursor,confirmed_cursor,rollback_ids_json,state,attempts,updated_at) VALUES(?,?,?,?,?,?,?,?, 'pending',0,?) ON CONFLICT(platform,account,chat_id) DO UPDATE SET operation_id=excluded.operation_id,revision=excluded.revision,cursor=excluded.cursor,confirmed_cursor=excluded.confirmed_cursor,rollback_ids_json=excluded.rollback_ids_json,state='pending',attempts=0,updated_at=excluded.updated_at",
                params![platform,account,chat_id,operation_id,revision,cursor,confirmed_cursor,serde_json::to_string(&rollback).map_err(|_|fail("read sync serialization failed"))?,now()?]).map_err(sql)?;
            if input["all"] == true {
                let mut evidence = provider_evidence(&tx, platform, account, chat_id)?;
                if evidence.is_object() {
                    evidence["read_all_operation_id"] = json!(operation_id);
                    tx.execute("UPDATE unread_evidence SET evidence_json=? WHERE platform=? AND account=? AND chat_id=?",params![evidence.to_string(),platform,account,chat_id]).map_err(sql)?;
                }
            }
            read_sync = json!({"operation_id":operation_id,"status":"pending"});
            task = json!({"operation_id":operation_id,"revision":revision,"platform":platform,"account":account,"chat_id":chat_id,"cursor":cursor});
        }
    }
    tx.commit().map_err(sql)?;
    Ok(
        json!({"unread":unread(connection,&current["chat"])? ,"read_sync":read_sync,"_read_sync_task":task}),
    )
}

fn read_sync_pending(connection: &Connection) -> CoreResult<Value> {
    let mut statement=connection.prepare("SELECT operation_id,revision,platform,account,chat_id,cursor FROM provider_read_sync WHERE state='pending' ORDER BY updated_at").map_err(sql)?;
    let tasks=statement.query_map([],|r|Ok(json!({"operation_id":r.get::<_,String>(0)?,"revision":r.get::<_,i64>(1)?,"platform":r.get::<_,String>(2)?,"account":r.get::<_,String>(3)?,"chat_id":r.get::<_,String>(4)?,"cursor":r.get::<_,String>(5)?}))).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
    Ok(json!({"tasks":tasks}))
}

fn read_sync_finish(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let operation_id = field(input, "operation_id")?;
    let (platform, account, chat_id) = chat(input)?;
    let success = input["success"]
        .as_bool()
        .ok_or_else(|| fail("invalid read sync outcome"))?;
    let current:Option<(String,String,Option<String>,String,String)>=connection.query_row("SELECT operation_id,cursor,confirmed_cursor,rollback_ids_json,state FROM provider_read_sync WHERE platform=? AND account=? AND chat_id=?",params![platform,account,chat_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(sql)?;
    let Some((current_operation, current_cursor, confirmed_cursor, rollback_json, state)) = current
    else {
        return Err(fail("unknown read sync"));
    };
    let tx = connection.unchecked_transaction().map_err(sql)?;
    let mut applied = false;
    if success {
        let acknowledged = input["cursor"]
            .as_str()
            .and_then(|s| s.parse::<u128>().ok())
            .ok_or_else(|| fail("invalid read sync cursor"))?;
        let confirmed = confirmed_cursor
            .as_deref()
            .and_then(|s| s.parse::<u128>().ok())
            .map_or(acknowledged, |old| old.max(acknowledged));
        let rollback = serde_json::from_str::<Vec<String>>(&rollback_json)
            .unwrap_or_default()
            .into_iter()
            .filter(|id| id.parse::<u128>().map_or(true, |id| id > confirmed))
            .collect::<Vec<_>>();
        let matched = current_operation == operation_id;
        tx.execute("UPDATE provider_read_sync SET confirmed_cursor=?,rollback_ids_json=?,state=CASE WHEN ? THEN 'synced' ELSE state END,attempts=attempts+1,updated_at=? WHERE platform=? AND account=? AND chat_id=?",params![confirmed.to_string(),serde_json::to_string(&rollback).map_err(|_|fail("read sync serialization failed"))?,matched,now()?,platform,account,chat_id]).map_err(sql)?;
        applied = matched;
    } else if current_operation == operation_id && state == "pending" {
        for id in serde_json::from_str::<Vec<String>>(&rollback_json).unwrap_or_default() {
            tx.execute("DELETE FROM response_seen WHERE platform=? AND account=? AND chat_id=? AND msg_id=?",params![platform,account,chat_id,id]).map_err(sql)?;
        }
        tx.execute("UPDATE provider_read_sync SET rollback_ids_json='[]',state='failed',attempts=attempts+1,updated_at=? WHERE platform=? AND account=? AND chat_id=?",params![now()?,platform,account,chat_id]).map_err(sql)?;
        applied = true;
    }
    tx.commit().map_err(sql)?;
    let scope = json!({"platform":platform,"account":account,"chat_id":chat_id});
    Ok(
        json!({"applied":applied,"operation_id":operation_id,"status":if success{"synced"}else if applied{"failed"}else{"stale"},"unread":unread(connection,&scope)?,"cursor":current_cursor}),
    )
}

fn feedback(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let event_id = field(input, "event_id")?;
    let session_id = field(input, "response_session_id")?;
    let event = field(input, "event")?;
    if !matches!(
        event,
        "shown" | "inserted" | "first_input" | "hidden" | "closed"
    ) {
        return Err(fail("invalid feedback event"));
    }
    let current = session(connection, session_id)?;
    let recording: i64 = connection
        .query_row(
            "SELECT recording FROM response_settings WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if recording == 1 {
        let payload=json!({"reason":input.get("reason"),"final_text":input.get("final_text"),"chat":current["chat"]}).to_string();
        connection.execute("INSERT OR IGNORE INTO response_trajectory(event_id,session_id,suggestion_id,event,payload_json,created_at) VALUES(?,?,?,?,?,?)",
            params![event_id,session_id,current["suggestion"]["id"].as_str(),event,payload,now()?]).map_err(sql)?;
    }
    if event == "closed" {
        connection.execute("UPDATE response_sessions SET state='closed',closed_at=? WHERE session_id=? AND state='open'",params![now()?,session_id]).map_err(sql)?;
    }
    Ok(json!({"recorded":recording==1}))
}

fn next(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let current = session(connection, field(input, "response_session_id")?)?;
    let platform = input["platform"].as_str();
    let account = input["account"].as_str();
    let accessible: HashSet<String> = input["accessible_chats"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|v| {
            format!(
                "{}\0{}\0{}",
                v["platform"].as_str().unwrap_or(""),
                v["account"].as_str().unwrap_or(""),
                v["chat_id"].as_str().unwrap_or("")
            )
        })
        .collect();
    let mut statement=connection.prepare("SELECT c.platform,c.account,c.chat_id,max(m.ts) latest FROM chats c LEFT JOIN messages m ON m.platform=c.platform AND m.account=c.account AND m.chat_id=c.chat_id AND m.deleted_at IS NULL GROUP BY c.platform,c.account,c.chat_id ORDER BY latest DESC,c.platform,c.account,c.chat_id").map_err(sql)?;
    let candidates = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    let mut same_room_new = None;
    let mut same_room_unavailable = None;
    let mut remaining_unknown = false;
    for (p, a, c) in candidates {
        if platform.is_some_and(|v| v != p) || account.is_some_and(|v| v != a) {
            continue;
        }
        if !accessible.contains(&format!("{p}\0{a}\0{c}")) {
            continue;
        }
        if let Some(own) = self_id(connection, &p, &a)? {
            if latest_human_is_self(connection, &p, &a, &c, &own)? {
                continue;
            }
        }
        let scope = json!({"platform":p,"account":a,"chat_id":c});
        let unread_state = unread(connection, &scope)?;
        if unread_state["status"] == "unknown" {
            remaining_unknown = true;
            continue;
        }
        if unread_state["count"].as_u64().unwrap_or(0) == 0 {
            continue;
        }
        if current["chat"] == scope {
            let mut prepare_scope = scope.clone();
            prepare_scope["runtime_version"] = input["runtime_version"].clone();
            let prepared = prepare(connection, &prepare_scope)?;
            let old = current["source_message_ids"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let newer = prepared["source_message_ids"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| !old.contains(id)));
            if newer {
                same_room_new = Some(scope);
            } else if prepared["source_message_ids"]
                .as_array()
                .is_none_or(Vec::is_empty)
            {
                same_room_unavailable = Some(scope);
            }
            continue;
        }
        return Ok(json!({"chat":scope,"status":"next"}));
    }
    if let Some(scope) = same_room_new {
        return Ok(json!({"chat":scope,"status":"next"}));
    }
    if let Some(scope) = same_room_unavailable {
        return Ok(json!({"chat":scope,"status":"unavailable","remaining_unknown":true}));
    }
    Ok(
        json!({"chat":null,"status":if remaining_unknown{"unavailable"}else{"done"},"remaining_unknown":remaining_unknown}),
    )
}

fn complete_send(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let Some(id) = input["response_session_id"].as_str() else {
        return Ok(Value::Null);
    };
    let current = session(connection, id)?;
    let (p, a, c) = chat(&current["chat"])?;
    if (
        input["platform"].as_str(),
        input["account"].as_str(),
        input["chat_id"].as_str(),
    ) != (Some(p), Some(a), Some(c))
    {
        return Err(fail("send destination does not match response session"));
    }
    let state = match input["outcome"]["state"].as_str() {
        Some("Sent" | "Verified") => "sent",
        Some("Failed") => "failed",
        _ => "uncertain",
    };
    let completed_at = now()?;
    connection.execute("UPDATE response_sessions SET state=?,closed_at=?,send_request_id=?,send_outcome_json=? WHERE session_id=? AND state='open'",params![state,completed_at,input["request_id"].as_str(),input["outcome"].to_string(),id]).map_err(sql)?;
    if state == "sent" {
        // Fence late generation results as well as ready text; reading/closing
        // sessions must never take this path.
        if let Some(suggestion_id) = current["suggestion"]["id"].as_str() {
            connection.execute("UPDATE reply_suggestions SET status='abstained',text=NULL,error='response_sent',generation_epoch=generation_epoch+1 WHERE suggestion_id=? AND error IS NOT 'response_sent'", [suggestion_id]).map_err(sql)?;
        }
    }
    let recording: i64 = connection
        .query_row(
            "SELECT recording FROM response_settings WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if recording == 1 {
        let event_id = format!("send:{}", field(input, "request_id")?);
        let send_record: Option<(String, String)> = connection
            .query_row(
                "SELECT body,state FROM owner_sends WHERE request_id=? AND platform=? AND account=? AND chat_id=?",
                params![field(input,"request_id")?,p,a,c],
                |row| Ok((row.get(0)?,row.get(1)?)),
            )
            .optional()
            .map_err(sql)?;
        let payload = json!({"state":state,"outcome":input["outcome"],"final_text":send_record.as_ref().map(|row|&row.0),"send_state":send_record.as_ref().map(|row|&row.1),"review_required":true});
        connection.execute(
            "INSERT OR IGNORE INTO response_trajectory(event_id,session_id,suggestion_id,event,payload_json,created_at) VALUES(?,?,?,'send_outcome',?,?)",
            params![event_id,id,current["suggestion"]["id"].as_str(),payload.to_string(),completed_at],
        ).map_err(sql)?;
    }
    Ok(session(connection, id)?)
}

fn claim(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let id = field(input, "suggestion_id")?;
    let changed=connection.execute("UPDATE reply_suggestions SET status='generating' WHERE suggestion_id=? AND status='queued'",[id]).map_err(sql)?;
    if changed == 0 {
        return Ok(Value::Null);
    }
    let (raw,p,a,c,version,sources,prompt,generation_epoch):(String,String,String,String,String,String,String,i64)=connection.query_row("SELECT context_json,platform,account,chat_id,context_version,source_json,prompt_version,generation_epoch FROM reply_suggestions WHERE suggestion_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).map_err(sql)?;
    if let Some(own) = self_id(connection, &p, &a)? {
        if latest_human_is_self(connection, &p, &a, &c, &own)? {
            invalidate_after_self(connection, &p, &a, &c)?;
            return Ok(Value::Null);
        }
    }
    if context_has_new_latest_message(connection, &p, &a, &c, &raw)? {
        invalidate_changed_context(connection, id)?;
        return Ok(Value::Null);
    }
    Ok(
        json!({"suggestion_id":id,"chat":{"platform":p,"account":a,"chat_id":c},"context_version":version,
        "incoming_message_ids":serde_json::from_str::<Value>(&sources).unwrap_or(json!([])),"prompt_version":prompt,"generation_epoch":generation_epoch,
        "context":serde_json::from_str::<Value>(&raw).map_err(|_|fail("invalid stored context"))?}),
    )
}
fn finish(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let id = field(input, "suggestion_id")?;
    let generation_epoch = input["generation_epoch"]
        .as_i64()
        .filter(|value| *value >= 0)
        .ok_or_else(|| fail("invalid generation epoch"))?;
    let status = field(input, "status")?;
    if !matches!(status, "ready" | "abstained" | "failed") {
        return Err(fail("invalid generation status"));
    }
    let text = input["text"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 16000);
    if status == "ready" && text.is_none() {
        return Err(fail("ready generation requires text"));
    }
    let generated_at = now()?;
    let tx = connection.unchecked_transaction().map_err(sql)?;
    let suggestion_row:(String,String,String,String,String)=tx.query_row("SELECT platform,account,chat_id,context_version,context_json FROM reply_suggestions WHERE suggestion_id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(sql)?;
    if let Some(own) = self_id(&tx, &suggestion_row.0, &suggestion_row.1)? {
        if latest_human_is_self(
            &tx,
            &suggestion_row.0,
            &suggestion_row.1,
            &suggestion_row.2,
            &own,
        )? {
            invalidate_after_self(&tx, &suggestion_row.0, &suggestion_row.1, &suggestion_row.2)?;
            tx.commit().map_err(sql)?;
            return suggestion(connection, id);
        }
    }
    if context_has_new_latest_message(
        &tx,
        &suggestion_row.0,
        &suggestion_row.1,
        &suggestion_row.2,
        &suggestion_row.4,
    )? {
        invalidate_changed_context(&tx, id)?;
        tx.commit().map_err(sql)?;
        return suggestion(connection, id);
    }
    let changed=tx.execute("UPDATE reply_suggestions SET status=?,text=?,model_version=?,prompt_version=?,error=?,generated_at=? WHERE suggestion_id=? AND status='generating' AND generation_epoch=?",
        params![status,text,input["model_version"].as_str(),input["prompt_version"].as_str().unwrap_or(PROMPT_VERSION),input["error"].as_str(),generated_at,id,generation_epoch]).map_err(sql)?;
    if changed == 0 {
        tx.rollback().map_err(sql)?;
        return suggestion(connection, id);
    }
    let recording: i64 = tx
        .query_row(
            "SELECT recording FROM response_settings WHERE id=1",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if recording == 1 {
        tx.execute_batch("SAVEPOINT trajectory_recording")
            .map_err(sql)?;
        let recording_result = (|| -> CoreResult<()> {
            let (platform, account, chat_id, context_version, context_json) = suggestion_row;
            let steps = input["steps"].as_array().map_or(&[][..], Vec::as_slice);
            if steps.len() > 64 {
                return Err(fail("invalid trajectory steps"));
            }
            let evidence = input["evidence"].as_array().map_or(&[][..], Vec::as_slice);
            if evidence.len() > 64 {
                return Err(fail("invalid trajectory evidence"));
            }
            let versions = json!({"pipeline":input["versions"],"model_version":input["model_version"],"prompt_version":input["prompt_version"],"personal_adapter_version":input["personal_adapter_version"]});
            let bounded = |value: &Value, limit: usize| -> CoreResult<String> {
                let raw = serde_json::to_string(value)
                    .map_err(|_| fail("trajectory serialization failed"))?;
                if raw.len() > limit {
                    return Err(fail("trajectory field too large"));
                }
                Ok(raw)
            };
            let snapshot = json!({
                "context":serde_json::from_str::<Value>(&context_json).unwrap_or(Value::Null),
                "state":input["state"],
                "model_input":input["model_input"],
                "check_input":input["check_input"],
            });
            let cost = input
                .get("cost")
                .or_else(|| input.get("retrieval_cost"))
                .cloned()
                .unwrap_or(Value::Null);
            tx.execute("INSERT INTO trajectory_runs(suggestion_id,platform,account,chat_id,context_version,trigger,input_snapshot_json,route_plan_json,output_status,suggested_text,versions_json,personal_adapter_version,cost_json,created_at,completed_at) VALUES(?,?,?,?,?,? ,?,?,?,?,?,?,?,?,?)",
                params![id,platform,account,chat_id,context_version,input["trigger"].as_str().unwrap_or("unread_prefetch"),bounded(&snapshot,8_000_000)?,bounded(&input["route_plan"],128_000)?,status,text,bounded(&versions,64_000)?,input["personal_adapter_version"].as_str(),bounded(&cost,32_000)?,generated_at,generated_at]).map_err(sql)?;
            for (ordinal, step) in steps.iter().enumerate() {
                let step_id = step["step_id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                    .ok_or_else(|| fail("invalid trajectory step id"))?;
                let node = step["node_type"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 128)
                    .ok_or_else(|| fail("invalid trajectory node"))?;
                let state = step["status"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 64)
                    .ok_or_else(|| fail("invalid trajectory step status"))?;
                tx.execute("INSERT INTO trajectory_steps(step_id,suggestion_id,parent_step_id,node_type,input_refs_json,decision_json,action_json,observation_json,outcome_json,state_json,model_input_json,status,duration_ms,versions_json,ordinal) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![step_id,id,step["parent_step_id"].as_str(),node,bounded(&step["input_refs"],64_000)?,bounded(&step["decision"],64_000)?,bounded(&step["action"],64_000)?,bounded(&step["observation"],1_000_000)?,bounded(&step["outcome"],64_000)?,bounded(&step["state"],1_000_000)?,bounded(&step["model_input"],8_000_000)?,state,step["duration_ms"].as_f64(),bounded(&step["versions"],32_000)?,ordinal as i64]).map_err(sql)?;
            }
            for item in evidence {
                let evidence_id = item["id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 512)
                    .ok_or_else(|| fail("invalid evidence id"))?;
                let source_id = item["source_id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 256)
                    .ok_or_else(|| fail("invalid evidence source"))?;
                let excerpt = item["excerpt"].as_str().filter(|s| s.len() <= 16_000);
                tx.execute("INSERT INTO trajectory_evidence(suggestion_id,evidence_id,source_id,source_key,source_version,excerpt,ts,observed_at) VALUES(?,?,?,?,?,?,?,?)",params![id,evidence_id,source_id,bounded(&item["key"],16_000)?,item["version"].as_str(),excerpt,item["ts"].as_f64(),item["observed_at"].as_f64()]).map_err(sql)?;
            }
            let payload = json!({"status":status,"route_plan":input["route_plan"],"decision":input["decision"],"versions":versions,"error":input["error"]});
            tx.execute("INSERT INTO response_trajectory(event_id,session_id,suggestion_id,event,payload_json,created_at) VALUES(?,NULL,?,'generated',?,?)", params![Uuid::new_v4().to_string(),id,bounded(&payload,256_000)?,generated_at]).map_err(sql)?;
            Ok(())
        })();
        match recording_result {
            Ok(()) => tx
                .execute_batch("RELEASE SAVEPOINT trajectory_recording")
                .map_err(sql)?,
            Err(_) => {
                tx.execute_batch(
                    "ROLLBACK TO SAVEPOINT trajectory_recording; RELEASE SAVEPOINT trajectory_recording",
                )
                .map_err(sql)?;
                tx.execute("INSERT INTO response_trajectory(event_id,session_id,suggestion_id,event,payload_json,created_at) VALUES(?,NULL,?,'recording_failed','{\"reason\":\"invalid_or_oversized_payload\"}',?)", params![Uuid::new_v4().to_string(),id,generated_at]).map_err(sql)?;
            }
        }
    }
    tx.commit().map_err(sql)?;
    suggestion(connection, id)
}

fn decode(raw: Option<String>) -> Value {
    raw.and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or(Value::Null)
}

fn purge_before(connection: &Connection, before: f64) -> CoreResult<usize> {
    let tx = connection.unchecked_transaction().map_err(sql)?;
    tx.execute(
        "UPDATE response_sessions SET suggestion_id=NULL WHERE suggestion_id IN (SELECT suggestion_id FROM reply_suggestions WHERE created_at<?)",
        [before],
    )
    .map_err(sql)?;
    let mut deleted = tx
        .execute(
            "DELETE FROM response_trajectory WHERE created_at<? OR suggestion_id IN (SELECT suggestion_id FROM reply_suggestions WHERE created_at<?)",
            params![before, before],
        )
        .map_err(sql)?;
    deleted += tx
        .execute(
            "DELETE FROM trajectory_steps WHERE suggestion_id IN (SELECT suggestion_id FROM trajectory_runs WHERE completed_at<?)",
            [before],
        )
        .map_err(sql)?;
    deleted += tx
        .execute(
            "DELETE FROM trajectory_evidence WHERE suggestion_id IN (SELECT suggestion_id FROM trajectory_runs WHERE completed_at<?)",
            [before],
        )
        .map_err(sql)?;
    deleted += tx
        .execute("DELETE FROM trajectory_runs WHERE completed_at<?", [before])
        .map_err(sql)?;
    deleted += tx
        .execute("DELETE FROM reply_suggestions WHERE created_at<?", [before])
        .map_err(sql)?;
    tx.commit().map_err(sql)?;
    Ok(deleted)
}

fn apply_retention(connection: &Connection) -> CoreResult<usize> {
    let days: i64 = connection
        .query_row(
            "SELECT retention_days FROM response_settings WHERE id=1",
            [],
            |row| row.get(0),
        )
        .map_err(sql)?;
    purge_before(connection, now()? - days as f64 * 86_400.0)
}

fn delete_trajectory(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let suggestion_id = input["suggestion_id"].as_str();
    let delete_all = input["all"] == true;
    let before = input["before"].as_f64().filter(|value| value.is_finite());
    if suggestion_id.is_none() && !delete_all && before.is_none() {
        return Err(fail("trajectory deletion selector required"));
    }
    if let Some(before) = before {
        if suggestion_id.is_none() && !delete_all {
            return Ok(json!({"deleted":purge_before(connection,before)?}));
        }
    }
    let tx = connection.unchecked_transaction().map_err(sql)?;
    let mut deleted = 0;
    if delete_all {
        tx.execute("UPDATE response_sessions SET suggestion_id=NULL", [])
            .map_err(sql)?;
        deleted += tx
            .execute("DELETE FROM response_trajectory", [])
            .map_err(sql)?;
        deleted += tx
            .execute("DELETE FROM trajectory_steps", [])
            .map_err(sql)?;
        deleted += tx
            .execute("DELETE FROM trajectory_evidence", [])
            .map_err(sql)?;
        deleted += tx.execute("DELETE FROM trajectory_runs", []).map_err(sql)?;
        deleted += tx
            .execute("DELETE FROM reply_suggestions", [])
            .map_err(sql)?;
    } else if let Some(id) = suggestion_id {
        tx.execute(
            "UPDATE response_sessions SET suggestion_id=NULL WHERE suggestion_id=?",
            [id],
        )
        .map_err(sql)?;
        deleted += tx
            .execute(
                "DELETE FROM response_trajectory WHERE suggestion_id=?",
                [id],
            )
            .map_err(sql)?;
        deleted += tx
            .execute("DELETE FROM trajectory_steps WHERE suggestion_id=?", [id])
            .map_err(sql)?;
        deleted += tx
            .execute(
                "DELETE FROM trajectory_evidence WHERE suggestion_id=?",
                [id],
            )
            .map_err(sql)?;
        deleted += tx
            .execute("DELETE FROM trajectory_runs WHERE suggestion_id=?", [id])
            .map_err(sql)?;
        deleted += tx
            .execute("DELETE FROM reply_suggestions WHERE suggestion_id=?", [id])
            .map_err(sql)?;
    }
    tx.commit().map_err(sql)?;
    Ok(json!({"deleted":deleted}))
}

fn trajectory_run(connection: &Connection, row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let suggestion_id: String = row.get(0)?;
    let mut steps_statement = connection
        .prepare("SELECT step_id,parent_step_id,node_type,input_refs_json,decision_json,action_json,observation_json,outcome_json,state_json,model_input_json,status,duration_ms,versions_json FROM trajectory_steps WHERE suggestion_id=? ORDER BY ordinal")
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    let steps = steps_statement
        .query_map([&suggestion_id], |step| {
            Ok(json!({
                "step_id":step.get::<_,String>(0)?,
                "parent_step_id":step.get::<_,Option<String>>(1)?,
                "node_type":step.get::<_,String>(2)?,
                "input_refs":decode(step.get::<_,Option<String>>(3)?),
                "decision":decode(step.get::<_,Option<String>>(4)?),
                "action":decode(step.get::<_,Option<String>>(5)?),
                "observation":decode(step.get::<_,Option<String>>(6)?),
                "outcome":decode(step.get::<_,Option<String>>(7)?),
                "state":decode(step.get::<_,Option<String>>(8)?),
                "model_input":decode(step.get::<_,Option<String>>(9)?),
                "status":step.get::<_,String>(10)?,
                "duration_ms":step.get::<_,Option<f64>>(11)?,
                "versions":decode(step.get::<_,Option<String>>(12)?),
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut evidence_statement = connection
        .prepare("SELECT evidence_id,source_id,source_key,source_version,excerpt,ts,observed_at FROM trajectory_evidence WHERE suggestion_id=? ORDER BY evidence_id")
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    let evidence = evidence_statement
        .query_map([&suggestion_id], |item| {
            Ok(json!({
                "id":item.get::<_,String>(0)?,
                "source_id":item.get::<_,String>(1)?,
                "key":decode(item.get::<_,Option<String>>(2)?),
                "version":item.get::<_,Option<String>>(3)?,
                "excerpt":item.get::<_,Option<String>>(4)?,
                "ts":item.get::<_,Option<f64>>(5)?,
                "observed_at":item.get::<_,Option<f64>>(6)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut events_statement = connection
        .prepare("SELECT event_id,session_id,event,payload_json,created_at FROM response_trajectory WHERE suggestion_id=? ORDER BY created_at,event_id LIMIT 100")
        .map_err(|_| rusqlite::Error::InvalidQuery)?;
    let events = events_statement
        .query_map([&suggestion_id], |event| {
            Ok(json!({
                "event_id":event.get::<_,String>(0)?,
                "response_session_id":event.get::<_,Option<String>>(1)?,
                "event":event.get::<_,String>(2)?,
                "payload":decode(event.get::<_,Option<String>>(3)?),
                "created_at":event.get::<_,f64>(4)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "suggestion_id":suggestion_id,
        "chat":{"platform":row.get::<_,String>(1)?,"account":row.get::<_,String>(2)?,"chat_id":row.get::<_,String>(3)?},
        "context_version":row.get::<_,String>(4)?,
        "trigger":row.get::<_,String>(5)?,
        "input_snapshot":decode(row.get::<_,Option<String>>(6)?),
        "route_plan":decode(row.get::<_,Option<String>>(7)?),
        "output_status":row.get::<_,String>(8)?,
        "suggested_text":row.get::<_,Option<String>>(9)?,
        "versions":decode(row.get::<_,Option<String>>(10)?),
        "personal_adapter_version":row.get::<_,Option<String>>(11)?,
        "cost":decode(row.get::<_,Option<String>>(12)?),
        "created_at":row.get::<_,f64>(13)?,
        "completed_at":row.get::<_,f64>(14)?,
        "steps":steps,
        "evidence":evidence,
        "events":events,
    }))
}

fn compact_trajectory(mut value: Value) -> Value {
    if serde_json::to_vec(&value).is_ok_and(|encoded| encoded.len() <= 48_000) {
        return value;
    }
    // Repeated model prompts dominate large traces. Drop these first, keeping
    // the original conversation and verdicts available for failure diagnosis.
    if let Some(snapshot) = value["input_snapshot"].as_object_mut() {
        for key in ["model_input", "check_input", "state"] {
            snapshot.remove(key);
        }
    }
    if let Some(items) = value["steps"].as_array_mut() {
        for item in items {
            item["model_input"] = Value::Null;
            item["state"] = Value::Null;
        }
    }
    value["truncated"] = json!(true);
    if serde_json::to_vec(&value).is_ok_and(|encoded| encoded.len() <= 48_000) {
        return value;
    }
    value["input_snapshot"] = Value::Null;
    value["route_plan"] = Value::Null;
    if let Some(items) = value["evidence"].as_array_mut() {
        for item in items {
            item["excerpt"] = Value::Null;
            item["key"] = Value::Null;
        }
    }
    if let Some(items) = value["steps"].as_array_mut() {
        for item in items {
            item["input_refs"] = Value::Null;
            item["decision"] = Value::Null;
            item["action"] = Value::Null;
            item["observation"] = Value::Null;
            item["outcome"] = Value::Null;
            item["state"] = Value::Null;
            item["model_input"] = Value::Null;
            item["versions"] = Value::Null;
        }
    }
    if let Some(items) = value["events"].as_array_mut() {
        for item in items {
            item["payload"] = Value::Null;
        }
    }
    value["truncated"] = json!(true);
    if serde_json::to_vec(&value).is_ok_and(|encoded| encoded.len() > 48_000) {
        for key in ["steps", "evidence", "events"] {
            if let Some(items) = value[key].as_array_mut() {
                items.truncate(16);
            }
        }
        if let Some(text) = value["suggested_text"].as_str() {
            value["suggested_text"] = json!(text.chars().take(4_000).collect::<String>());
        }
    }
    value
}

// Owner-only diagnostics omit conversation/model inputs so failures remain
// inspectable even when a full trace exhausts the protocol frame budget.
fn trajectory_summary(run: Value) -> Value {
    let short = |value: &Value| {
        value
            .as_str()
            .map(|s| s.chars().take(512).collect::<String>())
    };
    let steps = run["steps"].as_array().into_iter().flatten().map(|step| json!({
        "node_type":step["node_type"], "status":step["status"], "duration_ms":step["duration_ms"],
        "error":short(&step["outcome"]["error"]),
        "reasonCode":short(&step["decision"]["reasonCode"]),
        "reason":short(&step["decision"]["reason"]),
        "supported":step["decision"]["supported"].as_bool(),
    })).collect::<Vec<_>>();
    let error = run["events"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .find_map(|event| short(&event["payload"]["error"]));
    json!({"error":error,"suggestion_id":run["suggestion_id"],"chat":run["chat"],"output_status":run["output_status"],
        "completed_at":run["completed_at"],"versions":run["versions"],"steps":steps,"summary":true})
}

fn list_trajectories(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let purged = apply_retention(connection)?;
    let limit = input["limit"].as_u64().unwrap_or(10).clamp(1, 25) as i64;
    let suggestion_id = input["suggestion_id"].as_str();
    let status = input["status"].as_str();
    if status.is_some_and(|s| !matches!(s, "ready" | "failed" | "abstained")) {
        return Err(fail("invalid trajectory status"));
    }
    let mut statement = connection.prepare("SELECT suggestion_id,platform,account,chat_id,context_version,trigger,input_snapshot_json,route_plan_json,output_status,suggested_text,versions_json,personal_adapter_version,cost_json,created_at,completed_at FROM trajectory_runs WHERE (?1 IS NULL OR suggestion_id=?1) AND (?2 IS NULL OR output_status=?2) ORDER BY completed_at DESC,suggestion_id DESC LIMIT ?3").map_err(sql)?;
    let mut rows = statement
        .query(params![suggestion_id, status, limit])
        .map_err(sql)?;
    let mut trajectories = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    while let Some(row) = rows.next().map_err(sql)? {
        let run = trajectory_run(connection, row).map_err(sql)?;
        let value = compact_trajectory(if input["summary"] == true {
            trajectory_summary(run)
        } else {
            run
        });
        let size = serde_json::to_vec(&value)
            .map_err(|_| fail("trajectory serialization failed"))?
            .len();
        if !trajectories.is_empty() && bytes + size > 54_000 {
            truncated = true;
            break;
        }
        bytes += size;
        trajectories.push(value);
    }
    Ok(json!({"trajectories":trajectories,"truncated":truncated,"purged":purged}))
}

fn trajectory(connection: &Connection, op: &str, input: &Value) -> CoreResult<Value> {
    match op {
        "response.trajectory.list" => list_trajectories(connection, input),
        "response.trajectory.delete" => delete_trajectory(connection, input),
        "response.settings" => {
            if input
                .get("recording")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err(fail("invalid recording setting"));
            }
            if input.get("retention_days").is_some_and(|value| {
                value
                    .as_u64()
                    .is_none_or(|days| !(1..=3650).contains(&days))
            }) {
                return Err(fail("invalid retention setting"));
            }
            let current: (i64, i64) = connection
                .query_row(
                    "SELECT recording,retention_days FROM response_settings WHERE id=1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(sql)?;
            let recording = input["recording"].as_bool().map_or(current.0, i64::from);
            let days = input["retention_days"]
                .as_u64()
                .map_or(current.1, |value| value as i64);
            if input.get("recording").is_some() || input.get("retention_days").is_some() {
                connection.execute("UPDATE response_settings SET recording=?,retention_days=?,updated_at=? WHERE id=1",params![recording,days,now()?]).map_err(sql)?;
            }
            let purged = apply_retention(connection)?;
            Ok(json!({"recording":recording==1,"retention_days":days,"purged":purged}))
        }
        _ => Err(fail("unknown trajectory operation")),
    }
}

fn evidence(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let rows = input["chats"]
        .as_array()
        .filter(|v| v.len() <= 20_000)
        .ok_or_else(|| fail("invalid unread evidence batch"))?;
    let at = now()?;
    let tx = connection.unchecked_transaction().map_err(sql)?;
    for row in rows {
        let (p, a, c) = chat(row)?;
        let previous:Option<(String,f64)>=tx.query_row("SELECT evidence_json,observed_at FROM unread_evidence WHERE platform=? AND account=? AND chat_id=?",params![p,a,c],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
        let old = previous
            .as_ref()
            .and_then(|(raw, _)| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or(Value::Null);
        let previous_cursor = read_through(&old);
        let supplied_cursor = read_through(row);
        if let (Some(old), Some(new)) = (previous_cursor, supplied_cursor) {
            if (new.len(), new) < (old.len(), old) {
                continue;
            }
        }
        let cursor = supplied_cursor.or(previous_cursor);
        let cursor_advanced = cursor != previous_cursor;
        let same = previous
            .as_ref()
            .and_then(|(raw, _)| serde_json::from_str::<Value>(raw).ok())
            .is_some_and(|old| {
                old["status"]
                    == if row["unread_count"].is_u64() {
                        "known"
                    } else {
                        "unknown"
                    }
                    && old["count"] == row["unread_count"]
                    && !cursor_advanced
            });
        let observed_at = if same {
            previous.as_ref().unwrap().1
        } else {
            at
        };
        let mut value = if let Some(count) = row["unread_count"].as_u64() {
            json!({"chat":{"platform":p,"account":a,"chat_id":c},"status":"known","source":"platform","count":count,"observed_at":observed_at})
        } else {
            json!({"chat":{"platform":p,"account":a,"chat_id":c},"status":"unknown","source":"unknown","count":null,"reason":"unsupported","observed_at":observed_at})
        };
        if let Some(cursor) = cursor {
            value["read_through"] = json!(if cursor.is_empty() { "0" } else { cursor });
        }
        if same && old["read_all_operation_id"].is_string() {
            value["read_all_operation_id"] = old["read_all_operation_id"].clone();
        }
        // Own-read evidence changes the unread badge only. Prepared replies stay
        // available until successful sending or a change to their message context.
        tx.execute("INSERT INTO unread_evidence(platform,account,chat_id,evidence_json,observed_at) VALUES(?,?,?,?,?) ON CONFLICT(platform,account,chat_id) DO UPDATE SET evidence_json=excluded.evidence_json,observed_at=excluded.observed_at",params![p,a,c,value.to_string(),observed_at]).map_err(sql)?;
    }
    tx.commit().map_err(sql)?;
    Ok(json!({"stored":rows.len()}))
}

fn observe(connection: &Connection, input: &Value) -> CoreResult<Value> {
    let (p, a, c) = chat(input)?;
    let baseline: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM response_baselines WHERE platform=? AND account=? AND chat_id=?",
            params![p, a, c],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql)?;
    let at = now()?;
    if baseline.is_none() {
        connection.execute("INSERT INTO response_baselines(platform,account,chat_id,observed_at) VALUES(?,?,?,?)",params![p,a,c,at]).map_err(sql)?;
        return Ok(json!({"baseline":true,"added":0}));
    }
    let Some(me) = self_id(connection, p, a)? else {
        return Ok(json!({"baseline":false,"added":0,"identity":"unknown"}));
    };
    let ids = input["message_ids"]
        .as_array()
        .filter(|v| v.len() <= 1000)
        .ok_or_else(|| fail("invalid observed message ids"))?;
    let evidence = provider_evidence(connection, p, a, c)?;
    let cursor = read_through(&evidence);
    let tx = connection.unchecked_transaction().map_err(sql)?;
    let mut added = 0;
    for value in ids {
        let id = value
            .as_str()
            .ok_or_else(|| fail("invalid observed message id"))?;
        if covered_by_read(id, cursor) {
            continue;
        }
        let incoming:Option<i64>=tx.query_row("SELECT 1 FROM messages WHERE platform=? AND account=? AND chat_id=? AND msg_id=? AND deleted_at IS NULL AND author_id<>?",params![p,a,c,id,me],|r|r.get(0)).optional().map_err(sql)?;
        if incoming.is_some() {
            added+=tx.execute("INSERT OR IGNORE INTO response_unseen(platform,account,chat_id,msg_id,observed_at) VALUES(?,?,?,?,?)",params![p,a,c,id,at]).map_err(sql)?;
        }
    }
    tx.commit().map_err(sql)?;
    Ok(json!({"baseline":false,"added":added}))
}

pub(crate) fn execute(connection: &Connection, op: &str, input: &Value) -> CoreResult<Value> {
    match op {
        "response.recover" => {
            // Also repairs baselines for early v5 installations before ingestion resumes.
            connection.execute("INSERT OR IGNORE INTO response_baselines(platform,account,chat_id,observed_at) SELECT DISTINCT platform,account,chat_id,? FROM messages", [now()?]).map_err(sql)?;
            let changed=connection.execute("UPDATE reply_suggestions SET status='queued',error='interrupted' WHERE status='generating'",[]).map_err(sql)?;
            Ok(json!({"recovered":changed}))
        }
        "response.prepare" => prepare(connection, input),
        "response.unread" => unread(connection, input),
        "response.open" => open(connection, input),
        "response.get" => session(connection, field(input, "response_session_id")?),
        "response.seen" => seen(connection, input),
        "response.readSync.pending" => read_sync_pending(connection),
        "response.readSync.finish" => read_sync_finish(connection, input),
        "response.feedback" => feedback(connection, input),
        "response.next" => next(connection, input),
        "response.sendComplete" => complete_send(connection, input),
        "response.generationClaim" => claim(connection, input),
        "response.generationFinish" => finish(connection, input),
        "response.trajectory.list" | "response.trajectory.delete" | "response.settings" => {
            trajectory(connection, op, input)
        }
        "response.evidence" => evidence(connection, input),
        "response.observe" => observe(connection, input),
        _ => Err(fail("unknown response operation")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE messages(platform TEXT NOT NULL,account TEXT NOT NULL,chat_id TEXT NOT NULL,msg_id TEXT NOT NULL,author_id TEXT,ts REAL NOT NULL,body TEXT,parent_msg_id TEXT,deleted_at REAL,PRIMARY KEY(platform,account,chat_id,msg_id));CREATE TABLE account_self(platform TEXT NOT NULL,account TEXT NOT NULL,evidence_json TEXT NOT NULL,observed_at REAL NOT NULL,PRIMARY KEY(platform,account));CREATE TABLE unread_evidence(platform TEXT NOT NULL,account TEXT NOT NULL,chat_id TEXT NOT NULL,evidence_json TEXT NOT NULL,observed_at REAL NOT NULL,PRIMARY KEY(platform,account,chat_id));CREATE TABLE chats(platform TEXT NOT NULL,account TEXT NOT NULL,chat_id TEXT NOT NULL,PRIMARY KEY(platform,account,chat_id));").unwrap();
        connection
            .execute_batch(inboxd_core::RESPONSE_SCHEMA)
            .unwrap();
        connection
            .execute_batch(inboxd_core::OWNER_SEND_SCHEMA)
            .unwrap();
        connection.execute("INSERT INTO account_self VALUES('p','a','{\"status\":\"known\",\"self_id\":\"me\"}',1)",[]).unwrap();
        connection
            .execute("INSERT INTO chats VALUES('p','a','c')", [])
            .unwrap();
        connection
    }
    fn message(connection: &Connection, id: &str, ts: f64) {
        connection
            .execute(
                "INSERT INTO messages VALUES('p','a','c',?,'other',?,'body',NULL,NULL)",
                params![id, ts],
            )
            .unwrap();
    }
    fn scope() -> Value {
        json!({"platform":"p","account":"a","chat_id":"c"})
    }

    fn provider_read(connection: &Connection, cursor: &str, count: u64) {
        evidence(connection, &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":count,"read_through":cursor}]})).unwrap();
    }

    #[test]
    fn preflight_context_resolves_old_reply_without_crossing_chat_scope() {
        let connection = database();
        for i in 0..45 {
            message(&connection, &format!("m{i}"), i as f64);
        }
        connection
            .execute(
                "UPDATE messages SET parent_msg_id='m0' WHERE msg_id='m44'",
                [],
            )
            .unwrap();
        let prepared = prepare(&connection, &scope()).unwrap();
        let claimed = claim(
            &connection,
            &json!({"suggestion_id":prepared["suggestion_id"]}),
        )
        .unwrap();
        let context = claimed["context"].as_array().unwrap();
        assert_eq!(context.len(), 41);
        assert_eq!(context.first().unwrap()["message_id"], "m0");
        assert_eq!(context.last().unwrap()["message_id"], "m44");

        connection
            .execute(
                "UPDATE messages SET parent_msg_id='foreign' WHERE msg_id='m44'",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO messages VALUES('p','a','elsewhere','foreign','other',0,'private',NULL,NULL)", []).unwrap();
        let prepared = prepare(&connection, &scope()).unwrap();
        let claimed = claim(
            &connection,
            &json!({"suggestion_id":prepared["suggestion_id"]}),
        )
        .unwrap();
        assert!(
            !claimed["context"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["message_id"] == "foreign")
        );
        assert_eq!(
            claimed["context"].as_array().unwrap().last().unwrap()["reply_to"],
            "foreign"
        );
    }

    #[test]
    fn telegram_external_read_respects_prefixed_ids_and_new_arrivals() {
        let connection = database();
        connection.execute("INSERT INTO account_self VALUES('telegram','a','{\"status\":\"known\",\"self_id\":\"me\"}',1)",[]).unwrap();
        let room = "telegram:chat:42";
        let scope = json!({"platform":"telegram","account":"a","chat_id":room});
        observe(
            &connection,
            &json!({"platform":"telegram","account":"a","chat_id":room,"message_ids":[]}),
        )
        .unwrap();
        for id in ["9", "10", "11"] {
            let id = format!("telegram:message:42:{id}");
            connection
                .execute(
                    "INSERT INTO messages VALUES('telegram','a',?,?,'other',1,'hello',NULL,NULL)",
                    params![room, id],
                )
                .unwrap();
            observe(
                &connection,
                &json!({"platform":"telegram","account":"a","chat_id":room,"message_ids":[id]}),
            )
            .unwrap();
        }
        for (cursor, count) in [("10", 1), ("11", 0), ("9", 2)] {
            evidence(&connection,&json!({"chats":[{"platform":"telegram","account":"a","chat_id":room,"unread_count":count,"read_through":cursor}]})).unwrap();
            assert_eq!(
                unread(&connection, &scope).unwrap()["count"],
                if cursor == "10" { 1 } else { 0 }
            );
        }
        observe(&connection,&json!({"platform":"telegram","account":"a","chat_id":room,"message_ids":["telegram:message:42:8"]})).unwrap();
        assert_eq!(unread(&connection, &scope).unwrap()["count"], 0);
        connection.execute("INSERT INTO messages VALUES('telegram','a',?,'telegram:message:42:12','other',2,'new',NULL,NULL)",[room]).unwrap();
        observe(&connection,&json!({"platform":"telegram","account":"a","chat_id":room,"message_ids":["telegram:message:42:12"]})).unwrap();
        assert_eq!(unread(&connection, &scope).unwrap()["count"], 1);
    }

    #[test]
    fn read_room_without_prepared_reply_still_queues_one() {
        let connection = database();
        message(&connection, "10", 1.);
        provider_read(&connection, "10", 0);
        assert_eq!(prepare(&connection, &scope()).unwrap()["status"], "queued");
        assert_eq!(
            prepare(&connection, &scope()).unwrap()["source_message_ids"],
            json!([])
        );
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 0);
    }

    #[test]
    fn prepare_reports_latest_incoming_beyond_bounded_prompt_context() {
        let connection = database();
        message(&connection, "incoming", 1.0);
        for index in 0..41 {
            connection
                .execute(
                    "INSERT INTO messages VALUES('p','a','c',?,'me',?,'self',NULL,NULL)",
                    params![format!("self-{index}"), index as f64 + 2.0],
                )
                .unwrap();
        }
        let prepared = prepare(&connection, &scope()).unwrap();
        assert_eq!(prepared["status"], "abstained");
        assert_eq!(prepared["reason"], "no_reply_target");
    }

    #[test]
    fn latest_self_message_removes_ready_reply_and_waits_for_new_incoming() {
        let connection = database();
        message(&connection, "m1", 1.0);
        let first = prepare(&connection, &scope()).unwrap();
        let id = first["suggestion_id"].as_str().unwrap();
        let claim_value = claim(&connection, &json!({"suggestion_id":id})).unwrap();
        assert!(!claim_value.is_null());
        assert_eq!(
            finish(&connection, &generation_payload(id)).unwrap()["status"],
            "ready"
        );

        connection
            .execute(
                "INSERT INTO messages VALUES('p','a','c','m2','me',2,'sent',NULL,NULL)",
                [],
            )
            .unwrap();
        let prepared = prepare(&connection, &scope()).unwrap();
        assert_eq!(prepared["reason"], "no_reply_target");
        let previous = suggestion(&connection, id).unwrap();
        assert_eq!(previous["status"], "abstained");
        assert_eq!(previous["text"], Value::Null);
        assert_eq!(previous["error"], "no_reply_target");

        // A system message must not become an incoming reply target.
        connection
            .execute(
                "INSERT INTO messages VALUES('p','a','c','m3',NULL,3,'system',NULL,NULL)",
                [],
            )
            .unwrap();
        assert_eq!(
            prepare(&connection, &scope()).unwrap()["reason"],
            "no_reply_target"
        );
        message(&connection, "m4", 4.0);
        let next = prepare(&connection, &scope()).unwrap();
        assert_eq!(next["status"], "queued");
        assert_eq!(
            next["context"].as_array().unwrap()[1]["author_role"],
            "self"
        );
    }

    #[test]
    fn latest_self_fences_queued_claim_and_in_flight_finish() {
        let connection = database();
        message(&connection, "m1", 1.0);
        let first = prepare(&connection, &scope()).unwrap();
        let id = first["suggestion_id"].as_str().unwrap();
        connection
            .execute(
                "INSERT INTO messages VALUES('p','a','c','m2','me',2,'sent',NULL,NULL)",
                [],
            )
            .unwrap();
        assert!(
            claim(&connection, &json!({"suggestion_id":id}))
                .unwrap()
                .is_null()
        );
        assert_eq!(
            suggestion(&connection, id).unwrap()["error"],
            "no_reply_target"
        );

        message(&connection, "m3", 3.0);
        let second = prepare(&connection, &scope()).unwrap();
        let second_id = second["suggestion_id"].as_str().unwrap();
        assert!(
            !claim(&connection, &json!({"suggestion_id":second_id}))
                .unwrap()
                .is_null()
        );
        connection
            .execute(
                "INSERT INTO messages VALUES('p','a','c','m4','me',4,'sent',NULL,NULL)",
                [],
            )
            .unwrap();
        let late = finish(&connection, &generation_payload(second_id)).unwrap();
        assert_eq!(late["status"], "abstained");
        assert_eq!(late["error"], "no_reply_target");
        assert_eq!(late["text"], Value::Null);
    }

    #[test]
    fn open_and_get_expose_no_reply_target_without_a_queued_suggestion() {
        let connection = database();
        message(&connection, "m1", 1.0);
        connection
            .execute(
                "INSERT INTO messages VALUES('p','a','c','m2','me',2,'sent',NULL,NULL)",
                [],
            )
            .unwrap();
        let opened = execute(
            &connection,
            "response.open",
            &json!({"chat":scope(),"runtime_version":"test"}),
        )
        .unwrap();
        assert_eq!(opened["status"], "abstained");
        assert_eq!(opened["error"], "no_reply_target");
        assert_eq!(opened["suggestion"], Value::Null);
        let fetched = execute(
            &connection,
            "response.get",
            &json!({"response_session_id":opened["response_session_id"]}),
        )
        .unwrap();
        assert_eq!(fetched["error"], "no_reply_target");
        assert_eq!(fetched["suggestion"], Value::Null);
        let count: i64 = connection
            .query_row("SELECT count(*) FROM reply_suggestions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn open_session_shows_no_reply_target_over_historical_failure() {
        let connection = database();
        message(&connection, "m1", 1.0);
        let prepared = prepare(&connection, &scope()).unwrap();
        let suggestion_id = prepared["suggestion_id"].as_str().unwrap();
        assert!(
            !claim(&connection, &json!({"suggestion_id":suggestion_id}))
                .unwrap()
                .is_null()
        );
        let mut failed = generation_payload(suggestion_id);
        failed["status"] = json!("failed");
        failed["text"] = Value::Null;
        failed["error"] = json!("model_failure");
        assert_eq!(finish(&connection, &failed).unwrap()["status"], "failed");
        let opened = open(
            &connection,
            &json!({"chat":scope(),"runtime_version":"legacy"}),
        )
        .unwrap();
        assert_eq!(opened["status"], "failed");

        connection
            .execute(
                "INSERT INTO messages VALUES('p','a','c','m2','me',2,'sent',NULL,NULL)",
                [],
            )
            .unwrap();
        let fetched = execute(
            &connection,
            "response.get",
            &json!({"response_session_id":opened["response_session_id"]}),
        )
        .unwrap();
        assert_eq!(fetched["status"], "abstained");
        assert_eq!(fetched["error"], "no_reply_target");
        assert_eq!(fetched["suggestion"]["status"], "failed");
        assert_eq!(
            suggestion(&connection, suggestion_id).unwrap()["error"],
            "model_failure"
        );
    }

    #[test]
    fn old_generation_cannot_finish_after_self_and_new_incoming_arrive() {
        let connection = database();
        message(&connection, "m1", 1.0);
        let prepared = prepare(&connection, &scope()).unwrap();
        let old_id = prepared["suggestion_id"].as_str().unwrap();
        assert!(
            !claim(&connection, &json!({"suggestion_id":old_id}))
                .unwrap()
                .is_null()
        );
        connection
            .execute(
                "INSERT INTO messages VALUES('p','a','c','m2','me',2,'sent',NULL,NULL)",
                [],
            )
            .unwrap();
        message(&connection, "m3", 3.0);
        let late = finish(&connection, &generation_payload(old_id)).unwrap();
        assert_eq!(late["status"], "stale");
        assert_eq!(late["error"], "context_changed");
        assert_eq!(late["text"], Value::Null);
        assert_eq!(prepare(&connection, &scope()).unwrap()["status"], "queued");
    }

    #[test]
    fn next_skips_room_with_old_unread_but_latest_self_message() {
        let connection = database();
        message(&connection, "m1", 1.0);
        connection
            .execute("INSERT INTO response_unseen VALUES('p','a','c','m1',1)", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO messages VALUES('p','a','c','m2','me',2,'sent',NULL,NULL)",
                [],
            )
            .unwrap();
        let opened = open(
            &connection,
            &json!({"chat":scope(),"runtime_version":"test"}),
        )
        .unwrap();
        let next_room = next(&connection, &json!({"response_session_id":opened["response_session_id"],"platform":"p","account":"a","runtime_version":"test","accessible_chats":[scope()]})).unwrap();
        assert_eq!(next_room["status"], "done");
        assert_eq!(next_room["chat"], Value::Null);
    }

    #[test]
    fn external_read_clears_observed_unread_and_keeps_newer_messages() {
        let connection = database();
        observe(
            &connection,
            &json!({"platform":"p","account":"a","chat_id":"c","message_ids":[]}),
        )
        .unwrap();
        for (id, ts) in [("9", 1.0), ("10", 2.0), ("11", 3.0)] {
            message(&connection, id, ts);
        }
        observe(
            &connection,
            &json!({"platform":"p","account":"a","chat_id":"c","message_ids":["9","10","11"]}),
        )
        .unwrap();
        provider_read(&connection, "0", 3);
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 3);
        provider_read(&connection, "10", 1);
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 1);
        assert_eq!(
            prepare(&connection, &scope()).unwrap()["source_message_ids"],
            json!(["11"])
        );
        provider_read(&connection, "11", 0);
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 0);
        assert_eq!(prepare(&connection, &scope()).unwrap()["status"], "queued");
        // Late history and an older cached directory cannot undo a known read.
        message(&connection, "8", 0.5);
        observe(
            &connection,
            &json!({"platform":"p","account":"a","chat_id":"c","message_ids":["8"]}),
        )
        .unwrap();
        provider_read(&connection, "9", 2);
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 0);
        // A message arriving after that directory snapshot must remain unread.
        message(&connection, "12", 4.0);
        observe(
            &connection,
            &json!({"platform":"p","account":"a","chat_id":"c","message_ids":["12"]}),
        )
        .unwrap();
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 1);
    }

    #[test]
    fn external_read_preserves_generation_but_clears_unread_session_sources() {
        let connection = database();
        message(&connection, "9007199254740993", 1.0);
        provider_read(&connection, "0", 1);
        let opened = open(&connection, &json!({"chat":scope()})).unwrap();
        let id = opened["suggestion"]["id"].as_str().unwrap();
        assert!(
            !claim(&connection, &json!({"suggestion_id":id}))
                .unwrap()
                .is_null()
        );
        provider_read(&connection, "9007199254740993", 0);
        let current =
            session(&connection, opened["response_session_id"].as_str().unwrap()).unwrap();
        assert_eq!(current["source_message_ids"], json!([]));
        assert_eq!(current["status"], "generating");
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 0);
        assert_eq!(suggestion(&connection, id).unwrap()["status"], "generating");
    }

    #[test]
    fn read_and_reopen_keep_the_unsent_recommendation_until_successful_send() {
        for (external, recover_previous) in [(false, false), (true, false), (true, true)] {
            let connection = database();
            message(&connection, "10", 1.0);
            provider_read(&connection, "0", 1);
            let first = open(&connection, &json!({"chat":scope()})).unwrap();
            let suggestion_id = first["suggestion"]["id"].as_str().unwrap();
            let claimed = claim(&connection, &json!({"suggestion_id":suggestion_id})).unwrap();
            finish(&connection, &json!({"suggestion_id":suggestion_id,"generation_epoch":claimed["generation_epoch"],"status":"ready","text":"내일 확인하고 답드릴게요."})).unwrap();
            if external {
                provider_read(&connection, "10", 0);
            } else {
                seen(&connection, &json!({"response_session_id":first["response_session_id"],"message_ids":["10"]})).unwrap();
            }
            if recover_previous {
                connection.execute("UPDATE reply_suggestions SET status='abstained',text=NULL,error='provider_read_advanced' WHERE suggestion_id=?",[suggestion_id]).unwrap();
            }
            feedback(&connection, &json!({"response_session_id":first["response_session_id"],"event_id":"leave","event":"closed"})).unwrap();
            assert_eq!(unread(&connection, &scope()).unwrap()["count"], 0);
            let reopened = open(&connection, &json!({"chat":scope()})).unwrap();
            assert_eq!(reopened["status"], "ready");
            assert_eq!(reopened["suggestion"]["id"], suggestion_id);
            assert_eq!(reopened["suggestion"]["text"], "내일 확인하고 답드릴게요.");
            complete_send(&connection, &json!({"response_session_id":reopened["response_session_id"],"platform":"p","account":"a","chat_id":"c","request_id":"sent-request","outcome":{"state":"Sent"}})).unwrap();
            let after_send = open(&connection, &json!({"chat":scope()})).unwrap();
            assert_ne!(after_send["status"], "ready");
            assert!(after_send["suggestion"]["text"].is_null());
        }
    }

    #[test]
    fn reopening_same_failed_context_does_not_retry_generation() {
        for read_mode in ["unchanged", "provider", "local"] {
            let connection = database();
            message(&connection, "10", 1.0);
            provider_read(&connection, "0", 1);
            let first = open(&connection, &json!({"chat":scope()})).unwrap();
            let suggestion_id = first["suggestion"]["id"].as_str().unwrap();
            let claimed = claim(&connection, &json!({"suggestion_id":suggestion_id})).unwrap();
            let failed = finish(
                &connection,
                &json!({
                    "suggestion_id":suggestion_id,
                    "generation_epoch":claimed["generation_epoch"],
                    "status":"failed",
                    "error":"draft_check_withheld",
                    "steps":[{
                        "step_id":"check-once",
                        "node_type":"check",
                        "status":"completed",
                        "decision":{"supported":false,"reasonCode":"unsupported_commitment"},
                        "duration_ms":1
                    }]
                }),
            )
            .unwrap();
            assert_eq!(failed["status"], "failed");

            if read_mode == "provider" {
                provider_read(&connection, "10", 0);
            } else if read_mode == "local" {
                seen(
                &connection,
                &json!({"response_session_id":first["response_session_id"],"message_ids":["10"]}),
            )
            .unwrap();
            }

            let reopened = open(&connection, &json!({"chat":scope()})).unwrap();
            assert_eq!(reopened["suggestion"]["id"], suggestion_id);
            assert_eq!(reopened["status"], "failed");
            assert_eq!(reopened["suggestion"]["error"], "draft_check_withheld");
            assert_eq!(reopened["suggestion"]["generation_epoch"], Value::Null);
            assert!(
                claim(&connection, &json!({"suggestion_id":suggestion_id}))
                    .unwrap()
                    .is_null()
            );

            let trajectory =
                list_trajectories(&connection, &json!({"suggestion_id":suggestion_id})).unwrap();
            assert_eq!(trajectory["trajectories"][0]["output_status"], "failed");
            assert_eq!(
                trajectory["trajectories"][0]["steps"][0]["decision"]["reasonCode"],
                "unsupported_commitment"
            );
        }
    }

    #[test]
    fn failed_generation_allows_new_message_or_runtime_to_create_new_work() {
        for change in ["message", "runtime"] {
            let connection = database();
            message(&connection, "10", 1.0);
            provider_read(&connection, "0", 1);
            let first = open(&connection, &json!({"chat":scope()})).unwrap();
            let id = first["suggestion"]["id"].as_str().unwrap();
            let claimed = claim(&connection, &json!({"suggestion_id":id})).unwrap();
            finish(
                &connection,
                &json!({"suggestion_id":id,"generation_epoch":claimed["generation_epoch"],"status":"failed","error":"draft_check_withheld"}),
            )
            .unwrap();
            if change == "message" {
                message(&connection, "11", 2.0);
            }
            let reopened = open(
                &connection,
                &json!({"chat":scope(),"runtime_version":if change == "runtime" {"new-runtime"} else {"legacy"}}),
            )
            .unwrap();
            assert_ne!(reopened["suggestion"]["id"], id);
            assert_eq!(reopened["status"], "queued");
        }
    }

    #[test]
    fn retained_recommendation_is_not_reused_after_context_or_runtime_changes() {
        for change in ["message", "edit", "runtime"] {
            let connection = database();
            message(&connection, "10", 1.0);
            provider_read(&connection, "0", 1);
            let first = open(&connection, &json!({"chat":scope()})).unwrap();
            let id = first["suggestion"]["id"].as_str().unwrap();
            connection.execute("UPDATE reply_suggestions SET status='ready',text='old reply' WHERE suggestion_id=?", [id]).unwrap();
            provider_read(&connection, "10", 0);
            if change == "message" {
                message(&connection, "11", 2.0);
            }
            if change == "edit" {
                connection
                    .execute("UPDATE messages SET body='edited'", [])
                    .unwrap();
            }
            let reopened = open(&connection, &json!({"chat":scope(),"runtime_version":if change=="runtime" {"new-model"} else {"legacy"}})).unwrap();
            assert_ne!(reopened["status"], "ready");
        }
    }

    #[test]
    fn startup_baseline_deduplicates_and_providerless_new_messages_are_at_least() {
        let connection = database();
        message(&connection, "old", 1.0);
        assert_eq!(
            observe(
                &connection,
                &json!({"platform":"p","account":"a","chat_id":"c","message_ids":["old"]})
            )
            .unwrap()["baseline"],
            true
        );
        assert_eq!(unread(&connection, &scope()).unwrap()["status"], "unknown");
        message(&connection, "new", 2.0);
        assert_eq!(
            observe(
                &connection,
                &json!({"platform":"p","account":"a","chat_id":"c","message_ids":["new"]})
            )
            .unwrap()["added"],
            1
        );
        assert_eq!(
            observe(
                &connection,
                &json!({"platform":"p","account":"a","chat_id":"c","message_ids":["new"]})
            )
            .unwrap()["added"],
            0
        );
        let state = unread(&connection, &scope()).unwrap();
        assert_eq!(state["status"], "at_least");
        assert_eq!(state["count"], 1);
    }

    #[test]
    fn seen_consumes_stale_provider_count_without_resurfacing_history() {
        let connection = database();
        message(&connection, "old", 1.0);
        message(&connection, "new", 2.0);
        evidence(
            &connection,
            &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":1}]}),
        )
        .unwrap();
        let before = unread(&connection, &scope()).unwrap();
        assert_eq!(before["count"], 1);
        connection
            .execute(
                "INSERT INTO response_seen VALUES('p','a','c','new',?)",
                [now().unwrap()],
            )
            .unwrap();
        let after = unread(&connection, &scope()).unwrap();
        assert_eq!(after["count"], 0);
    }

    #[test]
    fn changed_provider_evidence_preserves_consumption_and_count_only_remainder() {
        let connection = database();
        message(&connection, "one", 1.0);
        message(&connection, "two", 2.0);
        evidence(
            &connection,
            &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":1}]}),
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO response_seen VALUES('p','a','c','two',?)",
                [now().unwrap()],
            )
            .unwrap();
        evidence(
            &connection,
            &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":1}]}),
        )
        .unwrap();
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 0);

        evidence(
            &connection,
            &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":3}]}),
        )
        .unwrap();
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 2);
    }

    #[test]
    fn provider_count_changes_never_revive_locally_seen_message_ids() {
        let connection = database();
        message(&connection, "seen", 1.0);
        evidence(
            &connection,
            &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":1}]}),
        )
        .unwrap();
        connection
            .execute("INSERT INTO response_seen VALUES('p','a','c','seen',0)", [])
            .unwrap();
        message(&connection, "fresh", 2.0);
        evidence(
            &connection,
            &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":2}]}),
        )
        .unwrap();
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 1);
        assert_eq!(
            prepare(&connection, &scope()).unwrap()["source_message_ids"],
            json!(["fresh"])
        );
        connection
            .execute(
                "INSERT INTO response_seen VALUES('p','a','c','fresh',0)",
                [],
            )
            .unwrap();
        evidence(
            &connection,
            &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":1}]}),
        )
        .unwrap();
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 0);
        assert_eq!(prepare(&connection, &scope()).unwrap()["status"], "queued");
    }

    #[test]
    fn unknown_self_identity_preserves_count_only_and_abstains_generation() {
        let connection = database();
        connection.execute("DELETE FROM account_self", []).unwrap();
        message(&connection, "possibly-own", 1.0);
        evidence(
            &connection,
            &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":1}]}),
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO response_seen VALUES('p','a','c','possibly-own',?)",
                [now().unwrap()],
            )
            .unwrap();
        assert_eq!(unread(&connection, &scope()).unwrap()["count"], 1);
        let prepared = prepare(&connection, &scope()).unwrap();
        assert_eq!(prepared["status"], "abstained");
        assert_eq!(prepared["reason"], "self_identity_unavailable");
    }

    fn generating_suggestion(connection: &Connection, id: &str, created_at: f64) {
        connection.execute("INSERT INTO reply_suggestions(suggestion_id,platform,account,chat_id,context_version,source_json,context_json,status,prompt_version,created_at) VALUES(?,'p','a','c',?,'[\"m1\"]','[{\"message_id\":\"m1\"}]','generating','reply-v2',?)",params![id,id,created_at]).unwrap();
    }

    fn generation_payload(id: &str) -> Value {
        json!({
            "suggestion_id":id,
            "generation_epoch":0,
            "status":"ready",
            "text":"답변",
            "model_version":"local-test",
            "prompt_version":"reply-v2",
            "personal_adapter_version":"adapter-v1",
            "model_input":[{"role":"user","content":"정확한 입력"}],
            "check_input":{"candidate":"답변"},
            "state":{"intent":"reply"},
            "route_plan":{"action":"reply"},
            "decision":{"reason":"direct"},
            "retrieval_cost":{"rounds":1,"query_calls":1},
            "versions":{"pipeline":"decision-graph-v1"},
            "steps":[{"step_id":"step-1","parent_step_id":null,"node_type":"route","input_refs":["m1"],"decision":{"reason":"direct"},"action":{"action":"reply"},"observation":{"status":"available"},"outcome":{"state":"ready"},"state":{"intent":"reply"},"model_input":[{"role":"user","content":"단계 입력"}],"status":"completed","duration_ms":2.5,"versions":{"policy":"v1"}}],
            "evidence":[{"id":"evidence-1","source_id":"current_chat_history","key":{"chat_id":"c","msg_id":"m1"},"version":"v1","excerpt":"근거","ts":1.0,"observed_at":2.0}]
        })
    }

    #[test]
    fn failed_trace_summaries_keep_diagnostics_without_large_inputs() {
        let connection = database();
        for (id, status) in [("good", "ready"), ("bad", "failed")] {
            generating_suggestion(&connection, id, now().unwrap());
            let mut payload = generation_payload(id);
            payload["status"] = json!(status);
            payload["steps"][0]["step_id"] = json!(format!("step-{id}"));
            payload["steps"][0]["decision"] =
                json!({"supported":false,"reasonCode":"unsupported_commitment"});
            payload["steps"][0]["model_input"] = json!("private ".repeat(10_000));
            finish(&connection, &payload).unwrap();
        }
        let listed =
            list_trajectories(&connection, &json!({"status":"failed","summary":true})).unwrap();
        assert_eq!(listed["trajectories"].as_array().unwrap().len(), 1);
        let run = &listed["trajectories"][0];
        assert_eq!(run["suggestion_id"], "bad");
        assert_eq!(run["steps"][0]["reasonCode"], "unsupported_commitment");
        assert!(run.get("input_snapshot").is_none());
        assert!(!run.to_string().contains("private"));
        assert!(list_trajectories(&connection, &json!({"status":"invalid"})).is_err());
        let detailed = list_trajectories(&connection, &json!({"suggestion_id":"bad"})).unwrap();
        let run = &detailed["trajectories"][0];
        assert_eq!(run["truncated"], true);
        assert_eq!(run["input_snapshot"]["context"][0]["message_id"], "m1");
        assert_eq!(
            run["steps"][0]["decision"]["reasonCode"],
            "unsupported_commitment"
        );
        assert!(run.to_string().len() <= 48_000);
    }

    #[test]
    fn graph_trajectory_round_trips_and_privacy_delete_scrubs_derived_data() {
        let connection = database();
        generating_suggestion(&connection, "suggestion-1", now().unwrap());
        let completed = finish(&connection, &generation_payload("suggestion-1")).unwrap();
        assert_eq!(completed["status"], "ready");

        let listed =
            list_trajectories(&connection, &json!({"suggestion_id":"suggestion-1"})).unwrap();
        let run = &listed["trajectories"][0];
        assert_eq!(run["steps"][0]["node_type"], "route");
        assert_eq!(run["steps"][0]["state"]["intent"], "reply");
        assert_eq!(run["steps"][0]["model_input"][0]["content"], "단계 입력");
        assert_eq!(run["evidence"][0]["excerpt"], "근거");
        assert_eq!(
            run["input_snapshot"]["model_input"][0]["content"],
            "정확한 입력"
        );
        assert_eq!(run["cost"]["query_calls"], 1);

        let deleted =
            delete_trajectory(&connection, &json!({"suggestion_id":"suggestion-1"})).unwrap();
        assert!(deleted["deleted"].as_u64().unwrap() >= 4);
        assert!(
            list_trajectories(
                &connection,
                &json!({"suggestion_id":"suggestion-1"})
            )
            .unwrap()["trajectories"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            suggestion(&connection, "suggestion-1").unwrap(),
            Value::Null
        );
    }

    #[test]
    fn recording_off_keeps_generation_terminal_and_retention_scrubs_old_context() {
        let connection = database();
        trajectory(
            &connection,
            "response.settings",
            &json!({"recording":false}),
        )
        .unwrap();
        generating_suggestion(&connection, "not-recorded", now().unwrap());
        assert_eq!(
            finish(&connection, &generation_payload("not-recorded")).unwrap()["status"],
            "ready"
        );
        assert!(
            list_trajectories(&connection, &json!({"suggestion_id":"not-recorded"}))
                .unwrap()["trajectories"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        trajectory(&connection, "response.settings", &json!({"recording":true})).unwrap();
        generating_suggestion(&connection, "expired", now().unwrap());
        finish(&connection, &generation_payload("expired")).unwrap();
        connection
            .execute(
                "UPDATE reply_suggestions SET created_at=0 WHERE suggestion_id='expired'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE trajectory_runs SET created_at=0,completed_at=0 WHERE suggestion_id='expired'",
                [],
            )
            .unwrap();
        let settings = trajectory(
            &connection,
            "response.settings",
            &json!({"retention_days":1}),
        )
        .unwrap();
        assert!(settings["purged"].as_u64().unwrap() >= 4);
        assert_eq!(suggestion(&connection, "expired").unwrap(), Value::Null);
    }

    #[test]
    fn stale_requeue_epoch_rejects_late_worker_completion() {
        let connection = database();
        message(&connection, "m1", 1.0);
        connection
            .execute("INSERT INTO response_unseen VALUES('p','a','c','m1',1)", [])
            .unwrap();
        let first = prepare(&connection, &scope()).unwrap();
        let id = first["suggestion_id"].as_str().unwrap();
        assert_eq!(first["generation_epoch"], 0);
        assert!(
            !claim(&connection, &json!({"suggestion_id":id}))
                .unwrap()
                .is_null()
        );
        connection
            .execute(
                "UPDATE reply_suggestions SET status='stale' WHERE suggestion_id=?",
                [id],
            )
            .unwrap();
        let requeued = prepare(&connection, &scope()).unwrap();
        assert_eq!(requeued["status"], "queued");
        assert_eq!(requeued["generation_epoch"], 1);
        assert!(
            !claim(&connection, &json!({"suggestion_id":id}))
                .unwrap()
                .is_null()
        );

        let late = finish(&connection, &generation_payload(id)).unwrap();
        assert_eq!(late["status"], "generating");
        let mut current_payload = generation_payload(id);
        current_payload["generation_epoch"] = json!(1);
        assert_eq!(
            finish(&connection, &current_payload).unwrap()["status"],
            "ready"
        );
    }

    #[test]
    fn invalid_trajectory_payload_does_not_leave_generation_stuck() {
        let connection = database();
        generating_suggestion(&connection, "oversized-graph", now().unwrap());
        let mut payload = generation_payload("oversized-graph");
        payload["steps"] = json!((0..65)
            .map(|index| json!({"step_id":format!("step-{index}"),"node_type":"route","status":"completed"}))
            .collect::<Vec<_>>());
        assert_eq!(finish(&connection, &payload).unwrap()["status"], "ready");
        let events: i64 = connection
            .query_row(
                "SELECT count(*) FROM response_trajectory WHERE suggestion_id='oversized-graph' AND event='recording_failed'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 1);
    }

    #[test]
    fn failed_route_preserves_raw_proposal_state_and_exact_model_input() {
        let connection = database();
        generating_suggestion(&connection, "failed-route", now().unwrap());
        let payload = json!({
            "suggestion_id":"failed-route",
            "generation_epoch":0,
            "status":"failed",
            "text":null,
            "error":"invalid_policy_output",
            "prompt_version":"reply-v2",
            "model_version":"local-test",
            "state":{"intent":"unknown","confidence":0.1},
            "model_input":[{"role":"system","content":"system"},{"role":"user","content":"input"}],
            "route_plan":null,
            "versions":{"pipeline":"decision-graph-v1"},
            "steps":[{
                "step_id":"failed-step",
                "parent_step_id":null,
                "node_type":"route",
                "input_refs":["m1"],
                "decision":null,
                "action":null,
                "observation":null,
                "outcome":{"error":"invalid_policy_output","raw_proposal":"{bad json"},
                "state":{"intent":"unknown","confidence":0.1},
                "model_input":[{"role":"system","content":"system"},{"role":"user","content":"input"}],
                "status":"failed",
                "duration_ms":1
            }],
            "evidence":[]
        });
        assert_eq!(finish(&connection, &payload).unwrap()["status"], "failed");
        let listed =
            list_trajectories(&connection, &json!({"suggestion_id":"failed-route"})).unwrap();
        let run = &listed["trajectories"][0];
        assert_eq!(run["output_status"], "failed");
        assert_eq!(run["steps"][0]["status"], "failed");
        assert_eq!(run["steps"][0]["outcome"]["raw_proposal"], "{bad json");
        assert_eq!(run["steps"][0]["state"]["intent"], "unknown");
        assert_eq!(run["steps"][0]["model_input"][1]["content"], "input");
        assert_eq!(run["input_snapshot"]["state"]["confidence"], 0.1);
        assert_eq!(run["input_snapshot"]["model_input"][0]["role"], "system");
    }

    #[test]
    fn send_completion_closes_session_and_records_idempotent_outcome() {
        let connection = database();
        generating_suggestion(&connection, "sent-suggestion", now().unwrap());
        connection
            .execute(
                "UPDATE reply_suggestions SET status='ready',text='reply' WHERE suggestion_id='sent-suggestion'",
                [],
            )
            .unwrap();
        connection.execute("INSERT INTO response_sessions(session_id,platform,account,chat_id,incoming_version,source_json,suggestion_id,state,created_at) VALUES('session-1','p','a','c','context-v','[\"m1\"]','sent-suggestion','open',1)",[]).unwrap();
        connection.execute("INSERT INTO owner_sends(request_id,platform,account,chat_id,body,envelope_json,state,outcome_json) VALUES('request-1','p','a','c','사용자가 실제로 보낸 답변','{}','Verified','{}')",[]).unwrap();
        let input = json!({"response_session_id":"session-1","platform":"p","account":"a","chat_id":"c","request_id":"request-1","outcome":{"state":"Verified","provider_id":"provider-1"}});
        let completed = complete_send(&connection, &input).unwrap();
        assert_eq!(completed["status"], "sent");
        assert_eq!(completed["send_outcome"]["state"], "Verified");
        complete_send(&connection, &input).unwrap();
        let events: i64 = connection
            .query_row(
                "SELECT count(*) FROM response_trajectory WHERE event_id='send:request-1' AND event='send_outcome'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(events, 1);
        let payload: String = connection
            .query_row(
                "SELECT payload_json FROM response_trajectory WHERE event_id='send:request-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["final_text"], "사용자가 실제로 보낸 답변");
        assert_eq!(payload["send_state"], "Verified");
        assert_eq!(payload["review_required"], true);
    }

    fn kakao_sync_database() -> Connection {
        let connection = database();
        connection.execute("INSERT INTO account_self VALUES('kakao','owner','{\"status\":\"known\",\"self_id\":\"me\"}',1)",[]).unwrap();
        connection
            .execute("INSERT INTO chats VALUES('kakao','owner','room')", [])
            .unwrap();
        for (id, ts) in [("9", 9.0), ("10", 10.0), ("11", 11.0)] {
            connection.execute("INSERT INTO messages VALUES('kakao','owner','room',?,'other',?,'body',NULL,NULL)",params![id,ts]).unwrap();
        }
        connection.execute("INSERT INTO response_sessions(session_id,platform,account,chat_id,incoming_version,source_json,state,created_at) VALUES('kakao-session','kakao','owner','room','v','[\"9\",\"10\",\"11\"]','open',1)",[]).unwrap();
        connection
    }
    fn seen_count(connection: &Connection, id: &str) -> i64 {
        connection.query_row("SELECT count(*) FROM response_seen WHERE platform='kakao' AND account='owner' AND chat_id='room' AND msg_id=?",[id],|r|r.get(0)).unwrap()
    }
    fn finish_task(connection: &Connection, task: &Value, success: bool) -> Value {
        read_sync_finish(connection,&json!({"operation_id":task["operation_id"],"revision":task["revision"],"platform":task["platform"],"account":task["account"],"chat_id":task["chat_id"],"cursor":task["cursor"],"success":success})).unwrap()
    }

    #[test]
    fn room_entry_reads_all_history_and_count_only_evidence_with_rollback() {
        for success in [false, true] {
            let connection = kakao_sync_database();
            let scope = json!({"platform":"kakao","account":"owner","chat_id":"room"});
            evidence(&connection,&json!({"chats":[{"platform":"kakao","account":"owner","chat_id":"room","unread_count":100}]})).unwrap();
            assert_eq!(unread(&connection, &scope).unwrap()["count"], 100);
            let result = seen(
                &connection,
                &json!({"response_session_id":"kakao-session","all":true,"message_ids":[]}),
            )
            .unwrap();
            assert_eq!(result["unread"]["count"], 0);
            assert_eq!(result["_read_sync_task"]["cursor"], "11");
            for id in ["9", "10", "11"] {
                assert_eq!(seen_count(&connection, id), 1);
            }
            let finished = finish_task(&connection, &result["_read_sync_task"], success);
            assert_eq!(finished["unread"]["count"], if success { 0 } else { 100 });
            if success {
                connection.execute("INSERT INTO messages VALUES('kakao','owner','room','12','other',12,'new',NULL,NULL)",[]).unwrap();
                connection
                    .execute(
                        "INSERT INTO response_unseen VALUES('kakao','owner','room','12',12)",
                        [],
                    )
                    .unwrap();
                assert_eq!(unread(&connection, &scope).unwrap()["count"], 1);
            }
        }
    }

    #[test]
    fn kakao_failed_sync_rolls_back_only_new_optimistic_rows() {
        let connection = kakao_sync_database();
        connection
            .execute(
                "INSERT INTO response_seen VALUES('kakao','owner','room','9',1)",
                [],
            )
            .unwrap();
        let result = seen(
            &connection,
            &json!({"response_session_id":"kakao-session","message_ids":["9","10"]}),
        )
        .unwrap();
        assert_eq!(result["read_sync"]["status"], "pending");
        assert_eq!(seen_count(&connection, "9"), 1);
        assert_eq!(seen_count(&connection, "10"), 1);
        let finished = finish_task(&connection, &result["_read_sync_task"], false);
        assert_eq!(finished["status"], "failed");
        assert_eq!(seen_count(&connection, "9"), 1);
        assert_eq!(seen_count(&connection, "10"), 0);
    }

    #[test]
    fn kakao_revalidates_a_confirmed_cursor_without_rolling_back_prior_seen_state() {
        let connection = kakao_sync_database();
        let first = seen(
            &connection,
            &json!({"response_session_id":"kakao-session","message_ids":["10"]}),
        )
        .unwrap();
        assert_eq!(
            finish_task(&connection, &first["_read_sync_task"], true)["status"],
            "synced"
        );

        let retry = seen(
            &connection,
            &json!({"response_session_id":"kakao-session","message_ids":["10"]}),
        )
        .unwrap();
        assert_eq!(retry["read_sync"]["status"], "pending");
        assert!(retry["_read_sync_task"].is_object());
        assert_eq!(
            finish_task(&connection, &retry["_read_sync_task"], false)["status"],
            "failed"
        );
        assert_eq!(seen_count(&connection, "10"), 1);
    }

    #[test]
    fn kakao_older_success_is_preserved_when_newer_sync_fails() {
        let connection = kakao_sync_database();
        let first = seen(
            &connection,
            &json!({"response_session_id":"kakao-session","message_ids":["10"]}),
        )
        .unwrap();
        let second = seen(
            &connection,
            &json!({"response_session_id":"kakao-session","message_ids":["11"]}),
        )
        .unwrap();
        assert_eq!(
            finish_task(&connection, &first["_read_sync_task"], true)["status"],
            "synced"
        );
        assert_eq!(
            finish_task(&connection, &second["_read_sync_task"], false)["status"],
            "failed"
        );
        assert_eq!(seen_count(&connection, "10"), 1);
        assert_eq!(seen_count(&connection, "11"), 0);
    }

    #[test]
    fn kakao_stale_failure_never_undoes_newer_success() {
        let connection = kakao_sync_database();
        let first = seen(
            &connection,
            &json!({"response_session_id":"kakao-session","message_ids":["10"]}),
        )
        .unwrap();
        let second = seen(
            &connection,
            &json!({"response_session_id":"kakao-session","message_ids":["11"]}),
        )
        .unwrap();
        assert_eq!(
            finish_task(&connection, &second["_read_sync_task"], true)["status"],
            "synced"
        );
        assert_eq!(
            finish_task(&connection, &first["_read_sync_task"], false)["status"],
            "stale"
        );
        assert_eq!(seen_count(&connection, "10"), 1);
        assert_eq!(seen_count(&connection, "11"), 1);
    }
}
