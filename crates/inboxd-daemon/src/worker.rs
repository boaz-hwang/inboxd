use inboxd_protocol::{
    NormalizedWorkerPage, validate_normalized_worker_page, validate_worker_request_frame,
    validate_worker_response_frame,
};
use serde_json::{Value, json};
use std::{
    error::Error,
    fmt,
    path::PathBuf,
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
use uuid::Uuid;

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

#[derive(Clone)]
pub struct WorkerSupervisor {
    inner: Arc<WorkerSupervisorInner>,
}

struct WorkerSupervisorInner {
    binding_id: String,
    executable: PathBuf,
    scenario: String,
    timeout: Duration,
    max_response_bytes: usize,
    max_queue_depth: usize,
    state_path: Option<PathBuf>,
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
    #[cfg(feature = "test-worker")]
    pub fn for_test(
        binding_id: impl Into<String>,
        config: TestWorkerConfig,
    ) -> Result<Self, WorkerError> {
        let binding_id = binding_id.into();
        if binding_id.is_empty() || binding_id.len() > 512 {
            return Err(WorkerError::new(
                "invalid_configuration",
                "worker binding id must contain from 1 to 512 characters",
                false,
            ));
        }
        if config.timeout.is_zero() || config.timeout > Duration::from_secs(300) {
            return Err(WorkerError::new(
                "invalid_configuration",
                "worker timeout must be positive and at most 300 seconds",
                false,
            ));
        }
        if !(1..=16_777_216).contains(&config.max_response_bytes) {
            return Err(WorkerError::new(
                "invalid_configuration",
                "worker response bound is invalid",
                false,
            ));
        }
        if !(1..=1_024).contains(&config.max_queue_depth) {
            return Err(WorkerError::new(
                "invalid_configuration",
                "worker queue depth is invalid",
                false,
            ));
        }
        Ok(Self {
            inner: Arc::new(WorkerSupervisorInner {
                binding_id,
                executable: config.executable,
                scenario: config.scenario,
                timeout: config.timeout,
                max_response_bytes: config.max_response_bytes,
                max_queue_depth: config.max_queue_depth,
                state_path: config.state_path,
                permits: Arc::new(Semaphore::new(config.max_queue_depth)),
                generation: AtomicU64::new(0),
            }),
        })
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

        let mut command = Command::new(&self.inner.executable);
        command
            .env("INBOXD_FAKE_WORKER_SCENARIO", &self.inner.scenario)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(path) = &self.inner.state_path {
            command.env("INBOXD_FAKE_WORKER_STATE", path);
        }
        let mut child = command.spawn().map_err(|_| {
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
