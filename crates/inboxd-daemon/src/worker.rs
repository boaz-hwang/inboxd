use inboxd_protocol::{
    NormalizedWorkerPage, validate_normalized_worker_page, validate_worker_request_frame,
    validate_worker_response_frame,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    error::Error,
    fmt,
    os::{fd::OwnedFd, unix::ffi::OsStrExt},
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Semaphore,
    time::timeout,
};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use rustix::{
    fs::{FileType, Mode, OFlags, fstat, mkdirat, openat},
    io::Errno,
};
#[cfg(target_os = "macos")]
use std::os::fd::AsFd;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerError {
    reason: &'static str,
    message: String,
    may_have_sent: bool,
}

impl WorkerError {
    fn new(reason: &'static str, message: impl Into<String>, may_have_sent: bool) -> Self {
        Self {
            reason,
            message: message.into(),
            may_have_sent,
        }
    }

    pub fn reason(&self) -> &'static str {
        self.reason
    }

    pub fn may_have_sent(&self) -> bool {
        self.may_have_sent
    }
}

impl fmt::Display for WorkerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for WorkerError {}

#[cfg(feature = "test-worker")]
#[derive(Clone, Debug)]
pub struct TestWorkerConfig {
    executable: PathBuf,
    scenario: String,
    timeout: Duration,
    max_response_bytes: usize,
    max_queue_depth: usize,
    state_path: Option<PathBuf>,
}

#[cfg(feature = "test-worker")]
impl TestWorkerConfig {
    pub fn new(executable: impl Into<PathBuf>, scenario: impl Into<String>) -> Self {
        Self {
            executable: executable.into(),
            scenario: scenario.into(),
            timeout: Duration::from_secs(5),
            max_response_bytes: 1_048_576,
            max_queue_depth: 8,
            state_path: None,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_max_response_bytes(mut self, maximum: usize) -> Self {
        self.max_response_bytes = maximum;
        self
    }

    pub fn with_max_queue_depth(mut self, maximum: usize) -> Self {
        self.max_queue_depth = maximum;
        self
    }

    pub fn with_state_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.state_path = Some(path.into());
        self
    }
}

/// Typed production worker configuration. Executable identity and environment
/// variable names are fixed by the daemon and cannot be supplied by config.
pub enum ProductionWorkerConfig {
    Slack {
        account: String,
        team_id: String,
        allowed_chat_ids_json: String,
        bot_token: String,
        session_cookie: Option<String>,
    },
    Telegram {
        account: String,
        self_user_id: String,
        chat_ids_json: String,
        api_id: String,
        api_hash: String,
        database_directory: String,
        files_directory: String,
    },
    KakaoPersonal {
        account: String,
        chat_id: String,
        credentials_json: String,
    },
    KakaoLocal {
        fixed_config_json: String,
    },
    KakaoOfficial {
        account: String,
        recipient_uuid_allowlist_json: String,
        template_id_allowlist_json: String,
        talk_message_consent: String,
        friends_message_permission: String,
        observed_at: String,
        auth_observation_json: String,
        auth_max_age_seconds: String,
        access_token: String,
    },
}

impl Zeroize for ProductionWorkerConfig {
    fn zeroize(&mut self) {
        match self {
            Self::Slack {
                bot_token,
                session_cookie,
                ..
            } => {
                bot_token.zeroize();
                session_cookie.zeroize();
            }
            Self::KakaoPersonal {
                credentials_json, ..
            } => credentials_json.zeroize(),
            Self::Telegram { api_hash, .. } => api_hash.zeroize(),
            Self::KakaoLocal { .. } => {}
            Self::KakaoOfficial { access_token, .. } => access_token.zeroize(),
        }
    }
}

impl ZeroizeOnDrop for ProductionWorkerConfig {}

impl Drop for ProductionWorkerConfig {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[derive(Default)]
struct ZeroizingEnvironment {
    values: BTreeMap<&'static str, Zeroizing<String>>,
}

impl ZeroizingEnvironment {
    fn insert(&mut self, name: &'static str, value: String) {
        self.values.insert(name, Zeroizing::new(value));
    }

    fn iter(&self) -> impl Iterator<Item = (&'static str, &str)> {
        self.values
            .iter()
            .map(|(name, value)| (*name, value.as_str()))
    }
}

struct ProductionLaunch {
    executable_name: &'static str,
    environment: ZeroizingEnvironment,
}

fn canonical_positive_integer(value: &str, maximum: u64) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && !value.starts_with('0')
        && value
            .parse::<u64>()
            .is_ok_and(|parsed| parsed > 0 && parsed <= maximum)
}

fn canonical_telegram_chat_ids(value: &str) -> bool {
    if value.len() > 1_048_576 {
        return false;
    }
    let Ok(chat_ids) = serde_json::from_str::<Vec<String>>(value) else {
        return false;
    };
    if chat_ids.is_empty()
        || chat_ids.len() > 128
        || !serde_json::to_string(&chat_ids).is_ok_and(|encoded| encoded == value)
    {
        return false;
    }
    let mut seen = std::collections::BTreeSet::new();
    chat_ids.iter().all(|chat_id| {
        let Some(raw) = chat_id.strip_prefix("telegram:chat:") else {
            return false;
        };
        let Ok(parsed) = raw.parse::<i64>() else {
            return false;
        };
        parsed != 0
            && (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&parsed)
            && parsed.to_string() == raw
            && seen.insert(chat_id)
    })
}

fn canonical_absolute_telegram_path(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 4_096
        || value.as_bytes().contains(&0)
        || !value.nfc().eq(value.chars())
    {
        return false;
    }
    let path = Path::new(value);
    let normalized = path.components().collect::<PathBuf>();
    path.is_absolute()
        && normalized.as_os_str().as_bytes() == path.as_os_str().as_bytes()
        && !path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
}

impl ProductionWorkerConfig {
    fn validate(&self, binding_id: &str) -> Result<(), WorkerError> {
        let invalid = || {
            WorkerError::new(
                "invalid_configuration",
                "production worker configuration is invalid",
                false,
            )
        };
        let bounded_nfc = |value: &str, maximum: usize| {
            !value.is_empty()
                && value.len() <= maximum
                && !value.as_bytes().contains(&0)
                && value.nfc().eq(value.chars())
        };
        if !bounded_nfc(binding_id, 512) {
            return Err(invalid());
        }
        let Self::Telegram {
            account,
            self_user_id,
            chat_ids_json,
            api_id,
            api_hash,
            database_directory,
            files_directory,
        } = self
        else {
            return Ok(());
        };
        if !bounded_nfc(account, 512)
            || api_hash.len() != 32
            || !api_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !canonical_positive_integer(api_id, i32::MAX as u64)
            || !canonical_positive_integer(self_user_id, 9_007_199_254_740_991)
            || !canonical_telegram_chat_ids(chat_ids_json)
            || !canonical_absolute_telegram_path(database_directory)
            || !canonical_absolute_telegram_path(files_directory)
        {
            return Err(invalid());
        }
        Ok(())
    }

    fn launch(mut self, binding_id: &str) -> ProductionLaunch {
        let mut environment = ZeroizingEnvironment::default();
        match &mut self {
            Self::Slack {
                account,
                team_id,
                allowed_chat_ids_json,
                bot_token,
                session_cookie,
            } => {
                if let Some(cookie) = session_cookie.take() {
                    environment.insert("INBOXD_SLACK_SESSION_COOKIE", cookie);
                }
                environment.insert("INBOXD_SLACK_ACCOUNT", std::mem::take(account));
                environment.insert(
                    "INBOXD_SLACK_ALLOWED_CHAT_IDS_JSON",
                    std::mem::take(allowed_chat_ids_json),
                );
                environment.insert("INBOXD_SLACK_BINDING_ID", binding_id.to_owned());
                environment.insert("INBOXD_SLACK_BOT_TOKEN", std::mem::take(bot_token));
                environment.insert("INBOXD_SLACK_TEAM_ID", std::mem::take(team_id));
                ProductionLaunch {
                    executable_name: "inboxd-slack-worker",
                    environment,
                }
            }
            Self::Telegram {
                account,
                self_user_id,
                chat_ids_json,
                api_id,
                api_hash,
                database_directory,
                files_directory,
            } => {
                environment.insert("INBOXD_TELEGRAM_ACCOUNT", std::mem::take(account));
                environment.insert("INBOXD_TELEGRAM_API_HASH", std::mem::take(api_hash));
                environment.insert("INBOXD_TELEGRAM_API_ID", std::mem::take(api_id));
                environment.insert("INBOXD_TELEGRAM_BINDING_ID", binding_id.to_owned());
                environment.insert(
                    "INBOXD_TELEGRAM_CHAT_IDS_JSON",
                    std::mem::take(chat_ids_json),
                );
                environment.insert(
                    "INBOXD_TELEGRAM_DATABASE_DIRECTORY",
                    std::mem::take(database_directory),
                );
                environment.insert(
                    "INBOXD_TELEGRAM_FILES_DIRECTORY",
                    std::mem::take(files_directory),
                );
                environment.insert("INBOXD_TELEGRAM_SELF_USER_ID", std::mem::take(self_user_id));
                ProductionLaunch {
                    executable_name: "inboxd-telegram-worker",
                    environment,
                }
            }
            Self::KakaoPersonal {
                account,
                chat_id,
                credentials_json,
            } => {
                environment.insert("INBOXD_KAKAO_PERSONAL_BINDING", binding_id.to_owned());
                environment.insert("INBOXD_KAKAO_PERSONAL_ACCOUNT", std::mem::take(account));
                environment.insert("INBOXD_KAKAO_PERSONAL_CHAT", std::mem::take(chat_id));
                environment.insert(
                    "INBOXD_KAKAO_PERSONAL_CREDENTIALS",
                    std::mem::take(credentials_json),
                );
                ProductionLaunch {
                    executable_name: "inboxd-kakao-personal-worker",
                    environment,
                }
            }
            Self::KakaoLocal { fixed_config_json } => {
                environment.insert(
                    "INBOXD_KAKAO_LOCAL_READ_CONFIG",
                    std::mem::take(fixed_config_json),
                );
                ProductionLaunch {
                    executable_name: "inboxd-kakao-local-worker",
                    environment,
                }
            }
            Self::KakaoOfficial {
                account,
                recipient_uuid_allowlist_json,
                template_id_allowlist_json,
                talk_message_consent,
                friends_message_permission,
                observed_at,
                auth_observation_json,
                auth_max_age_seconds,
                access_token,
            } => {
                environment.insert("INBOXD_KAKAO_ACCESS_TOKEN", std::mem::take(access_token));
                environment.insert("INBOXD_KAKAO_ACCOUNT", std::mem::take(account));
                environment.insert(
                    "INBOXD_KAKAO_AUTH_MAX_AGE_SECONDS",
                    std::mem::take(auth_max_age_seconds),
                );
                environment.insert(
                    "INBOXD_KAKAO_AUTH_OBSERVATION",
                    std::mem::take(auth_observation_json),
                );
                environment.insert("INBOXD_KAKAO_BINDING_ID", binding_id.to_owned());
                environment.insert(
                    "INBOXD_KAKAO_FRIENDS_MESSAGE_PERMISSION",
                    std::mem::take(friends_message_permission),
                );
                environment.insert("INBOXD_KAKAO_OBSERVED_AT", std::mem::take(observed_at));
                environment.insert(
                    "INBOXD_KAKAO_RECIPIENT_UUID_ALLOWLIST",
                    std::mem::take(recipient_uuid_allowlist_json),
                );
                environment.insert(
                    "INBOXD_KAKAO_TALK_MESSAGE_CONSENT",
                    std::mem::take(talk_message_consent),
                );
                environment.insert(
                    "INBOXD_KAKAO_TEMPLATE_ID_ALLOWLIST",
                    std::mem::take(template_id_allowlist_json),
                );
                ProductionLaunch {
                    executable_name: "inboxd-kakao-message-worker",
                    environment,
                }
            }
        }
    }
}

#[derive(Clone)]
pub struct WorkerSupervisor {
    inner: Arc<WorkerSupervisorInner>,
}

struct WorkerSupervisorInner {
    binding_id: String,
    executable: PathBuf,
    environment: ZeroizingEnvironment,
    trusted_executable: bool,
    timeout: Duration,
    max_response_bytes: usize,
    max_queue_depth: usize,
    permits: Arc<Semaphore>,
    generation: AtomicU64,
}

impl fmt::Debug for WorkerSupervisor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerSupervisor")
            .field("binding_id", &self.inner.binding_id)
            .field("timeout", &self.inner.timeout)
            .field("max_response_bytes", &self.inner.max_response_bytes)
            .field("max_queue_depth", &self.inner.max_queue_depth)
            .finish_non_exhaustive()
    }
}

impl WorkerSupervisor {
    pub fn production(
        binding_id: impl Into<String>,
        config: ProductionWorkerConfig,
    ) -> Result<Self, WorkerError> {
        let current_executable = std::env::current_exe().map_err(|_| {
            WorkerError::new(
                "invalid_configuration",
                "daemon executable directory could not be resolved",
                false,
            )
        })?;
        let executable_directory = current_executable
            .parent()
            .ok_or_else(|| {
                WorkerError::new(
                    "invalid_configuration",
                    "daemon executable directory could not be resolved",
                    false,
                )
            })?
            .to_owned();
        Self::production_in_directory(binding_id.into(), config, executable_directory)
    }

    #[cfg(feature = "test-worker")]
    pub fn production_for_test(
        binding_id: impl Into<String>,
        config: ProductionWorkerConfig,
        executable_directory: impl AsRef<Path>,
    ) -> Result<Self, WorkerError> {
        Self::production_in_directory(
            binding_id.into(),
            config,
            executable_directory.as_ref().to_owned(),
        )
    }

    fn production_in_directory(
        binding_id: String,
        config: ProductionWorkerConfig,
        executable_directory: PathBuf,
    ) -> Result<Self, WorkerError> {
        config.validate(&binding_id)?;
        let launch = config.launch(&binding_id);
        let executable = executable_directory.join(launch.executable_name);
        Self::build(
            binding_id,
            executable,
            launch.environment,
            true,
            Duration::from_secs(30),
            1_048_576,
            8,
        )
    }

    #[cfg(feature = "test-worker")]
    pub fn for_test(
        binding_id: impl Into<String>,
        config: TestWorkerConfig,
    ) -> Result<Self, WorkerError> {
        let mut environment = ZeroizingEnvironment::default();
        environment.insert("INBOXD_FAKE_WORKER_SCENARIO", config.scenario);
        if let Some(path) = config.state_path {
            environment.insert(
                "INBOXD_FAKE_WORKER_STATE",
                path.to_string_lossy().into_owned(),
            );
        }
        Self::build(
            binding_id.into(),
            config.executable,
            environment,
            false,
            config.timeout,
            config.max_response_bytes,
            config.max_queue_depth,
        )
    }

    fn build(
        binding_id: String,
        executable: PathBuf,
        environment: ZeroizingEnvironment,
        trusted_executable: bool,
        worker_timeout: Duration,
        max_response_bytes: usize,
        max_queue_depth: usize,
    ) -> Result<Self, WorkerError> {
        if binding_id.is_empty() || binding_id.len() > 512 {
            return Err(WorkerError::new(
                "invalid_configuration",
                "worker binding id must contain from 1 to 512 characters",
                false,
            ));
        }
        if worker_timeout.is_zero() || worker_timeout > Duration::from_secs(300) {
            return Err(WorkerError::new(
                "invalid_configuration",
                "worker timeout must be positive and at most 300 seconds",
                false,
            ));
        }
        if !(1..=16_777_216).contains(&max_response_bytes) {
            return Err(WorkerError::new(
                "invalid_configuration",
                "worker response bound is invalid",
                false,
            ));
        }
        if !(1..=1_024).contains(&max_queue_depth) {
            return Err(WorkerError::new(
                "invalid_configuration",
                "worker queue depth is invalid",
                false,
            ));
        }
        Ok(Self {
            inner: Arc::new(WorkerSupervisorInner {
                binding_id,
                executable,
                environment,
                trusted_executable,
                timeout: worker_timeout,
                max_response_bytes,
                max_queue_depth,
                permits: Arc::new(Semaphore::new(max_queue_depth)),
                generation: AtomicU64::new(0),
            }),
        })
    }

    /// Opens an owner-only regular file through the same component-wise trust
    /// gate used for packaged worker executables. The returned file is the
    /// validated final descriptor; callers must read from it without reopening
    /// the pathname.
    #[doc(hidden)]
    pub fn open_trusted_owner_file(
        path: &Path,
        maximum_bytes: u64,
    ) -> Result<std::fs::File, String> {
        if maximum_bytes == 0 {
            return Err("trusted file size bound is invalid".into());
        }
        open_trusted_path_for_owner(
            path,
            rustix::process::geteuid().as_raw(),
            TrustedFinal::OwnerFile { maximum_bytes },
        )
        .map(std::fs::File::from)
        .map_err(TrustedPathError::config_message)
    }

    /// Creates and validates Telegram's fixed private state tree without ever
    /// reopening a previously validated directory by pathname.
    #[doc(hidden)]
    pub fn prepare_telegram_state_directories(
        state_directory: &Path,
        binding_hash: &str,
    ) -> Result<(PathBuf, PathBuf), String> {
        if binding_hash.len() != 64
            || !binding_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("telegram binding state hash must be lowercase SHA-256 hex".into());
        }

        let owner = rustix::process::geteuid().as_raw();
        let state_descriptor = open_or_create_private_absolute_directory(state_directory, owner)
            .map_err(TrustedPathError::state_directory_message)?;
        let telegram_descriptor =
            open_or_create_private_child(&state_descriptor, "telegram", owner)
                .map_err(TrustedPathError::state_directory_message)?;
        let binding_descriptor =
            open_or_create_private_child(&telegram_descriptor, binding_hash, owner)
                .map_err(TrustedPathError::state_directory_message)?;
        let database_descriptor =
            open_or_create_private_child(&binding_descriptor, "database", owner)
                .map_err(TrustedPathError::state_directory_message)?;
        let files_descriptor = open_or_create_private_child(&binding_descriptor, "files", owner)
            .map_err(TrustedPathError::state_directory_message)?;

        // Keep every final descriptor alive until the complete tree has been
        // created and validated. Returned paths contain only daemon-chosen
        // components below the already validated absolute state directory.
        drop((database_descriptor, files_descriptor));
        let binding_directory = state_directory.join("telegram").join(binding_hash);
        Ok((
            binding_directory.join("database"),
            binding_directory.join("files"),
        ))
    }

    pub fn binding_id(&self) -> &str {
        &self.inner.binding_id
    }

    pub async fn health(&self, binding_id: &str) -> Result<Value, WorkerError> {
        self.invoke(binding_id, json!({"op":"health"})).await
    }

    pub async fn read_page(
        &self,
        binding_id: &str,
        chat: Value,
        interval: Value,
        limit: u64,
        cursor: Value,
    ) -> Result<NormalizedWorkerPage, WorkerError> {
        let operation = json!({
            "op":"read_page",
            "chat":chat,
            "interval":interval,
            "limit":limit,
            "cursor":cursor,
        });
        let (request, result) = self.invoke_with_request(binding_id, operation).await?;
        let items = result
            .get("items")
            .and_then(Value::as_array)
            .filter(|items| items.len() == 1)
            .ok_or_else(|| {
                WorkerError::new(
                    "malformed_response",
                    "read_page worker result must contain exactly one normalized page",
                    false,
                )
            })?;
        let page = validate_normalized_worker_page(&items[0], &request)
            .map_err(|error| WorkerError::new("malformed_response", error.message, false))?;
        if result.get("next_cursor") != Some(&page.next_cursor)
            || result.get("authoritative") != Some(&Value::Bool(page.authoritative))
        {
            return Err(WorkerError::new(
                "malformed_response",
                "normalized page cursor or authority does not match the worker result",
                false,
            ));
        }
        Ok(page)
    }

    pub async fn send(
        &self,
        binding_id: &str,
        envelope: Value,
        idempotency_key: &str,
    ) -> Result<Value, WorkerError> {
        self.invoke(
            binding_id,
            json!({"op":"send","envelope":envelope,"idempotency_key":idempotency_key}),
        )
        .await
    }

    pub async fn read_receipt(
        &self,
        binding_id: &str,
        destination: Value,
        receipt_id: &str,
        expected: Value,
    ) -> Result<Value, WorkerError> {
        self.invoke(
            binding_id,
            json!({
                "op":"read_receipt",
                "destination":destination,
                "receipt_id":receipt_id,
                "expected":expected,
            }),
        )
        .await
    }

    async fn invoke(&self, binding_id: &str, operation: Value) -> Result<Value, WorkerError> {
        self.invoke_with_request(binding_id, operation)
            .await
            .map(|(_, result)| result)
    }

    async fn invoke_with_request(
        &self,
        binding_id: &str,
        operation: Value,
    ) -> Result<(Value, Value), WorkerError> {
        if binding_id != self.inner.binding_id {
            return Err(WorkerError::new(
                "binding_mismatch",
                "worker binding does not match the fixed supervisor binding",
                false,
            ));
        }
        let _permit = Arc::clone(&self.inner.permits)
            .try_acquire_owned()
            .map_err(|_| WorkerError::new("queue_saturated", "worker queue is saturated", false))?;
        let generation = self.inner.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let timeout_ms = self.inner.timeout.as_millis().min(300_000) as u64;
        let request = json!({
            "v":1,
            "type":"worker_request",
            "request_id":Uuid::new_v4().to_string(),
            "generation":generation,
            "binding_id":binding_id,
            "limits":{
                "timeout_ms":timeout_ms,
                "max_response_bytes":self.inner.max_response_bytes,
                "max_queue_depth":self.inner.max_queue_depth,
            },
            "operation":operation,
        });
        let request_bytes = serde_json::to_vec(&request).map_err(|_| {
            WorkerError::new(
                "invalid_request",
                "worker request was not serializable",
                false,
            )
        })?;
        validate_worker_request_frame(&request_bytes)
            .map_err(|error| WorkerError::new("invalid_request", error.message, false))?;
        let operation_name = request
            .pointer("/operation/op")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let send_operation = operation_name == "send";

        let _trusted_executable = self
            .inner
            .trusted_executable
            .then(|| open_trusted_executable(&self.inner.executable))
            .transpose()?;
        let mut command = Command::new(&self.inner.executable);
        command
            .env_clear()
            .envs(self.inner.environment.iter())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn();
        drop(command);
        let mut child = child.map_err(|_| {
            WorkerError::new(
                "worker_unavailable",
                "worker could not be started before dispatch",
                false,
            )
        })?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            WorkerError::new(
                "worker_unavailable",
                "worker stdin was unavailable before dispatch",
                false,
            )
        })?;
        let mut stdout = child.stdout.take().ok_or_else(|| {
            WorkerError::new(
                "worker_unavailable",
                "worker stdout was unavailable before dispatch",
                false,
            )
        })?;
        let maximum = self.inner.max_response_bytes;
        let exchange = async {
            stdin.write_all(&request_bytes).await.map_err(|_| {
                WorkerError::new("worker_io", "worker request write failed", send_operation)
            })?;
            stdin.write_all(b"\n").await.map_err(|_| {
                WorkerError::new(
                    "worker_io",
                    "worker request terminator write failed",
                    send_operation,
                )
            })?;
            stdin.shutdown().await.map_err(|_| {
                WorkerError::new("worker_io", "worker request stream failed", send_operation)
            })?;
            let frame = read_raw_frame(&mut stdout, maximum, send_operation).await?;
            let response = validate_worker_response_frame(&frame, &request).map_err(|error| {
                WorkerError::new("malformed_response", error.message, send_operation)
            })?;
            if response.get("ok") == Some(&Value::Bool(false)) {
                let error = &response["error"];
                return Err(WorkerError::new(
                    "worker_error",
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("worker operation failed"),
                    error
                        .get("may_have_sent")
                        .and_then(Value::as_bool)
                        .unwrap_or(send_operation),
                ));
            }
            response.get("result").cloned().ok_or_else(|| {
                WorkerError::new(
                    "malformed_response",
                    "worker response omitted result",
                    send_operation,
                )
            })
        };
        let result = match timeout(self.inner.timeout, exchange).await {
            Ok(result) => result,
            Err(_) => Err(WorkerError::new(
                "timeout",
                "worker operation timed out",
                send_operation,
            )),
        };
        let _ = child.kill().await;
        let _ = child.wait().await;
        result.map(|result| (request, result))
    }
}

/// Keeps the validated file identity open until pathname spawn has completed.
/// macOS std/tokio do not expose descriptor-based execution, so this pin does
/// not by itself remove the final pathname replacement window.
struct TrustedExecutable {
    _descriptor: OwnedFd,
}

#[derive(Clone, Copy)]
enum TrustedFinal {
    Executable,
    OwnerFile { maximum_bytes: u64 },
}

#[derive(Clone, Copy)]
enum TrustedPathError {
    InvalidPath,
    Unavailable,
    Untrusted,
    InvalidSize,
}

impl TrustedPathError {
    fn worker_error(self) -> WorkerError {
        match self {
            Self::Unavailable => unavailable_executable_error(),
            Self::InvalidPath | Self::Untrusted | Self::InvalidSize => untrusted_executable_error(),
        }
    }

    fn config_message(self) -> String {
        match self {
            Self::InvalidSize => "daemon config size is invalid".into(),
            Self::InvalidPath | Self::Unavailable | Self::Untrusted => {
                "daemon config must be an available owner-only regular file without symlink components"
                    .into()
            }
        }
    }

    fn state_directory_message(self) -> String {
        match self {
            Self::InvalidPath => {
                "telegram state directory must be an absolute normalized path".into()
            }
            Self::Unavailable => "telegram state directory is unavailable".into(),
            Self::Untrusted | Self::InvalidSize => {
                "telegram state directories must be descriptor-validated, current-user-owned mode 0700 directories below trusted ancestors"
                    .into()
            }
        }
    }
}

pub fn validate_trusted_executable_for_owner(path: &Path, owner: u32) -> Result<(), WorkerError> {
    open_trusted_executable_for_owner(path, owner).map(|_| ())
}

fn open_trusted_executable(path: &Path) -> Result<TrustedExecutable, WorkerError> {
    open_trusted_executable_for_owner(path, rustix::process::geteuid().as_raw())
}

fn open_trusted_executable_for_owner(
    path: &Path,
    owner: u32,
) -> Result<TrustedExecutable, WorkerError> {
    open_trusted_path_for_owner(path, owner, TrustedFinal::Executable)
        .map(|descriptor| TrustedExecutable {
            _descriptor: descriptor,
        })
        .map_err(TrustedPathError::worker_error)
}

fn open_or_create_private_absolute_directory(
    path: &Path,
    owner: u32,
) -> Result<OwnedFd, TrustedPathError> {
    let mut components = path.components();
    if components.next() != Some(Component::RootDir) {
        return Err(TrustedPathError::InvalidPath);
    }
    let remaining = components.collect::<Vec<_>>();
    if remaining.is_empty()
        || remaining
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(TrustedPathError::InvalidPath);
    }

    let mut descriptor = openat(
        rustix::fs::CWD,
        "/",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| TrustedPathError::Unavailable)?;
    validate_trusted_ancestor(&descriptor, owner)?;

    for (index, component) in remaining.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(TrustedPathError::InvalidPath);
        };
        let (child, created) = open_or_create_directory_at(&descriptor, name)?;
        if created || index + 1 == remaining.len() {
            validate_private_owner_directory(&child, owner)?;
        } else {
            validate_trusted_ancestor(&child, owner)?;
        }
        descriptor = child;
    }
    Ok(descriptor)
}

fn open_or_create_private_child(
    parent: &OwnedFd,
    name: &str,
    owner: u32,
) -> Result<OwnedFd, TrustedPathError> {
    let (descriptor, _) = open_or_create_directory_at(parent, name.as_ref())?;
    validate_private_owner_directory(&descriptor, owner)?;
    Ok(descriptor)
}

fn open_or_create_directory_at(
    parent: &OwnedFd,
    name: &std::ffi::OsStr,
) -> Result<(OwnedFd, bool), TrustedPathError> {
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    match openat(parent, name, flags, Mode::empty()) {
        Ok(descriptor) => Ok((descriptor, false)),
        Err(Errno::NOENT) => {
            let created = match mkdirat(parent, name, Mode::from_raw_mode(0o700)) {
                Ok(()) => true,
                Err(Errno::EXIST) => false,
                Err(_) => return Err(TrustedPathError::Unavailable),
            };
            let descriptor = openat(parent, name, flags, Mode::empty())
                .map_err(|_| TrustedPathError::Unavailable)?;
            Ok((descriptor, created))
        }
        Err(_) => Err(TrustedPathError::Unavailable),
    }
}

fn validate_private_owner_directory(
    descriptor: &OwnedFd,
    owner: u32,
) -> Result<(), TrustedPathError> {
    let metadata = fstat(descriptor).map_err(|_| TrustedPathError::Unavailable)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::Directory
        || metadata.st_uid != owner
        || metadata.st_mode & 0o7777 != 0o700
    {
        return Err(TrustedPathError::Untrusted);
    }
    validate_trusted_acl(descriptor, true)
}

fn open_trusted_path_for_owner(
    path: &Path,
    owner: u32,
    final_kind: TrustedFinal,
) -> Result<OwnedFd, TrustedPathError> {
    let mut components = path.components();
    if components.next() != Some(Component::RootDir) {
        return Err(TrustedPathError::InvalidPath);
    }

    let remaining = components.collect::<Vec<_>>();
    if remaining.is_empty()
        || remaining
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(TrustedPathError::InvalidPath);
    }

    let mut descriptor = openat(
        rustix::fs::CWD,
        "/",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|_| TrustedPathError::Unavailable)?;
    validate_trusted_ancestor(&descriptor, owner)?;

    for (index, component) in remaining.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(TrustedPathError::InvalidPath);
        };
        let final_component = index + 1 == remaining.len();
        let mut flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        if !final_component {
            flags |= OFlags::DIRECTORY;
        }
        descriptor = openat(&descriptor, *name, flags, Mode::empty())
            .map_err(|_| TrustedPathError::Unavailable)?;
        if final_component {
            validate_trusted_final(&descriptor, owner, final_kind)?;
        } else {
            validate_trusted_ancestor(&descriptor, owner)?;
        }
    }

    Ok(descriptor)
}

fn validate_trusted_ancestor(descriptor: &OwnedFd, owner: u32) -> Result<(), TrustedPathError> {
    let metadata = fstat(descriptor).map_err(|_| TrustedPathError::Unavailable)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::Directory
        || (metadata.st_uid != 0 && metadata.st_uid != owner)
        || metadata.st_mode & 0o022 != 0
    {
        return Err(TrustedPathError::Untrusted);
    }
    validate_trusted_acl(descriptor, false)
}

fn validate_trusted_final(
    descriptor: &OwnedFd,
    owner: u32,
    final_kind: TrustedFinal,
) -> Result<(), TrustedPathError> {
    let metadata = fstat(descriptor).map_err(|_| TrustedPathError::Unavailable)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::RegularFile
        || metadata.st_uid != owner
    {
        return Err(TrustedPathError::Untrusted);
    }
    let confidentiality_required = match final_kind {
        TrustedFinal::Executable => {
            if metadata.st_mode & 0o100 == 0 || metadata.st_mode & 0o022 != 0 {
                return Err(TrustedPathError::Untrusted);
            }
            false
        }
        TrustedFinal::OwnerFile { maximum_bytes } => {
            if metadata.st_mode & 0o077 != 0 {
                return Err(TrustedPathError::Untrusted);
            }
            let size =
                u64::try_from(metadata.st_size).map_err(|_| TrustedPathError::InvalidSize)?;
            if size == 0 || size > maximum_bytes {
                return Err(TrustedPathError::InvalidSize);
            }
            true
        }
    };
    validate_trusted_acl(descriptor, confidentiality_required)
}

#[cfg(target_os = "macos")]
fn validate_trusted_acl(
    descriptor: &OwnedFd,
    confidentiality_required: bool,
) -> Result<(), TrustedPathError> {
    let acl = calcifer_macos_acl::read_acl(descriptor.as_fd())
        .map_err(|_| TrustedPathError::Untrusted)?;
    if acl_is_trusted(&acl, confidentiality_required) {
        Ok(())
    } else {
        Err(TrustedPathError::Untrusted)
    }
}

#[cfg(target_os = "macos")]
fn acl_is_trusted(acl: &calcifer_macos_acl::Acl, confidentiality_required: bool) -> bool {
    // Values are KAUTH_VNODE_* from the active MacOSX.sdk sys/kauth.h. Calcifer
    // 0.1.0 exposes the tags and delete bit but not the rest of this mask.
    const READ_ONLY_PERMISSIONS: u32 =
        (1 << 1) | (1 << 3) | (1 << 7) | (1 << 9) | (1 << 11) | (1 << 20);
    const MUTATING_PERMISSIONS: u32 = (1 << 2)
        | calcifer_macos_acl::PERMISSION_DELETE
        | (1 << 5)
        | (1 << 6)
        | (1 << 8)
        | (1 << 10)
        | (1 << 12)
        | (1 << 13);
    const KNOWN_PERMISSIONS: u32 = READ_ONLY_PERMISSIONS | MUTATING_PERMISSIONS;

    // No ACL-level flag is required by this policy, and Calcifer intentionally
    // preserves unknown native bits. Reject all of them. Likewise reject every
    // entry flag, including its exposed FLAG_INHERITED, rather than risk an
    // inheritance semantic changing which principals can mutate descendants.
    acl.flags == 0
        && acl.entries.iter().all(|entry| {
            entry.flags == 0
                && (entry.tag == calcifer_macos_acl::TAG_ALLOW
                    || entry.tag == calcifer_macos_acl::TAG_DENY)
                && entry.permissions & !KNOWN_PERMISSIONS == 0
                && (entry.tag != calcifer_macos_acl::TAG_ALLOW
                    || (!confidentiality_required && entry.permissions & MUTATING_PERMISSIONS == 0)
                    || entry.permissions == 0)
        })
}

#[cfg(not(target_os = "macos"))]
fn validate_trusted_acl(
    _descriptor: &OwnedFd,
    _confidentiality_required: bool,
) -> Result<(), TrustedPathError> {
    Ok(())
}

fn unavailable_executable_error() -> WorkerError {
    WorkerError::new(
        "worker_unavailable",
        "packaged worker executable or one of its ancestors is unavailable",
        false,
    )
}

fn untrusted_executable_error() -> WorkerError {
    WorkerError::new(
        "worker_unavailable",
        "packaged worker executable or one of its ancestors is not trusted",
        false,
    )
}

async fn read_raw_frame(
    stdout: &mut tokio::process::ChildStdout,
    maximum: usize,
    may_have_sent: bool,
) -> Result<Vec<u8>, WorkerError> {
    let mut frame = Vec::new();
    let mut chunk = [0_u8; 4_096];
    loop {
        let received = stdout.read(&mut chunk).await.map_err(|_| {
            WorkerError::new("worker_io", "worker response read failed", may_have_sent)
        })?;
        if received == 0 {
            return Err(WorkerError::new(
                "eof",
                "worker closed before a complete response",
                may_have_sent,
            ));
        }
        if let Some(index) = chunk[..received].iter().position(|byte| *byte == b'\n') {
            frame.extend_from_slice(&chunk[..index]);
            if frame.len() > maximum {
                return Err(WorkerError::new(
                    "output_overflow",
                    "worker response exceeded its raw byte bound",
                    may_have_sent,
                ));
            }
            if frame.is_empty() {
                return Err(WorkerError::new(
                    "malformed_response",
                    "worker returned an empty response",
                    may_have_sent,
                ));
            }
            return Ok(frame);
        }
        frame.extend_from_slice(&chunk[..received]);
        if frame.len() > maximum {
            return Err(WorkerError::new(
                "output_overflow",
                "worker response exceeded its raw byte bound",
                may_have_sent,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ProductionWorkerConfig, WorkerSupervisor, ZeroizingEnvironment,
        validate_trusted_executable_for_owner,
    };
    use rustix::process::geteuid;
    #[cfg(target_os = "macos")]
    use std::process::Command;
    use std::{
        collections::BTreeMap,
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };
    use zeroize::ZeroizeOnDrop;

    fn assert_zeroize_on_drop<T: ZeroizeOnDrop>(_: &T) {}

    fn trusted_tempdir() -> tempfile::TempDir {
        // Exercise the intended fixture violation, not macOS /var's symlink or
        // a shared writable temporary ancestor rejected by production policy.
        let home = fs::canonicalize(std::env::var_os("HOME").expect("HOME for trusted fixture"))
            .expect("canonical home for trusted fixture");
        tempfile::Builder::new()
            .prefix(".inboxd-worker-")
            .tempdir_in(home)
            .expect("private trusted fixture directory")
    }

    #[test]
    fn retained_worker_environment_zeroizes_values_on_drop_and_replacement() {
        let mut environment = ZeroizingEnvironment::default();
        environment.insert("INBOXD_SECRET", "first-secret".to_owned());
        environment.insert("INBOXD_SECRET", "replacement-secret".to_owned());

        let retained = environment
            .values
            .get("INBOXD_SECRET")
            .expect("replacement must remain retained");
        assert_zeroize_on_drop(retained);
        assert_eq!(retained.as_str(), "replacement-secret");
    }

    #[test]
    fn telegram_launch_emits_the_exact_database_and_files_directory_environment() {
        let launch = ProductionWorkerConfig::Telegram {
            account: "personal".into(),
            self_user_id: "7".into(),
            chat_ids_json: "[\"telegram:chat:42\"]".into(),
            api_id: "12345".into(),
            api_hash: "0123456789abcdef0123456789abcdef".into(),
            database_directory: "/private/state/telegram/hash/database".into(),
            files_directory: "/private/state/telegram/hash/files".into(),
        }
        .launch("telegram-personal-42");

        assert_eq!(launch.executable_name, "inboxd-telegram-worker");
        assert_eq!(
            launch
                .environment
                .iter()
                .map(|(name, value)| (name, value.to_owned()))
                .collect::<BTreeMap<_, _>>(),
            BTreeMap::from([
                ("INBOXD_TELEGRAM_ACCOUNT", "personal".into()),
                (
                    "INBOXD_TELEGRAM_API_HASH",
                    "0123456789abcdef0123456789abcdef".into(),
                ),
                ("INBOXD_TELEGRAM_API_ID", "12345".into()),
                ("INBOXD_TELEGRAM_BINDING_ID", "telegram-personal-42".into(),),
                (
                    "INBOXD_TELEGRAM_CHAT_IDS_JSON",
                    "[\"telegram:chat:42\"]".into(),
                ),
                (
                    "INBOXD_TELEGRAM_DATABASE_DIRECTORY",
                    "/private/state/telegram/hash/database".into(),
                ),
                (
                    "INBOXD_TELEGRAM_FILES_DIRECTORY",
                    "/private/state/telegram/hash/files".into(),
                ),
                ("INBOXD_TELEGRAM_SELF_USER_ID", "7".into()),
            ])
        );
    }

    #[test]
    fn telegram_production_constructor_rejects_worker_contract_mismatches() {
        fn config() -> ProductionWorkerConfig {
            ProductionWorkerConfig::Telegram {
                account: "personal".into(),
                self_user_id: "7".into(),
                chat_ids_json: "[\"telegram:chat:42\"]".into(),
                api_id: "12345".into(),
                api_hash: "0123456789abcdef0123456789abcdef".into(),
                database_directory: "/private/state/telegram/hash/database".into(),
                files_directory: "/private/state/telegram/hash/files".into(),
            }
        }

        let mut uppercase_hash = config();
        let ProductionWorkerConfig::Telegram { api_hash, .. } = &mut uppercase_hash else {
            unreachable!()
        };
        *api_hash = "0123456789ABCDEF0123456789ABCDEF".into();

        let mut non_nfc_account = config();
        let ProductionWorkerConfig::Telegram { account, .. } = &mut non_nfc_account else {
            unreachable!()
        };
        *account = "pe\u{301}rsonal".into();

        let mut relative_database = config();
        let ProductionWorkerConfig::Telegram {
            database_directory, ..
        } = &mut relative_database
        else {
            unreachable!()
        };
        *database_directory = "relative/database".into();

        let mut noncanonical_files = config();
        let ProductionWorkerConfig::Telegram {
            files_directory, ..
        } = &mut noncanonical_files
        else {
            unreachable!()
        };
        *files_directory = "/private//state/telegram/files/".into();

        for (label, binding_id, worker) in [
            ("uppercase api hash", "telegram-personal-42", uppercase_hash),
            ("non-NFC account", "telegram-personal-42", non_nfc_account),
            ("non-NFC binding id", "telegram-personal-e\u{301}", config()),
            (
                "relative database directory",
                "telegram-personal-42",
                relative_database,
            ),
            (
                "noncanonical files directory",
                "telegram-personal-42",
                noncanonical_files,
            ),
        ] {
            assert!(
                WorkerSupervisor::production(binding_id, worker).is_err(),
                "production constructor accepted {label}"
            );
        }
    }

    #[test]
    fn telegram_state_directories_are_created_as_owner_only_hashed_children() {
        const HASH: &str = "44e00b8147e28b2132939aac9b08a31de529c8fee0143660c14cb3ad3b822bc2";
        let directory = trusted_tempdir();
        let state = directory.path().join("state");

        let (database, files) =
            WorkerSupervisor::prepare_telegram_state_directories(&state, HASH).unwrap();

        assert_eq!(database, state.join("telegram").join(HASH).join("database"));
        assert_eq!(files, state.join("telegram").join(HASH).join("files"));
        for path in [
            state.clone(),
            state.join("telegram"),
            state.join("telegram").join(HASH),
            database,
            files,
        ] {
            let metadata = fs::symlink_metadata(path).unwrap();
            assert!(metadata.is_dir());
            assert_eq!(metadata.permissions().mode() & 0o7777, 0o700);
            assert_eq!(
                std::os::unix::fs::MetadataExt::uid(&metadata),
                geteuid().as_raw()
            );
        }
    }

    #[test]
    fn telegram_state_directories_reject_noncanonical_hashes_and_symlink_components() {
        const HASH: &str = "44e00b8147e28b2132939aac9b08a31de529c8fee0143660c14cb3ad3b822bc2";
        let directory = trusted_tempdir();
        let state = directory.path().join("state");
        fs::create_dir(&state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&outside, state.join("telegram")).unwrap();

        assert!(
            WorkerSupervisor::prepare_telegram_state_directories(&state, HASH).is_err(),
            "the producer must not traverse a symlinked provider directory"
        );
        assert!(
            WorkerSupervisor::prepare_telegram_state_directories(&state, "ABC").is_err(),
            "only a fixed lowercase SHA-256 directory name may reach mkdirat/openat"
        );
    }

    #[test]
    fn telegram_state_directories_reject_existing_non_private_final_directories() {
        const HASH: &str = "44e00b8147e28b2132939aac9b08a31de529c8fee0143660c14cb3ad3b822bc2";
        let directory = trusted_tempdir();
        let state = directory.path().join("state");
        let binding = state.join("telegram").join(HASH);
        fs::create_dir_all(&binding).unwrap();
        for path in [&state, &state.join("telegram"), &binding] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let database = binding.join("database");
        fs::create_dir(&database).unwrap();
        fs::set_permissions(&database, fs::Permissions::from_mode(0o750)).unwrap();

        assert!(
            WorkerSupervisor::prepare_telegram_state_directories(&state, HASH).is_err(),
            "an existing final directory must already be current-user-owned mode 0700"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn trusted_acl_policy_rejects_acl_and_entry_flags_fail_closed() {
        use super::acl_is_trusted;
        use calcifer_macos_acl::{Acl, Entry, FLAG_INHERITED, TAG_DENY};

        let read_only_entry = Entry {
            tag: TAG_DENY,
            flags: 0,
            permissions: 1 << 1,
        };
        assert!(acl_is_trusted(
            &Acl {
                flags: 0,
                entries: vec![read_only_entry],
            },
            false
        ));
        assert!(!acl_is_trusted(
            &Acl {
                flags: 0,
                entries: vec![Entry {
                    tag: calcifer_macos_acl::TAG_ALLOW,
                    ..read_only_entry
                }],
            },
            true
        ));
        assert!(!acl_is_trusted(
            &Acl {
                flags: 1,
                entries: vec![],
            },
            false
        ));
        assert!(!acl_is_trusted(
            &Acl {
                flags: 1 << 31,
                entries: vec![],
            },
            false
        ));
        assert!(!acl_is_trusted(
            &Acl {
                flags: 0,
                entries: vec![Entry {
                    flags: FLAG_INHERITED,
                    ..read_only_entry
                }],
            },
            false
        ));
        assert!(!acl_is_trusted(
            &Acl {
                flags: 0,
                entries: vec![Entry {
                    flags: 1 << 30,
                    ..read_only_entry
                }],
            },
            false
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn telegram_state_directories_reject_acl_mutation_on_a_final_directory() {
        const HASH: &str = "44e00b8147e28b2132939aac9b08a31de529c8fee0143660c14cb3ad3b822bc2";
        let directory = trusted_tempdir();
        let state = directory.path().join("state");
        let (database, _) =
            WorkerSupervisor::prepare_telegram_state_directories(&state, HASH).unwrap();
        let status = Command::new("chmod")
            .args([
                "+a",
                "group:everyone allow add_file,add_subdirectory,delete_child",
            ])
            .arg(database)
            .status()
            .expect("chmod must be available to construct the real macOS ACL exploit");
        assert!(status.success(), "chmod +a failed to construct ACL fixture");

        assert!(
            WorkerSupervisor::prepare_telegram_state_directories(&state, HASH).is_err(),
            "non-owner ACL mutation rights on a final provider directory must be rejected"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn telegram_state_directories_reject_acl_read_on_a_final_directory() {
        const HASH: &str = "44e00b8147e28b2132939aac9b08a31de529c8fee0143660c14cb3ad3b822bc2";
        let directory = trusted_tempdir();
        let state = directory.path().join("state");
        let (database, _) =
            WorkerSupervisor::prepare_telegram_state_directories(&state, HASH).unwrap();
        let status = Command::new("chmod")
            .args(["+a", "group:everyone allow list,search"])
            .arg(database)
            .status()
            .expect("chmod must be available to construct the real macOS ACL exploit");
        assert!(status.success(), "chmod +a failed to construct ACL fixture");

        assert!(
            WorkerSupervisor::prepare_telegram_state_directories(&state, HASH).is_err(),
            "non-owner ACL read rights on a private provider directory must be rejected"
        );
    }

    #[test]
    fn trusted_executable_rejects_symlink_non_regular_non_owner_and_non_executable_paths() {
        let directory = trusted_tempdir();
        let owner = geteuid().as_raw();
        let executable = directory.path().join("worker");
        fs::write(&executable, b"worker").unwrap();

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(validate_trusted_executable_for_owner(&executable, owner).is_err());

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(validate_trusted_executable_for_owner(&executable, owner).is_ok());
        assert!(validate_trusted_executable_for_owner(&executable, owner.wrapping_add(1)).is_err());

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o722)).unwrap();
        assert!(validate_trusted_executable_for_owner(&executable, owner).is_err());

        let link = directory.path().join("worker-link");
        symlink(&executable, &link).unwrap();
        assert!(validate_trusted_executable_for_owner(&link, owner).is_err());

        assert!(validate_trusted_executable_for_owner(directory.path(), owner).is_err());
    }

    #[test]
    fn trusted_executable_rejects_symlinked_and_group_or_world_writable_ancestors() {
        let directory = trusted_tempdir();
        let owner = geteuid().as_raw();
        let trusted = directory.path().join("trusted");
        fs::create_dir(&trusted).unwrap();
        fs::set_permissions(&trusted, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = trusted.join("worker");
        fs::write(&executable, b"worker").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

        let linked = directory.path().join("linked");
        symlink(&trusted, &linked).unwrap();
        assert!(validate_trusted_executable_for_owner(&linked.join("worker"), owner).is_err());

        fs::set_permissions(&trusted, fs::Permissions::from_mode(0o770)).unwrap();
        assert!(validate_trusted_executable_for_owner(&executable, owner).is_err());

        fs::set_permissions(&trusted, fs::Permissions::from_mode(0o702)).unwrap();
        assert!(validate_trusted_executable_for_owner(&executable, owner).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn trusted_executable_rejects_cross_uid_acl_mutation_on_mode_0700_ancestor() {
        let directory = trusted_tempdir();
        let owner = geteuid().as_raw();
        let trusted = directory.path().join("trusted");
        fs::create_dir(&trusted).unwrap();
        fs::set_permissions(&trusted, fs::Permissions::from_mode(0o700)).unwrap();
        let executable = trusted.join("worker");
        fs::write(&executable, b"worker").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

        let status = Command::new("chmod")
            .args([
                "+a",
                "group:everyone allow add_file,add_subdirectory,delete_child",
            ])
            .arg(&trusted)
            .status()
            .expect("chmod must be available to construct the real macOS ACL exploit");
        assert!(status.success(), "chmod +a failed to construct ACL fixture");
        assert_eq!(
            fs::metadata(&trusted).unwrap().permissions().mode() & 0o777,
            0o700,
            "the exploit fixture must remain invisible to mode-bit-only validation"
        );

        assert!(
            validate_trusted_executable_for_owner(&executable, owner).is_err(),
            "cross-UID ACL mutation rights on an executable ancestor must be rejected"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn trusted_executable_rejects_cross_uid_acl_mutation_on_final_file() {
        let directory = trusted_tempdir();
        let owner = geteuid().as_raw();
        let executable = directory.path().join("worker");
        fs::write(&executable, b"worker").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();

        let status = Command::new("chmod")
            .args(["+a", "group:everyone allow write,delete"])
            .arg(&executable)
            .status()
            .expect("chmod must be available to construct the real macOS ACL exploit");
        assert!(status.success(), "chmod +a failed to construct ACL fixture");

        assert!(
            validate_trusted_executable_for_owner(&executable, owner).is_err(),
            "cross-UID ACL mutation rights on the executable must be rejected"
        );
    }
}
