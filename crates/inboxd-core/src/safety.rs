use serde_json::{Map, Number, Value, json};

use crate::{CoreError, CoreResult, Host, SqlHost};

const GLOBAL_QUOTA_SCOPE: &str = "__global__";
const CURSOR_SCOPE: &str = "safety.intent.listPending:v1";
const DEFAULT_PAGE_LIMIT: u64 = 50;
const MAX_PAGE_LIMIT: u64 = 100;

fn error(name: &str, message: impl Into<String>) -> CoreError {
    CoreError::new(name, message)
}
fn type_error(message: impl Into<String>) -> CoreError {
    error("TypeError", message)
}
fn rejected(message: &str) -> CoreError {
    error("ApprovalRejectedError", message)
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

fn js_whitespace(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
        '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
        '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn non_empty(value: &str, field: &str) -> CoreResult<String> {
    if value.trim_matches(js_whitespace).is_empty() {
        Err(type_error(format!("{field} must be non-empty")))
    } else {
        Ok(value.to_owned())
    }
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
fn host_string(host: &dyn Host, method: &str, field: &str) -> CoreResult<String> {
    let value = host.call(method, Value::Null)?;
    non_empty(
        value
            .as_str()
            .ok_or_else(|| type_error(format!("{field} must be a string")))?,
        field,
    )
}
fn hash(host: &dyn Host, value: Value) -> CoreResult<String> {
    host.call("host.canonicalSha256", value)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| error("HostError", "host.canonicalSha256 must return a string"))
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

fn validated_scope(value: &Value) -> CoreResult<Value> {
    let input = object(value, "scope")?;
    Ok(json!({
        "platform": non_empty(string(input, "platform")?, "scope.platform")?,
        "account": non_empty(string(input, "account")?, "scope.account")?,
        "chat_id": non_empty(string(input, "chat_id")?, "scope.chat_id")?,
    }))
}

fn proposal_from(value: &Value) -> CoreResult<Value> {
    let input = object(value, "proposal")?;
    let mut proposal = Map::new();
    proposal.insert(
        "actor".into(),
        Value::String(non_empty(string(input, "actor")?, "actor")?),
    );
    proposal.insert(
        "scope".into(),
        validated_scope(input.get("scope").unwrap_or(&Value::Null))?,
    );
    proposal.insert(
        "body".into(),
        Value::String(non_empty(string(input, "body")?, "body")?),
    );
    if let Some(parent) = input.get("parent_id") {
        let parent = parent
            .as_str()
            .ok_or_else(|| type_error("parent_id must be a string"))?;
        proposal.insert(
            "parent_id".into(),
            Value::String(non_empty(parent, "parent_id")?),
        );
    }
    Ok(Value::Object(proposal))
}

fn payload_hash_input(payload: &Map<String, Value>) -> Value {
    let mut result = Map::new();
    for key in ["actor", "scope", "body", "parent_id"] {
        if let Some(value) = payload.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    Value::Object(result)
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

struct Approval {
    id: String,
    approved_at: Value,
    payload: Map<String, Value>,
}
fn load_approval(
    sql: &SqlHost<'_>,
    host: &dyn Host,
    intent_id: &str,
) -> CoreResult<Option<Approval>> {
    let row = sql.get(
        "SELECT id, approved_at, payload_json FROM approvals WHERE intent_id = ?",
        &[json!(intent_id)],
    )?;
    if row.is_null() {
        return Ok(None);
    }
    let obj = object(&row, "approval row")?;
    Ok(Some(Approval {
        id: string(obj, "id")?.to_owned(),
        approved_at: obj.get("approved_at").cloned().unwrap_or(Value::Null),
        payload: row_payload(host, &row)?,
    }))
}

fn bound_hash(
    host: &dyn Host,
    intent_id: &str,
    payload: &Map<String, Value>,
) -> CoreResult<String> {
    let actual = hash(host, payload_hash_input(payload))?;
    hash(
        host,
        json!({
            "intent_id": intent_id,
            "actor": payload.get("actor").cloned().unwrap_or(Value::Null),
            "scope": payload.get("scope").cloned().unwrap_or(Value::Null),
            "payload_hash": actual,
            "expires_at": payload.get("expires_at").cloned().unwrap_or(Value::Null),
        }),
    )
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

/// Deliberately not wrapped by the caller's rejecting transaction: expiry is durable.
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

fn equal_scopes(a: &Value, b: &Value) -> bool {
    ["platform", "account", "chat_id"]
        .iter()
        .all(|key| a.get(key) == b.get(key))
}

fn quota_scope(host: &dyn Host, scope: &Value) -> CoreResult<String> {
    host.call("host.canonicalJson", scope.clone())?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| error("HostError", "host.canonicalJson must return a string"))
}

fn reserve_quota_key(sql: &SqlHost<'_>, host: &dyn Host, key: &str, limit: f64) -> CoreResult<()> {
    let row = sql.get("SELECT used FROM quota WHERE scope = ?", &[json!(key)])?;
    let used = if row.is_null() {
        0.0
    } else {
        row.get("used").and_then(Value::as_f64).unwrap_or(0.0)
    };
    if used >= limit {
        return Err(error("QuotaExceededError", "send quota exhausted"));
    }
    if row.is_null() {
        sql.run(
            "INSERT INTO quota (scope, used, updated_at) VALUES (?, ?, ?)",
            &[json!(key), json!(1), now(host)?],
        )?;
    } else {
        sql.run(
            "UPDATE quota SET used = ?, updated_at = ? WHERE scope = ?",
            &[json!(used + 1.0), now(host)?, json!(key)],
        )?;
    }
    Ok(())
}

fn release_quota_key(sql: &SqlHost<'_>, host: &dyn Host, key: &str) -> CoreResult<()> {
    let row = sql.get("SELECT used FROM quota WHERE scope = ?", &[json!(key)])?;
    if !row.is_null() {
        let used = row.get("used").and_then(Value::as_f64).unwrap_or(0.0);
        sql.run(
            "UPDATE quota SET used = ?, updated_at = ? WHERE scope = ?",
            &[json!((used - 1.0).max(0.0)), now(host)?, json!(key)],
        )?;
    }
    Ok(())
}

fn reserve_quota(
    sql: &SqlHost<'_>,
    host: &dyn Host,
    scope: &Value,
    global: f64,
    scoped: f64,
) -> CoreResult<()> {
    reserve_quota_key(sql, host, GLOBAL_QUOTA_SCOPE, global)?;
    reserve_quota_key(sql, host, &quota_scope(host, scope)?, scoped)
}
fn release_quota(sql: &SqlHost<'_>, host: &dyn Host, scope: &Value) -> CoreResult<()> {
    release_quota_key(sql, host, &quota_scope(host, scope)?)?;
    release_quota_key(sql, host, GLOBAL_QUOTA_SCOPE)
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

fn propose(input: &Value, host: &dyn Host) -> CoreResult<Value> {
    let args = object(input, "safety.propose input")?;
    let proposal = proposal_from(args.get("proposal").unwrap_or(&Value::Null))?;
    let ttl = args
        .get("approval_ttl_ms")
        .and_then(Value::as_f64)
        .ok_or_else(|| type_error("approval_ttl_ms must be a number"))?;
    let intent_id = host_string(host, "host.id", "id")?;
    let expires = now_f64(host)? + ttl;
    let mut payload = proposal.as_object().unwrap().clone();
    payload.insert("state".into(), json!("Proposed"));
    payload.insert("expires_at".into(), json!(expires));
    payload.insert(
        "payload_hash".into(),
        json!(hash(host, payload_hash_input(&payload))?),
    );
    let code = host_string(host, "host.approvalCode", "approval code")?;
    let approval = json!({
        "code": code, "code_hash": hash(host, json!(code))?,
        "bound_hash": bound_hash(host, &intent_id, &payload)?,
        "actor": payload.get("actor").cloned().unwrap(), "scope": payload.get("scope").cloned().unwrap(), "expires_at": expires,
    });
    let sql = SqlHost::new(host);
    sql.transaction(|sql| {
        sql.run("INSERT INTO intents (id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)", &[json!(intent_id), json!("send"), json!(stringify(host, Value::Object(payload.clone()))?), now(host)?])?;
        sql.run("INSERT INTO approvals (id, intent_id, approved_at, payload_json) VALUES (?, ?, NULL, ?)", &[json!(host_string(host, "host.id", "id")?), json!(intent_id), json!(stringify(host, approval.clone())?)])?;
        audit(sql, host, "intent.proposed", &intent_id, metadata(&intent_id, &payload))?;
        Ok(())
    })?;
    Ok(json!({"intent_id":intent_id,"expires_at":expires}))
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
        let mut item = summary(id, &payload).as_object().unwrap().clone();
        if !matches!(state, "Sending" | "Uncertain") {
            let Some(approval) = load_approval(&sql, host, id)? else {
                continue;
            };
            if let Some(code) = approval.payload.get("code") {
                item.insert("approval_code".into(), code.clone());
            }
        }
        intents.push(Value::Object(item));
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

fn approve(input: &Value, host: &dyn Host) -> CoreResult<Value> {
    let args = object(input, "approval request")?;
    let intent_id = string(args, "intent_id")?;
    let sql = SqlHost::new(host);
    if current_intent(&sql, host, intent_id)?.get("state") == Some(&json!("Expired")) {
        return Err(rejected("approval has expired"));
    }
    sql.transaction(|sql| {
        let current = load_intent(sql, host, intent_id)?
            .ok_or_else(|| rejected("approval intent is missing"))?;
        let approval = load_approval(sql, host, intent_id)?
            .ok_or_else(|| rejected("approval intent is missing"))?;
        if current.get("state") != Some(&json!("Proposed"))
            || !approval.approved_at.is_null()
            || approval.payload.contains_key("consumed_at")
        {
            return Err(rejected("approval is no longer available"));
        }
        if expires_at(&approval.payload)? <= now_f64(host)?
            || expires_at(&current)? <= now_f64(host)?
        {
            return Err(rejected("approval has expired"));
        }
        if hash(host, args.get("code").cloned().unwrap_or(Value::Null))?
            != approval
                .payload
                .get("code_hash")
                .and_then(Value::as_str)
                .unwrap_or("")
        {
            return Err(rejected("approval code is invalid"));
        }
        let actor = args.get("actor");
        let scope = args.get("scope");
        if actor != approval.payload.get("actor")
            || actor != current.get("actor")
            || !equal_scopes(
                scope.unwrap_or(&Value::Null),
                approval.payload.get("scope").unwrap_or(&Value::Null),
            )
            || !equal_scopes(
                scope.unwrap_or(&Value::Null),
                current.get("scope").unwrap_or(&Value::Null),
            )
        {
            return Err(rejected("approval actor or scope does not match"));
        }
        if approval
            .payload
            .get("bound_hash")
            .and_then(Value::as_str)
            .unwrap_or("")
            != bound_hash(host, intent_id, &current)?
        {
            return Err(rejected("approval binding no longer matches intent"));
        }
        let approved_at = now(host)?;
        let mut approval_payload = approval.payload;
        approval_payload.insert("consumed_at".into(), now(host)?);
        sql.run(
            "UPDATE approvals SET approved_at = ?, payload_json = ? WHERE id = ?",
            &[
                approved_at,
                json!(stringify(host, Value::Object(approval_payload))?),
                json!(approval.id),
            ],
        )?;
        let approved = mark_intent(sql, host, intent_id, &current, "Approved", None)?;
        audit(
            sql,
            host,
            "intent.approved",
            intent_id,
            metadata(intent_id, &approved),
        )?;
        Ok(summary(intent_id, &approved))
    })
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

fn claim(input: &Value, host: &dyn Host) -> CoreResult<Value> {
    let args = object(input, "safety.claim input")?;
    let id = string(args, "intent_id")?;
    let sql = SqlHost::new(host);
    if current_intent(&sql, host, id)?.get("state") == Some(&json!("Expired")) {
        return Err(ineligible("intent has expired"));
    }
    if args.get("transport_present").and_then(Value::as_bool) != Some(true) {
        return Err(ineligible("no injected send transport"));
    }
    let send_capable = args
        .get("send_capable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !send_capable {
        return sql.transaction(|sql| {
            let current =
                load_intent(sql, host, id)?.ok_or_else(|| ineligible("intent is missing"))?;
            let state = current.get("state").and_then(Value::as_str).unwrap_or("");
            if state != "Approved" {
                return Err(ineligible(format!("intent is not eligible from {state}")));
            }
            let failed = mark_intent(
                sql,
                host,
                id,
                &current,
                "Failed",
                Some("send_capability_disabled"),
            )?;
            audit(sql, host, "send.rejected", id, metadata(id, &failed))?;
            Ok(json!({"summary":summary(id, &failed)}))
        });
    }
    let global = args
        .get("global_quota_limit")
        .and_then(Value::as_f64)
        .ok_or_else(|| type_error("global_quota_limit must be a number"))?;
    let scoped = args
        .get("quota_limit")
        .and_then(Value::as_f64)
        .ok_or_else(|| type_error("quota_limit must be a number"))?;
    let use_policy = args
        .get("use_allow_send")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    sql.transaction(|sql| {
        let current = load_intent(sql, host, id)?.ok_or_else(|| ineligible("intent is missing approval data"))?;
        let approval = load_approval(sql, host, id)?.ok_or_else(|| ineligible("intent is missing approval data"))?;
        let state = current.get("state").and_then(Value::as_str).unwrap_or("");
        if state != "Approved" { return Err(ineligible(format!("intent is not eligible from {state}"))); }
        if approval.approved_at.is_null() || !approval.payload.contains_key("consumed_at") || approval.payload.get("bound_hash").and_then(Value::as_str).unwrap_or("") != bound_hash(host, id, &current)? || expires_at(&approval.payload)? <= now_f64(host)? {
            return Err(ineligible("approval binding is no longer valid"));
        }
        // This host policy port is intentionally inside the transaction and sees the freshly loaded payload.
        if use_policy && host.call("host.allowSend", Value::Object(current.clone()))?.as_bool() != Some(true) {
            let failed = mark_intent(sql, host, id, &current, "Failed", Some("policy_denied"))?;
            audit(sql, host, "send.rejected", id, metadata(id, &failed))?;
            return Ok(json!({"summary":summary(id, &failed)}));
        }
        let scope = current.get("scope").cloned().unwrap_or(Value::Null);
        reserve_quota(sql, host, &scope, global, scoped)?;
        let key = hash(host, json!({"intent_id":id,"scope":scope,"payload_hash":current.get("payload_hash").cloned().unwrap_or(Value::Null),"expires_at":current.get("expires_at").cloned().unwrap_or(Value::Null)}))?;
        let sending = mark_intent(sql, host, id, &current, "Sending", None)?;
        sql.run("INSERT INTO sends (id, intent_id, idempotency_key, state, payload_json, created_at) VALUES (?, ?, ?, 'Sending', ?, ?)", &[
            json!(host_string(host, "host.id", "id")?), json!(id), json!(key), json!(stringify(host, Value::Object(current.clone()))?), now(host)?,
        ])?;
        audit(sql, host, "send.claimed", id, metadata(id, &sending))?;
        let mut request = payload_hash_input(&current).as_object().unwrap().clone();
        request.insert("idempotency_key".into(), json!(key));
        Ok(json!({"request":request}))
    })
}

fn finalize(input: &Value, host: &dyn Host) -> CoreResult<Value> {
    let args = object(input, "safety.finalize input")?;
    let id = string(args, "intent_id")?;
    let state = string(args, "state")?;
    if !matches!(state, "Sent" | "Failed" | "Uncertain") {
        return Err(type_error("finalize state is invalid"));
    }
    let transport = object(
        args.get("transport_payload").unwrap_or(&Value::Null),
        "transport_payload",
    )?;
    let sql = SqlHost::new(host);
    sql.transaction(|sql| {
        let payload = load_intent(sql, host, id)?.ok_or_else(|| ineligible("intent is missing"))?;
        let mut state_payload = payload.clone();
        if let Some(receipt) = transport.get("receipt") { state_payload.insert("receipt".into(), receipt.clone()); }
        let reason = transport.get("reason").and_then(Value::as_str);
        let updated = mark_intent(sql, host, id, &state_payload, state, reason)?;
        sql.run("UPDATE sends SET state = ?, payload_json = ? WHERE intent_id = ? AND state = 'Sending'", &[json!(state), json!(stringify(host, Value::Object(transport.clone()))?), json!(id)])?;
        if state == "Failed" { release_quota(sql, host, payload.get("scope").unwrap_or(&Value::Null))?; }
        audit(sql, host, &format!("send.{}", state.to_lowercase()), id, metadata(id, &updated))?;
        Ok(summary(id, &updated))
    })
}

pub fn dispatch(op: &str, input: &Value, host: &dyn Host) -> CoreResult<Value> {
    match op {
        "safety.propose" => propose(input, host),
        "safety.listPendingPage" => list_pending(input, host),
        "safety.getIntent" => get_intent(input, host),
        "safety.approve" => approve(input, host),
        "safety.reject" => reject_intent(input, host),
        "safety.claim" => claim(input, host),
        "safety.finalize" => finalize(input, host),
        _ => Err(error(
            "RangeError",
            format!("unknown safety operation: {op}"),
        )),
    }
}
