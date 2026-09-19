use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    panic::{self, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use fs2::FileExt;
use inboxd_core::{CoreError, CoreResult};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use inboxd_core::{DescriptorIdentity, descriptor_identity};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::fd::{AsRawFd, RawFd};

use crate::NativeHost;

const DEFAULT_QUEUE_CAPACITY: usize = 64;
const MAX_QUEUE_CAPACITY: usize = 4096;
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TIMEOUT: Duration = Duration::from_secs(60);

const ACTOR_RUNNING: u8 = 1;
const ACTOR_STOPPED: u8 = 2;
const ACTOR_PANICKED: u8 = 3;

pub struct StorageActorConfig {
    path: PathBuf,
    key: Zeroizing<Vec<u8>>,
    queue_capacity: usize,
    startup_timeout: Duration,
    call_timeout: Duration,
    shutdown_timeout: Duration,
}

impl std::fmt::Debug for StorageActorConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StorageActorConfig")
            .field("path", &self.path)
            .field("key", &"<redacted>")
            .field("queue_capacity", &self.queue_capacity)
            .field("startup_timeout", &self.startup_timeout)
            .field("call_timeout", &self.call_timeout)
            .field("shutdown_timeout", &self.shutdown_timeout)
            .finish()
    }
}

impl StorageActorConfig {
    pub fn new(path: impl AsRef<Path>, key: impl Into<Vec<u8>>) -> Self {
        Self {
            path: path.as_ref().to_owned(),
            key: Zeroizing::new(key.into()),
            queue_capacity: DEFAULT_QUEUE_CAPACITY,
            startup_timeout: DEFAULT_STARTUP_TIMEOUT,
            call_timeout: DEFAULT_CALL_TIMEOUT,
            shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
        }
    }

    pub fn with_queue_capacity(mut self, queue_capacity: usize) -> Self {
        self.queue_capacity = queue_capacity;
        self
    }

    pub fn with_startup_timeout(mut self, timeout: Duration) -> Self {
        self.startup_timeout = timeout;
        self
    }

    pub fn with_call_timeout(mut self, timeout: Duration) -> Self {
        self.call_timeout = timeout;
        self
    }

    pub fn with_shutdown_timeout(mut self, timeout: Duration) -> Self {
        self.shutdown_timeout = timeout;
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageOperation {
    Migrate,
    Diagnose,
    ApplySyncBatch,
    ReadSyncState,
    CoverageFor,
    GetMessage,
    RecordUnreadState,
    RecordAccountIdentity,
    RecentEvidence,
    RecentMessages,
    InboxMessages,
    SearchMessages,
    ObserveMessages,
    SearchAccountMessages,
    RecoverInterruptedSends,
    OwnerSendReserve,
    OwnerSendComplete,
    OwnerSendLookup,
    OwnerSendStatus,
    ChatList,
    AuditRead,
    SendStatus,
    SafetyInitialize,
    SafetyListPendingPage,
    SafetyGetIntent,
    SafetyReject,
}

impl StorageOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Migrate => "store.migrate",
            Self::Diagnose => "store.diagnose",
            Self::ApplySyncBatch => "store.applySyncBatch",
            Self::ReadSyncState => "store.readSyncState",
            Self::CoverageFor => "store.coverageFor",
            Self::GetMessage => "store.getMessage",
            Self::RecordUnreadState => "store.recordUnreadState",
            Self::RecordAccountIdentity => "store.recordAccountIdentity",
            Self::RecentEvidence => "store.recentEvidence",
            Self::RecentMessages => "store.recentMessages",
            Self::InboxMessages => "store.inboxMessages",
            Self::SearchMessages => "store.searchMessages",
            Self::ObserveMessages => "observations.store",
            Self::SearchAccountMessages => "observations.search",
            Self::RecoverInterruptedSends => "daemon.recoverInterruptedSends",
            Self::OwnerSendReserve => "ownerSend.reserve",
            Self::OwnerSendComplete => "ownerSend.complete",
            Self::OwnerSendLookup => "ownerSend.lookup",
            Self::OwnerSendStatus => "ownerSend.status",
            Self::ChatList => "daemon.chatList",
            Self::AuditRead => "daemon.auditRead",
            Self::SendStatus => "daemon.sendStatus",
            Self::SafetyInitialize => "safety.initialize",
            Self::SafetyListPendingPage => "safety.listPendingPage",
            Self::SafetyGetIntent => "safety.getIntent",
            Self::SafetyReject => "safety.reject",
        }
    }
}

enum ActorResponse {
    Blocking(SyncSender<CoreResult<Value>>),
    Async(tokio::sync::oneshot::Sender<CoreResult<Value>>),
}

impl ActorResponse {
    fn send(self, result: CoreResult<Value>) {
        match self {
            Self::Blocking(sender) => {
                let _ = sender.send(result);
            }
            Self::Async(sender) => {
                let _ = sender.send(result);
            }
        }
    }
}

enum ActorMessage {
    Call {
        operation: StorageOperation,
        input: Value,
        response: ActorResponse,
    },
    Shutdown,
}

pub struct StorageActor {
    sender: Option<SyncSender<ActorMessage>>,
    thread: Option<JoinHandle<()>>,
    done: Mutex<Receiver<()>>,
    state: Arc<AtomicU8>,
    call_timeout: Duration,
    shutdown_timeout: Duration,
}

impl std::fmt::Debug for StorageActor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StorageActor")
            .field("state", &self.state.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

fn actor_terminal_error(state: u8, stopped_message: &str) -> CoreError {
    if state == ACTOR_PANICKED {
        CoreError::new("ActorPanickedError", "storage actor panicked")
    } else {
        CoreError::new("ActorStoppedError", stopped_message)
    }
}

fn contain_actor_call(
    state: &AtomicU8,
    call: impl FnOnce() -> CoreResult<Value>,
) -> CoreResult<Value> {
    match panic::catch_unwind(AssertUnwindSafe(call)) {
        Ok(Err(error)) if error.name == "CorePanic" => {
            state.store(ACTOR_PANICKED, Ordering::Release);
            Err(actor_terminal_error(
                ACTOR_PANICKED,
                "storage actor stopped during a call",
            ))
        }
        Ok(result) => result,
        Err(_) => {
            state.store(ACTOR_PANICKED, Ordering::Release);
            Err(actor_terminal_error(
                ACTOR_PANICKED,
                "storage actor stopped during a call",
            ))
        }
    }
}

fn validate_timeout(timeout: Duration, field: &str) -> CoreResult<()> {
    if timeout.is_zero() || timeout > MAX_TIMEOUT {
        Err(CoreError::new(
            "ActorConfigurationError",
            format!("{field} must be greater than zero and at most 60 seconds"),
        ))
    } else {
        Ok(())
    }
}

impl StorageActor {
    pub fn start(config: StorageActorConfig) -> CoreResult<Self> {
        if !(1..=MAX_QUEUE_CAPACITY).contains(&config.queue_capacity) {
            return Err(CoreError::new(
                "ActorConfigurationError",
                format!("queue capacity must be from 1 to {MAX_QUEUE_CAPACITY}"),
            ));
        }

        validate_timeout(config.startup_timeout, "startup timeout")?;
        validate_timeout(config.call_timeout, "call timeout")?;
        validate_timeout(config.shutdown_timeout, "shutdown timeout")?;

        let queue_capacity = config.queue_capacity;
        let startup_timeout = config.startup_timeout;
        let call_timeout = config.call_timeout;
        let shutdown_timeout = config.shutdown_timeout;
        let startup_started = Instant::now();

        // Establish and initialize the SQLCipher owner before a worker exists.
        // A slow startup is reported only after synchronous ownership cleanup;
        // there is never a JoinHandle to detach on this path.
        let (host, lease) = open_writer(config)?;
        // Struct field drop order applies on startup error, spawn failure,
        // worker panic and normal shutdown alike.
        let owner = StorageOwner {
            host,
            _lease: lease,
        };
        owner.host.execute("store.migrate", &Value::Null)?;
        owner.host.execute("safety.initialize", &Value::Null)?;
        owner
            .host
            .execute("daemon.recoverInterruptedSends", &Value::Null)?;
        owner.host.execute("ownerSend.recover", &Value::Null)?;
        owner.host.execute("store.diagnose", &Value::Null)?;
        if startup_started.elapsed() > startup_timeout {
            return Err(CoreError::new(
                "ActorStartupTimeoutError",
                "storage actor startup exceeded its configured bound; ownership was reclaimed",
            ));
        }

        let (sender, receiver) = mpsc::sync_channel(queue_capacity);
        let (done_sender, done_receiver) = mpsc::sync_channel(1);
        let state = Arc::new(AtomicU8::new(ACTOR_RUNNING));
        let thread_state = Arc::clone(&state);
        let thread = thread::Builder::new()
            .name("inboxd-storage".into())
            .spawn(move || {
                let outcome = panic::catch_unwind(AssertUnwindSafe(|| {
                    let owner = owner;
                    while let Ok(message) = receiver.recv() {
                        match message {
                            ActorMessage::Call {
                                operation,
                                input,
                                response,
                            } => {
                                let result = contain_actor_call(&thread_state, || {
                                    owner.host.execute(operation.as_str(), &input)
                                });
                                let panicked =
                                    thread_state.load(Ordering::Acquire) == ACTOR_PANICKED;
                                response.send(result);
                                if panicked {
                                    break;
                                }
                            }
                            ActorMessage::Shutdown => break,
                        }
                    }
                }));
                if outcome.is_err() {
                    thread_state.store(ACTOR_PANICKED, Ordering::Release);
                } else if thread_state.load(Ordering::Acquire) != ACTOR_PANICKED {
                    thread_state.store(ACTOR_STOPPED, Ordering::Release);
                }
                let _ = done_sender.send(());
            })
            .map_err(|_| CoreError::new("ActorStartError", "unable to start storage actor"))?;

        Ok(Self {
            sender: Some(sender),
            thread: Some(thread),
            done: Mutex::new(done_receiver),
            state,
            call_timeout,
            shutdown_timeout,
        })
    }

    /// Blocking compatibility API for synchronous callers. Async runtimes must
    /// use `call_async` so a slow database does not occupy an executor thread.
    pub fn call(&self, operation: StorageOperation, input: Value) -> CoreResult<Value> {
        let (response, result) = mpsc::sync_channel(1);
        self.enqueue(operation, input, ActorResponse::Blocking(response))?;
        match result.recv_timeout(self.call_timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(CoreError::new(
                "ActorCallTimeoutError",
                "storage actor call timed out",
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(actor_terminal_error(
                self.state.load(Ordering::Acquire),
                "storage actor stopped without a response",
            )),
        }
    }

    /// Enqueues once and suspends while the single database owner executes it.
    /// Timeout or cancellation abandons only the response: an accepted write may
    /// still commit. Callers must not infer rollback or automatically replay it.
    pub async fn call_async(&self, operation: StorageOperation, input: Value) -> CoreResult<Value> {
        let (response, result) = tokio::sync::oneshot::channel();
        self.enqueue(operation, input, ActorResponse::Async(response))?;
        match tokio::time::timeout(self.call_timeout, result).await {
            Ok(Ok(result)) => result,
            Err(_) => Err(CoreError::new(
                "ActorCallTimeoutError",
                "storage actor call timed out",
            )),
            Ok(Err(_)) => Err(actor_terminal_error(
                self.state.load(Ordering::Acquire),
                "storage actor stopped without a response",
            )),
        }
    }

    fn enqueue(
        &self,
        operation: StorageOperation,
        input: Value,
        response: ActorResponse,
    ) -> CoreResult<()> {
        let sender = self.sender.as_ref().ok_or_else(|| {
            actor_terminal_error(
                self.state.load(Ordering::Acquire),
                "storage actor is not running",
            )
        })?;
        match sender.try_send(ActorMessage::Call {
            operation,
            input,
            response,
        }) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(CoreError::new(
                "ActorOverloadedError",
                "storage actor queue is full",
            )),
            Err(TrySendError::Disconnected(_)) => Err(actor_terminal_error(
                self.state.load(Ordering::Acquire),
                "storage actor is not running",
            )),
        }
    }

    /// Requests shutdown and waits up to the configured API bound. A timeout
    /// retains the worker handle so the caller can retry; dropping the actor
    /// performs the final, potentially blocking fail-closed join.
    pub fn shutdown(&mut self) -> CoreResult<()> {
        self.begin_shutdown();
        let completed = self
            .done
            .lock()
            .map_err(|_| CoreError::new("ActorPanickedError", "actor completion lock poisoned"))?
            .recv_timeout(self.shutdown_timeout);
        match completed {
            Ok(()) => {
                self.join_worker();
                let current = self.state.load(Ordering::Acquire);
                if current == ACTOR_PANICKED {
                    Err(actor_terminal_error(current, "storage actor stopped"))
                } else {
                    Ok(())
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => Err(CoreError::new(
                "ActorShutdownTimeoutError",
                "storage actor shutdown timed out; cleanup ownership was retained",
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.join_worker();
                Err(actor_terminal_error(
                    self.state.load(Ordering::Acquire),
                    "storage actor completion channel disconnected",
                ))
            }
        }
    }

    fn begin_shutdown(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.try_send(ActorMessage::Shutdown);
            drop(sender);
        }
    }

    fn join_worker(&mut self) {
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                self.state.store(ACTOR_PANICKED, Ordering::Release);
            }
        }
    }
}

impl Drop for StorageActor {
    fn drop(&mut self) {
        self.begin_shutdown();
        self.join_worker();
    }
}

fn canonical_database_path(path: &Path) -> CoreResult<PathBuf> {
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            CoreError::new(
                "WriterPathCanonicalizationError",
                "database path must name a file",
            )
        })?;
    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent).map_err(|_| {
        CoreError::new(
            "WriterPathCanonicalizationError",
            "unable to canonicalize the database parent directory",
        )
    })?;
    let metadata = fs::symlink_metadata(&parent).map_err(|_| {
        CoreError::new(
            "WriterPathOwnershipError",
            "unable to inspect the canonical database parent directory",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(CoreError::new(
            "WriterPathOwnershipError",
            "database parent must be a canonical private directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let owner = fs::metadata(writer_lock_root()?)
            .map_err(|_| {
                CoreError::new(
                    "WriterPathOwnershipError",
                    "unable to identify the storage owner",
                )
            })?
            .uid();
        let mode = metadata.permissions().mode();
        if metadata.uid() != owner || mode & 0o077 != 0 || mode & 0o300 != 0o300 {
            return Err(CoreError::new(
                "WriterPathOwnershipError",
                format!(
                    "database parent must be owner-controlled and inaccessible to group and other users (uid={}, owner={owner}, mode={mode:o})",
                    metadata.uid()
                ),
            ));
        }
    }
    Ok(parent.join(file_name))
}

fn reject_unsupported_or_symlink(path: &Path) -> CoreResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CoreError::new(
            "WriterSymlinkError",
            "refusing a symlink database path",
        )),
        Ok(metadata) if !metadata.file_type().is_file() => Err(CoreError::new(
            "WriterLockUnsupportedError",
            "database path is not a regular file",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(CoreError::new(
            "WriterLockOpenError",
            "unable to inspect the database path",
        )),
    }
}

#[cfg(unix)]
fn verify_open_identity(path: &Path, file: &File) -> CoreResult<()> {
    use std::os::unix::fs::MetadataExt;

    let opened = file.metadata().map_err(|_| {
        CoreError::new(
            "WriterLockOpenError",
            "unable to inspect the opened database file",
        )
    })?;
    let current = fs::symlink_metadata(path).map_err(|_| {
        CoreError::new(
            "WriterIdentityChangedError",
            "database path changed while establishing writer identity",
        )
    })?;
    if current.file_type().is_symlink() {
        return Err(CoreError::new(
            "WriterSymlinkError",
            "refusing a symlink database path",
        ));
    }
    if !current.file_type().is_file()
        || opened.dev() != current.dev()
        || opened.ino() != current.ino()
    {
        return Err(CoreError::new(
            "WriterIdentityChangedError",
            "database path changed while establishing writer identity",
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn verify_open_identity(path: &Path, file: &File) -> CoreResult<()> {
    if !file
        .metadata()
        .map_err(|_| {
            CoreError::new(
                "WriterLockOpenError",
                "unable to inspect the opened database file",
            )
        })?
        .is_file()
        || !fs::symlink_metadata(path)
            .map_err(|_| {
                CoreError::new(
                    "WriterIdentityChangedError",
                    "database path changed while establishing writer identity",
                )
            })?
            .is_file()
    {
        return Err(CoreError::new(
            "WriterLockUnsupportedError",
            "database path is not a regular file",
        ));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct OpenDescriptorSnapshot {
    identities: BTreeMap<RawFd, DescriptorIdentity>,
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
struct OpenDescriptorSnapshot;

#[cfg(target_os = "macos")]
const OPEN_DESCRIPTOR_DIRECTORY: &str = "/dev/fd";
#[cfg(target_os = "linux")]
const OPEN_DESCRIPTOR_DIRECTORY: &str = "/proc/self/fd";

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn descriptor_proof_error(message: &str) -> CoreError {
    CoreError::new("WriterDescriptorProofError", message)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn snapshot_open_descriptors_once() -> CoreResult<OpenDescriptorSnapshot> {
    let entries = fs::read_dir(OPEN_DESCRIPTOR_DIRECTORY).map_err(|_| {
        descriptor_proof_error("unable to enumerate process descriptors for database identity")
    })?;
    let mut identities = BTreeMap::new();
    for entry in entries {
        let entry = entry
            .map_err(|_| descriptor_proof_error("unable to enumerate every process descriptor"))?;
        let descriptor_number = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u64>().ok())
            .ok_or_else(|| {
                descriptor_proof_error("process descriptor enumeration was ambiguous")
            })?;
        let descriptor = RawFd::try_from(descriptor_number)
            .map_err(|_| descriptor_proof_error("process descriptor number was out of range"))?;
        // `fstat` the borrowed descriptor itself. Never open `/dev/fd/N` or
        // `/proc/self/fd/N`: dropping such a duplicate can release every POSIX
        // lock this process holds on the file, including locks owned by another
        // SQLite connection. The ReadDir's non-file descriptor stays in the
        // snapshot so fd-number reuse still changes identity.
        // A descriptor may close after `/dev/fd` enumerates it (Tokio and
        // other runtimes legitimately create short-lived descriptors). Ignore
        // that raced entry: the database proof below still requires exactly
        // one live descriptor with the leased inode in two consecutive
        // snapshots, so a raced database descriptor cannot be accepted.
        let identity = match descriptor_identity(descriptor) {
            Ok(identity) => identity,
            Err(error) if error.raw_os_error() == Some(libc::EBADF) => continue,
            Err(_) => {
                return Err(descriptor_proof_error(
                    "unable to inspect a live process descriptor during database identity proof",
                ));
            }
        };
        if identities.insert(descriptor, identity).is_some() {
            return Err(descriptor_proof_error(
                "process descriptor enumeration contained a duplicate number",
            ));
        }
    }
    if identities.is_empty() {
        return Err(descriptor_proof_error(
            "process descriptor enumeration returned no descriptors",
        ));
    }
    Ok(OpenDescriptorSnapshot { identities })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn snapshot_open_descriptors() -> CoreResult<OpenDescriptorSnapshot> {
    const MAX_ATTEMPTS: usize = 32;

    let mut last_error = None;
    for _ in 0..MAX_ATTEMPTS {
        match snapshot_open_descriptors_once() {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) => {
                last_error = Some(error);
                thread::yield_now();
            }
        }
    }
    Err(last_error.expect("descriptor snapshot attempts are nonzero"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn snapshot_open_descriptors() -> CoreResult<OpenDescriptorSnapshot> {
    Err(CoreError::new(
        "WriterLockUnsupportedError",
        "opened database descriptor identity proof is unsupported on this platform",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn new_database_descriptor_candidates(
    before: &OpenDescriptorSnapshot,
    opened: &OpenDescriptorSnapshot,
    leased_identity: DescriptorIdentity,
) -> Vec<RawFd> {
    opened
        .identities
        .iter()
        .filter_map(|(descriptor, identity)| {
            (before.identities.get(descriptor) != Some(identity) && *identity == leased_identity)
                .then_some(*descriptor)
        })
        .collect()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn verify_new_database_descriptor(
    before: &OpenDescriptorSnapshot,
    leased_file: &File,
) -> CoreResult<()> {
    let leased_identity = descriptor_identity(leased_file.as_raw_fd())
        .map_err(|_| descriptor_proof_error("unable to inspect the leased database descriptor"))?;
    let opened = snapshot_open_descriptors()?;
    let candidates = new_database_descriptor_candidates(before, &opened, leased_identity);
    let [candidate] = candidates.as_slice() else {
        return Err(CoreError::new(
            "WriterIdentityChangedError",
            "SQLite did not retain exactly one newly opened descriptor for the leased database inode",
        ));
    };

    // Confirm the exact descriptor number still names the leased device and
    // inode after enumeration, rather than accepting a descriptor that closed
    // or was reused mid-proof.
    let confirmed = snapshot_open_descriptors()?;
    let confirmed_candidates =
        new_database_descriptor_candidates(before, &confirmed, leased_identity);
    if confirmed_candidates.as_slice() != [*candidate] {
        return Err(CoreError::new(
            "WriterIdentityChangedError",
            "SQLite's newly opened database descriptor did not remain uniquely bound to the leased inode",
        ));
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn verify_new_database_descriptor(_: &OpenDescriptorSnapshot, _: &File) -> CoreResult<()> {
    Err(CoreError::new(
        "WriterLockUnsupportedError",
        "opened database descriptor identity proof is unsupported on this platform",
    ))
}

// Fields drop in declaration order: close SQLCipher before unlocking ownership.
struct StorageOwner {
    host: NativeHost,
    _lease: WriterLease,
}

struct WriterLease {
    identity: File,
    _lock: File,
    _path_guard: PathMutationGuard,
}

struct PathMutationGuard {
    _lock: File,
}

impl Drop for WriterLease {
    fn drop(&mut self) {
        // Closing our fd is insufficient while a concurrently forked child
        // still shares its open file description before exec/CLOEXEC.
        let _ = FileExt::unlock(&self._lock);
    }
}

impl Drop for PathMutationGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self._lock);
    }
}

fn writer_lock_root() -> CoreResult<PathBuf> {
    let root = std::env::temp_dir().join("inboxd-writer-locks-v1");
    match fs::create_dir(&root) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|_| {
                    CoreError::new(
                        "WriterLockOpenError",
                        "unable to secure the database writer lock directory",
                    )
                })?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => {
            return Err(CoreError::new(
                "WriterLockOpenError",
                "unable to create the database writer lock directory",
            ));
        }
    }
    let metadata = fs::symlink_metadata(&root).map_err(|_| {
        CoreError::new(
            "WriterLockOpenError",
            "unable to inspect the database writer lock directory",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
        return Err(CoreError::new(
            "WriterLockUnsupportedError",
            "database writer lock directory is not a private directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(CoreError::new(
                "WriterLockUnsupportedError",
                "database writer lock directory permissions are not private",
            ));
        }
    }
    Ok(root)
}

#[cfg(unix)]
fn writer_identity_lock_path(file: &File) -> CoreResult<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata().map_err(|_| {
        CoreError::new(
            "WriterLockOpenError",
            "unable to inspect the opened database file",
        )
    })?;
    Ok(writer_lock_root()?.join(format!(
        "database-{:016x}-{:016x}.lock",
        metadata.dev(),
        metadata.ino()
    )))
}

#[cfg(not(unix))]
fn writer_identity_lock_path(_: &File) -> CoreResult<PathBuf> {
    Err(CoreError::new(
        "WriterLockUnsupportedError",
        "alias-safe database writer identity is unsupported on this platform",
    ))
}

fn open_identity_lock(file: &File) -> CoreResult<File> {
    let path = writer_identity_lock_path(file)?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let lock = options.open(path).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return CoreError::new(
                "WriterLockUnsupportedError",
                "database writer lock path is a symlink",
            );
        }
        CoreError::new(
            "WriterLockOpenError",
            "unable to open the database writer identity lock",
        )
    })?;
    if !lock
        .metadata()
        .map_err(|_| {
            CoreError::new(
                "WriterLockOpenError",
                "unable to inspect the database writer identity lock",
            )
        })?
        .is_file()
    {
        return Err(CoreError::new(
            "WriterLockUnsupportedError",
            "database writer identity lock is not a regular file",
        ));
    }
    Ok(lock)
}

#[cfg(unix)]
fn path_mutation_lock_path(path: &Path) -> CoreResult<PathBuf> {
    use std::os::unix::ffi::OsStrExt;

    let digest = Sha256::digest(path.as_os_str().as_bytes());
    Ok(writer_lock_root()?.join(format!("path-{digest:x}.lock")))
}

#[cfg(not(unix))]
fn path_mutation_lock_path(_: &Path) -> CoreResult<PathBuf> {
    Err(CoreError::new(
        "WriterLockUnsupportedError",
        "path mutation locking is unsupported on this platform",
    ))
}

fn open_path_mutation_lock(path: &Path) -> CoreResult<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    options.open(path_mutation_lock_path(path)?).map_err(|_| {
        CoreError::new(
            "WriterLockOpenError",
            "unable to open the database path lock",
        )
    })
}

fn try_acquire_path_mutation_guard(path: &Path) -> CoreResult<PathMutationGuard> {
    let lock = open_path_mutation_lock(path)?;
    lock.try_lock_exclusive()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::WouldBlock => CoreError::new(
                "WriterAlreadyActiveError",
                "another owner controls the database path",
            ),
            std::io::ErrorKind::Unsupported => CoreError::new(
                "WriterLockUnsupportedError",
                "database path locking is unsupported on this filesystem",
            ),
            _ => CoreError::new(
                "WriterLockError",
                "unable to acquire the database path lock",
            ),
        })?;
    Ok(PathMutationGuard { _lock: lock })
}

#[cfg(test)]
type StartupHook = Box<dyn FnOnce(&Path) + Send>;
#[cfg(test)]
static TEST_STARTUP_HOOK: Mutex<Option<StartupHook>> = Mutex::new(None);
#[cfg(test)]
static TEST_POST_OPEN_HOOK: Mutex<Option<StartupHook>> = Mutex::new(None);

#[cfg(test)]
fn set_test_startup_hooks(before_open: StartupHook, after_open: StartupHook) {
    *TEST_STARTUP_HOOK.lock().expect("startup hook lock") = Some(before_open);
    *TEST_POST_OPEN_HOOK.lock().expect("post-open hook lock") = Some(after_open);
}

#[cfg(test)]
fn run_test_startup_hook(path: &Path) {
    if let Some(hook) = TEST_STARTUP_HOOK.lock().expect("startup hook lock").take() {
        hook(path);
    }
}

#[cfg(test)]
fn run_test_post_open_hook(path: &Path) {
    if let Some(hook) = TEST_POST_OPEN_HOOK
        .lock()
        .expect("post-open hook lock")
        .take()
    {
        hook(path);
    }
}

fn acquire_writer_lock(path: &Path) -> CoreResult<(PathBuf, WriterLease)> {
    let path = canonical_database_path(path)?;
    let path_guard = try_acquire_path_mutation_guard(&path)?;
    reject_unsupported_or_symlink(&path)?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let identity = options.open(&path).map_err(|error| {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ELOOP) {
            return CoreError::new("WriterSymlinkError", "refusing a symlink database path");
        }
        if error.kind() == std::io::ErrorKind::Unsupported {
            CoreError::new(
                "WriterLockUnsupportedError",
                "database writer identity is unsupported on this filesystem",
            )
        } else {
            CoreError::new(
                "WriterIdentityOpenError",
                "unable to open the database for writer identity",
            )
        }
    })?;
    if !identity
        .metadata()
        .map_err(|_| {
            CoreError::new(
                "WriterIdentityOpenError",
                "unable to inspect the opened database file",
            )
        })?
        .is_file()
    {
        return Err(CoreError::new(
            "WriterLockUnsupportedError",
            "database path is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if identity
            .metadata()
            .map_err(|_| {
                CoreError::new(
                    "WriterIdentityOpenError",
                    "unable to inspect the opened database file",
                )
            })?
            .nlink()
            != 1
        {
            return Err(CoreError::new(
                "WriterHardLinkError",
                "database files with hard-link aliases are unsupported",
            ));
        }
    }
    verify_open_identity(&path, &identity)?;
    let lock = open_identity_lock(&identity)?;
    lock.try_lock_exclusive()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::WouldBlock => CoreError::new(
                "WriterAlreadyActiveError",
                "another database writer is already active",
            ),
            std::io::ErrorKind::Unsupported => CoreError::new(
                "WriterLockUnsupportedError",
                "database writer locking is unsupported on this filesystem",
            ),
            _ => CoreError::new(
                "WriterLockError",
                "unable to acquire the database writer lock",
            ),
        })?;
    verify_open_identity(&path, &identity)?;
    Ok((
        path,
        WriterLease {
            identity,
            _lock: lock,
            _path_guard: path_guard,
        },
    ))
}

fn open_writer(config: StorageActorConfig) -> CoreResult<(NativeHost, WriterLease)> {
    let StorageActorConfig { path, key, .. } = config;
    let (path, lease) = acquire_writer_lock(&path)?;
    let production_open_guard = NativeHost::acquire_production_open_guard()?;
    #[cfg(test)]
    run_test_startup_hook(&path);
    let descriptors_before_open = snapshot_open_descriptors()?;
    let host = NativeHost::open_production_with_guard(&path, &key, &production_open_guard);
    #[cfg(test)]
    if host.is_err() {
        run_test_post_open_hook(&path);
    }
    let host = host?;
    let opened_descriptor_proof =
        verify_new_database_descriptor(&descriptors_before_open, &lease.identity);
    #[cfg(test)]
    run_test_post_open_hook(&path);
    opened_descriptor_proof?;
    if host.opened_database_path()? != path {
        return Err(CoreError::new(
            "WriterIdentityChangedError",
            "SQLite reported an unexpected database path",
        ));
    }
    verify_open_identity(&path, &lease.identity)?;
    Ok((host, lease))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn released_writer_lease_does_not_wait_for_inherited_descriptor_copies() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let path = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("inherited.db");
        let (_, lease) = acquire_writer_lock(&path).unwrap();
        // dup and fork share the same open file description. A concurrent spawn
        // can hold these copies until exec applies CLOEXEC, even after shutdown
        // has joined the actor thread.
        let inherited_path = lease._path_guard._lock.try_clone().unwrap();
        let inherited_identity = lease._lock.try_clone().unwrap();
        drop(lease);
        let (_, reopened) = acquire_writer_lock(&path)
            .expect("released owner must unlock even while descriptor copies exist");
        drop((reopened, inherited_path, inherited_identity));
    }

    #[test]
    fn cross_process_path_swap_helper() {
        if std::env::var_os("INBOXD_PATH_SWAP_CHILD").is_none() {
            return;
        }
        let path = PathBuf::from(std::env::var_os("INBOXD_PATH_SWAP_PATH").unwrap());
        let replacement = PathBuf::from(std::env::var_os("INBOXD_PATH_SWAP_REPLACEMENT").unwrap());
        let displaced = PathBuf::from(std::env::var_os("INBOXD_PATH_SWAP_DISPLACED").unwrap());
        let state = PathBuf::from(std::env::var_os("INBOXD_PATH_SWAP_STATE").unwrap());
        let restore = PathBuf::from(std::env::var_os("INBOXD_PATH_SWAP_RESTORE").unwrap());

        // Deliberately ignore the advisory path-mutation lock. The writer must
        // prove which inode SQLite retained even against a non-cooperating peer.
        fs::rename(&path, &displaced).unwrap();
        fs::rename(&replacement, &path).unwrap();
        fs::write(&state, b"swapped").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !restore.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(restore.exists(), "parent did not release the swap child");
        fs::rename(&path, &replacement).unwrap();
        fs::rename(&displaced, &path).unwrap();
    }

    #[test]
    fn descriptor_candidate_rejects_same_inode_on_a_different_device() {
        let before = OpenDescriptorSnapshot {
            identities: BTreeMap::new(),
        };
        let opened = OpenDescriptorSnapshot {
            identities: BTreeMap::from([(
                9,
                inboxd_core::DescriptorIdentity {
                    device: 22,
                    inode: 7,
                    is_regular: true,
                },
            )]),
        };
        let leased = inboxd_core::DescriptorIdentity {
            device: 11,
            inode: 7,
            is_regular: true,
        };

        assert!(new_database_descriptor_candidates(&before, &opened, leased).is_empty());
    }

    #[test]
    fn actor_call_panic_is_contained_and_classified() {
        let state = AtomicU8::new(ACTOR_RUNNING);
        let result = contain_actor_call(&state, || -> CoreResult<Value> {
            panic!("synthetic actor panic")
        });
        let error = result.unwrap_err();
        assert_eq!(error.name, "ActorPanickedError");
        assert_eq!(state.load(Ordering::Acquire), ACTOR_PANICKED);
    }

    #[test]
    fn startup_rejects_noncooperative_cross_process_a_b_a_swap() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let path = directory.path().join("guarded.db");
        let replacement = directory.path().join("replacement.db");
        let displaced = directory.path().join("displaced.db");
        let state = directory.path().join("swap.state");
        let restore = directory.path().join("swap.restore");
        let key = [0x58; 32];
        let message_key = json!({"platform":"p","account":"a","chat_id":"c","msg_id":"from-b"});

        for database in [&path, &replacement] {
            let host = NativeHost::open_production(database, &key).unwrap();
            host.execute("store.migrate", &Value::Null).unwrap();
            if database == &replacement {
                host.execute(
                    "store.applySyncBatch",
                    &json!({"events":[{"kind":"create","revision":{"source":"adapter","value":1},"message":{"key":message_key,"author_id":"a","ts":1,"body":"opened replacement inode","attachments":[]}}]}),
                )
                .unwrap();
            }
        }

        #[cfg(unix)]
        let original_identities = {
            use std::os::unix::fs::MetadataExt;
            (
                (
                    fs::metadata(&path).unwrap().dev(),
                    fs::metadata(&path).unwrap().ino(),
                ),
                (
                    fs::metadata(&replacement).unwrap().dev(),
                    fs::metadata(&replacement).unwrap().ino(),
                ),
            )
        };
        let child = Arc::new(Mutex::new(None::<std::process::Child>));
        let before_child = Arc::clone(&child);
        let after_child = Arc::clone(&child);
        let child_replacement = replacement.clone();
        let child_displaced = displaced.clone();
        let child_state = state.clone();
        let child_restore = restore.clone();
        let observed_state = state.clone();
        let release_state = state.clone();
        let release_restore = restore.clone();

        set_test_startup_hooks(
            Box::new(move |opened_path| {
                let spawned = std::process::Command::new(std::env::current_exe().unwrap())
                    .arg("--exact")
                    .arg("actor::tests::cross_process_path_swap_helper")
                    .arg("--nocapture")
                    .env("INBOXD_PATH_SWAP_CHILD", "1")
                    .env("INBOXD_PATH_SWAP_PATH", opened_path)
                    .env("INBOXD_PATH_SWAP_REPLACEMENT", child_replacement)
                    .env("INBOXD_PATH_SWAP_DISPLACED", child_displaced)
                    .env("INBOXD_PATH_SWAP_STATE", &child_state)
                    .env("INBOXD_PATH_SWAP_RESTORE", child_restore)
                    .spawn()
                    .unwrap();
                before_child.lock().unwrap().replace(spawned);
                let deadline = Instant::now() + Duration::from_secs(10);
                while !observed_state.exists() && Instant::now() < deadline {
                    assert!(
                        before_child
                            .lock()
                            .unwrap()
                            .as_mut()
                            .unwrap()
                            .try_wait()
                            .unwrap()
                            .is_none(),
                        "swap child exited before reporting its result"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                assert!(
                    observed_state.exists(),
                    "swap child did not report its result"
                );
                assert_eq!(fs::read_to_string(&observed_state).unwrap(), "swapped");
            }),
            Box::new(move |_| {
                assert_eq!(fs::read_to_string(&release_state).unwrap(), "swapped");
                fs::write(release_restore, b"restore").unwrap();
                assert!(
                    after_child
                        .lock()
                        .unwrap()
                        .take()
                        .unwrap()
                        .wait()
                        .unwrap()
                        .success()
                );
            }),
        );

        let error = StorageActor::start(StorageActorConfig::new(&path, key)).unwrap_err();
        assert_eq!(error.name, "WriterIdentityChangedError");
        assert_eq!(fs::read_to_string(&state).unwrap(), "swapped");
        let mut actor = StorageActor::start(StorageActorConfig::new(&path, key)).unwrap();
        assert!(
            actor
                .call(StorageOperation::GetMessage, message_key)
                .unwrap()
                .is_null(),
            "SQLite retained the unleased replacement inode"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                (
                    fs::metadata(&path).unwrap().dev(),
                    fs::metadata(&path).unwrap().ino()
                ),
                original_identities.0
            );
            assert_eq!(
                (
                    fs::metadata(&replacement).unwrap().dev(),
                    fs::metadata(&replacement).unwrap().ino(),
                ),
                original_identities.1
            );
        }
        actor.shutdown().unwrap();
    }
}
