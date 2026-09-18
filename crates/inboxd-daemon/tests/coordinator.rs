#![cfg(feature = "test-worker")]

use inboxd_core::SqlHost;
use inboxd_daemon::{Daemon, DaemonConfig, TestWorkerConfig, TrustedBinding, launch};
use inboxd_storage::{NativeHost, StorageActor, StorageActorConfig, StorageOperation};
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
    TrustedBinding::for_test(
        "slack-work",
        json!({
            "v":1,
            "resource":{"v":1,"kind":"chat","platform":"slack","account":"work","chat_id":"C0123"},
            "read":{"mode":"bounded_history","limits":{"max_page_size":100,"max_pages":10,"cursor":"opaque"}},
            "write":{"mode":"send","content_mode":"text","reply":true},
            "receipt":{"level":receipt_level}
        }),
        TestWorkerConfig::new(fake_worker(), scenario)
            .with_timeout(Duration::from_millis(500))
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
            hello["approver_token"] = json!(token);
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
    let approver = Client::connect(daemon.socket_path(), "approver", Some(&token)).await;
    (agent, approver)
}

async fn approved_send(agent: &mut Client, approver: &mut Client, body: &str) -> (Value, Value) {
    let created = agent
        .request(
            "safety.intent.create",
            json!({"actor":ACTOR,"scope":scope(),"body":body,"parent_id":"thread-1"}),
        )
        .await;
    let claimed = approver
        .request(
            "safety.intent.claimApprovalCode",
            json!({"intent_id":created["intent_id"]}),
        )
        .await;
    let approval = json!({
        "intent_id":created["intent_id"],
        "code":claimed["code"],
        "actor":ACTOR,
        "scope":scope(),
    });
    let outcome = approver
        .request("safety.intent.approve", approval.clone())
        .await;
    (approval, outcome)
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
async fn approval_claims_once_sends_once_and_verifies_only_exact_receipt() {
    let directory = private_tempdir();
    let calls = directory.path().join("worker-calls");
    let daemon = launch(config(
        directory.path(),
        binding("send_sent_verified", "independent_readback", &calls),
    ))
    .await
    .unwrap();
    let (mut agent, mut approver) = clients(directory.path(), &daemon).await;

    let (approval, outcome) = approved_send(&mut agent, &mut approver, "verify me").await;
    assert_eq!(outcome["state"], "Verified");
    assert_eq!(outcome["receipt"], "receipt-1");
    assert_eq!(journal(&calls), ["send", "read_receipt"]);

    let duplicate = approver
        .request_frame("safety.intent.approve", approval)
        .await;
    assert_eq!(duplicate["ok"], false);
    assert_eq!(journal(&calls), ["send", "read_receipt"]);

    drop((agent, approver));
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn timeout_and_eof_after_dispatch_are_uncertain_keep_quota_and_never_retry() {
    for scenario in ["send_timeout", "send_eof"] {
        let directory = private_tempdir();
        let calls = directory.path().join("worker-calls");
        let daemon = launch(config(
            directory.path(),
            binding(scenario, "independent_readback", &calls),
        ))
        .await
        .unwrap();
        let (mut agent, mut approver) = clients(directory.path(), &daemon).await;

        let (approval, outcome) = approved_send(&mut agent, &mut approver, scenario).await;
        assert_eq!(outcome["state"], "Uncertain", "{scenario}: {outcome}");
        assert_eq!(journal(&calls), ["send"], "{scenario}");
        assert_eq!(
            approver
                .request_frame("safety.intent.approve", approval)
                .await["ok"],
            false
        );
        assert_eq!(journal(&calls), ["send"], "{scenario}");

        drop((agent, approver));
        daemon.shutdown().await.unwrap();
        let (sends, quota) = persisted_rows(directory.path());
        assert_eq!(sends, [json!({"state":"Uncertain"})], "{scenario}");
        assert_eq!(quota.len(), 2, "{scenario}: {quota:?}");
        assert!(
            quota.iter().all(|row| row["used"] == 1),
            "{scenario}: {quota:?}"
        );
    }
}

#[tokio::test]
async fn receipt_capability_gates_readback_and_definite_failure_releases_quota() {
    for (scenario, receipt_level, expected, expected_calls) in [
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
    ] {
        let directory = private_tempdir();
        let calls = directory.path().join("worker-calls");
        let daemon = launch(config(
            directory.path(),
            binding(scenario, receipt_level, &calls),
        ))
        .await
        .unwrap();
        let (mut agent, mut approver) = clients(directory.path(), &daemon).await;

        let (_, outcome) = approved_send(&mut agent, &mut approver, scenario).await;
        assert_eq!(outcome["state"], expected, "{scenario}: {outcome}");
        assert_eq!(journal(&calls), expected_calls, "{scenario}");

        drop((agent, approver));
        daemon.shutdown().await.unwrap();
        let (_, quota) = persisted_rows(directory.path());
        let expected_used = if expected == "Failed" { 0 } else { 1 };
        assert!(
            quota.iter().all(|row| row["used"] == expected_used),
            "{scenario}: {quota:?}"
        );
    }
}

#[tokio::test]
async fn startup_recovery_marks_sending_uncertain_without_worker_io_or_quota_release() {
    let directory = private_tempdir();
    let database_path = directory.path().join("inboxd.db");
    let mut actor = StorageActor::start(
        StorageActorConfig::new(&database_path, KEY).with_send_policy(|_| true),
    )
    .unwrap();
    let created = actor
        .call(
            StorageOperation::SafetyPropose,
            json!({
                "proposal":{"actor":ACTOR,"scope":scope(),"body":"interrupted"},
                "approval_ttl_ms":60_000,
            }),
        )
        .unwrap();
    let code = actor
        .call(
            StorageOperation::SafetyClaimApprovalCode,
            json!({"intent_id":created["intent_id"]}),
        )
        .unwrap()["code"]
        .clone();
    actor
        .call(
            StorageOperation::SafetyApprove,
            json!({"intent_id":created["intent_id"],"code":code,"actor":ACTOR,"scope":scope()}),
        )
        .unwrap();
    actor
        .call(
            StorageOperation::SafetyClaim,
            json!({
                "intent_id":created["intent_id"],"transport_present":true,
                "send_capable":true,"quota_limit":1,"global_quota_limit":1,
            }),
        )
        .unwrap();
    actor.shutdown().unwrap();

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
