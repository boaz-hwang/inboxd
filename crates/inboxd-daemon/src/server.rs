use inboxd_protocol::{
    ClientRole, EVENT_METHODS, JsonLinesDecoder, MAX_CLIENT_FRAME_BYTES, ProtocolRequest,
    encode_json_line, parse_request,
};
use inboxd_storage::{StorageActor, StorageOperation};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
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

use crate::{CapabilityRegistry, DaemonError, Result, ServerOwner};

const DEFAULT_INTERVAL_END: u64 = 9_007_199_254_740_991;

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
        encode_json_line(&event, MAX_CLIENT_FRAME_BYTES)
            .map_err(|error| DaemonError::new(error.message))?;
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

pub(crate) struct ServerRuntime {
    pub(crate) accounts: Arc<crate::accounts::AccountService>,
    pub(crate) events: Arc<EventHub>,
    pub(crate) capabilities: Arc<CapabilityRegistry>,
    pub(crate) connection_tasks: Arc<AtomicUsize>,
    pub(crate) max_queued_events: usize,
}

pub(crate) async fn run_server(
    listener: UnixListener,
    owner: Arc<ServerOwner>,
    approver_token: Arc<Zeroizing<String>>,
    runtime: ServerRuntime,
    mut shutdown: oneshot::Receiver<()>,
) -> Arc<ServerOwner> {
    let mut live = runtime.accounts.start_live(Arc::clone(&runtime.events));
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            Some(_) = connections.join_next(), if !connections.is_empty() => {
                runtime.connection_tasks.store(connections.len(), Ordering::Release);
            }
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    let actor = Arc::clone(&owner.actor);
                    let token = Arc::clone(&approver_token);
                    let events = Arc::clone(&runtime.events);
                    let capabilities = Arc::clone(&runtime.capabilities);
                    let accounts = Arc::clone(&runtime.accounts);
                    let max_queued_events = runtime.max_queued_events;
                    connections.spawn(async move {
                        handle_connection(
                            socket,
                            actor,
                            token,
                            events,
                            capabilities,
                            max_queued_events,
                            accounts,
                        )
                        .await;
                    });
                    runtime.connection_tasks.store(connections.len(), Ordering::Release);
                }
                Err(_) => break,
            },
            _ = &mut shutdown => break,
        }
    }
    live.abort_all();
    while live.join_next().await.is_some() {}
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    runtime.accounts.stop_live().await;
    runtime.connection_tasks.store(0, Ordering::Release);
    owner
}

struct Session {
    id: String,
    role: Option<ClientRole>,
    trusted_approver: bool,
    trusted_sender: bool,
    topics: Arc<Mutex<BTreeSet<String>>>,
}

async fn handle_connection(
    mut socket: UnixStream,
    actor: Arc<StorageActor>,
    approver_token: Arc<Zeroizing<String>>,
    events: Arc<EventHub>,
    capabilities: Arc<CapabilityRegistry>,
    max_queued_events: usize,
    accounts: Arc<crate::accounts::AccountService>,
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
        trusted_sender: false,
        topics,
    };
    let mut reads: tokio::task::JoinSet<(Value, String, String)> = tokio::task::JoinSet::new();
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
            completed = reads.join_next(), if !reads.is_empty() => {
                if let Some(Ok((response, id, method))) = completed {
                    if write_response(&mut socket, response, &id, &method).await.is_err() { break; }
                }
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
                    if session.role.is_some() && matches!(request.method.as_str(), "account.messages" | "account.search" | "account.list") {
                        if reads.len() >= 16 {
                            if write_frame(&mut socket, failure(&request.id, &request.method, "BAD_REQUEST", "동시 조회 제한")).await.is_err() { break 'connection; }
                            continue;
                        }
                        let accounts = Arc::clone(&accounts);
                        reads.spawn(async move {
                            let params = Value::Object(request.params);
                            let result = if request.method == "account.list" { accounts.list(&params).await }
                                else { accounts.query(request.method.strip_prefix("account.").unwrap(), &params).await };
                            let response = match result {
                                Ok(value) => success(&request.id, &request.method, value),
                                Err(error) => failure(&request.id, &request.method, "UNSUPPORTED", &error),
                            };
                            (response, request.id, request.method)
                        });
                        continue;
                    }
                    let response = match dispatch(
                        &mut session,
                        &actor,
                        &approver_token,
                        &events,
                        &capabilities,
                        &accounts,
                        &request,
                    )
                    .await
                    {
                        Ok(result) => success(&request.id, &request.method, result),
                        Err(error) => failure(&request.id, &request.method, error.code, &error.message),
                    };
                    if write_response(&mut socket, response, &request.id, &request.method)
                        .await
                        .is_err()
                    {
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
    let from_value = from
        .cloned()
        .ok_or_else(|| RpcError::bad_request(format!("{label}.from_ts must be a finite number")))?;
    let to_value = to
        .cloned()
        .ok_or_else(|| RpcError::bad_request(format!("{label}.to_ts must be a finite number")))?;
    let from = finite_number(Some(&from_value), &format!("{label}.from_ts"))?;
    let to = finite_number(Some(&to_value), &format!("{label}.to_ts"))?;
    if from >= to {
        return Err(RpcError::bad_request(format!(
            "{label}.from_ts must be before {label}.to_ts"
        )));
    }
    Ok(json!({"from_ts":from_value,"to_ts":to_value}))
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

async fn actor_call(
    actor: &StorageActor,
    operation: StorageOperation,
    input: Value,
    bad_request_errors: bool,
) -> RpcResult {
    actor.call_async(operation, input).await.map_err(|error| {
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
        Some(ClientRole::Sender) => json!("sender"),
        None => Value::Null,
    }
}

async fn audit_read(
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
    )
    .await?;
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

async fn publish_safety(events: &EventHub, actor: &StorageActor, intent_id: &str) {
    if let Ok(intent) = actor
        .call_async(
            StorageOperation::SafetyGetIntent,
            json!({"intent_id":intent_id}),
        )
        .await
    {
        if let Some(state) = intent.get("state") {
            let _ = events.publish(
                "safety.intent.changed",
                json!({"intent_id":intent_id,"state":state}),
            );
        }
    }
}

struct BackfillPagePlan {
    interval: Value,
    provider_cursor: Value,
    committed_pages: u64,
}

impl BackfillPagePlan {
    fn for_request(
        sync: &Value,
        interval: &Value,
        max_pages: u64,
    ) -> std::result::Result<Self, RpcError> {
        let checkpoint = sync
            .get("cursor")
            .and_then(Value::as_str)
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|value| {
                let object = value.as_object()?;
                let exact = object.len() == 6
                    && [
                        "v",
                        "kind",
                        "interval",
                        "provider_cursor",
                        "committed_pages",
                        "terminal",
                    ]
                    .iter()
                    .all(|field| object.contains_key(*field));
                (exact
                    && object.get("v") == Some(&json!(1))
                    && object.get("kind") == Some(&json!("backfill_job"))
                    && object.get("interval") == Some(interval))
                .then_some(value)
            });
        if let Some(checkpoint) = checkpoint {
            let terminal = checkpoint["terminal"].as_bool();
            let committed_pages = checkpoint["committed_pages"]
                .as_u64()
                .filter(|value| *value > 0);
            let provider_cursor = checkpoint["provider_cursor"].as_str().filter(|value| {
                !value.is_empty() && value.len() <= inboxd_protocol::MAX_CURSOR_BYTES
            });
            if terminal == Some(false) {
                if let (Some(committed_pages), Some(provider_cursor)) =
                    (committed_pages, provider_cursor)
                {
                    if committed_pages >= max_pages {
                        return Err(RpcError::unsupported(
                            "sync.backfill max_pages budget is exhausted for this interval",
                        ));
                    }
                    return Ok(Self {
                        interval: interval.clone(),
                        provider_cursor: Value::String(provider_cursor.to_owned()),
                        committed_pages,
                    });
                }
            }
            if terminal == Some(true)
                && committed_pages.is_some()
                && checkpoint["provider_cursor"].is_null()
            {
                return Ok(Self {
                    interval: interval.clone(),
                    provider_cursor: Value::Null,
                    committed_pages: 0,
                });
            }
        }
        Ok(Self {
            interval: interval.clone(),
            provider_cursor: Value::Null,
            committed_pages: 0,
        })
    }

    fn into_apply_sync_batch(
        self,
        page: inboxd_protocol::NormalizedWorkerPage,
        expected_page_sequence: u64,
    ) -> std::result::Result<Value, RpcError> {
        let next_cursor = page.next_cursor.clone();
        let mut batch = page
            .into_apply_sync_batch(expected_page_sequence)
            .map_err(|error| RpcError::unsupported(error.message))?;
        let checkpoint = json!({
            "v":1,
            "kind":"backfill_job",
            "interval":self.interval,
            "provider_cursor":next_cursor,
            "committed_pages":self.committed_pages + 1,
            "terminal":next_cursor.is_null(),
        });
        batch["sync"]["cursor"] = Value::String(
            serde_json::to_string(&checkpoint)
                .map_err(|_| RpcError::unsupported("backfill checkpoint could not be encoded"))?,
        );
        Ok(batch)
    }
}

async fn dispatch(
    session: &mut Session,
    actor: &StorageActor,
    approver_token: &str,
    events: &EventHub,
    capabilities: &CapabilityRegistry,
    accounts: &crate::accounts::AccountService,
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
        session.trusted_sender = role == ClientRole::Sender
            && token_matches(
                approver_token,
                request.params.get("sender_token").and_then(Value::as_str),
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
        "system.status" => {
            let encryption =
                actor_call(actor, StorageOperation::Diagnose, json!({}), false).await?;
            let directory = capabilities.list();
            let mut auth = serde_json::Map::new();
            if let Some(resources) = directory["resources"].as_array() {
                for resource in resources {
                    if let Some(platform) = resource["resource"]["platform"].as_str() {
                        auth.insert(platform.to_owned(), resource["auth"].clone());
                    }
                }
            }
            Ok(
                json!({"ready":true,"owner":"daemon","encryption":encryption,"auth":auth,
                "isolation":{"grade":"same-user","protected":false,"warning":"same-user shell access is outside isolation"}}),
            )
        }
        "account.list" => accounts
            .list(&Value::Object(request.params.clone()))
            .await
            .map_err(RpcError::unsupported),
        "message.send" => {
            if !session.trusted_sender && !session.trusted_approver {
                return Err(RpcError::unsupported(
                    "authenticated local sender authorization is required",
                ));
            }
            crate::direct_send::execute(actor, capabilities, accounts, &Value::Object(request.params.clone()), json!({"role":role_value(session.role),"session_id":session.id,"authority":"local-owner-token","method":request.method})).await.map_err(RpcError::unsupported)
        }
        "account.messages" | "account.search" => {
            let op = request.method.strip_prefix("account.").unwrap();
            accounts
                .query(op, &Value::Object(request.params.clone()))
                .await
                .map_err(RpcError::unsupported)
        }
        "chat.list" => {
            let input = Value::Object(page(&request.params)?);
            let found = actor_call(actor, StorageOperation::ChatList, input, true).await?;
            let count = found["chats"].as_array().map_or(0, Vec::len);
            audit_read(session, actor, "read.chat_list", "all-chats".into(), count).await?;
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
            )
            .await?;
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
            audit_read(session, actor, action, subject, count).await?;
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
            let found = actor_call(actor, operation, Value::Object(input), true).await?;
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
            )
            .await?;
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
            let message =
                actor_call(actor, StorageOperation::GetMessage, key.clone(), true).await?;
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
            )
            .await?;
            Ok(json!({"message":message}))
        }
        "sync.backfill" => {
            if !session.trusted_sender {
                assert_trusted_approver(session)?;
            }
            let (chat, interval) = if request.params.contains_key("chat") {
                (chat(&request.params)?, interval(&request.params)?)
            } else {
                (flat_chat(&request.params)?, flat_interval(&request.params)?)
            };
            let resource = json!({
                "v":1,
                "kind":"chat",
                "platform":chat["platform"],
                "account":chat["account"],
                "chat_id":chat["chat_id"],
            });
            let binding = capabilities.exact(&resource).ok_or_else(|| {
                RpcError::unsupported(
                    "sync.backfill is unavailable because no adapter is configured",
                )
            })?;
            if binding.claims["read"]["mode"] == "none" {
                return Err(RpcError::unsupported(
                    "sync.backfill is unavailable for this resource",
                ));
            }
            let worker = binding.worker.as_ref().ok_or_else(|| {
                RpcError::unsupported(
                    "sync.backfill is unavailable because no worker is configured",
                )
            })?;
            let sync =
                actor_call(actor, StorageOperation::ReadSyncState, chat.clone(), false).await?;
            let expected_page_sequence = sync
                .get("page_sequence")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let limit = binding.claims["read"]["limits"]["max_page_size"]
                .as_u64()
                .ok_or_else(|| RpcError::unsupported("configured read limit is invalid"))?;
            let max_pages = binding.claims["read"]["limits"]["max_pages"]
                .as_u64()
                .ok_or_else(|| RpcError::unsupported("configured page budget is invalid"))?;
            let plan = BackfillPagePlan::for_request(&sync, &interval, max_pages)?;
            let cursor = plan.provider_cursor.clone();
            let page = worker
                .read_page(&binding.id, resource, interval, limit, cursor)
                .await
                .map_err(|error| RpcError::unsupported(error.to_string()))?;
            let event_count = page.messages.len() + page.tombstones.len();
            let authoritative = page.authoritative;
            let batch = plan.into_apply_sync_batch(page, expected_page_sequence)?;
            actor_call(actor, StorageOperation::ApplySyncBatch, batch, false).await?;
            // Notify only after durable commit, including empty-page coverage updates.
            let _ = events.publish("message.upserted", json!({"chat":chat}));
            let _ = events.publish("coverage.changed", json!({"chat":chat}));
            Ok(json!({"event_count":event_count,"authoritative":authoritative}))
        }
        "sync.status" => Ok(accounts.live_status()),
        "auth.status" => {
            let directory = capabilities.list();
            let authenticated = directory["resources"].as_array().is_some_and(|resources| {
                !resources.is_empty()
                    && resources
                        .iter()
                        .all(|r| r["auth"]["state"] == "authenticated")
            });
            Ok(json!({"authenticated":authenticated}))
        }
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
        "safety.intent.listPending" => {
            if !session.trusted_sender {
                assert_trusted_approver(session)?;
            }
            let found = actor_call(
                actor,
                StorageOperation::SafetyListPendingPage,
                Value::Object(page(&request.params)?),
                true,
            )
            .await?;
            let count = found["intents"].as_array().map_or(0, Vec::len);
            audit_read(
                session,
                actor,
                "read.safety_intent_list",
                "pending-intents".into(),
                count,
            )
            .await?;
            Ok(found)
        }
        "safety.intent.reject" => {
            if !session.trusted_sender {
                assert_trusted_approver(session)?;
            }
            let intent_id = string(request.params.get("intent_id"), "intent_id")?;
            let rejected = actor_call(
                actor,
                StorageOperation::SafetyReject,
                json!({"intent_id":intent_id}),
                false,
            )
            .await?;
            publish_safety(events, actor, &intent_id).await;
            Ok(rejected)
        }
        "send.status" => {
            let id = string(
                request
                    .params
                    .get("id")
                    .or_else(|| request.params.get("request_id")),
                "id",
            )?;
            let direct = actor_call(
                actor,
                StorageOperation::OwnerSendStatus,
                json!({"id":id}),
                true,
            )
            .await?;
            if !direct.is_null() {
                return Ok(direct);
            }
            actor_call(
                actor,
                StorageOperation::SendStatus,
                json!({"id":string(request.params.get("id"), "id")?}),
                true,
            )
            .await
        }
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
    let frame = encode_json_line(&value, MAX_CLIENT_FRAME_BYTES)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.message))?;
    socket.write_all(frame.as_bytes()).await
}

async fn write_response(
    socket: &mut UnixStream,
    response: Value,
    id: &str,
    method: &str,
) -> std::io::Result<()> {
    match encode_json_line(&response, MAX_CLIENT_FRAME_BYTES) {
        Ok(frame) => socket.write_all(frame.as_bytes()).await,
        Err(_) => {
            let bounded = failure(
                id,
                method,
                "RESPONSE_TOO_LARGE",
                "response exceeds the 65536 byte client frame limit",
            );
            write_frame(socket, bounded).await
        }
    }
}

fn token_matches(expected: &str, supplied: Option<&str>) -> bool {
    let Some(supplied) = supplied else {
        return false;
    };
    expected.len() == supplied.len() && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}

#[cfg(test)]
mod backfill_tests {
    use super::*;
    use inboxd_protocol::NormalizedWorkerPage;
    use inboxd_storage::StorageActorConfig;
    use std::{fs, os::unix::fs::PermissionsExt};

    fn terminal_page(interval: &Value) -> NormalizedWorkerPage {
        let chat_ref = json!({
            "v":1,"kind":"chat","platform":"telegram","account":"personal","chat_id":"42"
        });
        let chat = json!({"platform":"telegram","account":"personal","chat_id":"42"});
        NormalizedWorkerPage {
            mode: "bounded_history".into(),
            chat: chat_ref,
            interval: interval.clone(),
            messages: Vec::new(),
            tombstones: Vec::new(),
            identity: json!({
                "chat":chat,"status":"unknown","source":"unknown",
                "reason":"unsupported","observed_at":2
            }),
            unread: json!({
                "chat":chat,"status":"unknown","source":"unknown","count":null,
                "reason":"unsupported","observed_at":2
            }),
            coverage: Vec::new(),
            limits: Vec::new(),
            next_cursor: Value::Null,
            authoritative: true,
            observed_at: 2.0,
        }
    }

    #[test]
    fn terminal_page_commits_non_null_checkpoint_and_restarts_same_interval() {
        let interval = json!({"from_ts":0,"to_ts":10});
        let plan = BackfillPagePlan::for_request(&Value::Null, &interval, 1)
            .unwrap_or_else(|error| panic!("{}", error.message));
        let batch = plan
            .into_apply_sync_batch(terminal_page(&interval), 0)
            .unwrap_or_else(|error| panic!("{}", error.message));
        assert!(batch["sync"]["cursor"].is_string());

        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let mut actor = StorageActor::start(StorageActorConfig::new(
            directory.path().join("terminal.db"),
            [0x51; 32],
        ))
        .unwrap();
        actor.call(StorageOperation::ApplySyncBatch, batch).unwrap();
        let chat = json!({"platform":"telegram","account":"personal","chat_id":"42"});
        let stored = actor.call(StorageOperation::ReadSyncState, chat).unwrap();
        assert!(stored["cursor"].is_string());
        assert_eq!(stored["page_sequence"], 1);

        let restarted = BackfillPagePlan::for_request(&stored, &interval, 1)
            .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(restarted.provider_cursor, Value::Null);
        assert_eq!(restarted.committed_pages, 0);
        actor.shutdown().unwrap();
    }

    #[test]
    fn active_provider_cursor_resumes_only_for_the_exact_interval() {
        let interval = json!({"from_ts":0,"to_ts":10});
        let mut page = terminal_page(&interval);
        page.next_cursor = json!("provider-secret");
        let initial = BackfillPagePlan::for_request(&Value::Null, &interval, 3)
            .unwrap_or_else(|error| panic!("{}", error.message));
        let batch = initial
            .into_apply_sync_batch(page, 0)
            .unwrap_or_else(|error| panic!("{}", error.message));
        let stored = json!({"cursor":batch["sync"]["cursor"],"page_sequence":1});

        let resumed = BackfillPagePlan::for_request(&stored, &interval, 3)
            .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(resumed.provider_cursor, "provider-secret");
        assert_eq!(resumed.committed_pages, 1);

        let other_interval = json!({"from_ts":10,"to_ts":20});
        let restarted = BackfillPagePlan::for_request(&stored, &other_interval, 3)
            .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(restarted.provider_cursor, Value::Null);
        assert_eq!(restarted.committed_pages, 0);

        let legacy = json!({"cursor":"provider-secret","page_sequence":1});
        let legacy_restarted = BackfillPagePlan::for_request(&legacy, &interval, 3)
            .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(legacy_restarted.provider_cursor, Value::Null);
        assert_eq!(legacy_restarted.committed_pages, 0);
    }

    #[test]
    fn active_job_refuses_provider_io_after_its_page_budget_is_committed() {
        let interval = json!({"from_ts":0,"to_ts":10});
        let mut page = terminal_page(&interval);
        page.next_cursor = json!("more-pages");
        let first = BackfillPagePlan::for_request(&Value::Null, &interval, 1)
            .unwrap_or_else(|error| panic!("{}", error.message));
        let batch = first
            .into_apply_sync_batch(page, 0)
            .unwrap_or_else(|error| panic!("{}", error.message));
        let stored = json!({"cursor":batch["sync"]["cursor"],"page_sequence":1});

        let error = match BackfillPagePlan::for_request(&stored, &interval, 1) {
            Ok(_) => panic!("exhausted backfill job unexpectedly resumed"),
            Err(error) => error,
        };
        assert_eq!(error.code, "UNSUPPORTED");
        assert!(error.message.contains("max_pages"));

        let other_interval = json!({"from_ts":10,"to_ts":20});
        let fresh = BackfillPagePlan::for_request(&stored, &other_interval, 1)
            .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(fresh.provider_cursor, Value::Null);
        assert_eq!(fresh.committed_pages, 0);
    }
}
