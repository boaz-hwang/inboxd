//! Account-wide directory and direct owner-TUI operations. Credentials never cross RPC.
use serde_json::{Value, json};
use std::{collections::BTreeMap, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};
use zeroize::Zeroizing;

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
    worker: Option<WorkerProcess>,
    sends: BTreeMap<String, (String, Value)>,
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
    config: AccountConfig,
    slot: Arc<Mutex<Slot>>,
    snapshot: Arc<std::sync::Mutex<Snapshot>>,
}
pub(crate) struct AccountService {
    run_worker: Option<WorkerCall>,
    slots: Vec<Entry>,
    pages: std::sync::Mutex<BTreeMap<u64, (std::time::Instant, Value)>>,
    sequence: std::sync::atomic::AtomicU64,
}
impl AccountService {
    pub(crate) fn new(configs: Vec<AccountConfig>) -> Self {
        Self {
            run_worker: None,
            pages: Default::default(),
            sequence: std::sync::atomic::AtomicU64::new(0),
            slots: configs
                .into_iter()
                .map(|config| Entry {
                    config: config.clone(),
                    snapshot: Default::default(),
                    slot: Arc::new(Mutex::new(Slot {
                        config,
                        chats: vec![],
                        loaded: false,
                        failed: false,
                        worker: None,
                        sends: BTreeMap::new(),
                    })),
                })
                .collect(),
        }
    }
    pub(crate) async fn list(&self, params: &Value) -> Result<Value, String> {
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
            let runner = self.run_worker;
            let refresh = params["refresh"] == true;
            tokio::spawn(async move {
                let mut slot = shared.lock().await;
                let result =
                    call_worker(&mut slot, &json!({"op":"chats", "refresh":refresh}), runner)
                        .await
                        .and_then(|value| validate_chats(&slot.config, &value));
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
        }
        if !background {
            while self
                .slots
                .iter()
                .any(|e| e.snapshot.lock().unwrap().refreshing)
            {
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
        let platform = params["platform"].as_str().ok_or("메신저 없음")?;
        let account = params["account"].as_str().ok_or("계정 없음")?;
        for entry in &self.slots {
            if entry.config.platform != platform || entry.config.account != account {
                continue;
            }
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
                let id = params["request_id"]
                    .as_str()
                    .filter(|s| s.len() >= 16 && s.len() <= 80)
                    .ok_or("전송 식별자 없음")?
                    .to_owned();
                let fingerprint = format!("{}:{}", chat.unwrap(), body);
                if let Some((previous, result)) = slot.sends.get(&id) {
                    return if previous == &fingerprint {
                        Ok(result.clone())
                    } else {
                        Err("전송 식별자 재사용 거부".into())
                    };
                }
                if slot.sends.len() >= 10000 {
                    return Err("전송 세션 제한".into());
                }
                slot.sends.insert(
                    id.clone(),
                    (fingerprint.clone(), json!({"state":"Uncertain"})),
                );
                let mut outcome = match call_worker(&mut slot, &request, self.run_worker).await {
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
                slot.sends.insert(id, (fingerprint, outcome.clone()));
                return Ok(outcome);
            }
            if op == "search"
                && params["query"]
                    .as_str()
                    .is_none_or(|q| q.trim().is_empty() || q.len() > 1000)
            {
                return Err("검색어를 입력하세요".into());
            }
            let mut result = call_worker(&mut slot, &request, self.run_worker).await?;
            if let Some(messages) = result["messages"].as_array_mut() {
                messages.retain(|m| slot.chats.iter().any(|c| c["chat_id"] == m["chat_id"]));
                for m in messages {
                    m["platform"] = json!(platform);
                    m["account"] = json!(account);
                }
            }
            if serde_json::to_vec(&result)
                .map_err(|_| "응답 인코딩 실패")?
                .len()
                > 60000
            {
                return Err("메시지 페이지가 너무 큽니다".into());
            }
            return Ok(result);
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
}
impl WorkerProcess {
    fn start(config: &AccountConfig) -> Result<Self, String> {
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
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "계정 워커 실행 실패")?;
        let input = child.stdin.take().ok_or("워커 입력 오류")?;
        let output = BufReader::new(child.stdout.take().ok_or("워커 출력 오류")?);
        Ok(Self {
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
async fn call_worker(
    slot: &mut Slot,
    request: &Value,
    runner: Option<WorkerCall>,
) -> Result<Value, String> {
    if let Some(run) = runner {
        return run(&slot.config, request).await;
    }
    let mut process = match slot.worker.take() {
        Some(process) => process,
        None => WorkerProcess::start(&slot.config)?,
    };
    let result = tokio::time::timeout(Duration::from_secs(90), process.request(request))
        .await
        .unwrap_or_else(|_| Err("메신저 응답 시간 초과".into()));
    // Discard broken sessions without replaying the operation, especially sends.
    if result.is_ok() {
        slot.worker = Some(process);
    }
    result
}

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
                    json!({"messages":[{"id":"ok","chat_id":"room"},{"id":"foreign","chat_id":"other-account-room"}]}),
                ),
            }
        })
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
        let mut service = AccountService::new(vec![AccountConfig {
            platform: "telegram".into(),
            account: "personal".into(),
            config: Zeroizing::new("{}".into()),
        }]);
        service.run_worker = Some(fake);
        let directory = service.list(&json!({})).await.unwrap();
        assert_eq!(directory["chats"][0]["display_name"], "원래 이름");
        let params = json!({"platform":"telegram","account":"personal","chat_id":"room","body":"hello","request_id":"unique-request-123456"});
        let (one, two) = tokio::join!(
            service.query("send", &params),
            service.query("send", &params)
        );
        assert_eq!(one.unwrap(), two.unwrap());
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
