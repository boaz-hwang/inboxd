//! Account-wide directory and direct owner-TUI operations. Credentials never cross RPC.
use crate::accounts_backend::{AccountBackend, ProviderIo, pagination::MessagePages};
use inboxd_storage::{StorageActor, StorageOperation};
use serde_json::{Value, json};
use std::{collections::BTreeMap, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};
use zeroize::Zeroizing;

#[path = "accounts_live.rs"]
mod live;
#[path = "accounts_schedule.rs"]
mod schedule;
#[path = "accounts_search.rs"]
mod search;
use schedule::Schedule;

#[derive(Clone)]
pub struct AccountConfig {
    pub platform: String,
    pub account: String,
    pub config: Zeroizing<String>,
}
struct Slot {
    config: AccountConfig,
    chats: Vec<Value>,
    loaded: bool,
    failed: bool,
    backend: Option<AccountBackend>,
    backend_seed: AccountBackend,
    generation: u64,
    last_read_order: u64,
    sending: std::sync::Weak<()>,
    message_pages: MessagePages,
}
impl Slot {
    fn take_backend(&mut self) -> AccountBackend {
        let backend = self
            .backend
            .take()
            .unwrap_or_else(|| self.backend_seed.fork());
        self.backend_seed = backend.fork();
        backend
    }
    fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.backend = None;
        self.message_pages.clear();
    }
}
type WorkerCall = for<'a> fn(
    &'a AccountConfig,
    &'a Value,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>,
>;
#[derive(Default, Clone)]
struct Snapshot {
    chats: Vec<Value>,
    errors: Vec<Value>,
    refreshing: bool,
    loaded: bool,
    updated: Option<std::time::Instant>,
}
struct Entry {
    refresh_task: std::sync::Mutex<Option<tokio::task::AbortHandle>>,
    config: AccountConfig,
    slot: Arc<Mutex<Slot>>,
    schedule: Arc<Schedule>,
    snapshot: Arc<std::sync::Mutex<Snapshot>>,
}
pub(crate) struct AccountService {
    run_worker: Option<WorkerCall>,
    storage: Option<Arc<StorageActor>>,
    events: Option<Arc<crate::server::EventHub>>,
    pub(crate) work: crate::work_status::WorkStatus,
    searches: std::sync::Mutex<search::SearchJobs>,
    observation_sequence: std::sync::atomic::AtomicU64,
    slots: Vec<Entry>,
    pages: std::sync::Mutex<BTreeMap<u64, (std::time::Instant, Value)>>,
    sequence: std::sync::atomic::AtomicU64,
}
impl AccountService {
    pub(crate) fn new(configs: Vec<AccountConfig>) -> Self {
        Self {
            run_worker: None,
            storage: None,
            events: None,
            work: Default::default(),
            searches: Default::default(),
            observation_sequence: std::sync::atomic::AtomicU64::new(0),
            pages: Default::default(),
            sequence: std::sync::atomic::AtomicU64::new(0),
            slots: configs
                .into_iter()
                .map(|config| Entry {
                    refresh_task: Default::default(),
                    config: config.clone(),
                    snapshot: Default::default(),
                    schedule: Default::default(),
                    slot: Arc::new(Mutex::new(Slot {
                        backend: Some(AccountBackend::new(&config.platform)),
                        backend_seed: AccountBackend::new(&config.platform),
                        generation: 0,
                        last_read_order: 0,
                        sending: Default::default(),
                        message_pages: MessagePages::default(),
                        config,
                        chats: vec![],
                        loaded: false,
                        failed: false,
                    })),
                })
                .collect(),
        }
    }
    pub(crate) fn with_storage(mut self, storage: Arc<StorageActor>) -> Self {
        self.storage = Some(storage);
        self
    }
    pub(crate) fn with_events(mut self, events: Arc<crate::server::EventHub>) -> Self {
        self.events = Some(events);
        self
    }
    pub(crate) async fn list(&self, params: &Value) -> Result<Value, String> {
        self.list_filtered(params, None).await
    }
    async fn list_filtered(
        &self,
        params: &Value,
        target: Option<(&str, &str)>,
    ) -> Result<Value, String> {
        if let Some(cursor) = params["cursor"].as_str() {
            let (id, offset) = cursor.split_once(':').ok_or("목록을 다시 불러오세요")?;
            let id = id.parse::<u64>().map_err(|_| "잘못된 목록 커서")?;
            let offset = offset.parse::<usize>().map_err(|_| "잘못된 목록 커서")?;
            let pages = self.pages.lock().unwrap();
            let (created, snapshot) = pages.get(&id).ok_or("목록을 다시 불러오세요")?;
            if created.elapsed() > Duration::from_secs(120) {
                return Err("목록을 다시 불러오세요".into());
            }
            return directory_page(snapshot, id, offset);
        }
        let background = params["background"] == true;
        for entry in &self.slots {
            if target.is_some_and(|(platform, account)| {
                entry.config.platform != platform || entry.config.account != account
            }) {
                continue;
            }
            let mut snapshot = entry.snapshot.lock().unwrap();
            let expired = background
                && snapshot
                    .updated
                    .is_some_and(|t| t.elapsed() > Duration::from_secs(30));
            if snapshot.refreshing || !(params["refresh"] == true || !snapshot.loaded || expired) {
                continue;
            }
            snapshot.refreshing = true;
            let shared = Arc::clone(&entry.slot);
            let published = Arc::clone(&entry.snapshot);
            let schedule = Arc::clone(&entry.schedule);
            let runner = self.run_worker;
            let refresh = params["refresh"] == true;
            let task = tokio::spawn(async move {
                let Ok(_admission) = schedule.admit(false) else {
                    // Congestion is not an account/provider failure. Keep the last
                    // healthy directory and reserved send capacity usable.
                    published.lock().unwrap().refreshing = false;
                    return;
                };
                let mut slot = shared.lock().await;
                let config = slot.config.clone();
                let overlapped_send = slot.sending.upgrade().is_some();
                slot.invalidate();
                let generation = slot.generation;
                let mut backend = slot.take_backend();
                drop(slot);
                let result = call_account(
                    &config,
                    &mut backend,
                    &schedule,
                    &json!({"op":"chats", "refresh":refresh}),
                    runner,
                )
                .await
                .and_then(|value| validate_chats(&config, &value));
                let mut slot = shared.lock().await;
                if overlapped_send
                    || slot.sending.upgrade().is_some()
                    || generation != slot.generation
                {
                    // A concurrent send/refresh superseded this directory snapshot.
                    published.lock().unwrap().refreshing = false;
                    return;
                }
                slot.backend = Some(backend);
                match result {
                    Ok(chats) => {
                        slot.chats = chats;
                        slot.loaded = true;
                        slot.failed = false;
                    }
                    Err(_) => slot.failed = true,
                }
                let errors = if slot.failed {
                    vec![
                        json!({"platform":slot.config.platform,"account":slot.config.account,"message":"채팅 목록을 가져오지 못했습니다"}),
                    ]
                } else {
                    vec![]
                };
                *published.lock().unwrap() = Snapshot {
                    chats: slot.chats.clone(),
                    errors,
                    loaded: true,
                    refreshing: false,
                    updated: Some(std::time::Instant::now()),
                };
            });
            *entry.refresh_task.lock().unwrap() = Some(task.abort_handle());
        }
        if !background {
            while self.slots.iter().any(|e| {
                target.is_none_or(|(platform, account)| {
                    e.config.platform == platform && e.config.account == account
                }) && e.snapshot.lock().unwrap().refreshing
            }) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        let mut chats = vec![];
        let mut errors = vec![];
        let mut refreshing = false;
        for entry in &self.slots {
            let snapshot = entry.snapshot.lock().unwrap();
            chats.extend(snapshot.chats.clone());
            errors.extend(snapshot.errors.clone());
            refreshing |= snapshot.refreshing;
        }
        chats.sort_by(|a, b| {
            b["latest_ts"]
                .as_f64()
                .unwrap_or(0.)
                .total_cmp(&a["latest_ts"].as_f64().unwrap_or(0.))
                .then_with(|| a["platform"].as_str().cmp(&b["platform"].as_str()))
                .then_with(|| a["account"].as_str().cmp(&b["account"].as_str()))
                .then_with(|| a["chat_id"].as_str().cmp(&b["chat_id"].as_str()))
        });
        let value = json!({"available":!self.slots.is_empty(),"chats":chats,"errors":errors,"refreshing":refreshing});
        let id = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let result = directory_page(&value, id, 0)?;
        if !result["next_cursor"].is_null() {
            let mut pages = self.pages.lock().unwrap();
            pages.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(120));
            while pages.len() >= 32 {
                pages.pop_first();
            }
            pages.insert(id, (std::time::Instant::now(), value));
        }
        Ok(result)
    }
    pub(crate) async fn query(&self, op: &str, params: &Value) -> Result<Value, String> {
        #[cfg(test)]
        if op == "send" {
            let storage = self.storage.as_ref().ok_or("전송 기록 저장소 없음")?;
            let mut request = json!({"request_id":params["request_id"],"chat":{"platform":params["platform"],"account":params["account"],"chat_id":params["chat_id"]},"body":params["body"]});
            if let Some(parent) = params.get("parent_id") {
                request["parent_id"] = parent.clone();
            }
            return crate::direct_send::execute(
                storage,
                &crate::CapabilityRegistry::new(vec![]).unwrap(),
                self,
                &request,
                json!({"role":"sender"}),
            )
            .await;
        }
        let work = self.work.start(&format!("account.{op}"), json!({"platform":params["platform"],"account":params["account"],"chat_id":params["chat_id"]}))?;
        let observed = self.next_observation();
        let mut request = params.clone();
        request["_observation_order"] = json!(observed);
        let result = async {
            let mut result = self.dispatch_query(op, &request).await?;
            let observed = result
                .as_object_mut()
                .and_then(|r| r.remove("_observation_order"))
                .and_then(|v| v.as_u64())
                .unwrap_or(observed);
            if op != "send" {
                self.persist_observations(params, &result, observed).await?;
            }
            Ok(result)
        }
        .await;
        work.finish(result.is_ok());
        result
    }
    /// Fixed binding workers and account reads use different provider sessions,
    /// but must share the same cache invalidation boundary. Keep the marker alive
    /// across dispatch so overlapping reads cannot republish pre-send data.
    pub(crate) async fn with_external_send<F>(
        &self,
        destination: &Value,
        dispatch: F,
    ) -> Result<Value, String>
    where
        F: std::future::Future<Output = Result<Value, String>>,
    {
        let Some(entry) = self.slots.iter().find(|entry| {
            destination["platform"] == entry.config.platform
                && destination["account"] == entry.config.account
        }) else {
            return dispatch.await;
        };
        let _serial = entry.schedule.sends.lock().await;
        let scope = Arc::new(());
        {
            let mut slot = entry.slot.lock().await;
            slot.invalidate();
            slot.sending = Arc::downgrade(&scope);
        }
        let result = dispatch.await;
        entry.slot.lock().await.invalidate();
        drop(scope);
        result
    }

    pub(crate) async fn prepare_send(&self, params: &Value) -> Result<(), String> {
        let platform = params["platform"].as_str().ok_or("메신저 없음")?;
        let account = params["account"].as_str().ok_or("계정 없음")?;
        let entry = self
            .slots
            .iter()
            .find(|e| e.config.platform == platform && e.config.account == account)
            .ok_or("연결된 계정 없음")?;
        let needs_refresh = {
            let slot = entry.slot.lock().await;
            !slot.loaded || slot.failed
        };
        if needs_refresh {
            tokio::time::timeout(
                Duration::from_secs(30),
                self.list_filtered(&json!({"refresh":true}), Some((platform, account))),
            )
            .await
            .map_err(|_| "계정 채팅 목록 조회 시간 초과")??;
        }
        Ok(())
    }
    pub(crate) async fn validate_send(&self, params: &Value) -> Result<(), String> {
        params["body"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 16000)
            .ok_or("메시지 크기 제한")?;
        let entry = self
            .slots
            .iter()
            .find(|e| {
                e.config.platform == params["platform"] && e.config.account == params["account"]
            })
            .ok_or("연결된 계정 없음")?;
        let slot = entry.slot.lock().await;
        if !slot.loaded || slot.failed {
            return Err("채팅 목록을 먼저 불러오세요".into());
        }
        if !slot
            .chats
            .iter()
            .any(|chat| chat["chat_id"] == params["chat_id"] && chat["can_send"] == true)
        {
            return Err("연결된 쓰기 가능한 채팅방이 아닙니다".into());
        }
        Ok(())
    }
    pub(crate) async fn dispatch_query(&self, op: &str, params: &Value) -> Result<Value, String> {
        let platform = params["platform"].as_str().ok_or("메신저 없음")?;
        let account = params["account"].as_str().ok_or("계정 없음")?;
        for entry in &self.slots {
            if entry.config.platform != platform || entry.config.account != account {
                continue;
            }
            if op == "send" {
                params["body"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 16000)
                    .ok_or("메시지 크기 제한")?;
                params["request_id"]
                    .as_str()
                    .filter(|s| s.len() >= 16 && s.len() <= 80)
                    .ok_or("전송 식별자 없음")?;
                params["chat_id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("채팅방 없음")?;
            }
            let _admission = entry.schedule.admit(op == "send")?;
            let _send_guard = if op == "send" {
                Some(entry.schedule.sends.lock().await)
            } else {
                None
            };
            let mut slot = entry.slot.lock().await;
            if !slot.loaded || slot.failed {
                return Err("채팅 목록을 먼저 불러오세요".into());
            }
            let chat = params["chat_id"].as_str();
            if let Some(id) = chat {
                if !slot.chats.iter().any(|c| c["chat_id"] == id) {
                    return Err("연결된 계정의 채팅방이 아닙니다".into());
                }
            }
            if op != "search" && chat.is_none() {
                return Err("채팅방 없음".into());
            }
            let mut request = params.clone();
            request["op"] = json!(op);
            if op == "send" {
                if !slot
                    .chats
                    .iter()
                    .any(|c| c["chat_id"] == chat.unwrap() && c["can_send"] == true)
                {
                    return Err("읽기 전용 채팅방".into());
                }
                let body = params["body"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 16000)
                    .ok_or("메시지 크기 제한")?;
                let mut backend = slot.take_backend();
                let send_scope = Arc::new(());
                slot.sending = Arc::downgrade(&send_scope);
                slot.invalidate();
                let generation = slot.generation;
                drop(slot);
                let mut outcome = match call_account(
                    &entry.config,
                    &mut backend,
                    &entry.schedule,
                    &request,
                    self.run_worker,
                )
                .await
                {
                    Ok(value) => value,
                    Err(_) => json!({"state":"Uncertain"}),
                };
                if let Some(messages) = outcome["messages"].as_array_mut() {
                    messages.retain(|m| m["chat_id"] == chat.unwrap());
                    for message in messages {
                        message["platform"] = json!(platform);
                        message["account"] = json!(account);
                    }
                }
                let mut slot = entry.slot.lock().await;
                let cache_valid = slot.generation == generation;
                slot.invalidate();
                drop(send_scope);
                if cache_valid {
                    slot.backend = Some(backend);
                }
                if outcome["state"] == "Sent" {
                    if let Some(room) = slot
                        .chats
                        .iter_mut()
                        .find(|c| c["chat_id"] == chat.unwrap())
                    {
                        room["preview"] = json!(body.chars().take(200).collect::<String>());
                        room["latest_ts"] = json!(
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map_or(0., |d| d.as_secs_f64())
                        );
                    }
                }
                entry.snapshot.lock().unwrap().chats = slot.chats.clone();
                drop(slot);
                if !matches!(
                    outcome["state"].as_str(),
                    Some("Sent" | "Failed" | "Uncertain")
                ) {
                    outcome = json!({"state":"Uncertain"});
                }
                return Ok(outcome);
            }
            if op == "search"
                && params["query"]
                    .as_str()
                    .is_none_or(|q| q.trim().is_empty() || q.len() > 1000)
            {
                return Err("검색어를 입력하세요".into());
            }
            if request["refresh"] == true {
                slot.invalidate();
            }
            let (buffered, seen) = slot.message_pages.begin(&mut request)?;
            let generation = slot.generation;
            let overlapped_send = slot.sending.upgrade().is_some();
            let mut backend = if buffered.is_none() {
                Some(slot.take_backend())
            } else {
                None
            };
            drop(slot);
            let mut result = match buffered {
                Some(buffered) => buffered,
                None => {
                    let mut result = call_account(
                        &entry.config,
                        backend.as_mut().unwrap(),
                        &entry.schedule,
                        &request,
                        self.run_worker,
                    )
                    .await?;
                    result["_observation_order"] = request["_observation_order"].clone();
                    result
                }
            };
            let mut slot = entry.slot.lock().await;
            let superseded = overlapped_send
                || slot.sending.upgrade().is_some()
                || slot.generation != generation;
            let read_order = result["_observation_order"].as_u64().unwrap_or(0);
            if !superseded && read_order >= slot.last_read_order {
                if let Some(backend) = backend {
                    slot.backend = Some(backend);
                    slot.last_read_order = read_order;
                }
            }
            if let Some(messages) = result["messages"].as_array_mut() {
                messages.retain(|m| {
                    slot.chats.iter().any(|c| c["chat_id"] == m["chat_id"])
                        && chat.is_none_or(|id| m["chat_id"] == id)
                });
                for m in messages {
                    m["platform"] = json!(platform);
                    m["account"] = json!(account);
                }
            }
            if superseded {
                // A complete, already bounded read may still be returned as its
                // own snapshot. Never repopulate invalidated cursor registries.
                if result["next_cursor"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
                    || result["messages"].as_array().is_none_or(|m| m.len() > 30)
                    || serde_json::to_vec(&result).map_or(true, |bytes| bytes.len() > 58_000)
                {
                    return Err("조회 중 계정 상태가 변경되었습니다. 다시 조회하세요".into());
                }
                return Ok(result);
            }
            return slot.message_pages.finish(result, &request, seen);
        }
        Err("등록된 계정이 아닙니다".into())
    }
}
fn validate_chats(config: &AccountConfig, result: &Value) -> Result<Vec<Value>, String> {
    let items = result["chats"].as_array().ok_or("채팅 목록 응답 오류")?;
    if items.len() > 20000 {
        return Err("채팅 목록 제한 초과".into());
    }
    let mut unique = BTreeMap::new();
    for item in items {
        let id = item["chat_id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or("채팅 식별자 오류")?;
        let title = item["title"]
            .as_str()
            .filter(|s| s.len() <= 2000)
            .ok_or("채팅 이름 오류")?;
        let preview = item["preview"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(200)
            .collect::<String>();
        unique.insert(id.to_owned(),json!({"platform":config.platform,"account":config.account,"chat_id":id,"display_name":title,"latest_ts":item["latest_ts"],"preview":preview,"can_send":item["can_send"]==true,"unread_count":item["unread"]}));
    }
    Ok(unique.into_values().collect())
}
fn directory_page(snapshot: &Value, id: u64, offset: usize) -> Result<Value, String> {
    let chats = snapshot["chats"].as_array().ok_or("목록 오류")?;
    if offset > chats.len() {
        return Err("잘못된 목록 커서".into());
    }
    let mut end = (offset + 40).min(chats.len());
    while end > offset + 1
        && serde_json::to_vec(&chats[offset..end])
            .map_err(|_| "목록 오류")?
            .len()
            > 55000
    {
        end -= 1;
    }
    let mut result = snapshot.clone();
    result["chats"] = json!(&chats[offset..end]);
    result["next_cursor"] = json!((end < chats.len()).then(|| format!("{id}:{end}")));
    Ok(result)
}
struct WorkerProcess {
    _child: tokio::process::Child,
    input: tokio::process::ChildStdin,
    output: BufReader<tokio::process::ChildStdout>,
    _events: Option<live::EventReader>,
}
impl WorkerProcess {
    fn start(config: &AccountConfig, schedule: &Schedule) -> Result<Self, String> {
        let executable = std::env::current_exe()
            .map_err(|_| "실행 경로 오류")?
            .with_file_name("inboxd-account-worker");
        crate::worker::validate_trusted_executable_for_owner(
            &executable,
            rustix::process::geteuid().as_raw(),
        )
        .map_err(|_| "계정 워커 검증 실패")?;
        let mut child = Command::new(executable)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("INBOXD_ACCOUNT_CONFIG", config.config.as_str())
            .env("INBOXD_ACCOUNT_STREAM", "1")
            .env("INBOXD_ACCOUNT_LIVE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "계정 워커 실행 실패")?;
        let input = child.stdin.take().ok_or("워커 입력 오류")?;
        let output = BufReader::new(child.stdout.take().ok_or("워커 출력 오류")?);
        let events = live::read_events(
            child.stderr.take().ok_or("수신 채널 오류")?,
            schedule.live.clone(),
        );
        Ok(Self {
            _events: Some(events),
            _child: child,
            input,
            output,
        })
    }
    async fn request(&mut self, request: &Value) -> Result<Value, String> {
        let mut bytes = serde_json::to_vec(request).map_err(|_| "요청 오류")?;
        if bytes.len() > 65536 {
            return Err("요청 크기 제한".into());
        }
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| "워커 입력 실패")?;
        let mut response = vec![];
        (&mut self.output)
            .take(12_000_002)
            .read_until(b'\n', &mut response)
            .await
            .map_err(|_| "워커 출력 실패")?;
        if response.len() > 12_000_001 || response.last() != Some(&b'\n') {
            return Err("워커 응답 제한".into());
        }
        let value: Value = serde_json::from_slice(&response).map_err(|_| "워커 응답 오류")?;
        if value["ok"] != true {
            return Err("메신저 요청 실패".into());
        }
        Ok(value["result"].clone())
    }
}
async fn call_account(
    config: &AccountConfig,
    backend: &mut AccountBackend,
    schedule: &Schedule,
    request: &Value,
    runner: Option<WorkerCall>,
) -> Result<Value, String> {
    if let Some(run) = runner {
        return run(config, request).await;
    }
    let mut io = WorkerTransport { config, schedule };
    tokio::time::timeout(Duration::from_secs(90), backend.run(request, &mut io))
        .await
        .unwrap_or_else(|_| Err("메신저 응답 시간 초과".into()))
}

struct WorkerTransport<'a> {
    config: &'a AccountConfig,
    schedule: &'a Schedule,
}
impl ProviderIo for WorkerTransport<'_> {
    async fn call(&mut self, request: Value) -> Result<Value, String> {
        let typed =
            crate::accounts_backend::contract::validate_request(request, &self.config.platform)?;
        let request = serde_json::to_value(&typed).map_err(|_| "요청 오류")?;
        // Only this primitive/batch holds the FIFO worker lock. A long traversal
        // rejoins behind waiting interactive jobs at its next provider call.
        let mut worker = self.schedule.worker.lock().await;
        let mut process = match worker.take() {
            Some(process) => process,
            None => WorkerProcess::start(self.config, self.schedule)?,
        };
        let result = tokio::time::timeout(Duration::from_secs(90), process.request(&request))
            .await
            .unwrap_or_else(|_| Err("메신저 응답 시간 초과".into()));
        let result = result.and_then(|value| {
            crate::accounts_backend::contract::validate_result(&typed, &value)?;
            Ok(value)
        });
        // Cancellation during our I/O drops our taken process; cancellation while
        // queued cannot touch the active job's process. Never replay a request.
        if result.is_ok() {
            *worker = Some(process);
        }
        result
    }
}

#[cfg(test)]
#[path = "accounts_process_tests.rs"]
mod process_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SENDS: AtomicUsize = AtomicUsize::new(0);
    fn fake<'a>(
        _: &'a AccountConfig,
        request: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
    {
        Box::pin(async move {
            match request["op"].as_str() {
                Some("chats") => Ok(
                    json!({"chats":[{"chat_id":"room","title":"원래 이름","latest_ts":42,"preview":"hi","can_send":true}]}),
                ),
                Some("send") => {
                    SENDS.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"state":"Sent","receipt":"provider-id"}))
                }
                _ => Ok(
                    json!({"messages":[{"id":"ok","chat_id":"room","author_id":"u","author_name":"Name","ts":42,"body":"hi"},{"id":"foreign","chat_id":"other-account-room","author_id":"u","author_name":"Name","ts":42,"body":"foreign"}]}),
                ),
            }
        })
    }
    #[tokio::test]
    async fn direct_send_warms_only_target_account_and_revoked_binding_never_falls_back() {
        fn isolated<'a>(
            config: &'a AccountConfig,
            request: &'a Value,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
        {
            Box::pin(async move {
                assert_eq!(
                    config.account, "target",
                    "unrelated account must never load"
                );
                match request["op"].as_str() {
                    Some("chats") => Ok(
                        json!({"chats":[{"chat_id":"room","title":"room","latest_ts":0,"can_send":true}]}),
                    ),
                    Some("send") => Ok(json!({"state":"Sent","receipt":"only-target"})),
                    _ => panic!("unexpected operation"),
                }
            })
        }
        let directory = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().canonicalize().unwrap().join("direct.db");
        let storage = Arc::new(
            StorageActor::start(inboxd_storage::StorageActorConfig::new(&path, [0x76; 32]))
                .unwrap(),
        );
        let mut accounts = AccountService::new(
            ["target", "other"]
                .iter()
                .map(|account| AccountConfig {
                    platform: "slack".into(),
                    account: (*account).into(),
                    config: Zeroizing::new("{}".into()),
                })
                .collect(),
        )
        .with_storage(storage.clone());
        accounts.run_worker = Some(isolated);
        let registry = crate::CapabilityRegistry::new(vec![]).unwrap();
        let params = json!({"request_id":"cold-target-123456789","chat":{"platform":"slack","account":"target","chat_id":"room"},"body":"hello"});
        let outcome = crate::direct_send::execute(
            &storage,
            &registry,
            &accounts,
            &params,
            json!({"role":"sender"}),
        )
        .await
        .unwrap();
        assert_eq!(outcome["state"], "Sent");
        assert!(!accounts.slots[1].slot.lock().await.loaded);
        let denied = crate::TrustedBinding::new_static("fixed", json!({"v":1,"resource":{"v":1,"kind":"chat","platform":"slack","account":"target","chat_id":"room"},"read":{"mode":"none","limits":null},"write":{"mode":"none","content_mode":"none","reply":false},"receipt":{"level":"none"}})).unwrap();
        let registry = crate::CapabilityRegistry::new(vec![denied]).unwrap();
        assert!(registry.revoke("fixed").await);
        let mut new = params;
        new["request_id"] = json!("revoked-target-123456789");
        let error = crate::direct_send::execute(
            &storage,
            &registry,
            &accounts,
            &new,
            json!({"role":"sender"}),
        )
        .await
        .unwrap_err();
        assert!(error.contains("revoked"), "{error}");
    }
    static RELEASE: tokio::sync::Notify = tokio::sync::Notify::const_new();
    static LOADS: AtomicUsize = AtomicUsize::new(0);
    fn gated<'a>(
        config: &'a AccountConfig,
        request: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
    {
        Box::pin(async move {
            if request["op"] == "chats" {
                LOADS.fetch_add(1, Ordering::SeqCst);
                if config.account == "slow" {
                    RELEASE.notified().await;
                }
            }
            fake(config, request).await
        })
    }
    #[tokio::test]
    async fn background_directory_publishes_fast_accounts_and_coalesces_refresh() {
        let mut service = AccountService::new(
            ["slow", "fast"]
                .into_iter()
                .map(|account| AccountConfig {
                    platform: "telegram".into(),
                    account: account.into(),
                    config: Zeroizing::new("{}".into()),
                })
                .collect(),
        );
        service.run_worker = Some(gated);
        let first = service.list(&json!({"background":true})).await.unwrap();
        assert_eq!(first["refreshing"], true);
        tokio::time::timeout(Duration::from_secs(1), async {
            while !service.slots[1].snapshot.lock().unwrap().loaded {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let partial = service.list(&json!({"background":true})).await.unwrap();
        assert_eq!(partial["chats"].as_array().unwrap().len(), 1);
        assert_eq!(partial["chats"][0]["account"], "fast");
        assert_eq!(partial["refreshing"], true);
        // A slow unrelated account must not hold up a completed account's messages.
        tokio::time::timeout(
            Duration::from_secs(1),
            service.query(
                "messages",
                &json!({"platform":"telegram","account":"fast","chat_id":"room"}),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        RELEASE.notify_one();
        let complete = service.list(&json!({})).await.unwrap();
        assert_eq!(complete["chats"].as_array().unwrap().len(), 2);
        service.list(&json!({"background":true})).await.unwrap();
        assert_eq!(LOADS.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn directory_pagination_uses_an_immutable_snapshot() {
        let service = AccountService::new(vec![AccountConfig {
            platform: "slack".into(),
            account: "a".into(),
            config: Zeroizing::new("{}".into()),
        }]);
        {
            let mut snapshot = service.slots[0].snapshot.lock().unwrap();
            snapshot.loaded = true;
            snapshot.updated = Some(std::time::Instant::now());
            snapshot.chats = (0..45)
                .map(|i| json!({"chat_id":i.to_string(),"latest_ts":i}))
                .collect();
        }
        let first = service.list(&json!({"background":true})).await.unwrap();
        service.slots[0].snapshot.lock().unwrap().chats.clear();
        let second = service
            .list(&json!({"cursor":first["next_cursor"]}))
            .await
            .unwrap();
        assert_eq!(second["chats"].as_array().unwrap().len(), 5);
        assert_eq!(second["chats"][4]["chat_id"], "0");
    }
    #[tokio::test]
    async fn exact_account_scope_and_pending_send_deduplication() {
        let directory = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("owner-send.db");
        let actor = Arc::new(
            StorageActor::start(inboxd_storage::StorageActorConfig::new(
                &path,
                vec![0x73; 32],
            ))
            .unwrap(),
        );
        let mut service = AccountService::new(vec![AccountConfig {
            platform: "telegram".into(),
            account: "personal".into(),
            config: Zeroizing::new("{}".into()),
        }]);
        service.storage = Some(Arc::clone(&actor));
        service.run_worker = Some(fake);
        let directory = service.list(&json!({})).await.unwrap();
        assert_eq!(directory["chats"][0]["display_name"], "원래 이름");
        let params = json!({"platform":"telegram","account":"personal","chat_id":"room","body":"hello","request_id":"unique-request-123456"});
        let (one, two) = tokio::join!(
            service.query("send", &params),
            service.query("send", &params)
        );
        let outcomes = [one.unwrap(), two.unwrap()];
        assert!(outcomes.iter().any(|o| o["state"] == "Sent"));
        assert!(
            outcomes
                .iter()
                .all(|o| o["state"] == "Sent" || o["state"] == "Uncertain")
        );
        assert_eq!(SENDS.load(Ordering::SeqCst), 1);
        let mut changed = params.clone();
        changed["body"] = json!("different");
        assert!(service.query("send", &changed).await.is_err());
        changed = params.clone();
        changed["account"] = json!("historical");
        assert!(service.query("send", &changed).await.is_err());
        changed = params.clone();
        changed["chat_id"] = json!("foreign");
        assert!(service.query("send", &changed).await.is_err());
        let messages = service.query("messages", &params).await.unwrap();
        assert_eq!(messages["messages"].as_array().unwrap().len(), 1);
        assert_eq!(messages["messages"][0]["account"], "personal");
        drop(service);
        let mut actor = Arc::try_unwrap(actor).unwrap();
        actor.shutdown().unwrap();
        drop(actor);
        let actor = Arc::new(
            StorageActor::start(inboxd_storage::StorageActorConfig::new(
                &path,
                vec![0x73; 32],
            ))
            .unwrap(),
        );
        let mut restarted = AccountService::new(vec![AccountConfig {
            platform: "telegram".into(),
            account: "personal".into(),
            config: Zeroizing::new("{}".into()),
        }])
        .with_storage(actor);
        restarted.run_worker = Some(fake);
        // Known outcomes need neither a provider call nor a fresh directory.
        assert_eq!(
            restarted.query("send", &params).await.unwrap()["state"],
            "Sent"
        );
        assert_eq!(SENDS.load(Ordering::SeqCst), 1);
        let mut fresh = params.clone();
        fresh["request_id"] = json!("new-request-123456789");
        assert_eq!(
            restarted.query("send", &fresh).await.unwrap()["state"],
            "Sent"
        );
        assert_eq!(SENDS.load(Ordering::SeqCst), 2);
    }
    static OVERLAP_SEND_ENTERED: tokio::sync::Notify = tokio::sync::Notify::const_new();
    static OVERLAP_SEND_RELEASE: tokio::sync::Notify = tokio::sync::Notify::const_new();
    static OVERLAP_READ_ENTERED: tokio::sync::Notify = tokio::sync::Notify::const_new();
    static OVERLAP_READ_RELEASE: tokio::sync::Notify = tokio::sync::Notify::const_new();
    static OVERLAP_DIR_ENTERED: tokio::sync::Notify = tokio::sync::Notify::const_new();
    static OVERLAP_DIR_RELEASE: tokio::sync::Notify = tokio::sync::Notify::const_new();
    static OVERLAP_GATE_DIR: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static OVERLAP_SENDS: AtomicUsize = AtomicUsize::new(0);
    fn overlap<'a>(
        config: &'a AccountConfig,
        request: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
    {
        Box::pin(async move {
            match request["op"].as_str() {
                Some("send") => {
                    OVERLAP_SENDS.fetch_add(1, Ordering::SeqCst);
                    OVERLAP_SEND_ENTERED.notify_one();
                    OVERLAP_SEND_RELEASE.notified().await;
                    Ok(json!({"state":"Sent","receipt":"accepted"}))
                }
                Some("messages") => {
                    OVERLAP_READ_ENTERED.notify_one();
                    OVERLAP_READ_RELEASE.notified().await;
                    Ok(json!({"messages":[],"next_cursor":"pre-send-cursor","complete":false}))
                }
                Some("chats") if OVERLAP_GATE_DIR.load(Ordering::SeqCst) => {
                    OVERLAP_DIR_ENTERED.notify_one();
                    OVERLAP_DIR_RELEASE.notified().await;
                    fake(config, request).await
                }
                _ => fake(config, request).await,
            }
        })
    }
    #[tokio::test]
    async fn send_overlap_fences_read_and_directory_publication_even_after_cancellation_and_restart()
     {
        for cancel in [true, false] {
            OVERLAP_GATE_DIR.store(false, Ordering::SeqCst);
            let directory = tempfile::tempdir().unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .unwrap();
            let path = directory.path().canonicalize().unwrap().join("overlap.db");
            let actor = Arc::new(
                StorageActor::start(inboxd_storage::StorageActorConfig::new(&path, [0x75; 32]))
                    .unwrap(),
            );
            let configs = vec![AccountConfig {
                platform: "kakao".into(),
                account: "a".into(),
                config: Zeroizing::new("{}".into()),
            }];
            let mut service = AccountService::new(configs.clone()).with_storage(Arc::clone(&actor));
            service.run_worker = Some(overlap);
            service.list(&json!({})).await.unwrap();
            let service = Arc::new(service);
            let params = json!({"platform":"kakao","account":"a","chat_id":"room","body":"new preview","request_id":"overlap-send-123456"});
            let sender = Arc::clone(&service);
            let sent_params = params.clone();
            let send = tokio::spawn(async move { sender.query("send", &sent_params).await });
            OVERLAP_SEND_ENTERED.notified().await;
            let reader = Arc::clone(&service);
            let read = tokio::spawn(async move {
                reader
                    .query(
                        "messages",
                        &json!({"platform":"kakao","account":"a","chat_id":"room"}),
                    )
                    .await
            });
            OVERLAP_READ_ENTERED.notified().await;
            OVERLAP_GATE_DIR.store(true, Ordering::SeqCst);
            service
                .list(&json!({"background":true,"refresh":true}))
                .await
                .unwrap();
            OVERLAP_DIR_ENTERED.notified().await;
            if cancel {
                send.abort();
                assert!(send.await.unwrap_err().is_cancelled());
            } else {
                OVERLAP_SEND_RELEASE.notify_one();
                assert_eq!(send.await.unwrap().unwrap()["state"], "Sent");
            }
            OVERLAP_READ_RELEASE.notify_one();
            assert!(
                read.await.unwrap().is_err(),
                "overlapping cursor must not survive send cancellation/completion"
            );
            OVERLAP_DIR_RELEASE.notify_one();
            service.list(&json!({})).await.unwrap();
            {
                let slot = service.slots[0].slot.lock().await;
                assert!(
                    slot.backend.is_none(),
                    "overlapping jobs must not restore stale backend cache"
                );
                assert_eq!(
                    slot.chats[0]["preview"],
                    if cancel { "hi" } else { "new preview" }
                );
            }
            drop(service);
            let mut actor = Arc::try_unwrap(actor).unwrap();
            actor.shutdown().unwrap();
            drop(actor);
            let actor =
                StorageActor::start(inboxd_storage::StorageActorConfig::new(&path, [0x75; 32]))
                    .unwrap();
            let mut restarted = AccountService::new(configs).with_storage(Arc::new(actor));
            restarted.run_worker = Some(overlap);
            let count = OVERLAP_SENDS.load(Ordering::SeqCst);
            assert_eq!(
                restarted.query("send", &params).await.unwrap()["state"],
                if cancel { "Uncertain" } else { "Sent" }
            );
            assert_eq!(
                OVERLAP_SENDS.load(Ordering::SeqCst),
                count,
                "restart must not invoke provider again"
            );
        }
    }

    #[tokio::test]
    async fn directory_admission_overload_preserves_healthy_snapshot_and_send_capacity() {
        let mut service = AccountService::new(vec![AccountConfig {
            platform: "kakao".into(),
            account: "a".into(),
            config: Zeroizing::new("{}".into()),
        }]);
        service.run_worker = Some(fake);
        service.list(&json!({})).await.unwrap();
        let reads: Vec<_> = (0..3)
            .map(|_| service.slots[0].schedule.admit(false).unwrap())
            .collect();
        let result = service.list(&json!({"refresh":true})).await.unwrap();
        assert_eq!(result["errors"], json!([]));
        assert!(!service.slots[0].slot.lock().await.failed);
        assert!(service.slots[0].schedule.admit(true).is_ok());
        drop(reads);
    }

    #[test]
    fn directory_rejects_bad_ids_and_keeps_authority_out_of_provider_payload() {
        let config = AccountConfig {
            platform: "slack".into(),
            account: "account".into(),
            config: Zeroizing::new("{}".into()),
        };
        assert!(validate_chats(&config, &json!({"chats":[{"chat_id":"","title":"bad"}]})).is_err());
        let chats=validate_chats(&config,&json!({"chats":[{"chat_id":"room","title":"Original","account":"forged","platform":"forged"}]})).unwrap();
        assert_eq!(chats[0]["platform"], "slack");
        assert_eq!(chats[0]["account"], "account");
    }
    fn failing<'a>(
        _: &'a AccountConfig,
        _: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
    {
        Box::pin(async { Err("offline".into()) })
    }
    #[tokio::test]
    async fn cached_pages_preserve_failed_refresh_and_block_send() {
        let mut service = AccountService::new(vec![AccountConfig {
            platform: "telegram".into(),
            account: "personal".into(),
            config: Zeroizing::new("{}".into()),
        }]);
        service.run_worker = Some(fake);
        service.list(&json!({})).await.unwrap();
        service.run_worker = Some(failing);
        service.list(&json!({"refresh":true})).await.unwrap();
        let cached = service.list(&json!({})).await.unwrap();
        assert_eq!(cached["chats"].as_array().unwrap().len(), 1);
        assert_eq!(cached["errors"].as_array().unwrap().len(), 1);
        assert!(service.query("send",&json!({"platform":"telegram","account":"personal","chat_id":"room","body":"hello","request_id":"another-request-1234"})).await.is_err());
        service.run_worker = Some(fake);
        assert!(
            service.list(&json!({"refresh":true})).await.unwrap()["errors"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
