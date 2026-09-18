#![cfg(feature = "test-worker")]

use inboxd_daemon::{TestWorkerConfig, WorkerSupervisor};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};

fn fake_worker() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_inboxd-fake-worker"))
}

fn supervisor(scenario: &str) -> WorkerSupervisor {
    WorkerSupervisor::for_test(
        "slack-work",
        TestWorkerConfig::new(fake_worker(), scenario)
            .with_timeout(Duration::from_millis(500))
            .with_max_response_bytes(1_048_576)
            .with_max_queue_depth(1),
    )
    .unwrap()
}

fn chat() -> Value {
    json!({"v":1,"kind":"chat","platform":"slack","account":"work","chat_id":"C0123"})
}

fn interval() -> Value {
    json!({"from_ts":1726650000,"to_ts":1726653600})
}

#[tokio::test]
async fn supervisor_accepts_fragmented_utf8_health_and_semantically_valid_pages() {
    let fragmented = supervisor("fragmented_health");
    let health = fragmented.health("slack-work").await.unwrap();
    assert_eq!(health["state"], "degraded");
    assert_eq!(health["auth"]["reason"], "로그인🙂");

    let reader = supervisor("read_ok");
    let page = reader
        .read_page("slack-work", chat(), interval(), 100, Value::Null)
        .await
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.chat["chat_id"], "C0123");

    let mismatched = supervisor("read_scope_mismatch");
    let error = mismatched
        .read_page("slack-work", chat(), interval(), 100, Value::Null)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("scope") || error.to_string().contains("match"));
}

#[tokio::test]
async fn supervisor_rejects_raw_frame_and_correlation_failures_before_use() {
    for scenario in [
        "empty",
        "malformed",
        "oversized",
        "padded",
        "escape_inflated",
        "wrong_request_id",
        "wrong_generation",
        "wrong_operation",
    ] {
        let worker = WorkerSupervisor::for_test(
            "slack-work",
            TestWorkerConfig::new(fake_worker(), scenario)
                .with_timeout(Duration::from_millis(500))
                .with_max_response_bytes(256)
                .with_max_queue_depth(1),
        )
        .unwrap();
        let error = worker.health("slack-work").await.unwrap_err();
        assert!(!error.may_have_sent(), "{scenario} became ambiguous");
    }

    let error = supervisor("health_ok")
        .health("other-binding")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("binding"));
}

#[tokio::test]
async fn supervisor_bounds_timeout_eof_queue_and_restarts_after_crash() {
    for scenario in ["timeout", "eof"] {
        let error = supervisor(scenario).health("slack-work").await.unwrap_err();
        assert!(!error.may_have_sent());
    }

    let slow = supervisor("slow_health");
    let in_flight = {
        let worker = slow.clone();
        tokio::spawn(async move { worker.health("slack-work").await })
    };
    tokio::task::yield_now().await;
    let saturated = slow.health("slack-work").await.unwrap_err();
    assert!(saturated.to_string().contains("queue"));
    assert!(in_flight.await.unwrap().is_ok());

    let marker_directory = tempfile::tempdir().unwrap();
    let marker = marker_directory.path().join("crashed-once");
    let restarting = WorkerSupervisor::for_test(
        "slack-work",
        TestWorkerConfig::new(fake_worker(), "crash_once")
            .with_timeout(Duration::from_millis(500))
            .with_max_response_bytes(16_384)
            .with_max_queue_depth(1)
            .with_state_path(marker),
    )
    .unwrap();
    assert!(restarting.health("slack-work").await.is_err());
    assert!(restarting.health("slack-work").await.is_ok());
}

#[tokio::test]
async fn send_transport_loss_is_ambiguous_only_after_dispatch_and_never_retried() {
    let journal_directory = tempfile::tempdir().unwrap();
    let journal = journal_directory.path().join("send-calls.jsonl");
    let timed_out = WorkerSupervisor::for_test(
        "slack-work",
        TestWorkerConfig::new(fake_worker(), "send_timeout")
            .with_timeout(Duration::from_millis(500))
            .with_max_response_bytes(65_536)
            .with_max_queue_depth(1)
            .with_state_path(journal.clone()),
    )
    .unwrap();
    let envelope = json!({
        "v":2,
        "destination":chat(),
        "content":{"mode":"text","body":"deploy"}
    });
    let error = timed_out
        .send(
            "slack-work",
            envelope.clone(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .await
        .unwrap_err();
    assert!(error.may_have_sent());
    let calls = std::fs::read_to_string(journal).unwrap();
    assert_eq!(calls.lines().count(), 1);

    let missing = WorkerSupervisor::for_test(
        "slack-work",
        TestWorkerConfig::new(
            PathBuf::from("/definitely/missing/inboxd-worker"),
            "send_ok",
        )
        .with_timeout(Duration::from_millis(100)),
    )
    .unwrap();
    let error = missing
        .send(
            "slack-work",
            envelope,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .await
        .unwrap_err();
    assert!(!error.may_have_sent());
}
