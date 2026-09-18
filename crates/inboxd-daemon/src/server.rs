use inboxd_protocol::{
    ClientRole, EVENT_METHODS, JsonLinesDecoder, MAX_CLIENT_FRAME_BYTES, ProtocolRequest,
    parse_request,
};
use inboxd_storage::{StorageActor, StorageOperation};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::{Notify, mpsc, oneshot},
    task::JoinSet,
};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{CapabilityRegistry, DaemonError, Result};

const DEFAULT_INTERVAL_END: u64 = 9_007_199_254_740_991;
const APPROVAL_TTL_MS: u64 = 15 * 60 * 1_000;

struct Subscriber {
    topics: Arc<Mutex<BTreeSet<String>>>,
    events: mpsc::Sender<Value>,
    closed: Arc<AtomicBool>,
    close_notify: Arc<Notify>,
}

#[derive(Default)]
pub(crate) struct EventHub {
    subscribers: Mutex<HashMap<String, Subscriber>>,
}

impl EventHub {
    fn register(
        &self,
        id: String,
        topics: Arc<Mutex<BTreeSet<String>>>,
        events: mpsc::Sender<Value>,
        closed: Arc<AtomicBool>,
        close_notify: Arc<Notify>,
    ) {
        self.subscribers.lock().unwrap().insert(
            id,
            Subscriber {
                topics,
                events,
                closed,
                close_notify,
            },
        );
    }

    fn unregister(&self, id: &str) {
        self.subscribers.lock().unwrap().remove(id);
    }

    pub(crate) fn publish(&self, method: &str, params: Value) -> Result<usize> {
        if !EVENT_METHODS.contains(&method) {
            return Err(DaemonError::new(format!(
                "unknown protocol event method: {method}"
            )));
        }
        if !params.is_object() {
            return Err(DaemonError::new("event params must be an object"));
        }
        let event = json!({"type":"event","method":method,"params":params});
        let mut overflowed = Vec::new();
        let mut disconnected = Vec::new();
        let mut subscribers = self.subscribers.lock().unwrap();
        for (id, subscriber) in subscribers.iter() {
            if !subscriber.topics.lock().unwrap().contains(method) {
                continue;
            }
            match subscriber.events.try_send(event.clone()) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    subscriber.closed.store(true, Ordering::Release);
                    subscriber.close_notify.notify_one();
                    overflowed.push(id.clone());
                }
                Err(mpsc::error::TrySendError::Closed(_)) => disconnected.push(id.clone()),
            }
        }
        for id in overflowed.iter().chain(&disconnected) {
            subscribers.remove(id);
        }
        Ok(overflowed.len())
    }
}

pub(crate) async fn run_server(
    listener: UnixListener,
    actor: Arc<StorageActor>,
    approver_token: Arc<Zeroizing<String>>,
    events: Arc<EventHub>,
    capabilities: Arc<CapabilityRegistry>,
    max_queued_events: usize,
    mut shutdown: oneshot::Receiver<()>,
) -> Arc<StorageActor> {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    let actor = Arc::clone(&actor);
                    let token = Arc::clone(&approver_token);
                    let events = Arc::clone(&events);
                    let capabilities = Arc::clone(&capabilities);
                    connections.spawn(async move {
                        handle_connection(
                            socket,
                            actor,
                            token,
                            events,
                            capabilities,
                            max_queued_events,
                        )
                        .await;
                    });
                }
                Err(_) => break,
            },
            _ = &mut shutdown => break,
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    actor
}

struct Session {
    id: String,
    role: Option<ClientRole>,
    trusted_approver: bool,
    topics: Arc<Mutex<BTreeSet<String>>>,
}

async fn handle_connection(
    mut socket: UnixStream,
    actor: Arc<StorageActor>,
    approver_token: Arc<Zeroizing<String>>,
    events: Arc<EventHub>,
    capabilities: Arc<CapabilityRegistry>,
    max_queued_events: usize,
) {
    let mut decoder = match JsonLinesDecoder::new(MAX_CLIENT_FRAME_BYTES) {
        Ok(decoder) => decoder,
        Err(_) => return,
    };
    let session_id = Uuid::new_v4().to_string();
    let topics = Arc::new(Mutex::new(BTreeSet::new()));
    let closed = Arc::new(AtomicBool::new(false));
    let close_notify = Arc::new(Notify::new());
    let (event_sender, mut event_receiver) = mpsc::channel(max_queued_events);
    events.register(
        session_id.clone(),
        Arc::clone(&topics),
        event_sender,
        Arc::clone(&closed),
        Arc::clone(&close_notify),
    );
    let mut session = Session {
        id: session_id.clone(),
        role: None,
        trusted_approver: false,
        topics,
    };
    let mut chunk = [0_u8; 8_192];
    'connection: loop {
        if closed.load(Ordering::Acquire) {
            break;
        }
        tokio::select! {
            biased;
            _ = close_notify.notified() => break,
            event = event_receiver.recv() => {
                let Some(event) = event else { break; };
                if write_frame(&mut socket, event).await.is_err() { break; }
            }
            received = socket.read(&mut chunk) => {
                let received = match received {
                    Ok(0) | Err(_) => break,
                    Ok(received) => received,
                };
                let frames = match decoder.push(&chunk[..received]) {
                    Ok(frames) => frames,
                    Err(error) => {
                        let _ = write_frame(
                            &mut socket,
                            failure("invalid", "system.ping", "BAD_REQUEST", &error.message),
                        ).await;
                        break;
                    }
                };
                for frame in frames {
                    let raw_id = frame.get("id").and_then(Value::as_str).unwrap_or("invalid").to_owned();
                    let raw_method = frame.get("method").and_then(Value::as_str).unwrap_or("system.ping").to_owned();
                    let request = match parse_request(&frame, session.role) {
                        Ok(request) => request,
                        Err(error) => {
                            if write_frame(&mut socket, failure(&raw_id, &raw_method, "BAD_REQUEST", &error.message)).await.is_err() {
                                break 'connection;
                            }
                            continue;
                        }
                    };
                    let response = match dispatch(
                        &mut session,
                        &actor,
                        &approver_token,
                        &events,
                        &capabilities,
                        &request,
                    )
                    .await
                    {
                        Ok(result) => success(&request.id, &request.method, result),
                        Err(error) => failure(&request.id, &request.method, error.code, &error.message),
                    };
                    if write_frame(&mut socket, response).await.is_err() {
                        break 'connection;
                    }
                }
            }
        }
    }
    events.unregister(&session_id);
    let _ = socket.shutdown().await;
}

struct RpcError {
    code: &'static str,
    message: String,
}

impl RpcError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            code: "BAD_REQUEST",
            message: message.into(),
        }
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: "UNSUPPORTED",
            message: message.into(),
        }
    }
}

type RpcResult = std::result::Result<Value, RpcError>;

fn object(value: Option<&Value>, label: &str) -> std::result::Result<Map<String, Value>, RpcError> {
    value
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| RpcError::bad_request(format!("{label} must be an object")))
}

fn string(value: Option<&Value>, label: &str) -> std::result::Result<String, RpcError> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RpcError::bad_request(format!("{label} must be a non-empty string")))
}

fn finite_number(value: Option<&Value>, label: &str) -> std::result::Result<f64, RpcError> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| RpcError::bad_request(format!("{label} must be a finite number")))
}

fn chat(params: &Map<String, Value>) -> std::result::Result<Value, RpcError> {
    let value = object(params.get("chat"), "chat")?;
    Ok(json!({
        "platform": string(value.get("platform"), "chat.platform")?,
        "account": string(value.get("account"), "chat.account")?,
        "chat_id": string(value.get("chat_id"), "chat.chat_id")?,
    }))
}

fn flat_chat(params: &Map<String, Value>) -> std::result::Result<Value, RpcError> {
    Ok(json!({
        "platform": string(params.get("platform"), "platform")?,
        "account": string(params.get("account"), "account")?,
        "chat_id": string(params.get("chat_id"), "chat_id")?,
    }))
}

fn interval(params: &Map<String, Value>) -> std::result::Result<Value, RpcError> {
    let Some(raw) = params.get("interval") else {
        return Ok(json!({"from_ts":0,"to_ts":DEFAULT_INTERVAL_END}));
    };
    let value = object(Some(raw), "interval")?;
    checked_interval(value.get("from_ts"), value.get("to_ts"), "interval")
}

fn flat_interval(params: &Map<String, Value>) -> std::result::Result<Value, RpcError> {
    checked_interval(params.get("from_ts"), params.get("to_ts"), "interval")
}

fn checked_interval(
    from: Option<&Value>,
    to: Option<&Value>,
    label: &str,
) -> std::result::Result<Value, RpcError> {
    let from = finite_number(from, &format!("{label}.from_ts"))?;
    let to = finite_number(to, &format!("{label}.to_ts"))?;
    if from >= to {
        return Err(RpcError::bad_request(format!(
            "{label}.from_ts must be before {label}.to_ts"
        )));
    }
    Ok(json!({"from_ts":from,"to_ts":to}))
}

fn page(params: &Map<String, Value>) -> std::result::Result<Map<String, Value>, RpcError> {
    let mut result = Map::new();
    if let Some(limit) = params.get("limit") {
        let limit = limit
            .as_u64()
            .filter(|value| (1..=100).contains(value))
            .ok_or_else(|| RpcError::bad_request("limit must be an integer from 1 to 100"))?;
        result.insert("limit".into(), json!(limit));
    }
    if let Some(cursor) = params.get("cursor") {
        let cursor = string(Some(cursor), "cursor")?;
        if cursor.len() > 4_096
            || !cursor
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(RpcError::bad_request("cursor is malformed"));
        }
        result.insert("cursor".into(), Value::String(cursor));
    }
    Ok(result)
}

fn actor_call(
    actor: &StorageActor,
    operation: StorageOperation,
    input: Value,
    bad_request_errors: bool,
) -> RpcResult {
    actor.call(operation, input).map_err(|error| {
        if bad_request_errors
            && matches!(
                error.name.as_str(),
                "BadRequestError" | "TypeError" | "RangeError" | "Error"
            )
        {
            RpcError::bad_request(error.message)
        } else {
            RpcError::unsupported(error.message)
        }
    })
}

fn role_value(role: Option<ClientRole>) -> Value {
    match role {
        Some(ClientRole::Reader) => json!("reader"),
        Some(ClientRole::Agent) => json!("agent"),
        Some(ClientRole::Mcp) => json!("mcp"),
        Some(ClientRole::Approver) => json!("approver"),
        None => Value::Null,
    }
}

fn audit_read(
    session: &Session,
    actor: &StorageActor,
    action: &str,
    subject: String,
    result_count: usize,
) -> std::result::Result<(), RpcError> {
    actor_call(
        actor,
        StorageOperation::AuditRead,
        json!({
            "action":action,
            "subject":subject,
            "role":role_value(session.role),
            "session_id":session.id,
            "result_count":result_count,
        }),
        false,
    )?;
    Ok(())
}

fn assert_trusted_approver(session: &Session) -> std::result::Result<(), RpcError> {
    if session.role != Some(ClientRole::Approver) {
        return Err(RpcError::unsupported("approver role is required"));
    }
    if !session.trusted_approver {
        return Err(RpcError::unsupported(
            "trusted local approver authorization is required",
        ));
    }
    Ok(())
}

fn publish_safety(events: &EventHub, actor: &StorageActor, intent_id: &str) {
    if let Ok(intent) = actor.call(
        StorageOperation::SafetyGetIntent,
        json!({"intent_id":intent_id}),
    ) {
        if let Some(state) = intent.get("state") {
            let _ = events.publish(
                "safety.intent.changed",
                json!({"intent_id":intent_id,"state":state}),
            );
        }
    }
}

async fn dispatch(
    session: &mut Session,
    actor: &StorageActor,
    approver_token: &str,
    events: &EventHub,
    capabilities: &CapabilityRegistry,
    request: &ProtocolRequest,
) -> RpcResult {
    if request.method == "system.hello" {
        let role = ClientRole::parse(
            request
                .params
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map_err(|error| RpcError::bad_request(error.message))?;
        session.role = Some(role);
        session.trusted_approver = role == ClientRole::Approver
            && token_matches(
                approver_token,
                request.params.get("approver_token").and_then(Value::as_str),
            );
        return Ok(json!({"protocol":"inboxd","ready":true}));
    }
    if session.role.is_none() {
        return Err(RpcError::unsupported(
            "system.hello is required before API requests",
        ));
    }
    match request.method.as_str() {
        "system.ping" => Ok(json!({"pong":true})),
        "system.status" => Ok(json!({"ready":true,"owner":"daemon"})),
        "chat.list" => {
            let input = Value::Object(page(&request.params)?);
            let found = actor_call(actor, StorageOperation::ChatList, input, true)?;
            let count = found["chats"].as_array().map_or(0, Vec::len);
            audit_read(session, actor, "read.chat_list", "all-chats".into(), count)?;
            Ok(found)
        }
        "message.recent" | "message.evidence" => {
            let operation = if request.method == "message.recent" {
                StorageOperation::RecentMessages
            } else {
                StorageOperation::RecentEvidence
            };
            let found = actor_call(
                actor,
                operation,
                Value::Object(request.params.clone()),
                true,
            )?;
            let field = if request.method == "message.recent" {
                "messages"
            } else {
                "evidence"
            };
            let count = found[field].as_array().map_or(0, Vec::len);
            let action = if request.method == "message.recent" {
                "read.recent"
            } else {
                "read.evidence"
            };
            let subject =
                serde_json::to_string(request.params.get("chats").unwrap_or(&Value::Null))
                    .unwrap_or_default();
            audit_read(session, actor, action, subject, count)?;
            Ok(found)
        }
        "message.inbox" | "message.search" => {
            let chat = chat(&request.params)?;
            let interval = interval(&request.params)?;
            let mut input = page(&request.params)?;
            input.insert("chat".into(), chat.clone());
            input.insert("interval".into(), interval.clone());
            if request.method == "message.search" {
                input.insert(
                    "query".into(),
                    Value::String(string(request.params.get("query"), "query")?),
                );
            }
            let scope = if request.method == "message.search" {
                json!({"chat":chat,"interval":interval,"query":input["query"]})
            } else {
                json!({"chat":chat,"interval":interval})
            };
            input.insert(
                "scope_codec".into(),
                Value::String(serde_json::to_string(&scope).unwrap_or_default()),
            );
            let operation = if request.method == "message.search" {
                StorageOperation::SearchMessages
            } else {
                StorageOperation::InboxMessages
            };
            let found = actor_call(actor, operation, Value::Object(input), true)?;
            let count = found["messages"].as_array().map_or(0, Vec::len);
            let key = format!(
                "{}\0{}\0{}",
                chat["platform"].as_str().unwrap_or_default(),
                chat["account"].as_str().unwrap_or_default(),
                chat["chat_id"].as_str().unwrap_or_default()
            );
            audit_read(
                session,
                actor,
                if request.method == "message.search" {
                    "read.search"
                } else {
                    "read.inbox"
                },
                key,
                count,
            )?;
            Ok(found)
        }
        "message.get" => {
            let chat = chat(&request.params)?;
            let key = json!({
                "platform":chat["platform"],
                "account":chat["account"],
                "chat_id":chat["chat_id"],
                "msg_id":string(request.params.get("msg_id"), "msg_id")?,
            });
            let message = actor_call(actor, StorageOperation::GetMessage, key.clone(), true)?;
            let subject = format!(
                "{}\0{}\0{}\0{}",
                key["platform"].as_str().unwrap_or_default(),
                key["account"].as_str().unwrap_or_default(),
                key["chat_id"].as_str().unwrap_or_default(),
                key["msg_id"].as_str().unwrap_or_default()
            );
            audit_read(
                session,
                actor,
                "read.message",
                subject,
                usize::from(!message.is_null()),
            )?;
            Ok(json!({"message":message}))
        }
        "sync.backfill" => {
            assert_trusted_approver(session)?;
            let _ = if request.params.contains_key("chat") {
                (chat(&request.params)?, interval(&request.params)?)
            } else {
                (flat_chat(&request.params)?, flat_interval(&request.params)?)
            };
            Err(RpcError::unsupported(
                "sync.backfill is unavailable because no adapter is configured",
            ))
        }
        "sync.status" => Ok(json!({"state":"idle"})),
        "auth.status" => Ok(json!({"authenticated":false})),
        "capability.list" => {
            if request.params.keys().any(|key| key != "refresh")
                || request
                    .params
                    .get("refresh")
                    .is_some_and(|value| !value.is_boolean())
            {
                return Err(RpcError::bad_request(
                    "capability.list params must be exactly {refresh?: boolean}",
                ));
            }
            if request.params.get("refresh") == Some(&Value::Bool(true)) {
                for binding_id in capabilities.refresh().await {
                    let _ = events.publish("capability.changed", json!({"binding_id":binding_id}));
                }
            }
            Ok(capabilities.list())
        }
        "safety.intent.create" => {
            let created = actor_call(
                actor,
                StorageOperation::SafetyPropose,
                json!({
                    "proposal":Value::Object(request.params.clone()),
                    "approval_ttl_ms":APPROVAL_TTL_MS,
                }),
                true,
            )?;
            if let Some(intent_id) = created.get("intent_id").and_then(Value::as_str) {
                publish_safety(events, actor, intent_id);
            }
            Ok(created)
        }
        "safety.intent.listPending" => {
            assert_trusted_approver(session)?;
            let found = actor_call(
                actor,
                StorageOperation::SafetyListPendingPage,
                Value::Object(page(&request.params)?),
                true,
            )?;
            let count = found["intents"].as_array().map_or(0, Vec::len);
            audit_read(
                session,
                actor,
                "read.safety_intent_list",
                "pending-intents".into(),
                count,
            )?;
            Ok(found)
        }
        "safety.intent.claimApprovalCode" => {
            assert_trusted_approver(session)?;
            let intent_id = string(request.params.get("intent_id"), "intent_id")?;
            let result = actor_call(
                actor,
                StorageOperation::SafetyClaimApprovalCode,
                json!({"intent_id":intent_id}),
                true,
            )?;
            if result.get("unavailable") == Some(&json!(true)) {
                publish_safety(events, actor, &intent_id);
            }
            Ok(result)
        }
        "safety.intent.approve" => {
            assert_trusted_approver(session)?;
            let intent_id = string(request.params.get("intent_id"), "intent_id")?;
            let approved = actor_call(
                actor,
                StorageOperation::SafetyApprove,
                Value::Object(request.params.clone()),
                false,
            )?;
            publish_safety(events, actor, &intent_id);
            Ok(approved)
        }
        "safety.intent.reject" => {
            assert_trusted_approver(session)?;
            let intent_id = string(request.params.get("intent_id"), "intent_id")?;
            let rejected = actor_call(
                actor,
                StorageOperation::SafetyReject,
                json!({"intent_id":intent_id}),
                false,
            )?;
            publish_safety(events, actor, &intent_id);
            Ok(rejected)
        }
        "send.status" => actor_call(
            actor,
            StorageOperation::SendStatus,
            json!({"id":string(request.params.get("id"), "id")?}),
            true,
        ),
        "subscribe" => {
            let topics = request
                .params
                .get("topics")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    RpcError::bad_request("subscribe topics must be protocol event methods")
                })?;
            let mut replacement = BTreeSet::new();
            for topic in topics {
                let topic = topic.as_str().filter(|topic| EVENT_METHODS.contains(topic));
                let Some(topic) = topic else {
                    return Err(RpcError::bad_request(
                        "subscribe topics must be protocol event methods",
                    ));
                };
                replacement.insert(topic.to_owned());
            }
            *session.topics.lock().unwrap() = replacement.clone();
            Ok(json!({"subscribed":replacement.into_iter().collect::<Vec<_>>()}))
        }
        "settings.get" | "settings.update" => Err(RpcError::unsupported(format!(
            "{} is unsupported by this daemon",
            request.method
        ))),
        _ => Err(RpcError::unsupported(format!(
            "{} is unsupported by this daemon",
            request.method
        ))),
    }
}

fn success(id: &str, method: &str, result: Value) -> Value {
    json!({"type":"response","id":id,"method":method,"ok":true,"result":result})
}

fn failure(id: &str, method: &str, code: &str, message: &str) -> Value {
    json!({"type":"response","id":id,"method":method,"ok":false,"error":{"code":code,"message":message}})
}

async fn write_frame(socket: &mut UnixStream, value: Value) -> std::io::Result<()> {
    let mut frame = serde_json::to_vec(&value).map_err(std::io::Error::other)?;
    frame.push(b'\n');
    socket.write_all(&frame).await
}

fn token_matches(expected: &str, supplied: Option<&str>) -> bool {
    let Some(supplied) = supplied else {
        return false;
    };
    expected.len() == supplied.len() && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}
