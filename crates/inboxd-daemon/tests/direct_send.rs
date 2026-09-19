#![cfg(feature = "test-worker")]

use inboxd_core::SqlHost;
use inboxd_daemon::{Daemon, DaemonConfig, TestWorkerConfig, TrustedBinding, launch};
use inboxd_storage::NativeHost;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf},
    net::UnixStream,
    time::{Instant, sleep},
};

const KEY: [u8; 32] = [0x73; 32];
const ACTOR: &str = "agent:coordinator";

fn private_tempdir() -> TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn fake_worker() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_inboxd-fake-worker"))
}

fn scope() -> Value {
    json!({"platform":"slack","account":"work","chat_id":"C0123"})
}

fn binding(scenario: &str, receipt_level: &str, journal: &Path) -> TrustedBinding {
    binding_with_reply(scenario, receipt_level, journal, true)
}

fn binding_with_reply(
    scenario: &str,
    receipt_level: &str,
    journal: &Path,
    reply: bool,
) -> TrustedBinding {
    TrustedBinding::for_test(
        "slack-work",
        json!({
            "v":1,
            "resource":{"v":1,"kind":"chat","platform":"slack","account":"work","chat_id":"C0123"},
            "read":{"mode":"bounded_history","limits":{"max_page_size":100,"max_pages":10,"cursor":"opaque"}},
            "write":{"mode":"send","content_mode":"text","reply":reply},
            "receipt":{"level":receipt_level}
        }),
        TestWorkerConfig::new(fake_worker(), scenario)
            .with_timeout(match scenario {
                "send_timeout" | "read_receipt_timeout" => Duration::from_millis(500),
                "send_gated" | "read_receipt_gated" => Duration::from_secs(15),
                _ => Duration::from_secs(2),
            })
            .with_state_path(journal),
    )
    .unwrap()
}

fn config(directory: &Path, worker: TrustedBinding) -> DaemonConfig {
    DaemonConfig::new(
        directory,
        directory.join("inboxd.db"),
        directory.join("inboxd.sock"),
        KEY,
    )
    .with_bindings(vec![worker])
}

struct Client {
    read: BufReader<ReadHalf<UnixStream>>,
    write: WriteHalf<UnixStream>,
    next_id: u64,
}

impl Client {
    async fn connect(path: &Path, role: &str, token: Option<&str>) -> Self {
        let stream = UnixStream::connect(path).await.unwrap();
        let (read, write) = tokio::io::split(stream);
        let mut client = Self {
            read: BufReader::new(read),
            write,
            next_id: 0,
        };
        let mut hello = json!({"role":role});
        if let Some(token) = token {
            hello[if role == "sender" {
                "sender_token"
            } else {
                "approver_token"
            }] = json!(token);
        }
        client.request("system.hello", hello).await;
        client
    }

    async fn request_frame(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = format!("r{}", self.next_id);
        let request = json!({"type":"request","id":id,"method":method,"params":params});
        self.write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        loop {
            let mut line = String::new();
            assert!(self.read.read_line(&mut line).await.unwrap() > 0);
            let frame: Value = serde_json::from_str(line.trim_end()).unwrap();
            if frame["type"] == "response" && frame["id"] == id {
                return frame;
            }
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        let frame = self.request_frame(method, params).await;
        assert_eq!(frame["ok"], true, "{frame}");
        frame["result"].clone()
    }
}

async fn clients(directory: &Path, daemon: &Daemon) -> (Client, Client) {
    let token = fs::read_to_string(directory.join("approver.token"))
        .unwrap()
        .trim()
        .to_owned();
    let agent = Client::connect(daemon.socket_path(), "agent", None).await;
    let approver = Client::connect(daemon.socket_path(), "sender", Some(&token)).await;
    (agent, approver)
}

async fn direct_send(sender: &mut Client, body: &str) -> (Value, Value) {
    let params = json!({"request_id":uuid::Uuid::new_v4().to_string(),"chat":scope(),"body":body,"parent_id":"thread-1"});
    let result = sender.request("message.send", params.clone()).await;
    (params, result)
}

fn journal(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn persisted_rows(directory: &Path) -> (Vec<Value>, Vec<Value>) {
    let host = NativeHost::open_development(&directory.join("inboxd.db"), &KEY).unwrap();
    let sql = SqlHost::new(&host);
    (
        sql.all("SELECT state FROM sends ORDER BY created_at, id", &[])
            .unwrap(),
        sql.all("SELECT scope, used FROM quota ORDER BY scope", &[])
            .unwrap(),
    )
}

#[tokio::test]
async fn delegated_send_is_authenticated_durable_and_identity_exact() {
    let directory = private_tempdir();
    let calls = directory.path().join("worker-calls");
    let daemon = launch(config(
        directory.path(),
        binding("send_sent_verified", "independent_readback", &calls),
    ))
    .await
    .unwrap();
    let (mut agent, mut sender) = clients(directory.path(), &daemon).await;
    let params = json!({"request_id":"same-request-123456789","chat":scope(),"body":"hello","parent_id":"thread-1"});
    assert_eq!(
        agent.request_frame("message.send", params.clone()).await["ok"],
        false
    );
    let mut untrusted = Client::connect(daemon.socket_path(), "sender", Some("wrong")).await;
    assert_eq!(
        untrusted
            .request_frame("message.send", params.clone())
            .await["ok"],
        false
    );
    assert!(journal(&calls).is_empty());
    let result = sender.request("message.send", params.clone()).await;
    assert_eq!(result["state"], "Verified");
    assert_eq!(sender.request("message.send", params.clone()).await, result);
    assert_eq!(
        sender
            .request("send.status", json!({"id":params["request_id"]}))
            .await,
        result
    );
    for key in ["body", "parent_id"] {
        let mut changed = params.clone();
        changed[key] = json!("changed");
        assert_eq!(
            sender.request_frame("message.send", changed).await["ok"],
            false
        );
    }
    assert_eq!(journal(&calls), ["send", "read_receipt"]);
    drop((agent, sender, untrusted));
    daemon.shutdown().await.unwrap();
    {
        let host = NativeHost::open_development(&directory.path().join("inboxd.db"), &KEY).unwrap();
        let rows = SqlHost::new(&host)
            .all(
                "SELECT action, payload_json FROM audit WHERE action LIKE 'send.%' ORDER BY id",
                &[],
            )
            .unwrap();
        assert_eq!(rows.len(), 3, "reserve, Sent checkpoint, Verified outcome");
        for row in rows {
            let payload: Value =
                serde_json::from_str(row["payload_json"].as_str().unwrap()).unwrap();
            assert_eq!(payload["authorization"]["role"], "sender");
            assert_eq!(payload["authorization"]["method"], "message.send");
            assert!(
                payload["authorization"]["session_id"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty())
            );
            assert!(!payload.to_string().contains("sender_token"));
            assert!(!payload.to_string().contains("hello"));
        }
    }

    let daemon = launch(config(
        directory.path(),
        binding("send_sent_verified", "independent_readback", &calls),
    ))
    .await
    .unwrap();
    let (_, mut sender) = clients(directory.path(), &daemon).await;
    assert_eq!(sender.request("message.send", params).await, result);
    assert_eq!(journal(&calls), ["send", "read_receipt"]);
    drop(sender);
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn reply_disabled_binding_rejects_both_request_shapes_without_provider_io() {
    let directory = private_tempdir();
    let calls = directory.path().join("calls");
    let daemon = launch(config(
        directory.path(),
        binding_with_reply("send_sent_verified", "independent_readback", &calls, false),
    ))
    .await
    .unwrap();
    let (_, mut sender) = clients(directory.path(), &daemon).await;
    for params in [
        json!({"request_id":"reply-request-123456","chat":scope(),"body":"hello","parent_id":"p"}),
        json!({"request_id":"reply-envelope-123456","envelope":{"v":2,"destination":{"v":1,"kind":"chat","platform":"slack","account":"work","chat_id":"C0123"},"content":{"mode":"text","body":"hello"},"reply":{"parent_id":"p"}}}),
    ] {
        assert_eq!(
            sender.request_frame("message.send", params).await["ok"],
            false
        );
    }
    assert!(journal(&calls).is_empty());
    drop(sender);
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn dispatch_outcomes_readback_and_timeout_are_not_replayed() {
    for (scenario, receipt, expected, expected_calls) in [
        ("send_sent_verified", "ack_only", "Sent", vec!["send"]),
        (
            "send_sent_mismatch",
            "independent_readback",
            "Sent",
            vec!["send", "read_receipt"],
        ),
        (
            "send_failed",
            "independent_readback",
            "Failed",
            vec!["send"],
        ),
        (
            "send_timeout",
            "independent_readback",
            "Uncertain",
            vec!["send"],
        ),
        (
            "send_eof",
            "independent_readback",
            "Uncertain",
            vec!["send"],
        ),
    ] {
        let directory = private_tempdir();
        let calls = directory.path().join("calls");
        let daemon = launch(config(directory.path(), binding(scenario, receipt, &calls)))
            .await
            .unwrap();
        let (_, mut sender) = clients(directory.path(), &daemon).await;
        let (params, result) = direct_send(&mut sender, scenario).await;
        assert_eq!(result["state"], expected, "{scenario}: {result}");
        assert_eq!(sender.request("message.send", params).await, result);
        assert_eq!(journal(&calls), expected_calls);
        drop(sender);
        daemon.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn revocation_after_reservation_prevents_dispatch() {
    let directory = private_tempdir();
    let calls = directory.path().join("calls");
    let daemon = launch(config(
        directory.path(),
        binding("send_sent_verified", "independent_readback", &calls),
    ))
    .await
    .unwrap();
    let (_, mut sender) = clients(directory.path(), &daemon).await;
    daemon.revoke_binding_after_next_claim("slack-work");
    let (_, result) = direct_send(&mut sender, "revoked").await;
    assert_eq!(result["state"], "Failed");
    assert!(journal(&calls).is_empty());
    drop(sender);
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn active_dispatch_holds_revocation_lease_and_rejects_later_work() {
    let directory = private_tempdir();
    let calls = directory.path().join("calls");
    let daemon = launch(config(
        directory.path(),
        binding("send_gated", "ack_only", &calls),
    ))
    .await
    .unwrap();
    let (_, mut sender) = clients(directory.path(), &daemon).await;
    let mut send = Box::pin(direct_send(&mut sender, "in flight"));
    let deadline = Instant::now() + Duration::from_secs(10);
    while journal(&calls).is_empty() {
        assert!(Instant::now() < deadline);
        tokio::select! { result = &mut send => panic!("premature {result:?}"), () = sleep(Duration::from_millis(5)) => {} }
    }
    let mut revoke = Box::pin(daemon.revoke_binding("slack-work"));
    tokio::select! { _ = &mut revoke => panic!("lease not held"), () = sleep(Duration::from_millis(30)) => {} }
    fs::write(calls.with_extension("release"), b"release").unwrap();
    let ((_, outcome), revoked) = tokio::join!(send, revoke);
    assert_eq!(outcome["state"], "Sent");
    assert!(revoked.unwrap());
    assert_eq!(
        sender
            .request_frame(
                "message.send",
                json!({"request_id":"after-revoke-123456","chat":scope(),"body":"later"})
            )
            .await["ok"],
        false
    );
    assert_eq!(journal(&calls), ["send"]);
    drop(sender);
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn startup_recovery_marks_sending_uncertain_without_worker_io_or_quota_release() {
    let directory = private_tempdir();
    let database_path = directory.path().join("inboxd.db");
    // Historical v3 rows are fixtures, never generated through a retired send API.
    let host = NativeHost::open_development(&database_path, &KEY).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    let sql = SqlHost::new(&host);
    let payload = json!({"state":"Sending","actor":ACTOR,"scope":scope(),"body":"interrupted","expires_at":9999999999999.0});
    sql.run("INSERT INTO intents (id, kind, payload_json, created_at) VALUES ('historical', 'send', ?, 0)", &[json!(payload.to_string())]).unwrap();
    sql.run("INSERT INTO sends (id, intent_id, idempotency_key, state, payload_json, created_at) VALUES ('historical-send', 'historical', 'old-key', 'Sending', ?, 0)", &[json!(payload.to_string())]).unwrap();
    sql.run(
        "INSERT INTO quota (scope, used, updated_at) VALUES ('scope', 1, 0), ('__global__', 1, 0)",
        &[],
    )
    .unwrap();
    drop(host);

    let calls = directory.path().join("worker-calls");
    let daemon = launch(config(
        directory.path(),
        binding("send_sent_verified", "independent_readback", &calls),
    ))
    .await
    .unwrap();
    let token = fs::read_to_string(directory.path().join("approver.token"))
        .unwrap()
        .trim()
        .to_owned();
    let mut approver = Client::connect(daemon.socket_path(), "approver", Some(&token)).await;
    let pending = approver
        .request("safety.intent.listPending", json!({}))
        .await;
    assert_eq!(pending["intents"][0]["state"], "Uncertain");
    assert!(journal(&calls).is_empty());

    drop(approver);
    daemon.shutdown().await.unwrap();
    let (sends, quota) = persisted_rows(directory.path());
    assert_eq!(sends, [json!({"state":"Uncertain"})]);
    assert_eq!(quota.len(), 2);
    assert!(quota.iter().all(|row| row["used"] == 1));
}

#[tokio::test]
async fn daemon_cancellation_preserves_pending_and_acknowledged_sends_across_restart() {
    for (scenario, observed_calls, state) in [
        ("send_gated", 1, "Uncertain"),
        ("read_receipt_gated", 2, "Sent"),
    ] {
        let directory = private_tempdir();
        let calls = directory.path().join("calls");
        let daemon = launch(config(
            directory.path(),
            binding(scenario, "independent_readback", &calls),
        ))
        .await
        .unwrap();
        let (_, mut sender) = clients(directory.path(), &daemon).await;
        let params = json!({"request_id":"cancel-restart-123456789","chat":scope(),"body":"once"});
        let task_params = params.clone();
        let task = tokio::spawn(async move { sender.request("message.send", task_params).await });
        let deadline = Instant::now() + Duration::from_secs(10);
        while journal(&calls).len() < observed_calls {
            assert!(Instant::now() < deadline);
            sleep(Duration::from_millis(2)).await;
        }
        task.abort();
        let _ = task.await;
        daemon.shutdown().await.unwrap();
        let daemon = launch(config(
            directory.path(),
            binding("send_sent_verified", "independent_readback", &calls),
        ))
        .await
        .unwrap();
        let (_, mut sender) = clients(directory.path(), &daemon).await;
        assert_eq!(
            sender
                .request("send.status", json!({"id":params["request_id"]}))
                .await["state"],
            state
        );
        assert_eq!(sender.request("message.send", params).await["state"], state);
        assert_eq!(journal(&calls).len(), observed_calls);
        drop(sender);
        daemon.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn template_identity_canonicalizes_key_order_but_rejects_changed_arguments() {
    let directory = private_tempdir();
    let calls = directory.path().join("calls");
    let resource = json!({"v":1,"kind":"destination","platform":"kakao","account":"business","destination_id":"customer"});
    let trusted = TrustedBinding::for_test("template", json!({"v":1,"resource":resource,"read":{"mode":"none","limits":null},"write":{"mode":"send","content_mode":"approved_template","reply":false},"receipt":{"level":"ack_only"}}), TestWorkerConfig::new(fake_worker(), "send_sent_verified").with_state_path(&calls)).unwrap();
    let daemon = launch(config(directory.path(), trusted)).await.unwrap();
    let (_, mut sender) = clients(directory.path(), &daemon).await;
    let params = json!({"request_id":"template-request-123456789","envelope":{"v":2,"destination":resource,"content":{"mode":"approved_template","template_id":"order","preview":"Order shipped","arguments":{"name":"A","number":"1"}}}});
    let result = sender.request("message.send", params.clone()).await;
    assert_eq!(result["state"], "Sent");
    let mut reordered = params.clone();
    reordered["envelope"]["content"]["arguments"] = json!({"number":"1","name":"A"});
    assert_eq!(sender.request("message.send", reordered).await, result);
    let mut changed = params;
    changed["envelope"]["content"]["arguments"]["number"] = json!("2");
    assert_eq!(
        sender.request_frame("message.send", changed).await["ok"],
        false
    );
    assert_eq!(journal(&calls), ["send"]);
    drop(sender);
    daemon.shutdown().await.unwrap();
}
