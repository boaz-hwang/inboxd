//! Content-free push hints drive bounded, durable recent-message observation.
//! Provider history remains authoritative; a partial page never proves completeness.
use super::*;
use crate::server::EventHub;
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LiveSignal {
    pub revision: u64,
    pub chats: std::collections::BTreeSet<(String, Option<String>)>,
    pub pending_rooms: usize,
    pub observation_failed: bool,
    pub gap: bool,
    pub rescan: bool,
    pub state: String,
}
impl Default for LiveSignal {
    fn default() -> Self {
        Self {
            revision: 0,
            chats: Default::default(),
            pending_rooms: 0,
            observation_failed: false,
            gap: false,
            rescan: true,
            state: "connecting".into(),
        }
    }
}

pub(super) fn accept_event(
    sender: &watch::Sender<LiveSignal>,
    value: &Value,
) -> Result<(), String> {
    let object = value.as_object().ok_or("잘못된 수신 이벤트")?;
    match value["event"].as_str() {
        Some("gap") if object.len() == 1 => {
            sender.send_modify(|s| {
                s.gap = true;
                s.rescan = true;
                s.revision = s.revision.wrapping_add(1);
            });
        }
        Some("changed")
            if valid_id(&value["chat_id"])
                && (object.len() == 2 || (object.len() == 3 && valid_id(&value["message_id"]))) =>
        {
            sender.send_modify(|s| {
                if s.chats.len() < 1024 {
                    s.chats.insert((
                        value["chat_id"].as_str().unwrap().into(),
                        value["message_id"].as_str().map(str::to_owned),
                    ));
                } else {
                    s.gap = true;
                    s.rescan = true;
                }
                s.revision = s.revision.wrapping_add(1);
            });
        }
        Some("changed") if object.len() == 1 => {
            sender.send_modify(|s| s.revision = s.revision.wrapping_add(1));
        }
        Some("state") if object.len() == 2 => {
            let state = value["state"]
                .as_str()
                .filter(|s| matches!(*s, "connected" | "disconnected" | "unsupported"))
                .ok_or("잘못된 수신 상태")?;
            sender.send_if_modified(|s| {
                if s.state == state {
                    return false;
                }
                s.state = state.into();
                if state == "connected" {
                    s.rescan = true;
                }
                s.revision = s.revision.wrapping_add(1);
                true
            });
        }
        _ => return Err("잘못된 수신 이벤트".into()),
    }
    Ok(())
}

fn valid_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
}

#[derive(Clone)]
pub(super) struct DeletionSink {
    platform: String,
    account: String,
    storage: Arc<StorageActor>,
    events: Arc<EventHub>,
}
impl DeletionSink {
    async fn apply(&self, value: &Value) -> Result<(), String> {
        if value.as_object().is_none_or(|v| v.len() != 3)
            || !valid_id(&value["chat_id"])
            || !valid_id(&value["message_id"])
            || !matches!(self.platform.as_str(), "slack" | "telegram")
        {
            return Err("invalid deletion evidence".into());
        }
        let rows = crate::accounts_backend::storage_keys::observations(
            &self.platform,
            &[json!({"chat_id":value["chat_id"],"id":value["message_id"]})],
        );
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "clock error")?
            .as_secs_f64();
        let result = self.storage.call_async(StorageOperation::DeleteObservedMessages, json!({"platform":self.platform,"account":self.account,"chat_id":rows[0]["chat_id"],"ids":[rows[0]["id"]],"deleted_at":at})).await.map_err(|_| "deletion persistence failed")?;
        if result["changed"].as_u64().unwrap_or(0) > 0 {
            self.events.publish("message.upserted", json!({"platform":self.platform,"account":self.account,"chat_id":value["chat_id"],"deleted":true})).map_err(|_| "event publish failed")?;
        }
        Ok(())
    }
}

pub(super) struct EventReader(pub tokio::task::JoinHandle<()>, watch::Sender<LiveSignal>);
impl Drop for EventReader {
    fn drop(&mut self) {
        self.0.abort();
        let _ = accept_event(&self.1, &json!({"event":"state","state":"disconnected"}));
    }
}

pub(super) fn read_events(
    output: tokio::process::ChildStderr,
    sender: watch::Sender<LiveSignal>,
    sink: Option<DeletionSink>,
) -> EventReader {
    let retained = sender.clone();
    EventReader(
        tokio::spawn(async move {
            let mut output = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let read = (&mut output).take(1025).read_until(b'\n', &mut line).await;
                if read.is_err()
                    || line.is_empty()
                    || line.len() > 1024
                    || line.last() != Some(&b'\n')
                {
                    break;
                }
                let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                    break;
                };
                if value["event"] == "deleted" {
                    if let Some(sink) = &sink {
                        if sink.apply(&value).await.is_err() {
                            let _ = accept_event(&sender, &json!({"event":"gap"}));
                            break;
                        }
                    } else {
                        let _ = accept_event(&sender, &json!({"event":"gap"}));
                    }
                    let _ = accept_event(
                        &sender,
                        &json!({"event":"changed","chat_id":value["chat_id"]}),
                    );
                    continue;
                }
                if accept_event(&sender, &value).is_err() {
                    break;
                }
            }
            let _ = accept_event(&sender, &json!({"event":"state","state":"disconnected"}));
        }),
        retained,
    )
}

impl AccountService {
    pub(crate) fn start_live(self: &Arc<Self>, events: Arc<EventHub>) -> tokio::task::JoinSet<()> {
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..self.slots.len() {
            if let Some(storage) = &self.storage {
                let entry = &self.slots[index];
                *entry.schedule.deletion_sink.lock().unwrap() = Some(DeletionSink {
                    platform: entry.config.platform.clone(),
                    account: entry.config.account.clone(),
                    storage: Arc::clone(storage),
                    events: Arc::clone(&events),
                });
            }
            let service = Arc::clone(self);
            let events = Arc::clone(&events);
            tasks.spawn(async move {
                service.run_live(index, events).await;
            });
        }
        tasks
    }

    pub(crate) async fn stop_live(&self) {
        self.stop_searches().await;
        for entry in &self.slots {
            if let Some(task) = entry.refresh_task.lock().unwrap().take() {
                task.abort();
            }
            entry.schedule.worker.lock().await.take();
        }
    }

    pub(crate) fn live_status(&self) -> Value {
        let accounts: Vec<_> = self
            .slots
            .iter()
            .map(|entry| {
                let signal = entry.schedule.live.borrow();
                let snapshot = entry.snapshot.lock().unwrap();
                json!({"platform":entry.config.platform,"account":entry.config.account,
                "state":if signal.gap || signal.observation_failed || !snapshot.errors.is_empty() { "degraded" } else { &signal.state },
                "revision":signal.revision,"deletion_gap":signal.gap,"observation_failed":signal.observation_failed,"pending_observation_rooms":signal.pending_rooms,"deletion_evidence":if entry.config.platform=="kakao" {"unavailable"} else {"live_only"},"refreshing":snapshot.refreshing,
                "snapshot_age_seconds":snapshot.updated.map(|t| t.elapsed().as_secs())})
            })
            .collect();
        json!({"state":if accounts.is_empty() { "idle" } else if accounts.iter().all(|a| a["state"] == "connected") { "live" } else { "degraded" },"accounts":accounts})
    }

    async fn run_live(self: Arc<Self>, index: usize, events: Arc<EventHub>) {
        let entry = &self.slots[index];
        let mut signals = entry.schedule.live.subscribe();
        let mut delay = Duration::from_secs(60);
        let mut first = true;
        let mut failures = 0u32;
        let mut pending = std::collections::VecDeque::<(String, Option<String>)>::new();
        let mut queued = std::collections::BTreeSet::<(String, Option<String>)>::new();
        let mut directory = BTreeMap::<String, Value>::new();
        let mut last_directory = None::<std::time::Instant>;
        let mut last_sweep = None::<std::time::Instant>;
        let mut revision = 0;
        loop {
            if !first {
                tokio::select! {
                    changed = signals.changed() => { if changed.is_err() { return; } }
                    _ = tokio::time::sleep(delay) => {}
                }
                // Fixed window: continuous pushes cannot postpone observation forever.
                tokio::time::sleep(Duration::from_millis(750)).await;
            }
            first = false;
            signals.borrow_and_update();
            let mut hints = Default::default();
            let mut rescan = false;
            let mut observed = LiveSignal::default();
            // Drain atomically, without creating a notification feedback loop.
            // Events arriving during provider reads remain queued for the next pass.
            entry.schedule.live.send_if_modified(|s| {
                observed = s.clone();
                hints = std::mem::take(&mut s.chats);
                rescan = std::mem::take(&mut s.rescan);
                false
            });
            let period = if observed.state == "connected" {
                60
            } else {
                30
            };
            let refresh_directory = last_directory
                .is_none_or(|t| t.elapsed() >= Duration::from_secs(period))
                || revision != observed.revision
                || failures > 0
                || rescan;
            revision = observed.revision;
            let mut failed = false;
            if refresh_directory {
                let _ = events.publish("account.changed", json!({"platform":entry.config.platform,"account":entry.config.account,"state":observed.state,"phase":"refreshing"}));
                let result = self
                    .list_filtered(
                        &json!({"refresh":true}),
                        Some((&entry.config.platform, &entry.config.account)),
                    )
                    .await;
                failed = result.is_err() || !entry.snapshot.lock().unwrap().errors.is_empty();
                if !failed {
                    last_directory = Some(std::time::Instant::now());
                    let current: BTreeMap<String, Value> = entry
                        .snapshot
                        .lock()
                        .unwrap()
                        .chats
                        .iter()
                        .map(|c| (c["chat_id"].as_str().unwrap().to_owned(), c.clone()))
                        .collect();
                    if self.storage.is_some() {
                        for (chat, value) in &current {
                            if directory.get(chat) != Some(value)
                                && queued.insert((chat.clone(), None))
                            {
                                pending.push_back((chat.clone(), None));
                            }
                        }
                    }
                    directory = current;
                    pending.retain(|(chat, _)| directory.contains_key(chat));
                    queued.retain(|(chat, _)| directory.contains_key(chat));
                }
            }
            if self.storage.is_some() {
                // Prioritize explicit targets. The periodic sweep also observes edits
                // whose directory timestamp/preview did not change, including unopened rooms.
                if failed {
                    // Directory authority could not be refreshed. Retain even
                    // previously unknown chat/message IDs until it can validate
                    // them; a recent-page sweep cannot recover an old edit target.
                    entry.schedule.live.send_if_modified(|s| {
                        for target in std::mem::take(&mut hints) {
                            if s.chats.len() < 1024 {
                                s.chats.insert(target);
                            } else {
                                s.gap = true;
                                s.rescan = true;
                            }
                        }
                        false
                    });
                }
                let mut targeted_count = queued
                    .iter()
                    .filter(|(_, message)| message.is_some())
                    .count();
                for target in hints {
                    if !directory.contains_key(&target.0) || queued.contains(&target) {
                        continue;
                    }
                    if target.1.is_some() && targeted_count >= 1024 {
                        rescan = true;
                        entry.schedule.live.send_if_modified(|s| {
                            s.gap = true;
                            false
                        });
                    } else if queued.insert(target.clone()) {
                        if target.1.is_some() {
                            targeted_count += 1;
                            pending.push_front(target);
                        } else {
                            // Room sweeps remain FIFO, including chat-only hints.
                            pending.push_back(target);
                        }
                    }
                }
                if rescan || last_sweep.is_none_or(|t| t.elapsed() >= Duration::from_secs(period)) {
                    for chat in directory.keys() {
                        if queued.insert((chat.clone(), None)) {
                            pending.push_back((chat.clone(), None));
                        }
                    }
                    last_sweep = Some(std::time::Instant::now());
                }
                if !failed {
                    // Keep work bounded and yield between batches. Each read uses the
                    // existing admission/FIFO scheduler with reserved send capacity.
                    for position in 0..pending.len().min(8) {
                        // Reserve half the batch for the oldest room sweep. A busy
                        // room's message-specific hints must not starve quiet rooms.
                        let sweep = if position % 2 == 1 {
                            pending.iter().position(|(_, message)| message.is_none())
                        } else {
                            None
                        };
                        let target = pending.remove(sweep.unwrap_or(0)).unwrap();
                        let mut request = json!({"platform":entry.config.platform,"account":entry.config.account,"chat_id":target.0,"refresh":true,"limit":80});
                        if let Some(message) = &target.1 {
                            request["message_id"] = json!(message);
                        }
                        let result = tokio::time::timeout(
                            Duration::from_secs(30),
                            self.query("messages", &request),
                        )
                        .await;
                        if matches!(result, Ok(Ok(_))) {
                            queued.remove(&target);
                        } else {
                            pending.push_back(target);
                            failed = true;
                        }
                    }
                }
            }
            // Failed hints survive backoff. A failed initial/reconnect directory
            // read must also retain the request to sweep its eventual result.
            entry.schedule.live.send_if_modified(|s| {
                s.observation_failed = failed;
                s.pending_rooms = pending
                    .iter()
                    .map(|(chat, _)| chat)
                    .collect::<std::collections::BTreeSet<_>>()
                    .len();
                s.rescan |= failed && rescan;
                false
            });
            failures = if failed {
                failures.saturating_add(1)
            } else {
                0
            };
            delay = if failed {
                Duration::from_secs((5u64 << failures.saturating_sub(1).min(5)).min(120))
            } else if !pending.is_empty() {
                Duration::from_secs(1)
            } else {
                Duration::from_secs(period)
            };
            let state = signals.borrow().state.clone();
            let _ = events.publish("account.changed", json!({"platform":entry.config.platform,"account":entry.config.account,"state":if failed {"degraded"} else {state.as_str()},"phase":"ready"}));
            if failed {
                tokio::time::sleep(delay).await;
                first = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    static READS: AtomicUsize = AtomicUsize::new(0);
    static FAIL: AtomicBool = AtomicBool::new(false);

    #[test]
    fn untrusted_events_cannot_supply_identity_or_content_and_bursts_are_bounded() {
        let (tx, mut rx) = watch::channel(LiveSignal::default());
        for value in [
            json!({"event":"changed","account":"foreign"}),
            json!({"event":"changed","body":"secret"}),
            json!({"event":"state","state":"fake"}),
            json!({"event":"send"}),
        ] {
            assert!(accept_event(&tx, &value).is_err());
        }
        for _ in 0..10000 {
            accept_event(&tx, &json!({"event":"changed"})).unwrap();
        }
        assert_eq!(rx.borrow_and_update().revision, 10000);
        accept_event(&tx, &json!({"event":"state","state":"connected"})).unwrap();
        assert_eq!(rx.borrow_and_update().revision, 10001);
        accept_event(&tx, &json!({"event":"state","state":"connected"})).unwrap();
        assert!(!rx.has_changed().unwrap());
    }

    #[tokio::test]
    async fn deletion_sink_maps_identity_and_commits_before_notification() {
        let dir = tempfile::tempdir().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let storage = Arc::new(
            StorageActor::start(inboxd_storage::StorageActorConfig::new(
                dir.path().join("deletions.db"),
                [44; 32],
            ))
            .unwrap(),
        );
        storage
            .call_async(StorageOperation::Migrate, Value::Null)
            .await
            .unwrap();
        let events = Arc::new(EventHub::default());
        let sink = DeletionSink {
            platform: "telegram".into(),
            account: "owner".into(),
            storage: Arc::clone(&storage),
            events,
        };
        sink.apply(&json!({"event":"deleted","chat_id":"42","message_id":"100"}))
            .await
            .unwrap();
        storage.call_async(StorageOperation::ObserveMessages,json!({"platform":"telegram","account":"owner","observed_at":999,"messages":[{"chat_id":"telegram:chat:42","id":"telegram:message:42:100","author_id":"7","body":"needle","ts":1}]})).await.unwrap();
        let result = storage
            .call_async(
                StorageOperation::SearchAccountMessages,
                json!({"platform":"telegram","account":"owner","query":"needle"}),
            )
            .await
            .unwrap();
        assert!(result["messages"].as_array().unwrap().is_empty());
        assert!(
            sink.apply(
                &json!({"event":"deleted","chat_id":"42","message_id":"100","account":"foreign"})
            )
            .await
            .is_err()
        );
    }

    fn provider<'a>(
        _: &'a AccountConfig,
        request: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
    {
        Box::pin(async move {
            assert_eq!(request["op"], "chats", "live recovery must never send");
            let revision = READS.fetch_add(1, Ordering::SeqCst) + 1;
            if FAIL.load(Ordering::SeqCst) {
                return Err("synthetic unavailable".into());
            }
            Ok(
                json!({"chats":[{"chat_id":"room","title":format!("revision {revision}"),"latest_ts":revision,"can_send":true}]}),
            )
        })
    }

    async fn wait_for(mut predicate: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(4), async {
            while !predicate() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn daemon_syncs_without_ui_coalesces_recovers_and_stops() {
        READS.store(0, Ordering::SeqCst);
        FAIL.store(false, Ordering::SeqCst);
        let mut service = AccountService::new(vec![AccountConfig {
            platform: "slack".into(),
            account: "synthetic".into(),
            config: Zeroizing::new("{}".into()),
        }]);
        service.run_worker = Some(provider);
        let service = Arc::new(service);
        let mut tasks = service.start_live(Arc::new(EventHub::default()));
        wait_for(|| service.slots[0].snapshot.lock().unwrap().loaded).await;
        let tx = &service.slots[0].schedule.live;
        accept_event(tx, &json!({"event":"state","state":"connected"})).unwrap();
        for _ in 0..1000 {
            accept_event(tx, &json!({"event":"changed"})).unwrap();
        }
        wait_for(|| service.slots[0].snapshot.lock().unwrap().chats[0]["latest_ts"] == 2).await;
        assert_eq!(READS.load(Ordering::SeqCst), 2);
        assert_eq!(service.live_status()["state"], "live");
        accept_event(tx, &json!({"event":"state","state":"disconnected"})).unwrap();
        assert_eq!(service.live_status()["state"], "degraded");
        accept_event(tx, &json!({"event":"state","state":"connected"})).unwrap();
        wait_for(|| READS.load(Ordering::SeqCst) >= 3).await;
        FAIL.store(true, Ordering::SeqCst);
        accept_event(tx, &json!({"event":"changed"})).unwrap();
        wait_for(|| !service.slots[0].snapshot.lock().unwrap().errors.is_empty()).await;
        assert_eq!(service.live_status()["state"], "degraded");
        assert!(
            !service.slots[0].snapshot.lock().unwrap().chats.is_empty(),
            "offline retains the last snapshot"
        );
        let reads = READS.load(Ordering::SeqCst);
        for _ in 0..1000 {
            accept_event(tx, &json!({"event":"changed"})).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(850)).await;
        assert_eq!(
            READS.load(Ordering::SeqCst),
            reads,
            "failed reads must back off despite push bursts"
        );
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        service.stop_live().await;
        assert_eq!(Arc::strong_count(&service), 1);
    }
    fn durable_provider<'a>(
        config: &'a AccountConfig,
        request: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
    {
        Box::pin(async move {
            use std::io::Write;
            let root = std::path::Path::new(config.config.as_str());
            let mut log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(root.join("calls"))
                .unwrap();
            writeln!(log, "{}", request).unwrap();
            if request["op"] == "chats" {
                if root.join("fail-directory").exists() {
                    return Err("directory unavailable".into());
                }
                if root.join("many").exists() {
                    return Ok(
                        json!({"chats":(0..12).map(|n| json!({"chat_id":format!("room-{n:02}"),"title":"Room","latest_ts":10,"can_send":true})).collect::<Vec<_>>()}),
                    );
                }
                return Ok(json!({"chats":[
                    {"chat_id":"a","title":"A","latest_ts":10,"can_send":true},
                    {"chat_id":"b","title":"B","latest_ts":10,"can_send":true}
                ]}));
            }
            assert_eq!(request["op"], "messages", "observation must never send");
            assert_eq!(request["refresh"], true);
            let chat = request["chat_id"].as_str().unwrap();
            while root.join(format!("gate-{chat}")).exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            if root.join("fail").exists() {
                return Err("provider unavailable".into());
            }
            let body = std::fs::read_to_string(root.join(chat))
                .unwrap_or_else(|_| "needle initial".into());
            // Invalid observation simulates a rejected storage transaction, after
            // the read succeeded. No event may be emitted on this path.
            let author = if root.join("invalid").exists() {
                Value::Null
            } else {
                json!("u")
            };
            Ok(
                json!({"messages":[{"id":request["message_id"].as_str().unwrap_or("1"),"chat_id":chat,"author_id":author,"author_name":"User","ts":10,"body":body}]}),
            )
        })
    }

    fn durable_service() -> (
        tempfile::TempDir,
        Arc<AccountService>,
        tokio::sync::mpsc::Receiver<Value>,
    ) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let storage = Arc::new(
            StorageActor::start(inboxd_storage::StorageActorConfig::new(
                dir.path().join("live.db"),
                [55; 32],
            ))
            .unwrap(),
        );
        let events = Arc::new(EventHub::default());
        let receiver = events.test_subscription("message.upserted");
        let mut service = AccountService::new(vec![AccountConfig {
            platform: "slack".into(),
            account: "owner".into(),
            config: Zeroizing::new(dir.path().to_str().unwrap().into()),
        }])
        .with_storage(storage)
        .with_events(events);
        service.run_worker = Some(durable_provider);
        (dir, Arc::new(service), receiver)
    }

    async fn notification(rx: &mut tokio::sync::mpsc::Receiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn local(service: &Arc<AccountService>, query: &str) -> Value {
        service
            .search(&json!({"mode":"local","platform":"slack","account":"owner","query":query}))
            .await
            .unwrap()
    }

    fn message_calls(dir: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(dir.join("calls"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|v| v["op"] == "messages")
            .collect()
    }

    #[tokio::test]
    async fn unopened_rooms_are_durable_and_targeted_push_commits_before_event() {
        let (dir, service, mut rx) = durable_service();
        let mut tasks = service.start_live(Arc::clone(service.events.as_ref().unwrap()));
        for _ in 0..2 {
            let event = notification(&mut rx).await;
            let result = local(&service, "needle").await;
            assert!(
                result["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["chat_id"] == event["params"]["chat_id"])
            );
        }
        wait_for(|| service.slots[0].schedule.live.borrow().pending_rooms == 0).await;
        assert_eq!(message_calls(dir.path()).len(), 2);
        std::fs::write(dir.path().join("b"), "needle edited").unwrap();
        let sender = &service.slots[0].schedule.live;
        for _ in 0..1000 {
            accept_event(sender, &json!({"event":"changed","chat_id":"b"})).unwrap();
        }
        let event = notification(&mut rx).await;
        assert_eq!(event["params"]["chat_id"], "b");
        assert_eq!(
            local(&service, "edited").await["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(message_calls(dir.path()).len(), 3);
        assert_eq!(message_calls(dir.path())[2]["chat_id"], "b");
        assert!(
            sender.borrow().chats.is_empty(),
            "consumed targets must not accumulate"
        );
        accept_event(sender, &json!({"event":"changed","chat_id":"b"})).unwrap();
        wait_for(|| message_calls(dir.path()).len() == 4).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            rx.try_recv().is_err(),
            "unchanged observations must not notify"
        );
        accept_event(
            sender,
            &json!({"event":"changed","chat_id":"b","message_id":"old"}),
        )
        .unwrap();
        notification(&mut rx).await;
        assert!(
            local(&service, "edited").await["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["msg_id"] == "old")
        );
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        service.stop_live().await;
        drop(service);
        let host =
            inboxd_storage::NativeHost::open_development(&dir.path().join("live.db"), &[55; 32])
                .unwrap();
        assert_eq!(
            host.execute(
                "observations.search",
                &json!({"platform":"slack","account":"owner","query":"edited"})
            )
            .unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn hints_during_reads_and_reconnect_sweeps_are_not_lost() {
        let (dir, service, mut rx) = durable_service();
        let mut tasks = service.start_live(Arc::clone(service.events.as_ref().unwrap()));
        notification(&mut rx).await;
        notification(&mut rx).await;
        std::fs::write(dir.path().join("gate-a"), "").unwrap();
        let sender = &service.slots[0].schedule.live;
        accept_event(sender, &json!({"event":"changed","chat_id":"a"})).unwrap();
        wait_for(|| message_calls(dir.path()).len() == 3).await;
        std::fs::write(dir.path().join("b"), "needle during read").unwrap();
        accept_event(sender, &json!({"event":"changed","chat_id":"b"})).unwrap();
        std::fs::remove_file(dir.path().join("gate-a")).unwrap();
        assert_eq!(notification(&mut rx).await["params"]["chat_id"], "b");
        std::fs::write(dir.path().join("a"), "needle offline edit").unwrap();
        accept_event(sender, &json!({"event":"state","state":"connected"})).unwrap();
        assert_eq!(notification(&mut rx).await["params"]["chat_id"], "a");
        assert_eq!(
            local(&service, "offline").await["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        service.stop_live().await;
    }

    #[tokio::test]
    async fn failed_read_or_persistence_retains_target_and_retries_without_new_push() {
        for failure in ["fail", "invalid"] {
            let (dir, service, mut rx) = durable_service();
            let mut tasks = service.start_live(Arc::clone(service.events.as_ref().unwrap()));
            notification(&mut rx).await;
            notification(&mut rx).await;
            std::fs::write(dir.path().join("b"), "needle recovered").unwrap();
            std::fs::write(dir.path().join(failure), "").unwrap();
            accept_event(
                &service.slots[0].schedule.live,
                &json!({"event":"changed","chat_id":"b"}),
            )
            .unwrap();
            wait_for(|| service.slots[0].schedule.live.borrow().observation_failed).await;
            assert_eq!(
                service.live_status()["accounts"][0]["pending_observation_rooms"],
                1
            );
            assert!(rx.try_recv().is_err());
            assert!(
                local(&service, "recovered").await["messages"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            std::fs::remove_file(dir.path().join(failure)).unwrap();
            assert_eq!(notification(&mut rx).await["params"]["chat_id"], "b");
            assert_eq!(
                local(&service, "recovered").await["messages"]
                    .as_array()
                    .unwrap()
                    .len(),
                1
            );
            wait_for(|| !service.slots[0].schedule.live.borrow().observation_failed).await;
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
            service.stop_live().await;
        }
    }
    #[tokio::test]
    async fn room_sweep_drains_in_bounded_batches_without_reloading_directory() {
        let (dir, service, mut rx) = durable_service();
        std::fs::write(dir.path().join("many"), "").unwrap();
        let mut tasks = service.start_live(Arc::clone(service.events.as_ref().unwrap()));
        for _ in 0..8 {
            notification(&mut rx).await;
        }
        wait_for(|| service.slots[0].schedule.live.borrow().pending_rooms == 4).await;
        assert_eq!(message_calls(dir.path()).len(), 8);
        for _ in 0..4 {
            notification(&mut rx).await;
        }
        assert_eq!(
            local(&service, "needle").await["messages"]
                .as_array()
                .unwrap()
                .len(),
            12
        );
        let calls = std::fs::read_to_string(dir.path().join("calls")).unwrap();
        assert_eq!(
            calls
                .lines()
                .filter(|line| serde_json::from_str::<Value>(line).unwrap()["op"] == "chats")
                .count(),
            1
        );
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        service.stop_live().await;
    }

    #[tokio::test]
    async fn periodic_sweep_repairs_missed_push_with_unchanged_directory() {
        let (dir, service, mut rx) = durable_service();
        let mut tasks = service.start_live(Arc::clone(service.events.as_ref().unwrap()));
        notification(&mut rx).await;
        notification(&mut rx).await;
        std::fs::write(dir.path().join("a"), "needle missed push").unwrap();
        let event = tokio::time::timeout(Duration::from_secs(35), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["params"]["chat_id"], "a");
        assert_eq!(
            local(&service, "missed").await["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        service.stop_live().await;
    }
    #[tokio::test]
    async fn failed_initial_directory_preserves_unknown_old_message_hint() {
        let (dir, service, mut rx) = durable_service();
        std::fs::write(dir.path().join("fail-directory"), "").unwrap();
        let sender = &service.slots[0].schedule.live;
        accept_event(
            sender,
            &json!({"event":"changed","chat_id":"b","message_id":"old"}),
        )
        .unwrap();
        let mut tasks = service.start_live(Arc::clone(service.events.as_ref().unwrap()));
        wait_for(|| sender.borrow().observation_failed).await;
        assert!(
            sender
                .borrow()
                .chats
                .contains(&("b".into(), Some("old".into())))
        );
        assert!(rx.try_recv().is_err());
        std::fs::remove_file(dir.path().join("fail-directory")).unwrap();
        notification(&mut rx).await;
        assert!(
            message_calls(dir.path())
                .iter()
                .any(|r| r["chat_id"] == "b" && r["message_id"] == "old")
        );
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        service.stop_live().await;
    }
}
