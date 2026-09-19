//! Frozen inboxd JSON-lines and provider-worker protocol.
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{error::Error, fmt};

pub const MAX_CLIENT_FRAME_BYTES: usize = 65_536;
pub const MAX_WORKER_FRAME_BYTES: usize = 16_777_216;
pub const MAX_CURSOR_BYTES: usize = 4_096;
const MAX_SAFE_NUMBER: f64 = 9_007_199_254_740_991.0;

pub fn validate_local_attachment(value: &Value) -> Result<()> {
    let file = object(value, "attachment")?;
    exact_keys(file, &["path", "name", "size", "sha256"], "attachment")?;
    let path = bounded_utf8_string(file.get("path"), "file path", 4096)?;
    let name = bounded_utf8_string(file.get("name"), "file name", 255)?;
    let invalid = |s: &str| s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}');
    if !path.starts_with('/')
        || invalid(path)
        || invalid(name)
        || name.contains(['/', '\\'])
        || matches!(name, "." | "..")
    {
        return Err(ProtocolError::bad_request("invalid attachment path/name"));
    }
    if !file
        .get("size")
        .and_then(Value::as_f64)
        .is_some_and(|n| n.fract() == 0.0 && (1.0..=104857600.0).contains(&n))
    {
        return Err(ProtocolError::bad_request(
            "attachment must be 1 byte to 100 MiB",
        ));
    }
    if !file.get("sha256").and_then(Value::as_str).is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    }) {
        return Err(ProtocolError::bad_request("invalid attachment digest"));
    }
    Ok(())
}

pub const LEGACY_REQUEST_METHODS: [&str; 21] = [
    "system.hello",
    "system.ping",
    "system.status",
    "chat.list",
    "message.inbox",
    "message.recent",
    "message.evidence",
    "message.get",
    "message.search",
    "sync.status",
    "sync.backfill",
    "auth.status",
    "safety.intent.create",
    "safety.intent.listPending",
    "safety.intent.claimApprovalCode",
    "safety.intent.approve",
    "safety.intent.reject",
    "send.status",
    "settings.get",
    "settings.update",
    "subscribe",
];

pub const REQUEST_METHODS: [&str; 23] = [
    "system.hello",
    "system.ping",
    "system.status",
    "chat.list",
    "message.inbox",
    "message.recent",
    "message.evidence",
    "message.get",
    "message.search",
    "sync.status",
    "sync.backfill",
    "auth.status",
    "safety.intent.listPending",
    "safety.intent.reject",
    "send.status",
    "settings.get",
    "settings.update",
    "subscribe",
    "capability.list",
    "account.list",
    "account.messages",
    "account.search",
    "message.send",
];

pub const EVENT_METHODS: [&str; 5] = [
    "message.upserted",
    "coverage.changed",
    "account.changed",
    "safety.intent.changed",
    "capability.changed",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
}

impl ProtocolError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            code: "BAD_REQUEST".into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for ProtocolError {}

type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientRole {
    Reader,
    Agent,
    Mcp,
    Approver,
    Sender,
}

impl ClientRole {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "reader" => Ok(Self::Reader),
            "agent" => Ok(Self::Agent),
            "mcp" => Ok(Self::Mcp),
            "approver" => Ok(Self::Approver),
            "sender" => Ok(Self::Sender),
            _ => Err(ProtocolError::bad_request(format!(
                "unknown client role: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolRequest {
    pub id: String,
    pub method: String,
    pub params: Map<String, Value>,
}

pub fn parse_request(value: &Value, role: Option<ClientRole>) -> Result<ProtocolRequest> {
    let frame = object(value, "request")?;
    if frame.get("type").and_then(Value::as_str) != Some("request") {
        return Err(ProtocolError::bad_request("frame must be a request"));
    }
    let id = non_empty(frame.get("id"), "request id")?.to_owned();
    let method = non_empty(frame.get("method"), "request method")?;
    if !REQUEST_METHODS.contains(&method) {
        return Err(ProtocolError::bad_request(format!(
            "unknown request method: {method}"
        )));
    }
    if role.is_some_and(|role| {
        role != ClientRole::Approver
            && !(role == ClientRole::Sender
                && matches!(method, "safety.intent.listPending" | "safety.intent.reject"))
    }) && matches!(
        method,
        "safety.intent.listPending"
            | "safety.intent.claimApprovalCode"
            | "safety.intent.approve"
            | "safety.intent.reject"
    ) {
        return Err(ProtocolError::bad_request(format!(
            "{method} requires an approver role"
        )));
    }
    let params = object(
        frame.get("params").unwrap_or(&Value::Null),
        "request params",
    )?
    .clone();
    if method == "system.hello" {
        let declared = ClientRole::parse(non_empty(params.get("role"), "role")?)?;
        if let Some(token) = params.get("approver_token") {
            if declared != ClientRole::Approver {
                return Err(ProtocolError::bad_request(
                    "approver token may only be supplied by an approver",
                ));
            }
            let token = non_empty(Some(token), "approver token")?;
            if token.len() > 4_096 {
                return Err(ProtocolError::bad_request("approver token is too long"));
            }
        }
    }
    if method == "message.send"
        && role.is_some_and(|role| !matches!(role, ClientRole::Approver | ClientRole::Sender))
    {
        return Err(ProtocolError::bad_request(
            "send requires authenticated sender role",
        ));
    }
    if let Some(token) = params.get("sender_token") {
        if method != "system.hello"
            || params["role"] != "sender"
            || token
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 4096)
        {
            return Err(ProtocolError::bad_request(
                "sender token may only be supplied in sender hello",
            ));
        }
    }
    Ok(ProtocolRequest {
        id,
        method: method.to_owned(),
        params,
    })
}

pub fn encode_json_line(value: &Value, maximum: usize) -> Result<String> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|_| ProtocolError::bad_request("frame must be JSON serializable"))?;
    bytes.push(b'\n');
    if bytes.len() > maximum {
        return Err(ProtocolError::bad_request(format!(
            "frame exceeds {maximum} bytes"
        )));
    }
    String::from_utf8(bytes).map_err(|_| ProtocolError::bad_request("frame must be valid UTF-8"))
}

#[derive(Debug)]
pub struct JsonLinesDecoder {
    maximum: usize,
    buffer: Vec<u8>,
}

impl JsonLinesDecoder {
    pub fn new(maximum: usize) -> Result<Self> {
        if maximum == 0 {
            return Err(ProtocolError::bad_request("frame limit must be positive"));
        }
        Ok(Self {
            maximum,
            buffer: Vec::new(),
        })
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>> {
        self.buffer.extend_from_slice(chunk);
        let mut values = Vec::new();
        while let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = self.buffer.drain(..=index).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                return Err(ProtocolError::bad_request("empty JSON line"));
            }
            if line.len() > self.maximum {
                return Err(ProtocolError::bad_request(format!(
                    "frame exceeds {} bytes",
                    self.maximum
                )));
            }
            let text = std::str::from_utf8(&line)
                .map_err(|_| ProtocolError::bad_request("frame must be valid UTF-8"))?;
            values.push(
                serde_json::from_str(text)
                    .map_err(|_| ProtocolError::bad_request("frame must contain valid JSON"))?,
            );
        }
        if self.buffer.len() > self.maximum {
            return Err(ProtocolError::bad_request(format!(
                "frame exceeds {} bytes",
                self.maximum
            )));
        }
        Ok(values)
    }
}

pub fn validate_worker_request_frame(frame: &[u8]) -> Result<Value> {
    let value = parse_raw_worker_frame(frame, "worker request frame", MAX_WORKER_FRAME_BYTES)?;
    validate_worker_request(&value)?;
    Ok(value)
}

pub fn validate_worker_response_frame(frame: &[u8], request: &Value) -> Result<Value> {
    validate_worker_request(request)?;
    let maximum = request
        .pointer("/limits/max_response_bytes")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| ProtocolError::bad_request("invalid max_response_bytes"))?;
    let response = parse_raw_worker_frame(frame, "worker response frame", maximum)?;
    validate_worker_response(&response, request)?;
    Ok(response)
}

fn parse_raw_worker_frame(frame: &[u8], label: &str, maximum: usize) -> Result<Value> {
    if frame.len() > maximum {
        return Err(ProtocolError::bad_request(format!(
            "{label} exceeds the {maximum} byte frame limit"
        )));
    }
    let text = std::str::from_utf8(frame)
        .map_err(|_| ProtocolError::bad_request(format!("{label} must be valid UTF-8")))?;
    if text.contains(['\n', '\r']) {
        return Err(ProtocolError::bad_request(format!(
            "{label} must be one JSON line without a line terminator"
        )));
    }
    serde_json::from_str(text)
        .map_err(|_| ProtocolError::bad_request(format!("{label} must contain valid JSON")))
}

fn validate_worker_request(request: &Value) -> Result<()> {
    let request = object(request, "worker request")?;
    exact_keys(
        request,
        &[
            "v",
            "type",
            "request_id",
            "generation",
            "binding_id",
            "limits",
            "operation",
        ],
        "worker request",
    )?;
    if request.get("v") != Some(&json!(1))
        || request.get("type").and_then(Value::as_str) != Some("worker_request")
    {
        return Err(ProtocolError::bad_request(
            "worker request must be a version 1 worker_request",
        ));
    }
    bounded_string(request.get("request_id"), "worker request_id", 512)?;
    positive_integer(request.get("generation"), "worker generation", u64::MAX)?;
    bounded_string(request.get("binding_id"), "worker binding_id", 512)?;
    let limits = object(
        request.get("limits").unwrap_or(&Value::Null),
        "worker limits",
    )?;
    exact_keys(
        limits,
        &["timeout_ms", "max_response_bytes", "max_queue_depth"],
        "worker limits",
    )?;
    positive_integer(limits.get("timeout_ms"), "worker timeout_ms", 300_000)?;
    positive_integer(
        limits.get("max_response_bytes"),
        "worker max_response_bytes",
        MAX_WORKER_FRAME_BYTES as u64,
    )?;
    positive_integer(
        limits.get("max_queue_depth"),
        "worker max_queue_depth",
        1_024,
    )?;
    validate_worker_operation(request.get("operation").unwrap_or(&Value::Null))
}

fn validate_worker_operation(value: &Value) -> Result<()> {
    let operation = object(value, "worker operation")?;
    match operation.get("op").and_then(Value::as_str) {
        Some("read_page") => {
            exact_keys(
                operation,
                &["op", "chat", "interval", "limit", "cursor"],
                "read_page operation",
            )?;
            validate_chat_ref(operation.get("chat").unwrap_or(&Value::Null))?;
            validate_interval(operation.get("interval").unwrap_or(&Value::Null))?;
            positive_integer(operation.get("limit"), "read_page limit", 100)?;
            if let Some(cursor) = operation.get("cursor").filter(|value| !value.is_null()) {
                bounded_utf8_string(Some(cursor), "read_page cursor", MAX_CURSOR_BYTES)?;
            }
        }
        Some("send") => {
            exact_keys(
                operation,
                &["op", "envelope", "idempotency_key"],
                "send operation",
            )?;
            validate_send_envelope(operation.get("envelope").unwrap_or(&Value::Null))?;
            let digest = non_empty(operation.get("idempotency_key"), "send idempotency_key")?;
            if digest.len() != 64
                || !digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(ProtocolError::bad_request(
                    "send idempotency_key must be a lowercase SHA-256 digest",
                ));
            }
        }
        Some("read_receipt") => {
            exact_keys(
                operation,
                &["op", "destination", "receipt_id", "expected"],
                "read_receipt operation",
            )?;
            validate_chat_ref(operation.get("destination").unwrap_or(&Value::Null))?;
            bounded_string(
                operation.get("receipt_id"),
                "read_receipt receipt_id",
                4_096,
            )?;
            validate_send_envelope(operation.get("expected").unwrap_or(&Value::Null))?;
            if operation.get("destination")
                != operation
                    .get("expected")
                    .and_then(|value| value.get("destination"))
            {
                return Err(ProtocolError::bad_request(
                    "read_receipt destination must match the expected send destination",
                ));
            }
        }
        Some("health") => exact_keys(operation, &["op"], "health operation")?,
        _ => {
            return Err(ProtocolError::bad_request(
                "worker operation must be read_page, send, read_receipt, or health",
            ));
        }
    }
    Ok(())
}

fn validate_worker_response(response: &Value, request: &Value) -> Result<()> {
    let response = object(response, "worker response")?;
    exact_keys(
        response,
        &[
            "v",
            "type",
            "request_id",
            "generation",
            "operation",
            "ok",
            "result",
            "error",
        ],
        "worker response",
    )?;
    if response.get("v") != Some(&json!(1))
        || response.get("type").and_then(Value::as_str) != Some("worker_response")
    {
        return Err(ProtocolError::bad_request(
            "worker response must be a version 1 worker_response",
        ));
    }
    for (response_key, request_pointer) in [
        ("request_id", "/request_id"),
        ("generation", "/generation"),
        ("operation", "/operation/op"),
    ] {
        if response.get(response_key) != request.pointer(request_pointer) {
            return Err(ProtocolError::bad_request(format!(
                "worker response {response_key} does not match the request"
            )));
        }
    }
    let operation = non_empty(response.get("operation"), "worker response operation")?;
    match response.get("ok").and_then(Value::as_bool) {
        Some(true) => {
            if response.contains_key("error") || !response.contains_key("result") {
                return Err(ProtocolError::bad_request(
                    "successful worker response requires only result",
                ));
            }
            validate_worker_result(
                operation,
                response.get("result").unwrap_or(&Value::Null),
                request,
            )?;
        }
        Some(false) => {
            if response.contains_key("result") {
                return Err(ProtocolError::bad_request(
                    "failed worker response must not contain result",
                ));
            }
            let error = object(
                response.get("error").unwrap_or(&Value::Null),
                "worker response error",
            )?;
            exact_keys(
                error,
                &["code", "message", "retryable", "may_have_sent"],
                "worker response error",
            )?;
            bounded_string(error.get("code"), "worker error code", 256)?;
            bounded_string(error.get("message"), "worker error message", 4_096)?;
            let retryable = error
                .get("retryable")
                .and_then(Value::as_bool)
                .ok_or_else(|| ProtocolError::bad_request("retryable must be boolean"))?;
            let may_have_sent = error
                .get("may_have_sent")
                .and_then(Value::as_bool)
                .ok_or_else(|| ProtocolError::bad_request("may_have_sent must be boolean"))?;
            if may_have_sent && operation != "send" {
                return Err(ProtocolError::bad_request(
                    "may_have_sent is valid only for send failures",
                ));
            }
            if may_have_sent && retryable {
                return Err(ProtocolError::bad_request(
                    "a possibly sent operation must not be marked retryable",
                ));
            }
        }
        None => {
            return Err(ProtocolError::bad_request(
                "worker response ok must be boolean",
            ));
        }
    }
    Ok(())
}

fn validate_worker_result(operation: &str, value: &Value, request: &Value) -> Result<()> {
    let result = object(value, "worker result")?;
    match operation {
        "read_page" => {
            exact_keys(
                result,
                &["items", "next_cursor", "authoritative"],
                "read_page worker result",
            )?;
            let items = result
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| ProtocolError::bad_request("read_page items must be an array"))?;
            let limit = request
                .pointer("/operation/limit")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            if items.len() > limit || items.iter().any(|item| !item.is_object()) {
                return Err(ProtocolError::bad_request(
                    "read_page items exceed the requested limit",
                ));
            }
            if let Some(cursor) = result.get("next_cursor").filter(|value| !value.is_null()) {
                bounded_utf8_string(Some(cursor), "read_page next_cursor", MAX_CURSOR_BYTES)?;
            }
            if !result.get("authoritative").is_some_and(Value::is_boolean) {
                return Err(ProtocolError::bad_request(
                    "read_page authoritative must be boolean",
                ));
            }
        }
        "send" => match result.get("outcome").and_then(Value::as_str) {
            Some("sent") => {
                exact_keys(result, &["outcome", "receipt_id"], "sent worker result")?;
                bounded_string(result.get("receipt_id"), "send receipt_id", 4_096)?;
            }
            Some("failed" | "uncertain") => {
                exact_keys(result, &["outcome", "reason"], "send worker result")?;
                bounded_string(result.get("reason"), "send reason", 4_096)?;
            }
            _ => {
                return Err(ProtocolError::bad_request(
                    "send worker outcome must be sent, failed, or uncertain",
                ));
            }
        },
        "read_receipt" => match result.get("outcome").and_then(Value::as_str) {
            Some("verified") => {
                exact_keys(result, &["outcome", "evidence"], "verified receipt result")?;
                let evidence = object(
                    result.get("evidence").unwrap_or(&Value::Null),
                    "receipt evidence",
                )?;
                if evidence.get("receipt_id") != request.pointer("/operation/receipt_id")
                    || evidence.get("destination")
                        != request.pointer("/operation/expected/destination")
                    || evidence.get("content") != request.pointer("/operation/expected/content")
                    || evidence.get("reply") != request.pointer("/operation/expected/reply")
                {
                    return Err(ProtocolError::bad_request(
                        "receipt evidence does not match the request",
                    ));
                }
            }
            Some("not_found") => exact_keys(result, &["outcome"], "not_found receipt result")?,
            Some("unavailable") => {
                exact_keys(result, &["outcome", "reason"], "unavailable receipt result")?;
                bounded_string(result.get("reason"), "receipt unavailable reason", 4_096)?;
            }
            _ => {
                return Err(ProtocolError::bad_request(
                    "read_receipt worker outcome is invalid",
                ));
            }
        },
        "health" => {
            exact_keys(result, &["state", "auth"], "health worker result")?;
            if !matches!(
                result.get("state").and_then(Value::as_str),
                Some("ready" | "degraded" | "unavailable")
            ) {
                return Err(ProtocolError::bad_request("health worker state is invalid"));
            }
            validate_auth(result.get("auth").unwrap_or(&Value::Null))?;
        }
        _ => return Err(ProtocolError::bad_request("unknown worker operation")),
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct NormalizedWorkerPage {
    pub mode: String,
    pub chat: Value,
    pub interval: Value,
    pub messages: Vec<Value>,
    pub tombstones: Vec<Value>,
    pub identity: Value,
    pub unread: Value,
    pub coverage: Vec<Value>,
    pub limits: Vec<Value>,
    pub next_cursor: Value,
    pub authoritative: bool,
    pub observed_at: f64,
}

impl NormalizedWorkerPage {
    pub fn into_apply_sync_batch(self, expected_page_sequence: u64) -> Result<Value> {
        let chat_key = chat_key(&self.chat)?;
        let mut events = self.messages;
        events.extend(self.tombstones);
        let mut identity = self.identity;
        if let Some(object) = identity.as_object_mut() {
            object.remove("chat");
            object.insert("platform".into(), chat_key["platform"].clone());
            object.insert("account".into(), chat_key["account"].clone());
        }
        Ok(json!({
            "events": events,
            "coverage": self.coverage,
            "limits": self.limits,
            "expected_page_sequence": expected_page_sequence,
            "sync": {
                "chat": chat_key,
                "cursor": self.next_cursor,
                "updated_at": self.observed_at,
            },
            "identity": identity,
            "unread": self.unread,
        }))
    }
}

pub fn validate_normalized_worker_page(
    page: &Value,
    request: &Value,
) -> Result<NormalizedWorkerPage> {
    validate_worker_request(request)?;
    if request.pointer("/operation/op").and_then(Value::as_str) != Some("read_page") {
        return Err(ProtocolError::bad_request(
            "normalized page requires a read_page request",
        ));
    }
    let page = object(page, "normalized worker page")?;
    exact_keys(
        page,
        &[
            "v",
            "mode",
            "chat",
            "interval",
            "messages",
            "tombstones",
            "identity",
            "unread",
            "coverage",
            "limits",
            "next_cursor",
            "authoritative",
            "observed_at",
        ],
        "normalized worker page",
    )?;
    if page.get("v") != Some(&json!(1))
        || page.get("mode").and_then(Value::as_str) != Some("bounded_history")
    {
        return Err(ProtocolError::bad_request(
            "normalized worker page must be bounded_history v1",
        ));
    }
    let requested_chat = request.pointer("/operation/chat").unwrap_or(&Value::Null);
    let requested_interval = request
        .pointer("/operation/interval")
        .unwrap_or(&Value::Null);
    require_chat_match(page.get("chat"), requested_chat, "page chat")?;
    if page.get("interval") != Some(requested_interval) {
        return Err(ProtocolError::bad_request(
            "page interval must match the request",
        ));
    }
    let (requested_from, requested_to) = validate_interval(requested_interval)?;
    validate_interval(page.get("interval").unwrap_or(&Value::Null))?;
    let messages = array(page.get("messages"), "messages")?.clone();
    let requested_limit = request
        .pointer("/operation/limit")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| ProtocolError::bad_request("read_page limit is invalid"))?;
    if messages.len() > requested_limit {
        return Err(ProtocolError::bad_request(
            "normalized messages exceed the requested limit",
        ));
    }
    let tombstones = array(page.get("tombstones"), "tombstones")?.clone();
    let requested_key = chat_key(requested_chat)?;
    for (index, event) in messages.iter().enumerate() {
        let event = object(event, "message event")?;
        if event.get("kind").and_then(Value::as_str) != Some("create") {
            return Err(ProtocolError::bad_request(format!(
                "message event {index} must be create"
            )));
        }
        require_chat_key_match(
            event.get("message").and_then(|value| value.get("key")),
            &requested_key,
            "message scope",
        )?;
        let timestamp = event
            .get("message")
            .and_then(|value| value.get("ts"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && value.abs() <= MAX_SAFE_NUMBER)
            .ok_or_else(|| {
                ProtocolError::bad_request(format!(
                    "message event {index} timestamp must be a finite safe number"
                ))
            })?;
        if timestamp < requested_from || timestamp >= requested_to {
            return Err(ProtocolError::bad_request(format!(
                "message event {index} timestamp is outside the requested interval"
            )));
        }
    }
    for tombstone in &tombstones {
        let event = object(tombstone, "tombstone event")?;
        if event.get("kind").and_then(Value::as_str) != Some("delete") {
            return Err(ProtocolError::bad_request("tombstone event must be delete"));
        }
        require_chat_key_match(
            event.get("tombstone").and_then(|value| value.get("key")),
            &requested_key,
            "tombstone scope",
        )?;
    }
    let identity = page
        .get("identity")
        .ok_or_else(|| ProtocolError::bad_request("identity is required"))?
        .clone();
    require_chat_key_match(identity.get("chat"), &requested_key, "identity scope")?;
    validate_identity(&identity)?;
    let unread = page
        .get("unread")
        .ok_or_else(|| ProtocolError::bad_request("unread is required"))?
        .clone();
    require_chat_key_match(unread.get("chat"), &requested_key, "unread scope")?;
    validate_unread(&unread)?;
    let coverage = array(page.get("coverage"), "coverage")?.clone();
    for segment in &coverage {
        require_chat_key_match(segment.get("chat"), &requested_key, "coverage scope")?;
        let interval = segment.get("interval").unwrap_or(&Value::Null);
        validate_interval(interval)?;
        if !interval_within(interval, requested_interval)? {
            return Err(ProtocolError::bad_request(
                "coverage interval exceeds the requested interval",
            ));
        }
    }
    let limits = array(page.get("limits"), "limits")?.clone();
    for limit in &limits {
        require_chat_key_match(limit.get("chat"), &requested_key, "limit scope")?;
        let interval = limit.get("interval").unwrap_or(&Value::Null);
        validate_interval(interval)?;
        if !interval_within(interval, requested_interval)? {
            return Err(ProtocolError::bad_request(
                "limit interval exceeds the requested interval",
            ));
        }
    }
    let next_cursor = page
        .get("next_cursor")
        .ok_or_else(|| ProtocolError::bad_request("next_cursor is required"))?
        .clone();
    if !next_cursor.is_null() {
        bounded_utf8_string(Some(&next_cursor), "next_cursor", MAX_CURSOR_BYTES)?;
    }
    let authoritative = page
        .get("authoritative")
        .and_then(Value::as_bool)
        .ok_or_else(|| ProtocolError::bad_request("authoritative must be boolean"))?;
    let observed_at = page
        .get("observed_at")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| ProtocolError::bad_request("observed_at must be finite"))?;
    Ok(NormalizedWorkerPage {
        mode: "bounded_history".into(),
        chat: page["chat"].clone(),
        interval: page["interval"].clone(),
        messages,
        tombstones,
        identity,
        unread,
        coverage,
        limits,
        next_cursor,
        authoritative,
        observed_at,
    })
}

fn validate_identity(value: &Value) -> Result<()> {
    let identity = object(value, "identity")?;
    let status = identity.get("status").and_then(Value::as_str);
    let source = identity.get("source").and_then(Value::as_str);
    match (status, source) {
        (Some("known"), Some("authenticated_adapter")) => {
            non_empty(identity.get("self_id"), "identity self_id")?;
        }
        (Some("unknown"), Some("unknown")) => {
            if identity.contains_key("self_id")
                || !matches!(
                    identity.get("reason").and_then(Value::as_str),
                    Some("unsupported" | "unavailable")
                )
            {
                return Err(ProtocolError::bad_request("invalid unknown identity"));
            }
        }
        _ => return Err(ProtocolError::bad_request("invalid identity evidence")),
    }
    finite_non_negative(identity.get("observed_at"), "identity observed_at")?;
    Ok(())
}

fn validate_unread(value: &Value) -> Result<()> {
    let unread = object(value, "unread")?;
    match (
        unread.get("status").and_then(Value::as_str),
        unread.get("source").and_then(Value::as_str),
    ) {
        (Some("known"), Some("platform" | "local_estimate")) => {
            unread
                .get("count")
                .and_then(Value::as_u64)
                .ok_or_else(|| ProtocolError::bad_request("unread count must be non-negative"))?;
        }
        (Some("unknown"), Some("unknown"))
            if unread.get("count").is_some_and(Value::is_null)
                && matches!(
                    unread.get("reason").and_then(Value::as_str),
                    Some("unsupported" | "unavailable")
                ) => {}
        _ => return Err(ProtocolError::bad_request("invalid unread evidence")),
    }
    finite_non_negative(unread.get("observed_at"), "unread observed_at")?;
    Ok(())
}

fn validate_auth(value: &Value) -> Result<()> {
    let auth = object(value, "auth")?;
    exact_keys(auth, &["state", "reason", "observed_at"], "auth")?;
    let state = auth.get("state").and_then(Value::as_str);
    if !matches!(state, Some("authenticated" | "unauthenticated" | "unknown")) {
        return Err(ProtocolError::bad_request("invalid auth state"));
    }
    let reason = auth.get("reason").unwrap_or(&Value::Null);
    if state == Some("authenticated") {
        if !reason.is_null() {
            return Err(ProtocolError::bad_request(
                "authenticated auth reason must be null",
            ));
        }
    } else {
        non_empty(Some(reason), "auth reason")?;
    }
    finite_non_negative(auth.get("observed_at"), "auth observed_at")?;
    Ok(())
}

pub fn validate_send_envelope(value: &Value) -> Result<()> {
    let envelope = object(value, "send envelope")?;
    if envelope.get("v") != Some(&json!(2)) {
        return Err(ProtocolError::bad_request(
            "send envelope version must be 2",
        ));
    }
    if envelope
        .keys()
        .any(|key| !matches!(key.as_str(), "v" | "destination" | "content" | "reply"))
    {
        return Err(ProtocolError::bad_request("unknown send envelope field"));
    }
    if let Some(reply) = envelope.get("reply") {
        let reply = object(reply, "send reply")?;
        exact_keys(reply, &["parent_id"], "send reply")?;
        bounded_utf8_string(reply.get("parent_id"), "parent id", 4096)?;
    }
    let destination = object(
        envelope.get("destination").unwrap_or(&Value::Null),
        "send destination",
    )?;
    match destination.get("kind").and_then(Value::as_str) {
        Some("chat") => validate_chat_ref(&Value::Object(destination.clone()))?,
        Some("destination") => {
            exact_keys(
                destination,
                &["v", "kind", "platform", "account", "destination_id"],
                "destination ref",
            )?;
            if destination.get("v") != Some(&json!(1)) {
                return Err(ProtocolError::bad_request(
                    "destination ref version must be 1",
                ));
            }
            for key in ["platform", "account", "destination_id"] {
                non_empty(destination.get(key), key)?;
            }
        }
        _ => return Err(ProtocolError::bad_request("invalid send destination")),
    }
    let content = object(
        envelope.get("content").unwrap_or(&Value::Null),
        "send content",
    )?;
    match content.get("mode").and_then(Value::as_str) {
        Some("text") => {
            exact_keys(content, &["mode", "body"], "text content")?;
            bounded_utf8_string(content.get("body"), "send body", 65_536)?;
            if destination.get("kind").and_then(Value::as_str) != Some("chat") {
                return Err(ProtocolError::bad_request(
                    "text sends require a chat destination",
                ));
            }
        }
        Some("approved_template") => {
            exact_keys(
                content,
                &["mode", "template_id", "preview", "arguments"],
                "template content",
            )?;
            if envelope.get("reply").is_some() {
                return Err(ProtocolError::bad_request("template replies unsupported"));
            }
            bounded_utf8_string(content.get("template_id"), "template id", 1_024)?;
            bounded_utf8_string(content.get("preview"), "template preview", 65_536)?;
            object(
                content.get("arguments").unwrap_or(&Value::Null),
                "template arguments",
            )?;
            if destination.get("kind").and_then(Value::as_str) != Some("destination") {
                return Err(ProtocolError::bad_request(
                    "template sends require a destination resource",
                ));
            }
        }
        _ => return Err(ProtocolError::bad_request("invalid send content")),
    }
    Ok(())
}

fn validate_chat_ref(value: &Value) -> Result<()> {
    let chat = object(value, "chat ref")?;
    exact_keys(
        chat,
        &["v", "kind", "platform", "account", "chat_id"],
        "chat ref",
    )?;
    if chat.get("v") != Some(&json!(1)) || chat.get("kind").and_then(Value::as_str) != Some("chat")
    {
        return Err(ProtocolError::bad_request(
            "chat ref must be a version 1 chat",
        ));
    }
    for key in ["platform", "account", "chat_id"] {
        non_empty(chat.get(key), key)?;
    }
    Ok(())
}

fn chat_key(value: &Value) -> Result<Value> {
    let chat = object(value, "chat")?;
    Ok(json!({
        "platform": non_empty(chat.get("platform"), "platform")?,
        "account": non_empty(chat.get("account"), "account")?,
        "chat_id": non_empty(chat.get("chat_id"), "chat_id")?,
    }))
}

fn require_chat_match(candidate: Option<&Value>, expected: &Value, label: &str) -> Result<()> {
    let candidate =
        candidate.ok_or_else(|| ProtocolError::bad_request(format!("{label} is required")))?;
    if candidate != expected {
        return Err(ProtocolError::bad_request(format!(
            "{label} must match the request"
        )));
    }
    validate_chat_ref(candidate)
}

fn require_chat_key_match(candidate: Option<&Value>, expected: &Value, label: &str) -> Result<()> {
    let candidate =
        candidate.ok_or_else(|| ProtocolError::bad_request(format!("{label} is required")))?;
    if chat_key(candidate)? != *expected {
        return Err(ProtocolError::bad_request(format!(
            "{label} must match the request"
        )));
    }
    Ok(())
}

fn validate_interval(value: &Value) -> Result<(f64, f64)> {
    let interval = object(value, "interval")?;
    let from = interval
        .get("from_ts")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && value.abs() <= MAX_SAFE_NUMBER)
        .ok_or_else(|| ProtocolError::bad_request("from_ts must be a finite safe number"))?;
    let to = interval
        .get("to_ts")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && value.abs() <= MAX_SAFE_NUMBER)
        .ok_or_else(|| ProtocolError::bad_request("to_ts must be a finite safe number"))?;
    if from >= to {
        return Err(ProtocolError::bad_request("from_ts must precede to_ts"));
    }
    Ok((from, to))
}

fn interval_within(candidate: &Value, expected: &Value) -> Result<bool> {
    let (candidate_from, candidate_to) = validate_interval(candidate)?;
    let (expected_from, expected_to) = validate_interval(expected)?;
    Ok(candidate_from >= expected_from && candidate_to <= expected_to)
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| ProtocolError::bad_request(format!("{label} must be an object")))
}

fn array<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a Vec<Value>> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| ProtocolError::bad_request(format!("{label} must be an array")))
}

fn non_empty<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ProtocolError::bad_request(format!("{label} must be a non-empty string")))
}

fn bounded_string<'a>(value: Option<&'a Value>, label: &str, maximum: usize) -> Result<&'a str> {
    let value = non_empty(value, label)?;
    if value.chars().count() > maximum {
        return Err(ProtocolError::bad_request(format!("{label} is too long")));
    }
    Ok(value)
}

fn bounded_utf8_string<'a>(
    value: Option<&'a Value>,
    label: &str,
    maximum: usize,
) -> Result<&'a str> {
    let value = non_empty(value, label)?;
    if value.len() > maximum {
        return Err(ProtocolError::bad_request(format!(
            "{label} exceeds {maximum} UTF-8 bytes"
        )));
    }
    Ok(value)
}

fn positive_integer(value: Option<&Value>, label: &str, maximum: u64) -> Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= maximum)
        .ok_or_else(|| ProtocolError::bad_request(format!("{label} must be a positive integer")))
}

fn finite_non_negative(value: Option<&Value>, label: &str) -> Result<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| {
            ProtocolError::bad_request(format!("{label} must be non-negative and finite"))
        })
}

fn exact_keys(value: &Map<String, Value>, allowed: &[&str], label: &str) -> Result<()> {
    if value.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(ProtocolError::bad_request(format!(
            "{label} contains an unknown field"
        )));
    }
    Ok(())
}
