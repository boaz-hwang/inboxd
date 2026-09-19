//! Read and retire historical intent records. Direct sends use the daemon ledger;
//! no proposal, approval-code, quota reservation or send execution lives here.
use crate::{CoreError, CoreResult, Host, SqlHost};
use serde_json::{Map, Number, Value, json};
const CURSOR_SCOPE: &str = "safety.intent.listPending:v1";
const DEFAULT_PAGE_LIMIT: u64 = 50;
const MAX_PAGE_LIMIT: u64 = 100;

fn error(name: &str, message: impl Into<String>) -> CoreError {
    CoreError::new(name, message)
}

fn type_error(message: impl Into<String>) -> CoreError {
    error("TypeError", message)
}

fn ineligible(message: impl Into<String>) -> CoreError {
    error("IntentNotEligibleError", message)
}

fn object<'a>(value: &'a Value, label: &str) -> CoreResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| type_error(format!("{label} must be an object")))
}

fn string<'a>(object: &'a Map<String, Value>, key: &str) -> CoreResult<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| type_error(format!("{key} must be a string")))
}

fn now(host: &dyn Host) -> CoreResult<Value> {
    host.call("host.now", Value::Null)
}

fn now_number(host: &dyn Host) -> CoreResult<Number> {
    now(host)?
        .as_number()
        .cloned()
        .filter(|n| n.as_f64().is_some_and(f64::is_finite))
        .ok_or_else(|| type_error("now must return a finite number"))
}

fn now_f64(host: &dyn Host) -> CoreResult<f64> {
    Ok(now_number(host)?.as_f64().unwrap())
}

fn stringify(host: &dyn Host, value: Value) -> CoreResult<String> {
    host.call("host.jsonStringify", value)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| error("HostError", "host.jsonStringify must return a string"))
}

fn parse(host: &dyn Host, value: &str) -> CoreResult<Value> {
    host.call("host.jsonParse", json!(value))
}

fn metadata(intent_id: &str, payload: &Map<String, Value>) -> Value {
    json!({
        "intent_id": intent_id,
        "actor": payload.get("actor").cloned().unwrap_or(Value::Null),
        "scope": payload.get("scope").cloned().unwrap_or(Value::Null),
        "payload_hash": payload.get("payload_hash").cloned().unwrap_or(Value::Null),
        "expires_at": payload.get("expires_at").cloned().unwrap_or(Value::Null),
    })
}

fn audit(
    sql: &SqlHost<'_>,
    host: &dyn Host,
    action: &str,
    subject: &str,
    payload: Value,
) -> CoreResult<()> {
    sql.run(
        "INSERT INTO audit (action, subject, payload_json, created_at) VALUES (?, ?, ?, ?)",
        &[
            json!(action),
            json!(subject),
            json!(stringify(host, payload)?),
            now(host)?,
        ],
    )?;
    Ok(())
}

fn row_payload(host: &dyn Host, row: &Value) -> CoreResult<Map<String, Value>> {
    let encoded = row
        .as_object()
        .and_then(|r| r.get("payload_json"))
        .and_then(Value::as_str)
        .ok_or_else(|| error("CoreError", "stored payload_json is missing"))?;
    parse(host, encoded)?
        .as_object()
        .cloned()
        .ok_or_else(|| error("CoreError", "stored payload_json is not an object"))
}

fn load_intent(
    sql: &SqlHost<'_>,
    host: &dyn Host,
    intent_id: &str,
) -> CoreResult<Option<Map<String, Value>>> {
    let row = sql.get(
        "SELECT payload_json FROM intents WHERE id = ?",
        &[json!(intent_id)],
    )?;
    if row.is_null() {
        Ok(None)
    } else {
        Ok(Some(row_payload(host, &row)?))
    }
}

fn mark_intent(
    sql: &SqlHost<'_>,
    host: &dyn Host,
    intent_id: &str,
    payload: &Map<String, Value>,
    state: &str,
    reason: Option<&str>,
) -> CoreResult<Map<String, Value>> {
    let mut updated = payload.clone();
    updated.insert("state".into(), json!(state));
    if let Some(reason) = reason {
        updated.insert("failure_reason".into(), json!(reason));
    }
    sql.run(
        "UPDATE intents SET payload_json = ? WHERE id = ?",
        &[
            json!(stringify(host, Value::Object(updated.clone()))?),
            json!(intent_id),
        ],
    )?;
    Ok(updated)
}

fn expires_at(payload: &Map<String, Value>) -> CoreResult<f64> {
    payload
        .get("expires_at")
        .and_then(Value::as_f64)
        .ok_or_else(|| error("CoreError", "intent expires_at is invalid"))
}

fn expire_if_needed(
    sql: &SqlHost<'_>,
    host: &dyn Host,
    intent_id: &str,
    payload: Map<String, Value>,
) -> CoreResult<Map<String, Value>> {
    let state = payload.get("state").and_then(Value::as_str).unwrap_or("");
    if matches!(state, "Proposed" | "Approved") && expires_at(&payload)? <= now_f64(host)? {
        let expired = mark_intent(
            sql,
            host,
            intent_id,
            &payload,
            "Expired",
            Some("ttl_elapsed"),
        )?;
        audit(
            sql,
            host,
            "intent.expired",
            intent_id,
            metadata(intent_id, &expired),
        )?;
        Ok(expired)
    } else {
        Ok(payload)
    }
}

fn current_intent(
    sql: &SqlHost<'_>,
    host: &dyn Host,
    intent_id: &str,
) -> CoreResult<Map<String, Value>> {
    let payload =
        load_intent(sql, host, intent_id)?.ok_or_else(|| ineligible("intent is missing"))?;
    expire_if_needed(sql, host, intent_id, payload)
}

fn summary(intent_id: &str, payload: &Map<String, Value>) -> Value {
    let mut result = Map::new();
    result.insert("intent_id".into(), json!(intent_id));
    for key in [
        "state",
        "actor",
        "scope",
        "envelope",
        "body",
        "parent_id",
        "expires_at",
        "receipt",
    ] {
        if let Some(value) = payload.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    Value::Object(result)
}

fn encode_cursor(host: &dyn Host, created_at: &Value, id: &str) -> CoreResult<String> {
    // Property order and JavaScript number formatting are persisted v1 bytes.
    let encoded = stringify(
        host,
        json!({"v":1,"scope":CURSOR_SCOPE,"created_at":created_at,"id":id}),
    )?;
    host.call("host.base64urlEncode", json!(encoded))?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| error("HostError", "host.base64urlEncode must return a string"))
}

fn decode_cursor(host: &dyn Host, value: &str) -> CoreResult<(Value, String)> {
    let malformed = || error("Error", "cursor is malformed");
    if value.is_empty()
        || value.len() > 4096
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(malformed());
    }
    let text = host
        .call("host.base64urlDecode", json!(value))
        .map_err(|_| malformed())?;
    let text = text.as_str().ok_or_else(malformed)?;
    let decoded = parse(host, text).map_err(|_| malformed())?;
    let object = decoded.as_object().ok_or_else(malformed)?;
    let created = object
        .get("created_at")
        .filter(|v| v.as_f64().is_some_and(f64::is_finite))
        .cloned();
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    if object.get("v") != Some(&json!(1))
        || object.get("scope") != Some(&json!(CURSOR_SCOPE))
        || created.is_none()
        || id.is_none()
    {
        return Err(error("Error", "cursor does not match pending intents"));
    }
    let (created, id) = (created.unwrap(), id.unwrap().to_owned());
    if encode_cursor(host, &created, &id)? != value {
        return Err(malformed());
    }
    Ok((created, id))
}

fn initialize(host: &dyn Host) -> CoreResult<Value> {
    let sql = SqlHost::new(host);
    sql.transaction(|sql| {
        // Legacy approvals must never be a recovery source for raw codes.
        sql.run("UPDATE approvals SET payload_json = json_remove(payload_json, '$.code', '$.approval_code', '$.approvalCode')", &[])?;
        for row in sql.all("SELECT id, payload_json FROM intents WHERE json_extract(payload_json, '$.state') = 'Proposed'", &[])? {
            let id = string(object(&row, "intent row")?, "id")?;
            let payload = row_payload(host, &row)?;
            let expired = mark_intent(sql, host, id, &payload, "Expired", Some("approval_code_unavailable"))?;
            audit(sql, host, "intent.expired", id, metadata(id, &expired))?;
        }
        Ok(Value::Null)
    })
}

fn list_pending(input: &Value, host: &dyn Host) -> CoreResult<Value> {
    let args = object(input, "safety.listPendingPage input")?;
    let limit = match args.get("limit") {
        None => DEFAULT_PAGE_LIMIT,
        Some(value) => value
            .as_u64()
            .filter(|v| (1..=MAX_PAGE_LIMIT).contains(v))
            .ok_or_else(|| {
                error(
                    "Error",
                    format!("limit must be an integer from 1 to {MAX_PAGE_LIMIT}"),
                )
            })?,
    };
    let cursor = match args.get("cursor") {
        None => None,
        Some(Value::String(value)) => Some(decode_cursor(host, value)?),
        _ => return Err(type_error("cursor must be a string")),
    };
    let sql = SqlHost::new(host);
    let (query, params) = if let Some((created, id)) = cursor {
        (
            "SELECT id, created_at, payload_json FROM intents WHERE json_extract(payload_json, '$.state') IN ('Proposed', 'Approved', 'Sending', 'Uncertain') AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?",
            vec![created.clone(), created, json!(id), json!(limit + 1)],
        )
    } else {
        (
            "SELECT id, created_at, payload_json FROM intents WHERE json_extract(payload_json, '$.state') IN ('Proposed', 'Approved', 'Sending', 'Uncertain') ORDER BY created_at, id LIMIT ?",
            vec![json!(limit + 1)],
        )
    };
    let rows = sql.all(query, &params)?;
    let mut intents = Vec::new();
    for row in rows.iter().take(limit as usize) {
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| error("CoreError", "intent row id is missing"))?;
        let payload = expire_if_needed(&sql, host, id, row_payload(host, row)?)?;
        let state = payload.get("state").and_then(Value::as_str).unwrap_or("");
        if !matches!(state, "Proposed" | "Approved" | "Sending" | "Uncertain") {
            continue;
        }
        intents.push(summary(id, &payload));
    }
    let mut result = json!({"intents":intents}).as_object().unwrap().clone();
    if rows.len() > limit as usize {
        if let Some(row) = rows.get(limit as usize - 1) {
            let created = row
                .get("created_at")
                .ok_or_else(|| error("CoreError", "cursor row timestamp is missing"))?;
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| error("CoreError", "cursor row id is missing"))?;
            result.insert(
                "next_cursor".into(),
                json!(encode_cursor(host, created, id)?),
            );
        }
    }
    Ok(Value::Object(result))
}

fn get_intent(input: &Value, host: &dyn Host) -> CoreResult<Value> {
    let id = string(object(input, "safety.getIntent input")?, "intent_id")?;
    let sql = SqlHost::new(host);
    let Some(payload) = load_intent(&sql, host, id)? else {
        return Ok(Value::Null);
    };
    Ok(summary(id, &expire_if_needed(&sql, host, id, payload)?))
}

fn reject_intent(input: &Value, host: &dyn Host) -> CoreResult<Value> {
    let id = string(object(input, "safety.reject input")?, "intent_id")?;
    let sql = SqlHost::new(host);
    current_intent(&sql, host, id)?;
    sql.transaction(|sql| {
        let payload = load_intent(sql, host, id)?.ok_or_else(|| ineligible("intent is missing"))?;
        if !matches!(
            payload.get("state").and_then(Value::as_str),
            Some("Proposed" | "Approved")
        ) {
            return Err(ineligible("intent is not rejectable"));
        }
        let rejected = mark_intent(sql, host, id, &payload, "Expired", Some("rejected"))?;
        audit(sql, host, "intent.rejected", id, metadata(id, &rejected))?;
        Ok(summary(id, &rejected))
    })
}

pub fn dispatch(op: &str, input: &Value, host: &dyn Host) -> CoreResult<Value> {
    match op {
        "safety.initialize" => initialize(host),
        "safety.listPendingPage" => list_pending(input, host),
        "safety.getIntent" => get_intent(input, host),
        "safety.reject" => reject_intent(input, host),
        _ => Err(error(
            "RangeError",
            format!("unknown safety operation: {op}"),
        )),
    }
}
