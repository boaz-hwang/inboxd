use std::cmp::Ordering;

use serde_json::{Map, Value, json};

use crate::{CoreError, CoreResult};

trait DomainErrorConstructors: Sized {
    fn from_domain_parts(name: &str, message: String) -> Self;

    fn type_error(message: impl Into<String>) -> Self {
        Self::from_domain_parts("TypeError", message.into())
    }

    fn range_error(message: impl Into<String>) -> Self {
        Self::from_domain_parts("RangeError", message.into())
    }
}

impl DomainErrorConstructors for CoreError {
    fn from_domain_parts(name: &str, message: String) -> Self {
        CoreError::new(name, message)
    }
}

pub type DomainResult<T> = CoreResult<T>;

fn object<'a>(value: &'a Value, field: &str) -> DomainResult<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| CoreError::type_error(format!("{field} must be an object")))
}

fn non_empty_string(value: Option<&Value>, field: &str) -> DomainResult<String> {
    match value.and_then(Value::as_str) {
        Some(value)
            if value
                .chars()
                .any(|character| !is_ecmascript_whitespace(character)) =>
        {
            Ok(value.to_owned())
        }
        _ => Err(CoreError::type_error(format!(
            "{field} must be a non-empty string"
        ))),
    }
}

fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn finite_number(value: Option<&Value>, field: &str) -> DomainResult<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| CoreError::type_error(format!("{field} must be a finite timestamp")))
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

pub fn chat_key(value: &Value) -> DomainResult<Value> {
    let input = object(value, "chat key")?;
    Ok(json!({
        "platform": non_empty_string(input.get("platform"), "platform")?,
        "account": non_empty_string(input.get("account"), "account")?,
        "chat_id": non_empty_string(input.get("chat_id"), "chat_id")?,
    }))
}

pub fn message_key(value: &Value) -> DomainResult<Value> {
    let input = object(value, "message key")?;
    let mut result = object(&chat_key(value)?, "chat key")?.clone();
    result.insert(
        "msg_id".into(),
        Value::String(non_empty_string(input.get("msg_id"), "msg_id")?),
    );
    Ok(Value::Object(result))
}

pub fn adapter_revision(value: &Value) -> DomainResult<Value> {
    let input = object(value, "adapter revision")?;
    let source = input.get("source").and_then(Value::as_str);
    if source != Some("adapter") && source != Some("observation") {
        return Err(CoreError::type_error(
            "adapter revision source must be 'adapter' or 'observation'",
        ));
    }
    let revision = input.get("value").ok_or_else(|| {
        CoreError::type_error("adapter revision value must be a non-empty string or finite number")
    })?;
    if source == Some("observation") && revision.as_str() != Some("unversioned") {
        return Err(CoreError::type_error(
            "observation revision value must be 'unversioned'",
        ));
    }
    let valid = revision.as_str().is_some_and(|value| {
        value
            .chars()
            .any(|character| !is_ecmascript_whitespace(character))
    }) || revision.as_f64().is_some_and(f64::is_finite);
    if !valid {
        return Err(CoreError::type_error(
            "adapter revision value must be a non-empty string or finite number",
        ));
    }
    Ok(json!({ "source": source.unwrap(), "value": revision.clone() }))
}

fn attachment(value: &Value) -> DomainResult<Value> {
    let input = object(value, "attachment")?;
    let size = input.get("size").and_then(Value::as_f64);
    if !size.is_some_and(|value| value.is_finite() && value >= 0.0) {
        return Err(CoreError::type_error(
            "attachment size must be a non-negative finite number",
        ));
    }
    Ok(json!({
        "filename": non_empty_string(input.get("filename"), "attachment filename")?,
        "mime": non_empty_string(input.get("mime"), "attachment mime")?,
        "size": input.get("size").cloned().unwrap(),
    }))
}

fn normalized_message(value: &Value, revision: &Value) -> DomainResult<Value> {
    let input = object(value, "message")?;
    let attachments = input
        .get("attachments")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::type_error("message attachments must be an array"))?
        .iter()
        .map(attachment)
        .collect::<DomainResult<Vec<_>>>()?;
    let mut result = Map::new();
    result.insert(
        "key".into(),
        message_key(input.get("key").unwrap_or(&Value::Null))?,
    );
    result.insert(
        "author_id".into(),
        Value::String(non_empty_string(input.get("author_id"), "author_id")?),
    );
    result.insert(
        "ts".into(),
        number(finite_number(input.get("ts"), "message ts")?),
    );
    result.insert(
        "body".into(),
        Value::String(non_empty_string(input.get("body"), "message body")?),
    );
    result.insert("attachments".into(), Value::Array(attachments));
    result.insert("adapter_revision".into(), revision.clone());
    if let Some(parent) = input.get("parent_id") {
        result.insert("parent_id".into(), message_key(parent)?);
    }
    if let Some(edited_at) = input.get("edited_at") {
        result.insert(
            "edited_at".into(),
            number(finite_number(Some(edited_at), "edited_at")?),
        );
    }
    if let Some(deleted_at) = input.get("deleted_at") {
        result.insert(
            "deleted_at".into(),
            number(finite_number(Some(deleted_at), "deleted_at")?),
        );
    }
    Ok(Value::Object(result))
}

fn tombstone(value: &Value) -> DomainResult<Value> {
    let input = object(value, "tombstone")?;
    if input.get("body") != Some(&Value::Null) {
        return Err(CoreError::type_error("tombstone body must be null"));
    }
    Ok(json!({
        "key": message_key(input.get("key").unwrap_or(&Value::Null))?,
        "body": Value::Null,
        "deleted_at": number(finite_number(input.get("deleted_at"), "deleted_at")?),
    }))
}

pub fn normalize_message_event(value: &Value) -> DomainResult<Value> {
    let input = object(value, "message event")?;
    let revision = adapter_revision(input.get("revision").unwrap_or(&Value::Null))?;
    match input.get("kind").and_then(Value::as_str) {
        Some("create") => Ok(json!({
            "kind": "create",
            "message": normalized_message(input.get("message").unwrap_or(&Value::Null), &revision)?,
            "revision": revision,
        })),
        Some("edit") => Ok(json!({
            "kind": "edit",
            "key": message_key(input.get("key").unwrap_or(&Value::Null))?,
            "body": non_empty_string(input.get("body"), "edit body")?,
            "edited_at": number(finite_number(input.get("edited_at"), "edited_at")?),
            "revision": revision,
        })),
        Some("delete") => Ok(json!({
            "kind": "delete",
            "tombstone": tombstone(input.get("tombstone").unwrap_or(&Value::Null))?,
            "revision": revision,
        })),
        _ => Err(CoreError::type_error(
            "message event kind must be create, edit, or delete",
        )),
    }
}

pub fn half_open_interval(from_ts: f64, to_ts: f64) -> DomainResult<Value> {
    if !from_ts.is_finite() {
        return Err(CoreError::type_error("from_ts must be finite"));
    }
    if !to_ts.is_finite() {
        return Err(CoreError::type_error("to_ts must be finite"));
    }
    if from_ts >= to_ts {
        return Err(CoreError::range_error(
            "half-open interval must satisfy from_ts < to_ts",
        ));
    }
    Ok(json!({ "from_ts": number(from_ts), "to_ts": number(to_ts) }))
}

fn interval(value: &Value) -> DomainResult<(f64, f64, Value)> {
    let input = object(value, "interval")?;
    let from = input
        .get("from_ts")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    let to = input
        .get("to_ts")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    Ok((from, to, half_open_interval(from, to)?))
}

fn same_chat(left: &Value, right: &Value) -> bool {
    ["platform", "account", "chat_id"]
        .iter()
        .all(|key| left.get(key) == right.get(key))
}

fn intersect(left: (f64, f64), right: (f64, f64)) -> Option<Value> {
    let from = left.0.max(right.0);
    let to = left.1.min(right.1);
    (from < to).then(|| json!({ "from_ts": number(from), "to_ts": number(to) }))
}

pub fn coverage_segment(value: &Value) -> DomainResult<Value> {
    let input = object(value, "coverage segment")?;
    let (_, _, checked_interval) = interval(input.get("interval").unwrap_or(&Value::Null))?;
    let kind = input.get("kind").and_then(Value::as_str);
    if !matches!(kind, Some("backfill" | "watch" | "verified_empty")) {
        return Err(CoreError::type_error(
            "coverage kind must be backfill, watch, or verified_empty",
        ));
    }
    let collected = finite_number(input.get("collected_at"), "collected_at")?;
    match input.get("mutations_verified_at") {
        Some(Value::Null) => {}
        Some(value) => {
            finite_number(Some(value), "mutations_verified_at")?;
        }
        None => {
            return Err(CoreError::type_error(
                "mutations_verified_at must be a finite timestamp",
            ));
        }
    }
    let mut result = input.clone();
    result.insert("interval".into(), checked_interval);
    result.insert("collected_at".into(), number(collected));
    Ok(Value::Object(result))
}

fn coverage_limit(value: &Value) -> DomainResult<Value> {
    let input = object(value, "coverage limit")?;
    let (_, _, checked_interval) = interval(input.get("interval").unwrap_or(&Value::Null))?;
    let reason = input.get("reason").and_then(Value::as_str);
    if !matches!(
        reason,
        Some("retention" | "permission" | "rate_limit" | "unsupported" | "unknown")
    ) {
        return Err(CoreError::type_error("invalid coverage limit reason"));
    }
    finite_number(input.get("observed_at"), "observed_at")?;
    if let Some(resolved) = input.get("resolved_at") {
        finite_number(Some(resolved), "resolved_at")?;
    }
    let mut result = input.clone();
    result.insert("interval".into(), checked_interval);
    Ok(Value::Object(result))
}

pub fn build_coverage(value: &Value) -> DomainResult<Value> {
    let input = object(value, "coverage input")?;
    let raw_target = object(
        input.get("target").unwrap_or(&Value::Null),
        "coverage target",
    )?;
    let target_chat = Value::Object(
        raw_target
            .get("chat")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    );
    let (target_from, target_to, target_interval) =
        interval(raw_target.get("interval").unwrap_or(&Value::Null))?;
    let target = json!({ "chat": target_chat.clone(), "interval": target_interval });

    let raw_covered = input
        .get("covered")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::type_error("covered must be an array"))?;
    let mut covered = Vec::new();
    for candidate in raw_covered {
        let mut segment = object(&coverage_segment(candidate)?, "coverage segment")?.clone();
        if !same_chat(&target_chat, segment.get("chat").unwrap_or(&Value::Null)) {
            return Err(CoreError::type_error(
                "coverage segment chat is outside target",
            ));
        }
        let (from, to, _) = interval(segment.get("interval").unwrap())?;
        if let Some(value) = intersect((target_from, target_to), (from, to)) {
            segment.insert("interval".into(), value);
            covered.push(Value::Object(segment));
        }
    }

    let raw_limits = input
        .get("limits")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::type_error("limits must be an array"))?;
    let mut limits = Vec::new();
    for candidate in raw_limits {
        let mut limit = object(&coverage_limit(candidate)?, "coverage limit")?.clone();
        if !same_chat(&target_chat, limit.get("chat").unwrap_or(&Value::Null)) {
            return Err(CoreError::type_error(
                "coverage limit chat is outside target",
            ));
        }
        let (from, to, _) = interval(limit.get("interval").unwrap())?;
        if let Some(value) = intersect((target_from, target_to), (from, to)) {
            limit.insert("interval".into(), value);
            limits.push(Value::Object(limit));
        }
    }

    let mut known: Vec<(f64, f64)> = covered
        .iter()
        .map(|segment| {
            let value = segment.get("interval").unwrap();
            (
                value.get("from_ts").and_then(Value::as_f64).unwrap(),
                value.get("to_ts").and_then(Value::as_f64).unwrap(),
            )
        })
        .collect();
    known.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.1.partial_cmp(&right.1).unwrap_or(Ordering::Equal))
    });
    let mut gaps = Vec::new();
    let mut cursor = target_from;
    for (from, to) in known {
        if from > cursor {
            gaps.push(json!({ "interval": { "from_ts": number(cursor), "to_ts": number(from) }, "reason": "unknown" }));
        }
        cursor = cursor.max(to);
    }
    if cursor < target_to {
        gaps.push(json!({ "interval": { "from_ts": number(cursor), "to_ts": number(target_to) }, "reason": "unknown" }));
    }

    let freshness = covered.iter().map(|segment| json!({
        "interval": segment.get("interval").cloned().unwrap(),
        "collected_at": segment.get("collected_at").cloned().unwrap(),
        "mutations_verified_at": segment.get("mutations_verified_at").cloned().unwrap_or(Value::Null),
    })).collect::<Vec<_>>();
    Ok(
        json!({ "target": target, "covered": covered, "gaps": gaps, "freshness": freshness, "limits": limits }),
    )
}

pub fn gateway_capabilities(value: &Value) -> DomainResult<Value> {
    let input = object(value, "gateway capabilities")?;
    for field in ["list_chats", "fetch_historical", "send", "watch"] {
        if !input.get(field).is_some_and(Value::is_boolean) {
            return Err(CoreError::type_error(format!(
                "{field} capability must be boolean"
            )));
        }
    }
    if !matches!(
        input.get("revision").and_then(Value::as_str),
        Some("adapter" | "none")
    ) {
        return Err(CoreError::type_error(
            "revision capability must be adapter or none",
        ));
    }
    if !matches!(
        input.get("read_cursor_comparison").and_then(Value::as_str),
        Some("message_id" | "timestamp" | "none")
    ) {
        return Err(CoreError::type_error(
            "read_cursor_comparison must be message_id, timestamp, or none",
        ));
    }
    Ok(value.clone())
}

pub fn assert_gateway_capabilities(value: &Value) -> DomainResult<Value> {
    let input = object(value, "gateway")?;
    let capabilities = gateway_capabilities(input.get("capabilities").unwrap_or(&Value::Null))?;
    let exposed = object(input.get("ports").unwrap_or(&Value::Null), "gateway ports")?;
    for (capability, port) in [
        ("list_chats", "listChats"),
        ("fetch_historical", "fetchHistorical"),
        ("send", "send"),
        ("watch", "watch"),
    ] {
        let claimed = capabilities
            .get(capability)
            .and_then(Value::as_bool)
            .unwrap();
        let present = exposed.get(port).and_then(Value::as_bool).unwrap_or(false);
        if claimed && !present {
            return Err(CoreError::type_error(format!(
                "gateway claims {capability} but does not provide {port}"
            )));
        }
        if !claimed && present {
            return Err(CoreError::type_error(format!(
                "gateway exposes {port} while capability {capability} is false"
            )));
        }
    }
    Ok(Value::Null)
}

pub fn validate_send_configuration(value: &Value) -> DomainResult<Value> {
    let input = object(value, "daemon options")?;
    if input.get("send_capable").and_then(Value::as_bool) != Some(true) {
        return Ok(Value::Null);
    }
    for (field, label) in [
        ("quota_limit", "per-scope"),
        ("global_quota_limit", "global"),
    ] {
        let valid = input
            .get(field)
            .and_then(Value::as_f64)
            .is_some_and(|value| value.is_finite() && value > 0.0);
        if !valid {
            return Err(CoreError::type_error(format!(
                "send-capable daemon requires an explicitly configured finite positive {label} quota"
            )));
        }
    }
    if input.get("has_allow_send").and_then(Value::as_bool) != Some(true) {
        return Err(CoreError::type_error(
            "send-capable daemon requires an explicit allowlist policy",
        ));
    }
    Ok(Value::Null)
}

pub fn dispatch(op: &str, input: &Value) -> Option<DomainResult<Value>> {
    Some(match op {
        "domain.chatKey" => chat_key(input),
        "domain.messageKey" => message_key(input),
        "domain.adapterRevision" => adapter_revision(input),
        "domain.normalizeMessageEvent" => normalize_message_event(input),
        "domain.halfOpenInterval" => {
            let value = match object(input, "interval") {
                Ok(value) => value,
                Err(error) => return Some(Err(error)),
            };
            half_open_interval(
                value
                    .get("from_ts")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NAN),
                value
                    .get("to_ts")
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NAN),
            )
        }
        "domain.coverageSegment" => coverage_segment(input),
        "domain.buildCoverage" => build_coverage(input),
        "domain.gatewayCapabilities" => gateway_capabilities(input),
        "domain.assertGatewayCapabilities" => assert_gateway_capabilities(input),
        "domain.validateSendConfiguration" => validate_send_configuration(input),
        "sync.decideReadAdapterWidening" => {
            let input = match object(input, "read contract request") {
                Ok(value) => value,
                Err(error) => return Some(Err(error)),
            };
            Ok(
                if input.get("authoritative_history").and_then(Value::as_bool) == Some(true) {
                    json!({ "decision": "direct_cursor_adapter_required" })
                } else {
                    json!({ "decision": "degraded_adapter_allowed" })
                },
            )
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletion_requires_a_bodyless_tombstone() {
        let result = normalize_message_event(&json!({
            "kind": "delete",
            "tombstone": { "key": { "platform": "p", "account": "a", "chat_id": "c", "msg_id": "m" }, "body": "bad", "deleted_at": 1 },
            "revision": { "source": "adapter", "value": 1 },
        }));
        assert_eq!(result.unwrap_err().message, "tombstone body must be null");
    }

    #[test]
    fn coverage_preserves_middle_gap() {
        let chat = json!({ "platform": "p", "account": "a", "chat_id": "c" });
        let result = build_coverage(&json!({
            "target": { "chat": chat, "interval": { "from_ts": 0, "to_ts": 100 } },
            "covered": [
                { "chat": chat, "interval": { "from_ts": 0, "to_ts": 25 }, "kind": "backfill", "collected_at": 1, "mutations_verified_at": null },
                { "chat": chat, "interval": { "from_ts": 75, "to_ts": 100 }, "kind": "watch", "collected_at": 2, "mutations_verified_at": 3 }
            ],
            "limits": []
        })).unwrap();
        assert_eq!(
            result["gaps"],
            json!([{ "interval": { "from_ts": 25.0, "to_ts": 75.0 }, "reason": "unknown" }])
        );
    }
}
