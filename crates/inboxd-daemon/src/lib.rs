//! Rust-owned inboxd daemon and UDS lifecycle.
#![forbid(unsafe_code)]

use inboxd_protocol::{
    ClientRole, JsonLinesDecoder, MAX_CLIENT_FRAME_BYTES, ProtocolRequest, parse_request,
};
use inboxd_storage::{StorageActor, StorageActorConfig};
use serde_json::{Value, json};
use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{FileTypeExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::oneshot,
    task::JoinHandle,
};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonError(String);

impl DaemonError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for DaemonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for DaemonError {}

type Result<T> = std::result::Result<T, DaemonError>;

pub struct DaemonConfig {
    pub state_dir: PathBuf,
    pub database_path: PathBuf,
    pub socket_path: PathBuf,
    database_key: Zeroizing<Vec<u8>>,
}

impl fmt::Debug for DaemonConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonConfig")
            .field("state_dir", &self.state_dir)
            .field("database_path", &self.database_path)
            .field("socket_path", &self.socket_path)
            .field("database_key", &"<redacted>")
            .finish()
    }
}

impl Clone for DaemonConfig {
    fn clone(&self) -> Self {
        Self {
            state_dir: self.state_dir.clone(),
            database_path: self.database_path.clone(),
            socket_path: self.socket_path.clone(),
            database_key: Zeroizing::new(self.database_key.to_vec()),
        }
    }
}

impl DaemonConfig {
    pub fn new(
        state_dir: impl AsRef<Path>,
        database_path: impl AsRef<Path>,
        socket_path: impl AsRef<Path>,
        database_key: impl Into<Vec<u8>>,
    ) -> Self {
        Self {
            state_dir: state_dir.as_ref().to_owned(),
            database_path: database_path.as_ref().to_owned(),
            socket_path: socket_path.as_ref().to_owned(),
            database_key: Zeroizing::new(database_key.into()),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.database_key.is_empty() {
            return Err(DaemonError::new("database key must not be empty"));
        }
        if !self.state_dir.is_absolute()
            || !self.database_path.is_absolute()
            || !self.socket_path.is_absolute()
        {
            return Err(DaemonError::new("daemon paths must be absolute"));
        }
        if self.database_path.parent() != Some(self.state_dir.as_path())
            || self.socket_path.parent() != Some(self.state_dir.as_path())
        {
            return Err(DaemonError::new(
                "database_path and socket_path must be direct children of state_dir",
            ));
        }
        Ok(())
    }
}

struct StateLock {
    path: PathBuf,
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub struct Daemon {
    socket_path: PathBuf,
    shutdown: Option<oneshot::Sender<()>>,
    server: Option<JoinHandle<Arc<StorageActor>>>,
    state_lock: Option<StateLock>,
}

impl Daemon {
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub async fn shutdown(mut self) -> Result<()> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let actor = self
            .server
            .take()
            .ok_or_else(|| DaemonError::new("daemon server is not running"))?
            .await
            .map_err(|_| DaemonError::new("daemon server task failed"))?;
        let mut actor = Arc::try_unwrap(actor)
            .map_err(|_| DaemonError::new("daemon connections did not shut down"))?;
        actor
            .shutdown()
            .map_err(|error| DaemonError::new(format!("{}: {}", error.name, error.message)))?;
        remove_socket(&self.socket_path)?;
        self.state_lock.take();
        Ok(())
    }
}

pub async fn launch(config: DaemonConfig) -> Result<Daemon> {
    config.validate()?;
    prepare_private_directory(&config.state_dir)?;
    let state_lock = acquire_state_lock(&config.state_dir)?;
    remove_stale_socket(&config.socket_path).await?;
    let approver_token = Arc::new(ensure_approver_token(&config.state_dir)?);
    let actor_config = StorageActorConfig::new(&config.database_path, config.database_key.to_vec());
    let actor = StorageActor::start(actor_config)
        .map_err(|error| DaemonError::new(format!("{}: {}", error.name, error.message)))?;
    let actor = Arc::new(actor);
    let listener = match UnixListener::bind(&config.socket_path) {
        Ok(listener) => listener,
        Err(error) => {
            return Err(DaemonError::new(format!(
                "unable to bind daemon socket: {error}"
            )));
        }
    };
    fs::set_permissions(&config.socket_path, fs::Permissions::from_mode(0o600))
        .map_err(|error| DaemonError::new(format!("unable to secure daemon socket: {error}")))?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server_actor = Arc::clone(&actor);
    let server = tokio::spawn(async move {
        run_server(listener, server_actor, approver_token, shutdown_rx).await
    });
    Ok(Daemon {
        socket_path: config.socket_path,
        shutdown: Some(shutdown_tx),
        server: Some(server),
        state_lock: Some(state_lock),
    })
}

async fn run_server(
    listener: UnixListener,
    actor: Arc<StorageActor>,
    approver_token: Arc<Zeroizing<String>>,
    mut shutdown: oneshot::Receiver<()>,
) -> Arc<StorageActor> {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => {
                    let actor = Arc::clone(&actor);
                    let token = Arc::clone(&approver_token);
                    connections.spawn(async move { handle_connection(socket, actor, token).await; });
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
}

async fn handle_connection(
    mut socket: UnixStream,
    actor: Arc<StorageActor>,
    approver_token: Arc<Zeroizing<String>>,
) {
    let mut decoder = match JsonLinesDecoder::new(MAX_CLIENT_FRAME_BYTES) {
        Ok(decoder) => decoder,
        Err(_) => return,
    };
    let mut session = Session {
        id: Uuid::new_v4().to_string(),
        role: None,
        trusted_approver: false,
    };
    let mut chunk = [0_u8; 8_192];
    loop {
        let received = match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(received) => received,
        };
        let frames = match decoder.push(&chunk[..received]) {
            Ok(frames) => frames,
            Err(error) => {
                let _ = write_frame(
                    &mut socket,
                    failure("invalid", "system.ping", "BAD_REQUEST", &error.message),
                )
                .await;
                let _ = socket.shutdown().await;
                return;
            }
        };
        for frame in frames {
            let raw_id = frame
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("invalid")
                .to_owned();
            let raw_method = frame
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("system.ping")
                .to_owned();
            let request = match parse_request(&frame, session.role) {
                Ok(request) => request,
                Err(error) => {
                    if write_frame(
                        &mut socket,
                        failure(&raw_id, &raw_method, "BAD_REQUEST", &error.message),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }
            };
            let response = match dispatch(&mut session, &actor, &approver_token, &request).await {
                Ok(result) => success(&request.id, &request.method, result),
                Err(error) => failure(&request.id, &request.method, error.code, &error.message),
            };
            if write_frame(&mut socket, response).await.is_err() {
                return;
            }
        }
    }
}

struct RpcError {
    code: &'static str,
    message: String,
}

impl RpcError {
    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: "UNSUPPORTED",
            message: message.into(),
        }
    }
}

async fn dispatch(
    session: &mut Session,
    _actor: &Arc<StorageActor>,
    approver_token: &str,
    request: &ProtocolRequest,
) -> std::result::Result<Value, RpcError> {
    if request.method == "system.hello" {
        let role = ClientRole::parse(
            request
                .params
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map_err(|error| RpcError {
            code: "BAD_REQUEST",
            message: error.message,
        })?;
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
    expected.as_bytes().len() == supplied.as_bytes().len()
        && bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}

fn prepare_private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)
        .map_err(|error| DaemonError::new(format!("unable to create state directory: {error}")))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| DaemonError::new(format!("unable to inspect state directory: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(DaemonError::new(
            "daemon state directory must be a real directory",
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| DaemonError::new(format!("unable to secure state directory: {error}")))?;
    Ok(())
}

fn acquire_state_lock(directory: &Path) -> Result<StateLock> {
    let path = directory.join("inboxd.lock");
    for _ in 0..2 {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut file) => {
                let receipt = json!({
                    "pid": std::process::id(),
                    "created_at": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis(),
                });
                writeln!(file, "{receipt}").map_err(|error| {
                    DaemonError::new(format!("unable to write daemon lock: {error}"))
                })?;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|error| {
                    DaemonError::new(format!("unable to secure daemon lock: {error}"))
                })?;
                return Ok(StateLock { path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_owner_alive(&path) {
                    return Err(DaemonError::new(
                        "another inboxd daemon already owns this state directory",
                    ));
                }
                fs::remove_file(&path)
                    .map_err(|_| DaemonError::new("unable to reclaim stale daemon lock"))?;
            }
            Err(error) => {
                return Err(DaemonError::new(format!(
                    "unable to create daemon lock: {error}"
                )));
            }
        }
    }
    Err(DaemonError::new(
        "another inboxd daemon already owns this state directory",
    ))
}

fn lock_owner_alive(path: &Path) -> bool {
    let pid = fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .and_then(|value| value.get("pid").and_then(Value::as_u64))
        .filter(|pid| *pid > 0);
    let Some(pid) = pid else {
        return true;
    };
    Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .is_ok_and(|status| status.success())
}

async fn remove_stale_socket(path: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(DaemonError::new(format!(
                "unable to inspect daemon socket: {error}"
            )));
        }
    };
    if !metadata.file_type().is_socket() {
        return Err(DaemonError::new(
            "daemon socket path exists but is not a socket",
        ));
    }
    if UnixStream::connect(path).await.is_ok() {
        return Err(DaemonError::new("daemon socket is already reachable"));
    }
    fs::remove_file(path)
        .map_err(|error| DaemonError::new(format!("unable to remove stale socket: {error}")))
}

fn remove_socket(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(DaemonError::new(format!(
            "unable to remove daemon socket: {error}"
        ))),
    }
}

fn ensure_approver_token(directory: &Path) -> Result<Zeroizing<String>> {
    let path = directory.join("approver.token");
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut file) => {
            let mut bytes = Zeroizing::new([0_u8; 32]);
            getrandom::fill(bytes.as_mut())
                .map_err(|_| DaemonError::new("secure approver token generation failed"))?;
            let token = Zeroizing::new(hex(bytes.as_ref()));
            file.write_all(token.as_bytes())
                .and_then(|_| file.write_all(b"\n"))
                .map_err(|error| {
                    DaemonError::new(format!("unable to write approver token: {error}"))
                })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(DaemonError::new(format!(
                "unable to create approver token: {error}"
            )));
        }
    }
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| DaemonError::new(format!("unable to inspect approver token: {error}")))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.permissions().mode() & 0o777 != 0o600
    {
        return Err(DaemonError::new(
            "local approver token is not an owner-only regular file",
        ));
    }
    let token = Zeroizing::new(
        fs::read_to_string(path)
            .map_err(|error| DaemonError::new(format!("unable to read approver token: {error}")))?
            .trim()
            .to_owned(),
    );
    if token.len() < 32
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(DaemonError::new("local approver token is invalid"));
    }
    Ok(token)
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}
