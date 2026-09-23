use inboxd_storage::{StorageActor, StorageOperation};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, Notify},
    task::JoinHandle,
};

const DEFAULT_MODEL: &str = ".inboxd/reply-model/models/Qwen3.5-9B-4bit";
const DEFAULT_PYTHON: &str = ".inboxd/reply-model/venv/bin/python";

pub(crate) struct ReplyService {
    actor: Arc<StorageActor>,
    queue: Mutex<Vec<ReplyJob>>,
    wake: Notify,
}

const MAX_REPLY_WORKERS: usize = 2;

fn reply_worker_count(configured: Option<&str>, physical_memory_bytes: Option<u64>) -> usize {
    configured
        .and_then(|value| value.parse::<usize>().ok())
        .map(|count| count.clamp(1, MAX_REPLY_WORKERS))
        .unwrap_or_else(|| {
            usize::from(physical_memory_bytes.unwrap_or(0) >= 48 * 1024 * 1024 * 1024) + 1
        })
}

#[cfg(target_os = "macos")]
fn physical_memory_bytes() -> Option<u64> {
    let output = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok()?.trim().parse().ok())
        .flatten()
}

#[cfg(not(target_os = "macos"))]
fn physical_memory_bytes() -> Option<u64> {
    None
}

fn configured_worker_count() -> usize {
    reply_worker_count(
        std::env::var("INBOXD_REPLY_WORKERS").ok().as_deref(),
        physical_memory_bytes(),
    )
}

struct ReplyJob {
    id: String,
    chat: String,
    unread: bool,
    first_queued: tokio::time::Instant,
    ready_at: tokio::time::Instant,
    activity: f64,
}

fn latest_incoming_activity(context: &Value) -> f64 {
    context
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["author_role"] == "other")
        .filter_map(|message| message["ts"].as_f64())
        .max_by(f64::total_cmp)
        .unwrap_or(0.0)
}

fn enqueue_job(
    queue: &mut Vec<ReplyJob>,
    id: &str,
    chat: &Value,
    unread: bool,
    activity: f64,
    now: tokio::time::Instant,
) {
    let key = json!([chat["platform"], chat["account"], chat["chat_id"]]).to_string();
    let old = queue
        .iter()
        .position(|job| job.chat == key)
        .map(|i| queue.remove(i));
    let first = old.as_ref().map(|job| job.first_queued).unwrap_or(now);
    let ready_at = (now + std::time::Duration::from_millis(500))
        .min(first + std::time::Duration::from_secs(2));
    queue.push(ReplyJob {
        id: id.to_owned(),
        chat: key,
        unread,
        first_queued: first,
        ready_at,
        activity,
    });
    queue.sort_by(|a, b| {
        b.unread
            .cmp(&a.unread)
            .then_with(|| b.activity.total_cmp(&a.activity))
            .then_with(|| a.first_queued.cmp(&b.first_queued))
    });
}

pub(crate) struct Worker {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

fn worker_script() -> PathBuf {
    std::env::current_exe()
        .ok()
        .map(|p| p.with_file_name("inboxd-reply-worker.py"))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/reply-model/worker.py")
        })
}

pub(crate) fn runtime_version() -> String {
    let mut fingerprint = Sha256::new();
    fingerprint.update(b"decision-graph-v1:source-current-chat-local-v1:venv-launch-v2");
    if let Some(path) = installed_path("INBOXD_REPLY_MODEL", DEFAULT_MODEL, true) {
        fingerprint.update(path.to_string_lossy().as_bytes());
        if let Ok(config) = std::fs::read(path.join("config.json")) {
            fingerprint.update(config);
        }
        let mut files = std::fs::read_dir(&path)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|f| f.path().extension().is_some_and(|e| e == "safetensors"))
            .map(|f| f.path())
            .collect::<Vec<_>>();
        files.sort();
        for file in files {
            if let Ok(meta) = file.metadata() {
                fingerprint.update(
                    format!(
                        "{}:{}:{:?}",
                        file.display(),
                        meta.len(),
                        meta.modified().ok()
                    )
                    .as_bytes(),
                );
            }
        }
    }
    if let Some(path) = adapter_registry() {
        if let Ok(bytes) = std::fs::read(path) {
            fingerprint.update(bytes);
        }
    }
    let script = worker_script();
    for file in [
        script.clone(),
        script.with_file_name("context_intelligence.py"),
        script.with_file_name("policy.py"),
    ] {
        if let Ok(bytes) = std::fs::read(file) {
            fingerprint.update(bytes);
        }
    }
    format!("{:x}", fingerprint.finalize())
}

fn adapter_registry() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".inboxd/reply-model/active-adapter.json"))
}

fn installed_path(env_key: &str, default_suffix: &str, require_config: bool) -> Option<PathBuf> {
    let candidate = std::env::var_os(env_key)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(default_suffix)))?;
    if !candidate.is_absolute() {
        return None;
    }
    let path = validated_runtime_path(candidate, require_config)?;
    Some(path)
}

fn validated_runtime_path(candidate: PathBuf, require_config: bool) -> Option<PathBuf> {
    // Python detects its venv from the invoked path. Resolving bin/python's
    // symlink launches the base interpreter without the installed MLX packages.
    let path = if require_config {
        candidate.canonicalize().ok()?
    } else {
        candidate
    };
    if require_config && (!path.is_dir() || !path.join("config.json").is_file()) {
        return None;
    }
    if !require_config && !path.is_file() {
        return None;
    }
    Some(path)
}
impl Worker {
    fn start() -> Result<Self, String> {
        let mut command =
            if let Some(executable) = std::env::var_os("INBOXD_REPLY_WORKER").map(PathBuf::from) {
                if !executable.is_absolute() || !executable.is_file() {
                    return Err("INBOXD_REPLY_WORKER must be an absolute executable path".into());
                }
                Command::new(executable)
            } else {
                let python = installed_path("INBOXD_REPLY_PYTHON", DEFAULT_PYTHON, false)
                    .unwrap_or_else(|| PathBuf::from("python3"));
                let script = worker_script();
                let mut command = Command::new(python);
                command.arg(script);
                command
            };
        // A generator receives only message context, never provider credentials,
        // owner tokens, proxy settings or arbitrary inherited Python paths.
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
            .env("LANG", "en_US.UTF-8")
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("HF_HUB_DISABLE_TELEMETRY", "1")
            .env("DO_NOT_TRACK", "1");
        for key in ["HOME", "TMPDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|_| "local reply worker unavailable".to_owned())?;
        let input = child.stdin.take().ok_or("reply worker stdin unavailable")?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("reply worker stdout unavailable")?,
        );
        Ok(Self {
            _child: child,
            input,
            output,
        })
    }
    pub(crate) async fn generate(&mut self, request: &Value) -> Result<Value, String> {
        let mut bytes = serde_json::to_vec(request).map_err(|_| "reply request encoding failed")?;
        if bytes.len() > 1_000_000 {
            return Err("reply request too large".into());
        }
        bytes.push(b'\n');
        let line = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            self.input.write_all(&bytes).await?;
            self.input.flush().await?;
            let mut line = Vec::new();
            // Bound memory before reading, including an unterminated frame.
            let mut bounded = (&mut self.output).take(1_000_001);
            bounded.read_until(b'\n', &mut line).await?;
            Ok::<_, std::io::Error>(line)
        })
        .await
        .map_err(|_| "reply generation timed out")?
        .map_err(|_| "reply worker stopped")?;
        if line.len() > 1_000_000 {
            return Err("reply response too large".into());
        }
        if !line.ends_with(b"\n") {
            return Err("incomplete reply worker response".into());
        }
        let result: Value =
            serde_json::from_slice(&line).map_err(|_| "invalid reply worker response")?;
        if result["id"] != request["id"] {
            return Err("reply worker response id mismatch".into());
        }
        Ok(result)
    }
}

#[cfg(test)]
mod worker_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn python_launch_preserves_virtualenv_symlink() {
        let directory =
            std::env::temp_dir().join(format!("inboxd-python-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let python = directory.join("python");
        std::os::unix::fs::symlink("/bin/sh", &python).unwrap();
        assert_eq!(validated_runtime_path(python.clone(), false), Some(python));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn worker_pool_defaults_to_two_only_with_measured_memory_headroom() {
        let gib = 1024 * 1024 * 1024;
        assert_eq!(reply_worker_count(None, Some(48 * gib)), 2);
        assert_eq!(reply_worker_count(None, Some(47 * gib)), 1);
        assert_eq!(reply_worker_count(None, Some(16 * gib)), 1);
        assert_eq!(reply_worker_count(None, None), 1);
        assert_eq!(reply_worker_count(Some("1"), Some(48 * gib)), 1);
        assert_eq!(reply_worker_count(Some("2"), Some(16 * gib)), 2);
        assert_eq!(reply_worker_count(Some("20"), Some(48 * gib)), 2);
    }

    #[test]
    fn incoming_bursts_coalesce_and_cannot_delay_forever() {
        let mut queue = Vec::new();
        let first = tokio::time::Instant::now();
        let chat = json!({"platform":"test","account":"a","chat_id":"room"});
        enqueue_job(&mut queue, "old", &chat, false, 1.0, first);
        enqueue_job(
            &mut queue,
            "new",
            &chat,
            false,
            2.0,
            first + std::time::Duration::from_millis(1900),
        );
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].id, "new");
        assert_eq!(queue[0].ready_at, first + std::time::Duration::from_secs(2));
        enqueue_job(
            &mut queue,
            "new",
            &chat,
            false,
            2.0,
            first + std::time::Duration::from_millis(1950),
        );
        assert_eq!(queue[0].ready_at, first + std::time::Duration::from_secs(2));
    }

    #[test]
    fn unread_rooms_outrank_recent_read_rooms() {
        let mut queue = Vec::new();
        let now = tokio::time::Instant::now();
        enqueue_job(
            &mut queue,
            "recent-read",
            &json!({"platform":"test","account":"a","chat_id":"recent-read"}),
            false,
            100.0,
            now,
        );
        enqueue_job(
            &mut queue,
            "old-unread",
            &json!({"platform":"test","account":"a","chat_id":"old-unread"}),
            true,
            1.0,
            now,
        );
        assert_eq!(queue[0].id, "old-unread");
    }

    #[test]
    fn unread_and_read_groups_each_use_latest_incoming_activity() {
        let mut queue = Vec::new();
        let now = tokio::time::Instant::now();
        for (id, unread, activity) in [
            ("new-read", false, 40.0),
            ("old-unread", true, 10.0),
            ("old-read", false, 20.0),
            ("new-unread", true, 30.0),
        ] {
            enqueue_job(
                &mut queue,
                id,
                &json!({"platform":"test","account":"a","chat_id":id}),
                unread,
                activity,
                now,
            );
        }
        assert_eq!(
            queue.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(),
            ["new-unread", "old-unread", "new-read", "old-read"]
        );
    }

    #[test]
    fn latest_incoming_activity_ignores_newer_self_messages() {
        assert_eq!(
            latest_incoming_activity(&json!([
                {"author_role":"other","ts":12.0},
                {"author_role":"self","ts":99.0},
                {"author_role":"other","ts":18.0}
            ])),
            18.0
        );
    }

    #[test]
    fn queue_keeps_every_room_beyond_previous_capacity() {
        let mut queue = Vec::new();
        let now = tokio::time::Instant::now();
        for index in 0..129 {
            enqueue_job(
                &mut queue,
                &index.to_string(),
                &json!({"platform":"test","account":"a","chat_id":index.to_string()}),
                false,
                index as f64,
                now,
            );
        }
        assert_eq!(queue.len(), 129);
        assert_eq!(queue[0].id, "128");
        assert!(queue.iter().any(|job| job.id == "0"));
    }

    #[tokio::test]
    async fn one_wakeup_dispatches_backlog_to_two_waiting_consumers() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let actor = Arc::new(
            StorageActor::start(inboxd_storage::StorageActorConfig::new(
                directory.path().join("reply-queue.db"),
                [0x45; 32],
            ))
            .unwrap(),
        );
        let service = Arc::new(ReplyService {
            actor,
            queue: Mutex::new(Vec::new()),
            wake: Notify::new(),
        });
        let first_service = Arc::clone(&service);
        let first = tokio::spawn(async move { first_service.next_job().await });
        let second_service = Arc::clone(&service);
        let second = tokio::spawn(async move { second_service.next_job().await });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let now = tokio::time::Instant::now() - std::time::Duration::from_secs(1);
        {
            let mut queue = service.queue.lock().await;
            enqueue_job(
                &mut queue,
                "newest",
                &json!({"platform":"test","account":"a","chat_id":"newest"}),
                true,
                2.0,
                now,
            );
            enqueue_job(
                &mut queue,
                "older",
                &json!({"platform":"test","account":"a","chat_id":"older"}),
                true,
                1.0,
                now,
            );
        }
        // Simulate coalesced producer notifications: the first consumer must
        // hand the remaining ready backlog to the second consumer.
        service.wake.notify_one();
        let mut ids = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            vec![first.await.unwrap(), second.await.unwrap()]
        })
        .await
        .unwrap();
        ids.sort();
        assert_eq!(ids, ["newest", "older"]);
    }

    fn worker(script: &str) -> Worker {
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Worker {
            _child: child,
            input,
            output,
        }
    }

    #[tokio::test]
    async fn refuses_another_jobs_output() {
        let mut worker = worker(
            "IFS= read -r request; printf '%s\\n' '{\"id\":\"wrong\",\"status\":\"ready\",\"text\":\"unrelated\"}'",
        );
        assert!(
            worker
                .generate(&json!({"id":"expected"}))
                .await
                .unwrap_err()
                .contains("id mismatch")
        );
    }

    #[tokio::test]
    async fn refuses_unterminated_output() {
        let mut worker = worker("IFS= read -r request; printf '%s' '{\"id\":\"expected\"}'");
        assert!(
            worker
                .generate(&json!({"id":"expected"}))
                .await
                .unwrap_err()
                .contains("incomplete")
        );
    }

    #[tokio::test]
    async fn accepts_only_complete_matching_frames() {
        let mut worker = worker(
            "IFS= read -r request; printf '%s\\n' '{\"id\":\"expected\",\"status\":\"abstained\"}'",
        );
        assert_eq!(
            worker.generate(&json!({"id":"expected"})).await.unwrap()["status"],
            "abstained"
        );
    }
}

impl ReplyService {
    async fn enqueue(&self, id: &str, chat: &Value, unread: bool, activity: f64) {
        let now = tokio::time::Instant::now();
        let mut queue = self.queue.lock().await;
        enqueue_job(&mut queue, id, chat, unread, activity, now);
        drop(queue);
        self.wake.notify_one();
    }

    async fn enqueue_prepared(&self, prepared: &Value) {
        if prepared["status"] != "queued" {
            return;
        }
        let Some(id) = prepared["suggestion_id"].as_str() else {
            return;
        };
        let activity = prepared["latest_incoming_ts"]
            .as_f64()
            .unwrap_or_else(|| latest_incoming_activity(&prepared["context"]));
        let unread = prepared["unread"]["count"].as_u64().unwrap_or(0) > 0;
        self.enqueue(id, &prepared["chat"], unread, activity).await;
    }

    async fn next_job(&self) -> String {
        loop {
            let notified = self.wake.notified();
            let mut queue = self.queue.lock().await;
            let now = tokio::time::Instant::now();
            if queue.first().is_some_and(|job| job.ready_at <= now) {
                let id = queue.remove(0).id;
                if !queue.is_empty() {
                    // A notification permit can coalesce before both pool
                    // consumers are waiting. Hand the remaining backlog to
                    // another idle consumer after every dispatch.
                    self.wake.notify_one();
                }
                return id;
            }
            // Wait for the highest-ranked job even when a lower-ranked job has
            // already finished its debounce. Otherwise opening a read room can
            // bypass a queued unread room.
            let next = queue.first().map(|job| job.ready_at);
            drop(queue);
            match next {
                Some(at) => {
                    tokio::select! {_=notified=>{},_=tokio::time::sleep_until(at)=>{}}
                }
                None => notified.await,
            }
        }
    }

    pub(crate) fn start(actor: Arc<StorageActor>) -> (Arc<Self>, JoinHandle<()>) {
        let service = Arc::new(Self {
            actor: Arc::clone(&actor),
            queue: Mutex::new(Vec::new()),
            wake: Notify::new(),
        });
        let pending = Arc::clone(&service);
        let task = tokio::spawn(async move {
            let worker_count = configured_worker_count();
            let mut pool = tokio::task::JoinSet::new();
            for _ in 0..worker_count {
                pool.spawn(Arc::clone(&pending).run_worker_loop(Arc::clone(&actor)));
            }
            while pool.join_next().await.is_some() {
                pool.spawn(Arc::clone(&pending).run_worker_loop(Arc::clone(&actor)));
            }
        });
        (service, task)
    }

    async fn run_worker_loop(self: Arc<Self>, actor: Arc<StorageActor>) {
        let mut worker: Option<Worker> = None;
        let mut loaded_runtime = String::new();
        loop {
            let id = self.next_job().await;
            let claim = match actor
                .call_async(
                    StorageOperation::ResponseGenerationClaim,
                    json!({"suggestion_id":id}),
                )
                .await
            {
                Ok(v) if !v.is_null() => v,
                _ => continue,
            };
            let model = installed_path("INBOXD_REPLY_MODEL", DEFAULT_MODEL, true);
            let runtime = runtime_version();
            if runtime != loaded_runtime {
                worker = None;
                loaded_runtime = runtime.clone();
            }
            let request = json!({"id":claim["suggestion_id"],"suggestion_id":claim["suggestion_id"],"chat":claim["chat"],
                "context_version":claim["context_version"],"prompt_version":claim["prompt_version"],"model_path":model,
                "context":claim["context"],"incoming_message_ids":claim["incoming_message_ids"],
                "adapter_registry":adapter_registry(),"runtime_version":runtime});
            if worker.is_none() {
                worker = Worker::start().ok();
            }
            let result=match worker.as_mut(){Some(w)=>crate::reply_pipeline::run(w,&actor,request).await.unwrap_or_else(|error|{worker=None;json!({"id":claim["suggestion_id"],"status":"failed","error":error,"prompt_version":"reply-v1"})}),None=>json!({"id":claim["suggestion_id"],"status":"failed","error":"local_reply_worker_unavailable","prompt_version":"reply-v1"})};
            if result["id"] != claim["suggestion_id"] || result["reset_worker"] == true {
                worker = None;
            }
            let status = result["status"]
                .as_str()
                .filter(|s| matches!(*s, "ready" | "abstained" | "failed"))
                .unwrap_or("failed");
            let mut finish = result.clone();
            finish["suggestion_id"] = claim["suggestion_id"].clone();
            finish["generation_epoch"] = claim["generation_epoch"].clone();
            finish["status"] = json!(status);
            let _ = actor
                .call_async(StorageOperation::ResponseGenerationFinish, finish)
                .await;
        }
    }
    pub(crate) async fn observe(&self, mut scope: Value) {
        scope["runtime_version"] = json!(runtime_version());
        if let Ok(prepared) = self
            .actor
            .call_async(StorageOperation::ResponsePrepare, scope)
            .await
        {
            self.enqueue_prepared(&prepared).await;
        }
    }
    pub(crate) async fn enqueue_session(&self, result: &Value) {
        if result["status"] != "queued" {
            return;
        }
        let mut scope = result["chat"].clone();
        scope["runtime_version"] = json!(runtime_version());
        if let Ok(prepared) = self
            .actor
            .call_async(StorageOperation::ResponsePrepare, scope)
            .await
        {
            self.enqueue_prepared(&prepared).await;
        }
    }
}

pub(crate) fn storage_chat(mut chat: Value) -> Value {
    if chat["platform"] == "telegram" {
        if let Some(id) = chat["chat_id"].as_str() {
            chat["chat_id"] = json!(crate::accounts_backend::storage_keys::chat("telegram", id));
        }
    }
    chat
}
pub(crate) fn public_result(mut value: Value) -> Value {
    if value["chat"]["platform"] == "telegram" {
        if let Some(chat) = value["chat"]["chat_id"]
            .as_str()
            .and_then(|s| s.strip_prefix("telegram:chat:"))
            .map(str::to_owned)
        {
            value["chat"]["chat_id"] = json!(chat.clone());
            if let Some(ids) = value["source_message_ids"].as_array_mut() {
                let prefix = format!("telegram:message:{chat}:");
                for id in ids {
                    if let Some(raw) = id.as_str().and_then(|s| s.strip_prefix(&prefix)) {
                        *id = json!(raw);
                    }
                }
            }
        }
    }
    value
}
