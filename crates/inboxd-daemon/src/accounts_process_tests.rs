//! Cross-runtime tests use production adapters with synthetic SDK ports, never accounts.
use super::*;

async fn service(platform: &str) -> (tempfile::TempDir, AccountService) {
    service_with_live(platform, false).await
}

async fn service_with_live(platform: &str, live: bool) -> (tempfile::TempDir, AccountService) {
    let directory = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let actor = StorageActor::start(inboxd_storage::StorageActorConfig::new(
        directory.path().canonicalize().unwrap().join("send.db"),
        [0x74; 32],
    ))
    .unwrap();
    let service = AccountService::new(vec![AccountConfig {
        platform: platform.into(),
        account: "synthetic".into(),
        config: Zeroizing::new("{}".into()),
    }])
    .with_storage(Arc::new(actor));
    let bun = std::env::var("BUN_BIN").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = format!("{home}/.bun/bin/bun");
        if std::path::Path::new(&path).is_file() {
            path
        } else {
            "bun".into()
        }
    });
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/account-provider-process.ts");
    let mut child = Command::new(bun)
        .arg(fixture)
        .arg(platform)
        .env("INBOXD_SYNTHETIC_LIVE", if live { "1" } else { "0" })
        .arg(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if live {
            Stdio::piped()
        } else {
            Stdio::inherit()
        })
        .kill_on_drop(true)
        .spawn()
        .expect("Bun is required for the account cross-runtime contract tests");
    let input = child.stdin.take().unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    let events = child
        .stderr
        .take()
        .map(|stderr| live::read_events(stderr, service.slots[0].schedule.live.clone()));
    *service.slots[0].schedule.worker.lock().await = Some(WorkerProcess {
        _events: events,
        _child: child,
        input,
        output,
    });
    (directory, service)
}

async fn scenario(platform: &str) {
    let (_directory, service) = service(platform).await;
    let list = service.list(&json!({})).await.unwrap();
    assert_eq!(list["errors"], json!([]));
    assert_eq!(list["chats"][0]["display_name"], "원래 방 이름");
    assert_eq!(list["chats"][0]["platform"], platform);
    let scope = json!({"platform":platform,"account":"synthetic","chat_id":"1"});
    let messages = service.query("messages", &scope).await.unwrap();
    assert_eq!(messages["messages"].as_array().unwrap().len(), 30);
    assert_eq!(messages["messages"][0]["author_name"], "실제 이름");
    assert_eq!(messages["messages"][0]["account"], "synthetic");

    let mut search = json!({"platform":platform,"account":"synthetic","query":"needle"});
    let mut ids = std::collections::BTreeSet::new();
    let mut pages = 0;
    loop {
        let result = service.query("search", &search).await.unwrap();
        assert!(serde_json::to_vec(&result).unwrap().len() < 60_000);
        for message in result["messages"].as_array().unwrap() {
            assert_eq!(message["author_name"], "실제 이름");
            assert!(ids.insert(message["id"].as_str().unwrap().to_owned()));
        }
        pages += 1;
        assert!(pages < 10, "page cursor must make progress");
        let Some(cursor) = result["next_cursor"].as_str() else {
            break;
        };
        assert!(cursor.starts_with("account:"));
        let mut wrong_query = search.clone();
        wrong_query["query"] = json!("other");
        wrong_query["cursor"] = json!(cursor);
        assert!(service.query("search", &wrong_query).await.is_err());
        search["cursor"] = json!(cursor);
    }
    assert!(pages > 1);
    assert_eq!(ids.len(), 100);

    if platform != "kakao" {
        let mut request = json!({"platform":platform,"account":"synthetic","query":"paged"});
        let first = service.query("search", &request).await.unwrap();
        assert_eq!(first["messages"].as_array().unwrap().len(), 1);
        request["cursor"] = first["next_cursor"].clone();
        let second = service.query("search", &request).await.unwrap();
        assert_eq!(second["messages"].as_array().unwrap().len(), 1);
        assert_ne!(first["messages"][0]["id"], second["messages"][0]["id"]);
        assert!(second.get("next_cursor").is_none());
    }
    if platform == "telegram" {
        let mut request = json!({"platform":platform,"account":"synthetic","query":"repeat"});
        let first = service.query("search", &request).await.unwrap();
        request["cursor"] = first["next_cursor"].clone();
        assert!(
            service
                .query("search", &request)
                .await
                .unwrap_err()
                .contains("커서 반복")
        );
    }

    let mut send = scope.clone();
    send["body"] = json!("fixture send");
    send["request_id"] = json!("synthetic-request-0001");
    let first = service.query("send", &send).await.unwrap();
    assert_eq!(first["state"], "Sent");
    assert_eq!(first["receipt"], "sent-1");
    assert_eq!(service.query("send", &send).await.unwrap(), first);
    // A mismatched body may not reuse an already reserved request ID.
    send["body"] = json!("changed");
    assert!(service.query("send", &send).await.is_err());
    send["body"] = json!("ambiguous");
    send["request_id"] = json!("synthetic-request-0002");
    let uncertain = service.query("send", &send).await.unwrap();
    assert_eq!(uncertain["state"], "Uncertain");
    assert_eq!(service.query("send", &send).await.unwrap(), uncertain);
    assert!(service.slots[0].schedule.worker.lock().await.is_none());
}

#[tokio::test]
async fn slack_account_uses_real_bun_adapter_transport() {
    scenario("slack").await;
}
#[tokio::test]
async fn kakao_account_uses_real_bun_adapter_transport() {
    scenario("kakao").await;
}
#[tokio::test]
async fn telegram_account_uses_real_bun_adapter_transport() {
    scenario("telegram").await;
}

async fn scheduled_service() -> (tempfile::TempDir, Arc<AccountService>) {
    let (directory, service) = service("kakao").await;
    let bun = std::env::var("BUN_BIN")
        .unwrap_or_else(|_| format!("{}/.bun/bin/bun", std::env::var("HOME").unwrap()));
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/account-scheduling-process.ts");
    let mut child = Command::new(bun)
        .arg(fixture)
        .arg(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    *service.slots[0].schedule.worker.lock().await = Some(WorkerProcess {
        _events: None,
        _child: child,
        input,
        output,
    });
    service.list(&json!({})).await.unwrap();
    (directory, Arc::new(service))
}
async fn entered(directory: &tempfile::TempDir) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !directory.path().join("entered").exists() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}
fn long_query(service: Arc<AccountService>) -> tokio::task::JoinHandle<Result<Value, String>> {
    tokio::spawn(async move {
        service
            .query(
                "messages",
                &json!({"platform":"kakao","account":"synthetic","chat_id":"long"}),
            )
            .await
    })
}
#[tokio::test]
async fn long_history_yields_to_interactive_read_and_send_without_losing_latest_semantics() {
    let (directory, service) = scheduled_service().await;
    let long = long_query(Arc::clone(&service));
    entered(&directory).await;
    let reader = Arc::clone(&service);
    let read = tokio::spawn(async move {
        reader
            .query(
                "messages",
                &json!({"platform":"kakao","account":"synthetic","chat_id":"fast"}),
            )
            .await
    });
    let sender = Arc::clone(&service);
    let send = tokio::spawn(async move {
        sender.query("send", &json!({"platform":"kakao","account":"synthetic","chat_id":"fast","body":"new preview","request_id":"schedule-send-123456"})).await
    });
    // Let both jobs queue behind the running provider primitive.
    tokio::time::sleep(Duration::from_millis(15)).await;
    std::fs::write(directory.path().join("release"), "1").unwrap();
    assert_eq!(
        read.await.unwrap().unwrap()["messages"][0]["chat_id"],
        "fast"
    );
    assert_eq!(send.await.unwrap().unwrap()["state"], "Sent");
    let result = long.await.unwrap().unwrap();
    assert_eq!(result["complete"], true);
    assert_eq!(
        result["messages"].as_array().unwrap().last().unwrap()["id"],
        "12"
    );
    let log: Vec<Value> = std::fs::read_to_string(directory.path().join("calls"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let last = log
        .iter()
        .position(|r| r["op"] == "kakao_page" && r["cursor"] == "11")
        .unwrap();
    assert!(log.iter().position(|r| r["op"] == "kakao_send").unwrap() < last);
    assert!(
        log.iter()
            .position(|r| r["op"] == "kakao_page" && r["chat_id"] == "fast")
            .unwrap()
            < last
    );
    assert_eq!(
        service.slots[0]
            .snapshot
            .lock()
            .unwrap()
            .chats
            .iter()
            .find(|c| c["chat_id"] == "fast")
            .unwrap()["preview"],
        "new preview"
    );
}
#[tokio::test]
async fn queued_cancellation_preserves_active_worker_and_active_cancellation_discards_it() {
    let (directory, service) = scheduled_service().await;
    let long = long_query(Arc::clone(&service));
    entered(&directory).await;
    let reader = Arc::clone(&service);
    let queued = tokio::spawn(async move {
        reader
            .query(
                "messages",
                &json!({"platform":"kakao","account":"synthetic","chat_id":"fast"}),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(10)).await;
    queued.abort();
    assert!(queued.await.unwrap_err().is_cancelled());
    std::fs::write(directory.path().join("release"), "1").unwrap();
    assert_eq!(long.await.unwrap().unwrap()["complete"], true);
    assert!(service.slots[0].schedule.worker.lock().await.is_some());
    let log = std::fs::read_to_string(directory.path().join("calls")).unwrap();
    assert!(!log.lines().any(|line| {
        let r: Value = serde_json::from_str(line).unwrap();
        r["op"] == "kakao_page" && r["chat_id"] == "fast"
    }));
    // A fresh traversal cancelled while awaiting its own response loses only its
    // taken process; the next request cannot accidentally consume its old reply.
    std::fs::remove_file(directory.path().join("entered")).unwrap();
    std::fs::remove_file(directory.path().join("release")).unwrap();
    service.slots[0].slot.lock().await.invalidate();
    let active = long_query(Arc::clone(&service));
    entered(&directory).await;
    active.abort();
    assert!(active.await.unwrap_err().is_cancelled());
    assert!(service.slots[0].schedule.worker.lock().await.is_none());
}

#[tokio::test]
async fn attachment_sends_use_real_adapters_and_durable_full_file_identity() {
    for platform in ["slack", "kakao", "telegram"] {
        let (directory, service) = service(platform).await;
        let path = directory.path().canonicalize().unwrap().join("test.txt");
        std::fs::write(&path, b"abc").unwrap();
        let mut params = json!({"request_id":"file-request-0001","chat":{"platform":platform,"account":"synthetic","chat_id":"1"},"file":{"path":path,"name":"test.txt","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}});
        let registry = crate::CapabilityRegistry::new(vec![]).unwrap();
        let actor = service.storage.as_ref().unwrap();
        let first = crate::direct_send::execute(
            actor,
            &registry,
            &service,
            &params,
            json!({"role":"sender"}),
        )
        .await
        .unwrap();
        assert_eq!(first["state"], "Sent", "{platform}: {first}");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            crate::direct_send::execute(
                actor,
                &registry,
                &service,
                &params,
                json!({"role":"sender"})
            )
            .await
            .unwrap(),
            first
        );
        params["file"]["sha256"] = json!("a".repeat(64));
        assert!(
            crate::direct_send::execute(
                actor,
                &registry,
                &service,
                &params,
                json!({"role":"sender"})
            )
            .await
            .is_err()
        );
    }
}

#[tokio::test]
async fn fixed_worker_send_invalidates_account_history_including_overlapping_reads() {
    let (directory, service) = service("kakao").await;
    service.list(&json!({})).await.unwrap();
    let chat = json!({"platform":"kakao","account":"synthetic","chat_id":"1"});
    let old = service.query("messages", &chat).await.unwrap();
    assert_eq!(
        old["messages"].as_array().unwrap().last().unwrap()["id"],
        "100"
    );
    // Simulate delivery through the independent fixed worker while the account
    // session retains its complete, fresh history snapshot.
    service
        .with_external_send(&chat, async {
            service.query("messages", &chat).await.unwrap();
            assert!(
                service.slots[0].slot.lock().await.backend.is_none(),
                "overlapping reads cannot restore stale history"
            );
            std::fs::write(directory.path().join("new-message"), b"delivered").unwrap();
            Ok(json!({"state":"Verified","receipt":"101"}))
        })
        .await
        .unwrap();
    let fresh = service.query("messages", &chat).await.unwrap();
    assert_eq!(
        fresh["messages"].as_array().unwrap().last().unwrap()["id"],
        "101"
    );
}

#[tokio::test]
async fn canceled_fixed_send_does_not_leave_a_live_cache_marker() {
    let (_directory, service) = service("kakao").await;
    service.list(&json!({})).await.unwrap();
    let chat = json!({"platform":"kakao","account":"synthetic","chat_id":"1"});
    service.query("messages", &chat).await.unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(10),
            service.with_external_send(&chat, std::future::pending())
        )
        .await
        .is_err()
    );
    let slot = service.slots[0].slot.lock().await;
    assert!(slot.sending.upgrade().is_none());
    assert!(slot.backend.is_none());
}

#[tokio::test]
async fn live_side_channel_does_not_consume_request_responses_and_reads_while_idle() {
    let (_directory, service) = service_with_live("telegram", true).await;
    let result = service.list(&json!({})).await.unwrap();
    assert_eq!(result["errors"], json!([]));
    let mut receiver = service.slots[0].schedule.live.subscribe();
    tokio::time::timeout(Duration::from_secs(3), async {
        while receiver.borrow().revision < 2 {
            receiver.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(receiver.borrow().state, "connected");
    let result = service
        .query(
            "messages",
            &json!({"platform":"telegram","account":"synthetic","chat_id":"1"}),
        )
        .await
        .unwrap();
    assert_eq!(result["messages"].as_array().unwrap().len(), 30);
    service.stop_live().await;
    assert_eq!(receiver.borrow().state, "disconnected");
}
