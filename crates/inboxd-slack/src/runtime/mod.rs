use futures_util::{SinkExt, StreamExt, future::join_all};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, mpsc, watch},
    time::{Instant, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use zeroize::Zeroizing;

const RESPONSE_LIMIT: usize = 4_000_000;
const AUTH_ERRORS: &[&str] = &[
    "invalid_auth",
    "not_authed",
    "token_revoked",
    "token_expired",
    "account_inactive",
    "invalid_cookie",
];
const READS: &[&str] = &[
    "users.list",
    "users.info",
    "client.counts",
    "conversations.list",
    "conversations.members",
    "conversations.history",
    "conversations.replies",
    "search.messages",
];
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Error {
    Request,
    Auth,
    Rate,
    Frame,
}
impl Error {
    fn public(self) -> &'static str {
        match self {
            Self::Auth => "Slack 인증이 만료되었습니다. inboxd connect slack으로 다시 연결하세요.",
            Self::Rate => "provider_rate_limit",
            _ => "메신저 요청 실패. 연결 상태나 요청 제한을 확인하세요.",
        }
    }
}
type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Credentials {
    bot_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_cookie: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
}
struct Account {
    client: Client,
    credentials: watch::Sender<Credentials>,
    recovery: Mutex<()>,
    remembered: AtomicBool,
    helper: PathBuf,
    api_base: String,
}
impl Account {
    async fn new(credentials: Credentials, helper: PathBuf) -> Result<Self> {
        let mut account = Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(15))
                .http1_only()
                .retry(reqwest::retry::never())
                .pool_max_idle_per_host(8)
                .build()
                .map_err(|_| Error::Request)?,
            credentials: watch::channel(credentials.clone()).0,
            recovery: Mutex::new(()),
            remembered: AtomicBool::new(false),
            helper,
            api_base: "https://slack.com/api/".into(),
        };
        let current = account.auth("current", &credentials).await?;
        let current: Credentials = serde_json::from_value(current).map_err(|_| Error::Auth)?;
        account.credentials = watch::channel(current).0;
        Ok(account)
    }
    async fn auth(&self, op: &str, credentials: &Credentials) -> Result<Value> {
        // Only stdin carries secrets. Helper is a trusted sibling in the private
        // installed product; no PATH lookup, shell, inherited credentials or logs.
        let mut child = Command::new(&self.helper)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| Error::Auth)?;
        let work = async {
            let bytes = Zeroizing::new(
                serde_json::to_vec(&json!({"op":op,"credentials":credentials}))
                    .map_err(|_| Error::Auth)?,
            );
            let mut input = child.stdin.take().ok_or(Error::Auth)?;
            input.write_all(&bytes).await.map_err(|_| Error::Auth)?;
            input.shutdown().await.map_err(|_| Error::Auth)?;
            drop(input);
            let mut output = Vec::new();
            child
                .stdout
                .take()
                .ok_or(Error::Auth)?
                .take(32769)
                .read_to_end(&mut output)
                .await
                .map_err(|_| Error::Auth)?;
            if output.len() > 32768 {
                return Err(Error::Auth);
            }
            let status = child.wait().await.map_err(|_| Error::Auth)?;
            let value: Value = serde_json::from_slice(&output).map_err(|_| Error::Auth)?;
            if !status.success() || value["ok"] != true {
                return Err(Error::Auth);
            }
            Ok(value["result"].clone())
        };
        timeout(Duration::from_secs(65), work)
            .await
            .map_err(|_| Error::Auth)?
    }
    async fn once(&self, credentials: &Credentials, method: &str, params: &Value) -> Result<Value> {
        let fields: Vec<(String, String)> = params
            .as_object()
            .into_iter()
            .flat_map(|o| o.iter())
            .map(|(k, v)| {
                (
                    k.clone(),
                    v.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| v.to_string()),
                )
            })
            .collect();
        let mut request = self
            .client
            .post(format!("{}{method}", self.api_base))
            .bearer_auth(&credentials.bot_token)
            .form(&fields);
        if let Some(cookie) = &credentials.session_cookie {
            request = request.header("cookie", format!("d={cookie}"));
        }
        let response = request.send().await.map_err(|_| Error::Request)?;
        decode_response(response).await
    }
    async fn recover(&self, failed: &Credentials) -> Result<()> {
        let _guard = self.recovery.lock().await;
        if *self.credentials.borrow() != *failed {
            return Ok(());
        }
        let value = self.auth("recover", failed).await?;
        let next: Credentials = serde_json::from_value(value).map_err(|_| Error::Auth)?;
        self.credentials.send_replace(next);
        Ok(())
    }
    async fn call(&self, method: &str, params: &Value, read: bool) -> Result<Value> {
        let before = self.credentials.borrow().clone();
        match self.once(&before, method, params).await {
            Ok(value) => {
                if read && !self.remembered.swap(true, Ordering::SeqCst) {
                    let _ = self.auth("remember", &before).await;
                }
                Ok(value)
            }
            Err(Error::Auth) if read => {
                self.recover(&before).await?;
                let next = self.credentials.borrow().clone();
                let result = self.once(&next, method, params).await;
                if result == Err(Error::Auth) {
                    let _ = self.auth("reject", &next).await;
                }
                result
            }
            error => error, // Mutations and transport errors are NEVER retried.
        }
    }
    async fn primitive(&self, request: &Value) -> Result<Value> {
        let op = request["op"].as_str().ok_or(Error::Request)?;
        if op == "slack_leave" {
            let params = json!({"channel":request["chat_id"]});
            let info = self.call("conversations.info", &params, false).await?;
            if info["channel"]["id"] != request["chat_id"] {
                return Err(Error::Request);
            }
            let method = if info["channel"]["is_im"] == true || info["channel"]["is_mpim"] == true {
                "conversations.close"
            } else {
                "conversations.leave"
            };
            self.call(method, &params, false).await?;
            return Ok(json!({"state":"Left"}));
        }
        if op == "slack_send_file" {
            return self.send_file(request).await;
        }
        let method = op.strip_prefix("slack.").ok_or(Error::Request)?;
        let read = READS.contains(&method);
        if !read && method != "chat.postMessage" {
            return Err(Error::Request);
        }
        let result = self.call(method, &request["params"], read).await?;
        Ok(json!({"data": result}))
    }
    async fn dispatch(&self, input: Value) -> Result<Value> {
        let typed = crate::contract::validate_request(input.clone(), "slack")
            .map_err(|_| Error::Request)?;
        let result = if input["op"] == "batch" {
            let requests = input["requests"].as_array().ok_or(Error::Request)?;
            let results = join_all(requests.iter().map(|r| self.primitive(r))).await;
            // Drain every started read before returning; preserve auth/rate priority.
            for error in [Error::Auth, Error::Rate, Error::Request, Error::Frame] {
                if results.iter().any(|r| r.as_ref().err() == Some(&error)) {
                    return Err(error);
                }
            }
            json!({"results":results.into_iter().collect::<Result<Vec<_>>>()?})
        } else {
            self.primitive(&input).await?
        };
        crate::contract::validate_result(&typed, &result).map_err(|_| Error::Request)?;
        Ok(result)
    }
    async fn send_file(&self, request: &Value) -> Result<Value> {
        let file = request["file"].clone();
        let bytes = tokio::task::spawn_blocking(move || read_attachment(&file))
            .await
            .map_err(|_| Error::Request)??;
        let upload = self
            .call(
                "files.getUploadURLExternal",
                &json!({"filename":request["file"]["name"],"length":bytes.len()}),
                false,
            )
            .await?;
        let url = Url::parse(upload["upload_url"].as_str().ok_or(Error::Request)?)
            .map_err(|_| Error::Request)?;
        if !allowed_upload(&url) {
            return Err(Error::Request);
        }
        let id = upload["file_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(Error::Request)?;
        let response = self
            .client
            .post(url)
            .timeout(Duration::from_secs(50))
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|_| Error::Request)?;
        if !response.status().is_success() {
            return Err(Error::Request);
        }
        drop(response);
        let complete = self.call("files.completeUploadExternal", &json!({"files":[{"id":id,"title":request["file"]["name"]}],"channel_id":request["chat_id"]}),false).await?;
        if !complete["files"]
            .as_array()
            .is_some_and(|files| files.iter().any(|file| file["id"] == id))
        {
            return Err(Error::Request);
        }
        Ok(json!({"state":"Sent","receipt":id}))
    }
}
async fn decode_response(response: reqwest::Response) -> Result<Value> {
    if response.status().as_u16() == 429 {
        return Err(Error::Rate);
    }
    let success = response.status().is_success();
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_LIMIT as u64)
    {
        return Err(Error::Frame);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Error::Request)?;
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(Error::Frame);
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut result: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Request)?;
    if result["ok"] == false
        && result["error"]
            .as_str()
            .is_some_and(|e| AUTH_ERRORS.contains(&e))
    {
        return Err(Error::Auth);
    }
    if !success || result["ok"] != true {
        return Err(Error::Request);
    }
    normalize_messages(&mut result);
    Ok(result)
}
fn normalize_messages(result: &mut Value) {
    fn normalize(message: &mut Value) {
        if let Some(channel) = message["channel"].as_str() {
            let channel = channel.to_owned();
            message["channel"] = json!({"id":channel});
        }
    }
    if let Some(rows) = result.get_mut("messages").and_then(Value::as_array_mut) {
        for row in rows {
            normalize(row);
        }
    } else if let Some(rows) = result
        .get_mut("messages")
        .and_then(|v| v.get_mut("matches"))
        .and_then(Value::as_array_mut)
    {
        for row in rows {
            normalize(row);
        }
    }
    if let Some(message) = result.get_mut("message") {
        normalize(message);
    }
}
fn allowed_upload(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("files.slack.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}
fn read_attachment(file: &Value) -> Result<Vec<u8>> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    let path = file["path"].as_str().ok_or(Error::Request)?;
    if !std::path::Path::new(path).is_absolute() {
        return Err(Error::Request);
    }
    let handle = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| Error::Request)?;
    let metadata = handle.metadata().map_err(|_| Error::Request)?;
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > 104857600
        || Some(metadata.len()) != file["size"].as_u64()
    {
        return Err(Error::Request);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize + 1);
    handle
        .take(metadata.len() + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Request)?;
    if bytes.len() as u64 != metadata.len()
        || format!("{:x}", Sha256::digest(&bytes)) != file["sha256"].as_str().unwrap_or("")
    {
        return Err(Error::Request);
    }
    Ok(bytes)
}

#[derive(Clone)]
struct Events {
    hints: mpsc::Sender<Value>,
    state: watch::Sender<Option<Value>>,
    gap: Arc<AtomicBool>,
}
impl Events {
    fn start() -> Self {
        let (hints, mut receiver) = mpsc::channel::<Value>(1024);
        let (state, mut states) = watch::channel::<Option<Value>>(None);
        let gap = Arc::new(AtomicBool::new(false));
        let lost = Arc::clone(&gap);
        tokio::spawn(async move {
            let mut output = tokio::io::stderr();
            loop {
                let value = tokio::select! {
                    biased;
                    changed = states.changed() => { if changed.is_err() { break; } states.borrow_and_update().clone() },
                    hint = receiver.recv() => hint,
                };
                let Some(value) = value else {
                    break;
                };
                if lost.swap(false, Ordering::SeqCst)
                    && output.write_all(b"{\"event\":\"gap\"}\n").await.is_err()
                {
                    break;
                }
                let mut bytes = value.to_string().into_bytes();
                bytes.push(b'\n');
                if output.write_all(&bytes).await.is_err() || output.flush().await.is_err() {
                    break;
                }
            }
        });
        Self { hints, state, gap }
    }
    fn emit(&self, value: Value) {
        if value["event"] == "state" {
            if value["state"] == "connected" {
                self.emit(json!({"event":"changed"}));
            }
            self.state.send_replace(Some(value));
        } else if value.to_string().len() > 1000 {
            self.gap.store(true, Ordering::SeqCst);
            // Wake an otherwise idle writer so an oversized hint cannot hide a gap.
            let _ = self.hints.try_send(json!({"event":"changed"}));
        } else if self.hints.try_send(value).is_err() {
            // The full queue already wakes the writer; it emits gap before hints.
            self.gap.store(true, Ordering::SeqCst);
        }
    }
}
fn event_hint(value: &Value) -> Option<Value> {
    // The daemon intentionally rejects malformed hint frames. Convert malformed
    // vendor IDs to a bounded rescan, instead of poisoning the event pipe.
    for field in [
        &value["channel"],
        &value["deleted_ts"],
        &value["ts"],
        &value["message"]["ts"],
    ] {
        if let Some(id) = field.as_str() {
            if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
                return Some(json!({"event":"gap"}));
            }
        }
    }
    let kind = value["type"].as_str()?;
    if matches!(kind, "hello" | "pong" | "user_typing" | "presence_change")
        || !value["reply_to"].is_null()
    {
        return None;
    }
    if kind == "message" && value["subtype"] == "message_deleted" {
        if let (Some(chat), Some(id)) = (value["channel"].as_str(), value["deleted_ts"].as_str()) {
            return Some(json!({"event":"deleted","chat_id":chat,"message_id":id}));
        }
    }
    let mut hint = json!({"event":"changed"});
    if let Some(chat) = value["channel"].as_str() {
        hint["chat_id"] = json!(chat);
        if let Some(id) = value["message"]["ts"]
            .as_str()
            .or_else(|| value["ts"].as_str())
        {
            hint["message_id"] = json!(id);
        }
    }
    Some(hint)
}
fn allowed_socket(url: &Url) -> bool {
    url.scheme() == "wss"
        && url
            .host_str()
            .is_some_and(|host| host.ends_with(".slack.com") || host.ends_with(".slack-msgs.com"))
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
}
async fn socket_session(
    account: &Account,
    events: &Events,
    changed: &mut watch::Receiver<Credentials>,
) -> Result<()> {
    let rtm = account.call("rtm.connect", &json!({}), true).await?;
    let url = Url::parse(rtm["url"].as_str().ok_or(Error::Request)?).map_err(|_| Error::Request)?;
    if !allowed_socket(&url) {
        return Err(Error::Request);
    }
    let credentials = changed.borrow_and_update().clone();
    let cookie = credentials.session_cookie.ok_or(Error::Auth)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| Error::Request)?;
    request.headers_mut().insert(
        "cookie",
        format!("d={cookie}").parse().map_err(|_| Error::Auth)?,
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(RESPONSE_LIMIT))
        .max_frame_size(Some(RESPONSE_LIMIT));
    let (socket, _) = timeout(
        Duration::from_secs(15),
        connect_async_with_config(request, Some(config), false),
    )
    .await
    .map_err(|_| Error::Request)?
    .map_err(|_| Error::Request)?;
    drive_socket(socket, events, changed).await
}
async fn drive_socket<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut socket: tokio_tungstenite::WebSocketStream<S>,
    events: &Events,
    changed: &mut watch::Receiver<Credentials>,
) -> Result<()> {
    let mut ping = tokio::time::interval_at(
        Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut sequence = 0u64;
    let mut pending: Option<u64> = None;
    let mut deadline = Instant::now() + Duration::from_secs(86400);
    loop {
        tokio::select! {
            _ = changed.changed() => return Ok(()),
            _ = tokio::time::sleep_until(deadline), if pending.is_some() => return Err(Error::Request),
            _ = ping.tick() => {
                sequence += 1;
                timeout(Duration::from_secs(10), socket.send(Message::Text(json!({"type":"ping","id":sequence}).to_string().into())))
                    .await.map_err(|_|Error::Request)?.map_err(|_|Error::Request)?;
                pending = Some(sequence); deadline=Instant::now()+Duration::from_secs(10);
            }
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue; };
                        if value["type"] == "hello" { events.emit(json!({"event":"state","state":"connected"})); }
                        else if matches!(value["type"].as_str(),Some("goodbye"|"team_migration_started")) { return Ok(()); }
                        else if pending.is_some() && value["reply_to"].as_u64() == pending { pending=None; }
                        else if let Some(hint) = event_hint(&value) { events.emit(hint); }
                    }
                    Some(Ok(Message::Ping(_))) => { socket.flush().await.map_err(|_|Error::Request)?; }
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Ok(Message::Binary(_))) => {},
                    _ => return Err(Error::Request),
                }
            }
        }
    }
}
async fn listen(account: Arc<Account>, events: Events) {
    let mut changed = account.credentials.subscribe();
    let mut failures = 0u32;
    loop {
        if changed.borrow().session_cookie.is_none() {
            events.emit(json!({"event":"state","state":"unsupported"}));
            return;
        }
        let start = Instant::now();
        let result = socket_session(&account, &events, &mut changed).await;
        events.emit(json!({"event":"state","state":"disconnected"}));
        if result.is_ok() {
            failures = 0;
            continue;
        }
        if start.elapsed() >= Duration::from_secs(30) {
            failures = 0;
        }
        let delay = Duration::from_secs((1u64 << failures.min(5)).min(30));
        failures = failures.saturating_add(1);
        tokio::select! { _=tokio::time::sleep(delay)=>{}, _=changed.changed()=>{failures=0;} }
    }
}
async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(input: &mut R) -> Result<Option<Value>> {
    let mut line = Vec::new();
    let count = input
        .take(65537)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|_| Error::Frame)?;
    if count == 0 {
        return Ok(None);
    }
    if line.len() > 65536 || line.last() != Some(&b'\n') {
        return Err(Error::Frame);
    }
    serde_json::from_slice(&line)
        .map(Some)
        .map_err(|_| Error::Frame)
}
pub(crate) async fn serve() -> std::result::Result<(), ()> {
    let raw = Zeroizing::new(std::env::var("INBOXD_ACCOUNT_CONFIG").map_err(|_| ())?);
    if raw.len() > 32768 {
        return Err(());
    }
    let credentials: Credentials = serde_json::from_str(&raw).map_err(|_| ())?;
    if credentials.bot_token.is_empty() {
        return Err(());
    }
    let helper = std::env::current_exe()
        .map_err(|_| ())?
        .with_file_name("inboxd-slack-auth-helper");
    let account = Arc::new(Account::new(credentials, helper).await.map_err(|_| ())?);
    let events = Events::start();
    if std::env::var("INBOXD_ACCOUNT_LIVE").as_deref() == Ok("1") {
        tokio::spawn(listen(Arc::clone(&account), events.clone()));
    }
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    loop {
        let request = match read_frame(&mut input).await {
            Ok(Some(request)) => request,
            Ok(None) => return Ok(()),
            Err(_) => return Err(()),
        };
        let result = match account.dispatch(request).await {
            Ok(value) => json!({"ok":true,"result":value}),
            Err(error) => json!({"ok":false,"error":error.public()}),
        };
        let mut bytes = serde_json::to_vec(&result).map_err(|_| ())?;
        if bytes.len() > 12_000_000 {
            bytes = serde_json::to_vec(&json!({"ok":false,"error":Error::Frame.public()}))
                .map_err(|_| ())?;
        }
        bytes.push(b'\n');
        output.write_all(&bytes).await.map_err(|_| ())?;
        output.flush().await.map_err(|_| ())?;
    }
}

#[cfg(test)]
mod tests;
