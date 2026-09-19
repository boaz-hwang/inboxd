//! Rust-owned inboxd daemon and UDS lifecycle.
#![forbid(unsafe_code)]

mod accounts;
pub use accounts::AccountConfig;
mod capability;
mod coordinator;
mod server;
mod worker;

pub use capability::TrustedBinding;
#[cfg(feature = "test-worker")]
pub use worker::TestWorkerConfig;
pub use worker::{
    ProductionWorkerConfig, WorkerError, WorkerSupervisor, validate_trusted_executable_for_owner,
};

use inboxd_storage::{StorageActor, StorageActorConfig};
use serde_json::{Value, json};
use std::{
    error::Error,
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, atomic::AtomicUsize},
};
use tokio::{
    net::{UnixListener, UnixStream},
    sync::oneshot,
    task::JoinHandle,
};
use zeroize::Zeroizing;

use capability::CapabilityRegistry;
use server::{EventHub, ServerRuntime, run_server};

const DEFAULT_MAX_QUEUED_EVENTS: usize = 256;
const MAX_QUEUED_EVENTS: usize = 4_096;

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
    max_queued_events: usize,
    bindings: Vec<TrustedBinding>,
    accounts: Vec<AccountConfig>,
}

impl fmt::Debug for DaemonConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonConfig")
            .field("state_dir", &self.state_dir)
            .field("database_path", &self.database_path)
            .field("socket_path", &self.socket_path)
            .field("database_key", &"<redacted>")
            .field("max_queued_events", &self.max_queued_events)
            .field("bindings", &self.bindings.len())
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
            max_queued_events: self.max_queued_events,
            bindings: self.bindings.clone(),
            accounts: self.accounts.clone(),
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
            max_queued_events: DEFAULT_MAX_QUEUED_EVENTS,
            bindings: Vec::new(),
            accounts: Vec::new(),
        }
    }

    pub fn with_max_queued_events(mut self, maximum: usize) -> Self {
        self.max_queued_events = maximum;
        self
    }

    pub fn with_accounts(mut self, accounts: Vec<AccountConfig>) -> Self {
        self.accounts = accounts;
        self
    }

    pub fn with_bindings(mut self, bindings: Vec<TrustedBinding>) -> Self {
        self.bindings = bindings;
        self
    }

    fn validate(&self) -> Result<()> {
        if self.database_key.is_empty() {
            return Err(DaemonError::new("database key must not be empty"));
        }
        if !(1..=MAX_QUEUED_EVENTS).contains(&self.max_queued_events) {
            return Err(DaemonError::new(format!(
                "max queued events must be from 1 to {MAX_QUEUED_EVENTS}"
            )));
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
    server: Option<JoinHandle<Arc<ServerOwner>>>,
    events: Arc<EventHub>,
    capabilities: Arc<CapabilityRegistry>,
    #[cfg(feature = "test-worker")]
    connection_tasks: Arc<AtomicUsize>,
}

pub(crate) struct ServerOwner {
    pub(crate) actor: Arc<StorageActor>,
    state_lock: StateLock,
}

impl Daemon {
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Publishes a committed notification. Overflowed subscribers are closed and
    /// must reconnect, resubscribe, and re-query; notifications are not replayed.
    pub fn publish_event(
        &self,
        method: &str,
        params: Value,
    ) -> std::result::Result<usize, DaemonError> {
        self.events.publish(method, params)
    }

    /// Removes a trusted fixed binding. Capability notifications are emitted
    /// only when the registry actually changed.
    pub async fn revoke_binding(&self, binding_id: &str) -> Result<bool> {
        let revoked = self.capabilities.revoke(binding_id).await;
        if revoked {
            self.events
                .publish("capability.changed", json!({"binding_id":binding_id}))?;
        }
        Ok(revoked)
    }

    /// Arms a deterministic test-only revocation between durable claim and
    /// provider dispatch.
    #[cfg(feature = "test-worker")]
    pub fn revoke_binding_after_next_claim(&self, binding_id: impl Into<String>) {
        self.capabilities.revoke_after_next_claim(binding_id);
    }

    #[cfg(feature = "test-worker")]
    pub fn retained_connection_tasks(&self) -> usize {
        self.connection_tasks
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub async fn shutdown(mut self) -> Result<()> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let owner = self
            .server
            .as_mut()
            .ok_or_else(|| DaemonError::new("daemon server is not running"))?
            .await
            .map_err(|_| DaemonError::new("daemon server task failed"))?;
        self.server.take();
        let owner = Arc::try_unwrap(owner)
            .map_err(|_| DaemonError::new("daemon connections did not shut down"))?;
        let ServerOwner { actor, state_lock } = owner;
        let mut actor = Arc::try_unwrap(actor)
            .map_err(|_| DaemonError::new("daemon connections retained storage ownership"))?;
        let actor_result = actor
            .shutdown()
            .map_err(|error| DaemonError::new(format!("{}: {}", error.name, error.message)));
        drop(actor);
        let socket_result = remove_socket(&self.socket_path);
        drop(state_lock);
        actor_result?;
        socket_result
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(server) = self.server.take() {
            server.abort();
        }
        let _ = remove_socket(&self.socket_path);
    }
}

pub async fn launch(config: DaemonConfig) -> Result<Daemon> {
    config.validate()?;
    let capabilities = Arc::new(CapabilityRegistry::new(config.bindings.clone())?);
    prepare_private_directory(&config.state_dir)?;
    let state_lock = acquire_state_lock(&config.state_dir)?;
    remove_stale_socket(&config.socket_path).await?;
    let approver_token = Arc::new(ensure_approver_token(&config.state_dir)?);
    let policy_capabilities = Arc::clone(&capabilities);
    let actor_config = StorageActorConfig::new(&config.database_path, config.database_key.to_vec())
        .with_send_policy(move |intent| policy_capabilities.allows_send(intent));
    let actor = StorageActor::start(actor_config)
        .map_err(|error| DaemonError::new(format!("{}: {}", error.name, error.message)))?;
    let actor = Arc::new(actor);
    let listener = UnixListener::bind(&config.socket_path)
        .map_err(|error| DaemonError::new(format!("unable to bind daemon socket: {error}")))?;
    fs::set_permissions(&config.socket_path, fs::Permissions::from_mode(0o600))
        .map_err(|error| DaemonError::new(format!("unable to secure daemon socket: {error}")))?;
    let events = Arc::new(EventHub::default());
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let owner = Arc::new(ServerOwner { actor, state_lock });
    let server_owner = Arc::clone(&owner);
    let server_events = Arc::clone(&events);
    let server_capabilities = Arc::clone(&capabilities);
    let connection_tasks = Arc::new(AtomicUsize::new(0));
    let server_connection_tasks = Arc::clone(&connection_tasks);
    let maximum = config.max_queued_events;
    let server = tokio::spawn(async move {
        run_server(
            listener,
            server_owner,
            approver_token,
            ServerRuntime {
                accounts: Arc::new(accounts::AccountService::new(config.accounts)),
                events: server_events,
                capabilities: server_capabilities,
                connection_tasks: server_connection_tasks,
                max_queued_events: maximum,
            },
            shutdown_rx,
        )
        .await
    });
    Ok(Daemon {
        socket_path: config.socket_path,
        shutdown: Some(shutdown_tx),
        server: Some(server),
        events,
        capabilities,
        #[cfg(feature = "test-worker")]
        connection_tasks,
    })
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
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(DaemonError::new(
            "daemon state directory must be owned by the current user",
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
                let metadata = fs::symlink_metadata(&path)
                    .map_err(|_| DaemonError::new("unable to inspect existing daemon lock"))?;
                if metadata.file_type().is_symlink()
                    || !metadata.is_file()
                    || metadata.permissions().mode() & 0o777 != 0o600
                    || metadata.uid() != rustix::process::geteuid().as_raw()
                {
                    return Err(DaemonError::new(
                        "daemon lock is not an owner-only regular file",
                    ));
                }
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
        || metadata.uid() != rustix::process::geteuid().as_raw()
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
