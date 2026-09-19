//! Shared local/remote/refresh search, with bounded scope-bound refresh handles.
use super::*;
use std::{collections::VecDeque, sync::atomic::Ordering, time::Instant};

struct SearchJob {
    id: String,
    scope: Value,
    created: Instant,
    result: Option<Result<Value, String>>,
    task: tokio::task::JoinHandle<()>,
}
#[derive(Default)]
pub(super) struct SearchJobs {
    entries: VecDeque<SearchJob>,
}

/// One account per request; clients can query selected accounts concurrently.
/// Legacy chat+interval searches without a mode retain their historical API.
fn normalize(params: &Value) -> Result<(String, Value, Option<String>), String> {
    let object = params.as_object().ok_or("invalid search request")?;
    if object.keys().any(|k| {
        ![
            "mode",
            "platform",
            "account",
            "chat_id",
            "chat",
            "query",
            "interval",
            "limit",
            "cursor",
            "refresh_id",
        ]
        .contains(&k.as_str())
    }) {
        return Err("unknown search parameter".into());
    }
    let mode = params["mode"].as_str().unwrap_or("local");
    if !matches!(mode, "local" | "remote" | "refresh")
        || params.get("mode").is_some_and(|v| !v.is_string())
    {
        return Err("invalid search mode".into());
    }
    let mut input = json!({});
    if let Some(chat) = params.get("chat") {
        if object.contains_key("platform")
            || object.contains_key("account")
            || object.contains_key("chat_id")
        {
            return Err("supply chat or account scope, not both".into());
        }
        if chat.as_object().is_none_or(|c| {
            c.len() != 3
                || c.keys()
                    .any(|k| !["platform", "account", "chat_id"].contains(&k.as_str()))
        }) {
            return Err("invalid chat".into());
        }
        input = chat.clone();
    } else {
        input["platform"] = params["platform"].clone();
        input["account"] = params["account"].clone();
        if let Some(chat) = params.get("chat_id") {
            input["chat_id"] = chat.clone();
        }
    }
    for key in ["platform", "account"] {
        if input[key]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 1024)
        {
            return Err("invalid account scope".into());
        }
    }
    if let Some(chat) = input.get("chat_id") {
        let id = chat
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 1024)
            .ok_or("invalid chat scope")?;
        if input["platform"] == "telegram" {
            input["chat_id"] = json!(id.strip_prefix("telegram:chat:").unwrap_or(id));
        }
    }
    let query = params["query"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 1000)
        .ok_or("query must contain 1 to 1000 bytes")?;
    input["query"] = json!(query);
    let interval = params
        .get("interval")
        .cloned()
        .unwrap_or(json!({"from_ts":0,"to_ts":9007199254740991u64}));
    if interval.as_object().is_none_or(|o| o.len() != 2)
        || !interval["from_ts"].as_f64().is_some_and(f64::is_finite)
        || !interval["to_ts"].as_f64().is_some_and(|to| {
            to.is_finite() && to > interval["from_ts"].as_f64().unwrap_or(f64::INFINITY)
        })
    {
        return Err("invalid search interval".into());
    }
    input["interval"] = interval;
    input["limit"] = json!(
        params
            .get("limit")
            .map_or(Some(80), Value::as_u64)
            .filter(|n| (1..=80).contains(n))
            .ok_or("limit must be 1 to 80")?
    );
    if let Some(cursor) = params.get("cursor") {
        if mode == "refresh" {
            return Err("continue returned pages with local or remote mode".into());
        }
        input["cursor"] = json!(
            cursor
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 4096)
                .ok_or("invalid cursor")?
        );
    }
    let refresh = params
        .get("refresh_id")
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty() && s.len() <= 80)
                .map(str::to_owned)
                .ok_or("invalid refresh ID")
        })
        .transpose()?;
    if refresh.is_some() && mode != "refresh" {
        return Err("refresh_id requires refresh mode".into());
    }
    Ok((mode.into(), input, refresh))
}

impl AccountService {
    pub(super) fn next_observation(&self) -> u64 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |t| t.as_micros() as u64);
        self.observation_sequence
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |old| {
                Some(now.max(old.saturating_add(1)))
            })
            .unwrap()
            .max(now.saturating_sub(1))
            + 1
    }
    pub(super) async fn persist_observations(
        &self,
        scope: &Value,
        result: &Value,
        order: u64,
    ) -> Result<(), String> {
        let Some(storage) = &self.storage else {
            return Ok(());
        };
        let Some(messages) = result["messages"].as_array() else {
            return Ok(());
        };
        let messages = crate::accounts_backend::storage_keys::observations(
            scope["platform"].as_str().ok_or("platform required")?,
            messages,
        );
        let stored=storage.call_async(StorageOperation::ObserveMessages,json!({"platform":scope["platform"],"account":scope["account"],"observed_at":order,"messages":messages})).await.map_err(|e|e.message)?;
        if stored["changed"].as_u64().unwrap_or(0) > 0 {
            if let Some(events) = &self.events {
                let _=events.publish("message.upserted",json!({"platform":scope["platform"],"account":scope["account"],"chat_id":scope["chat_id"]}));
            }
        }
        Ok(())
    }
    async fn local_search(&self, input: &Value) -> Result<Value, String> {
        let mut scope = input.clone();
        let platform = input["platform"].as_str().unwrap();
        if let Some(chat) = input["chat_id"].as_str() {
            scope["chat_id"] = json!(crate::accounts_backend::storage_keys::chat(platform, chat));
        }
        let mut result = self
            .storage
            .as_ref()
            .ok_or("search storage unavailable")?
            .call_async(StorageOperation::SearchAccountMessages, scope)
            .await
            .map_err(|e| e.message)?;
        crate::accounts_backend::storage_keys::workspace_result(platform, &mut result);
        Ok(result)
    }
    async fn remote_search(&self, input: &Value) -> Result<Value, String> {
        let work=self.work.start("message.search.remote",json!({"platform":input["platform"],"account":input["account"],"chat_id":input["chat_id"]}))?;
        let result = self.remote_search_inner(input).await;
        work.finish(result.is_ok());
        result
    }
    async fn remote_search_inner(&self, input: &Value) -> Result<Value, String> {
        let platform = input["platform"].as_str().unwrap();
        let account = input["account"].as_str().unwrap();
        // MCP need not open a TUI first. Directory authority is shared and lazily
        // initialized through the same bounded account scheduler.
        self.list_filtered(&json!({}), Some((platform, account)))
            .await?;
        let mut request = input.clone();
        if request.get("cursor").is_none() {
            request["refresh"] = json!(true);
        }
        let mut result = self.query("search", &request).await?;
        let from = input["interval"]["from_ts"].as_f64().unwrap();
        let to = input["interval"]["to_ts"].as_f64().unwrap();
        if let Some(rows) = result["messages"].as_array_mut() {
            rows.retain(|m| m["ts"].as_f64().is_some_and(|ts| ts >= from && ts < to));
        }
        result["source"] = json!("remote");
        result["semantics"] = json!("provider");
        result["persisted"] = json!(true);
        result["checked_at"] = json!(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0., |t| t.as_secs_f64())
        );
        result["coverage"] = json!({"covered":[],"gaps":[{"interval":input["interval"],"reason":"unknown"}],"limits":[],"freshness":[]});
        Ok(result)
    }
    pub(crate) async fn search(self: &Arc<Self>, params: &Value) -> Result<Value, String> {
        let (mode, input, refresh) = normalize(params)?;
        if self.storage.is_none() {
            return Err("search storage unavailable".into());
        }
        if !self
            .slots
            .iter()
            .any(|e| e.config.platform == input["platform"] && e.config.account == input["account"])
        {
            return Err("configured account required".into());
        }
        match mode.as_str() {
            "local" => return self.local_search(&input).await,
            "remote" => return self.remote_search(&input).await,
            _ => {}
        }
        if let Some(id) = refresh {
            let result = {
                let jobs = self.searches.lock().unwrap();
                let job = jobs
                    .entries
                    .iter()
                    .find(|j| {
                        j.id == id
                            && j.scope == input
                            && j.created.elapsed() < Duration::from_secs(120)
                    })
                    .ok_or("refresh expired or scope mismatch")?;
                job.result.clone()
            };
            return match result {
                Some(Ok(mut result)) => {
                    result["refresh"] = json!({"id":id,"state":"succeeded"});
                    Ok(result)
                }
                other => {
                    let mut local = self.local_search(&input).await?;
                    local["refresh"] = match other {
                        Some(Err(_)) => {
                            json!({"id":id,"state":"failed","error":"remote search or persistence failed"})
                        }
                        _ => json!({"id":id,"state":"running"}),
                    };
                    Ok(local)
                }
            };
        }
        let mut local = self.local_search(&input).await?;
        let mut jobs = self.searches.lock().unwrap();
        jobs.entries.retain(|job| {
            let keep = job.created.elapsed() < Duration::from_secs(120);
            if !keep {
                job.task.abort();
            }
            keep
        });
        // Coalesce repeated first-page requests for the same still-running scope.
        if let Some(job) = jobs
            .entries
            .iter()
            .find(|j| j.scope == input && j.result.is_none())
        {
            local["refresh"] = json!({"id":job.id,"state":"running"});
            return Ok(local);
        }
        while jobs.entries.len() >= 32 {
            let index = jobs
                .entries
                .iter()
                .position(|j| j.result.is_some())
                .ok_or("too many active refresh jobs")?;
            jobs.entries.remove(index);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let task_id = id.clone();
        let scope = input.clone();
        let service = Arc::clone(self);
        let task = tokio::spawn(async move {
            let result =
                tokio::time::timeout(Duration::from_secs(100), service.remote_search(&scope))
                    .await
                    .unwrap_or_else(|_| Err("remote search timed out".into()));
            if let Some(job) = service
                .searches
                .lock()
                .unwrap()
                .entries
                .iter_mut()
                .find(|j| j.id == task_id)
            {
                job.result = Some(result);
            }
        });
        jobs.entries.push_back(SearchJob {
            id: id.clone(),
            scope: input,
            created: Instant::now(),
            result: None,
            task,
        });
        local["refresh"] = json!({"id":id,"state":"running"});
        Ok(local)
    }
    pub(super) async fn stop_searches(&self) {
        let jobs = std::mem::take(&mut self.searches.lock().unwrap().entries);
        for job in &jobs {
            job.task.abort();
        }
        for job in jobs {
            let _ = job.task.await;
        }
    }
    pub(crate) fn sync_status(&self) -> Value {
        let mut status = self.live_status();
        status["receiving_state"] = status["state"].clone();
        let work = self.work.snapshot();
        status["state"] = work["state"].clone();
        status["work"] = work;
        status
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use inboxd_storage::StorageActorConfig;
    use std::{fs, os::unix::fs::PermissionsExt};

    fn provider<'a>(
        config: &'a AccountConfig,
        request: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>
    {
        Box::pin(async move {
            let path = std::path::Path::new(config.config.as_str());
            if request["op"] == "chats" {
                return Ok(
                    json!({"chats":[{"chat_id":"room","title":"Room","latest_ts":10,"can_send":true}]}),
                );
            }
            if request["query"] == "fail" {
                return Err("synthetic provider failure".into());
            }
            while path.join("gate").exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            if request["op"] == "search" && request.get("cursor").is_none() {
                assert_eq!(request["refresh"], true);
            }
            let body = fs::read_to_string(path.join("body")).unwrap_or("needle original".into());
            Ok(
                json!({"messages":[{"id":"1","chat_id":"room","author_id":"u","author_name":"Name","ts":10,"body":body},{"id":"2","chat_id":"room","author_id":"u","author_name":"Name","ts":11,"body":format!("{body} second")}]}),
            )
        })
    }
    fn service() -> (tempfile::TempDir, Arc<AccountService>) {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let storage = Arc::new(
            StorageActor::start(StorageActorConfig::new(
                dir.path().join("search.db"),
                [0x61; 32],
            ))
            .unwrap(),
        );
        let mut service = AccountService::new(vec![AccountConfig {
            platform: "slack".into(),
            account: "a".into(),
            config: Zeroizing::new(dir.path().to_str().unwrap().into()),
        }])
        .with_storage(storage);
        service.run_worker = Some(provider);
        (dir, Arc::new(service))
    }
    fn request(mode: &str) -> Value {
        json!({"platform":"slack","account":"a","query":"needle","mode":mode})
    }
    async fn completed(service: &Arc<AccountService>, id: &Value, query: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let mut input = request("refresh");
                input["refresh_id"] = id.clone();
                input["query"] = json!(query);
                let result = service.search(&input).await.unwrap();
                if result["refresh"]["state"] != "running" {
                    return result;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn browsing_persists_and_common_search_binds_local_and_remote_cursors() {
        let (_dir, service) = service();
        service.list(&json!({})).await.unwrap();
        service
            .query(
                "messages",
                &json!({"platform":"slack","account":"a","chat_id":"room"}),
            )
            .await
            .unwrap();
        let local = service.search(&request("local")).await.unwrap();
        assert_eq!(local["messages"].as_array().unwrap().len(), 2);
        assert_eq!(local["semantics"], "substring");
        let mut remote = request("remote");
        remote["limit"] = json!(1);
        let first = service.search(&remote).await.unwrap();
        assert_eq!(first["messages"].as_array().unwrap().len(), 1);
        assert_eq!(first["persisted"], true);
        remote["cursor"] = first["next_cursor"].clone();
        assert_eq!(
            service.search(&remote).await.unwrap()["messages"][0]["id"],
            "2"
        );
        remote["interval"] = json!({"from_ts":0,"to_ts":10});
        assert!(service.search(&remote).await.is_err());
        let mut local_cursor = request("local");
        local_cursor["cursor"] = first["next_cursor"].clone();
        assert!(service.search(&local_cursor).await.is_err());
        let mut other = request("local");
        other["account"] = json!("unconfigured");
        assert!(service.search(&other).await.is_err());
        service.stop_searches().await;
    }
    #[tokio::test]
    async fn refresh_returns_local_before_remote_coalesces_and_preserves_failure_evidence() {
        let (dir, service) = service();
        service.search(&request("remote")).await.unwrap();
        fs::write(dir.path().join("body"), "needle changed").unwrap();
        fs::write(dir.path().join("gate"), "").unwrap();
        let local = tokio::time::timeout(
            Duration::from_millis(200),
            service.search(&request("refresh")),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(local["source"], "local");
        assert!(local["messages"].to_string().contains("original"));
        let id = local["refresh"]["id"].clone();
        let coalesced = service.search(&request("refresh")).await.unwrap();
        assert_eq!(coalesced["refresh"]["id"], id);
        tokio::time::timeout(Duration::from_secs(1), async {
            while service.sync_status()["work"]["active"] == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(service.sync_status()["state"], "running");
        assert_eq!(
            service.search(&request("local")).await.unwrap()["source"],
            "local"
        );
        fs::remove_file(dir.path().join("gate")).unwrap();
        let remote = completed(&service, &id, "needle").await;
        assert_eq!(remote["refresh"]["state"], "succeeded");
        assert_eq!(remote["source"], "remote");
        assert!(
            service.search(&request("local")).await.unwrap()["messages"]
                .to_string()
                .contains("changed")
        );
        let mut mismatched = request("refresh");
        mismatched["query"] = json!("other");
        mismatched["refresh_id"] = id;
        assert!(service.search(&mismatched).await.is_err());
        let mut failure = request("refresh");
        failure["query"] = json!("fail");
        let failed = service.search(&failure).await.unwrap();
        assert_eq!(
            completed(&service, &failed["refresh"]["id"], "fail").await["refresh"]["state"],
            "failed"
        );
        assert_eq!(service.sync_status()["state"], "failed");
        service.stop_searches().await;
    }
    #[tokio::test]
    async fn old_buffered_pages_keep_their_original_observation_order() {
        let (dir, service) = service();
        service.list(&json!({})).await.unwrap();
        let mut request = json!({"platform":"slack","account":"a","chat_id":"room","limit":1});
        let first = service.query("messages", &request).await.unwrap();
        let cursor = first["next_cursor"].clone();
        assert!(first.get("_observation_order").is_none());
        fs::write(dir.path().join("body"), "needle newer").unwrap();
        request["limit"] = json!(80);
        service.query("messages", &request).await.unwrap();
        request["limit"] = json!(1);
        request["cursor"] = cursor;
        let old = service.query("messages", &request).await.unwrap();
        assert!(
            old["messages"][0]["body"]
                .as_str()
                .unwrap()
                .contains("original")
        );
        let saved = service
            .search(&super::tests::request("local"))
            .await
            .unwrap();
        assert!(
            saved["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m["body"].as_str().unwrap().contains("newer"))
        );
        service.stop_searches().await;
    }

    #[tokio::test]
    async fn shutting_down_cancels_refresh_work_and_marks_it_interrupted() {
        let (dir, service) = service();
        fs::write(dir.path().join("gate"), "").unwrap();
        service.search(&request("refresh")).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while service.sync_status()["work"]["active"] == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        service.stop_searches().await;
        assert_eq!(service.sync_status()["work"]["active"], 0);
        assert!(
            service.sync_status()["work"]["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|j| j["state"] == "interrupted")
        );
    }
}
