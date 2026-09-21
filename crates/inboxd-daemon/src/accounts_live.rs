//! Account-wide push invalidation and reconnect reconciliation. No message body
//! crosses this channel; remote history remains authoritative for workspace reads.
use super::*;
use crate::server::EventHub;
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct LiveSignal {
    pub revision: u64,
    pub chats: std::collections::BTreeSet<String>,
    pub gap: bool,
    pub state: String,
}
impl Default for LiveSignal {
    fn default() -> Self {
        Self {
            revision: 0,
            chats: Default::default(),
            gap: false,
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
                s.revision = s.revision.wrapping_add(1);
            });
        }
        Some("changed") if object.len() == 2 && valid_id(&value["chat_id"]) => {
            sender.send_modify(|s| {
                if s.chats.len() < 1024 {
                    s.chats.insert(value["chat_id"].as_str().unwrap().into());
                } else {
                    s.gap = true;
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
                "state":if signal.gap || !snapshot.errors.is_empty() { "degraded" } else { &signal.state },
                "revision":signal.revision,"deletion_gap":signal.gap,"deletion_evidence":if entry.config.platform=="kakao" {"unavailable"} else {"live_only"},"refreshing":snapshot.refreshing,
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
        loop {
            if !first {
                tokio::select! {
                    changed = signals.changed() => { if changed.is_err() { return; } }
                    _ = tokio::time::sleep(delay) => {}
                }
                // A fixed coalescing window bounds bursts without postponing work
                // forever when messages keep arriving. Each account runs independently.
                tokio::time::sleep(Duration::from_millis(750)).await;
            }
            first = false;
            let observed = signals.borrow_and_update().clone();
            let _ = events.publish("account.changed", json!({"platform":entry.config.platform,"account":entry.config.account,"state":observed.state,"phase":"refreshing"}));
            let result = self
                .list_filtered(
                    &json!({"refresh":true}),
                    Some((&entry.config.platform, &entry.config.account)),
                )
                .await;
            let failed = result.is_err() || !entry.snapshot.lock().unwrap().errors.is_empty();
            failures = if failed {
                failures.saturating_add(1)
            } else {
                0
            };
            delay = if failed {
                Duration::from_secs((5u64 << failures.saturating_sub(1).min(5)).min(120))
            } else if signals.borrow().state == "connected" {
                Duration::from_secs(60)
            } else {
                Duration::from_secs(30)
            };
            let state = signals.borrow().state.clone();
            let _ = events.publish("account.changed", json!({"platform":entry.config.platform,"account":entry.config.account,"state":if failed {"degraded"} else { state.as_str() },"phase":"ready"}));
            // Failure retries use a bounded backoff even if SDK errors generate
            // new hints. Sending is never retried by this read-only task.
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
}
