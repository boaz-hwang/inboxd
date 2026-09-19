#![cfg(feature = "test-worker")]

use inboxd_daemon::{
    Daemon, DaemonConfig, ProductionWorkerConfig, TrustedBinding, WorkerSupervisor, launch,
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf},
    net::UnixStream,
};

const KEY: [u8; 32] = [0x79; 32];
const BINDING_ID: &str = "slack-work";

fn private_tempdir() -> TempDir {
    // Fixed workers must have trusted ancestors even with macOS's default TMPDIR.
    let home =
        fs::canonicalize(std::env::var_os("HOME").expect("HOME for worker fixture")).unwrap();
    let directory = tempfile::Builder::new()
        .prefix(".inboxd-pa-")
        .tempdir_in(home)
        .unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn fake_worker() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_inboxd-fake-worker"))
}

fn install_fixed_slack_worker(directory: &Path) -> PathBuf {
    install_fixed_worker(directory, "inboxd-slack-worker")
}

fn install_fixed_worker(directory: &Path, name: &str) -> PathBuf {
    fs::create_dir_all(directory).unwrap();
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    let destination = directory.join(name);
    fs::copy(fake_worker(), &destination).unwrap();
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o700)).unwrap();
    destination
}

fn production_config() -> ProductionWorkerConfig {
    ProductionWorkerConfig::Slack {
        session_cookie: None,
        account: "work".into(),
        team_id: "T0123".into(),
        allowed_chat_ids_json: "[\"C0123\"]".into(),
        bot_token: "xoxb-synthetic".into(),
    }
}

fn claims() -> Value {
    json!({
        "v":1,
        "resource":{"v":1,"kind":"chat","platform":"slack","account":"work","chat_id":"C0123"},
        "read":{"mode":"bounded_history","limits":{"max_page_size":100,"max_pages":100,"cursor":"opaque"}},
        "write":{"mode":"send","content_mode":"text","reply":true},
        "receipt":{"level":"independent_readback"}
    })
}

fn binding(worker_directory: &Path) -> TrustedBinding {
    TrustedBinding::production_for_test(BINDING_ID, claims(), production_config(), worker_directory)
        .unwrap()
}

fn daemon_config(directory: &Path, binding: TrustedBinding) -> DaemonConfig {
    DaemonConfig::new(
        directory,
        directory.join("inboxd.db"),
        directory.join("inboxd.sock"),
        KEY,
    )
    .with_bindings(vec![binding])
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

async fn clients(directory: &Path, daemon: &Daemon) -> (Client, Client, Client) {
    let token = fs::read_to_string(directory.join("approver.token"))
        .unwrap()
        .trim()
        .to_owned();
    let reader = Client::connect(daemon.socket_path(), "reader", None).await;
    let agent = Client::connect(daemon.socket_path(), "agent", None).await;
    let approver = Client::connect(daemon.socket_path(), "approver", Some(&token)).await;
    (reader, agent, approver)
}

async fn direct_send(_agent: &mut Client, sender: &mut Client) -> (Value, Value) {
    let params = json!({"request_id":"provider-acceptance-123456","chat":{"platform":"slack","account":"work","chat_id":"C0123"},"body":"ship it"});
    let result = sender.request("message.send", params.clone()).await;
    (params, result)
}

fn journal(worker_directory: &Path) -> Vec<String> {
    fs::read_to_string(worker_directory.join("production-calls.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[tokio::test]
async fn fixed_production_worker_runs_real_uds_refresh_bounded_read_and_one_attempt_send_receipt() {
    let directory = private_tempdir();
    let worker_directory = directory.path().join("workers");
    install_fixed_slack_worker(&worker_directory);
    let daemon = launch(daemon_config(directory.path(), binding(&worker_directory)))
        .await
        .unwrap();
    let (mut reader, mut agent, mut approver) = clients(directory.path(), &daemon).await;

    let initial = reader.request("capability.list", json!({})).await;
    assert_eq!(
        initial["resources"],
        json!([{
            "v":1,
            "resource":{"v":1,"kind":"chat","platform":"slack","account":"work","chat_id":"C0123"},
            "read":{"mode":"bounded_history","limits":{"max_page_size":100,"max_pages":100,"cursor":"opaque"}},
            "write":{"mode":"send","content_mode":"text","reply":true},
            "receipt":{"level":"independent_readback"},
            "auth":{"state":"unknown","reason":"unobserved","observed_at":initial["resources"][0]["auth"]["observed_at"]}
        }])
    );

    let refreshed = reader
        .request("capability.list", json!({"refresh":true}))
        .await;
    assert_eq!(refreshed["resources"][0]["auth"]["state"], "authenticated");

    let backfill = approver
        .request(
            "sync.backfill",
            json!({
                "platform":"slack","account":"work","chat_id":"C0123",
                "from_ts":1726650000,"to_ts":1726653600
            }),
        )
        .await;
    assert_eq!(backfill, json!({"event_count":1,"authoritative":true}));
    assert_eq!(
        reader
            .request(
                "message.get",
                json!({
                    "chat":{"platform":"slack","account":"work","chat_id":"C0123"},
                    "msg_id":"m1"
                }),
            )
            .await["message"]["body"],
        "hello"
    );

    let (approval, outcome) = direct_send(&mut agent, &mut approver).await;
    assert_eq!(outcome["state"], "Verified", "{outcome}");
    assert_eq!(outcome["receipt"], "receipt-1");
    assert_eq!(
        journal(&worker_directory),
        ["health", "read_page", "send", "read_receipt"]
    );

    assert_eq!(
        approver.request_frame("message.send", approval).await["ok"],
        true
    );
    assert_eq!(
        journal(&worker_directory),
        ["health", "read_page", "send", "read_receipt"]
    );

    drop((reader, agent, approver));
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_fixed_runtime_refreshes_unknown_and_fails_send_before_dispatch() {
    let directory = private_tempdir();
    let worker_directory = directory.path().join("workers");
    fs::create_dir(&worker_directory).unwrap();
    fs::set_permissions(&worker_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let daemon = launch(daemon_config(directory.path(), binding(&worker_directory)))
        .await
        .unwrap();
    let (mut reader, mut agent, mut approver) = clients(directory.path(), &daemon).await;

    let refreshed = reader
        .request("capability.list", json!({"refresh":true}))
        .await;
    assert_eq!(refreshed["resources"][0]["auth"]["state"], "unknown");
    assert_eq!(
        refreshed["resources"][0]["auth"]["reason"],
        "worker_unavailable"
    );

    let (_, outcome) = direct_send(&mut agent, &mut approver).await;
    assert_eq!(outcome["state"], "Failed", "{outcome}");
    assert_eq!(outcome["reason"], "worker_unavailable");
    assert!(journal(&worker_directory).is_empty());

    drop((reader, agent, approver));
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn production_supervisor_ignores_nonfixed_executable_names() {
    let directory = private_tempdir();
    let decoy = directory.path().join("caller-selected-worker");
    fs::copy(fake_worker(), &decoy).unwrap();
    fs::set_permissions(&decoy, fs::Permissions::from_mode(0o700)).unwrap();
    let supervisor =
        WorkerSupervisor::production_for_test(BINDING_ID, production_config(), directory.path())
            .unwrap();

    let error = supervisor.health(BINDING_ID).await.unwrap_err();
    assert_eq!(error.reason(), "worker_unavailable");
    assert!(!error.may_have_sent());
}

#[tokio::test]
async fn telegram_production_worker_receives_only_the_fixed_state_directory_environment() {
    const TELEGRAM_BINDING_ID: &str = "telegram-personal-42";
    const BINDING_HASH: &str = "44e00b8147e28b2132939aac9b08a31de529c8fee0143660c14cb3ad3b822bc2";
    let directory = private_tempdir();
    let worker_directory = directory.path().join("workers");
    install_fixed_worker(&worker_directory, "inboxd-telegram-worker");
    let state_directory = directory.path().join("state");
    let (database_directory, files_directory) =
        WorkerSupervisor::prepare_telegram_state_directories(&state_directory, BINDING_HASH)
            .unwrap();
    let supervisor = WorkerSupervisor::production_for_test(
        TELEGRAM_BINDING_ID,
        ProductionWorkerConfig::Telegram {
            account: "personal".into(),
            self_user_id: "7".into(),
            chat_ids_json: "[\"telegram:chat:42\"]".into(),
            api_id: "12345".into(),
            api_hash: "0123456789abcdef0123456789abcdef".into(),
            database_directory: database_directory.to_string_lossy().into_owned(),
            files_directory: files_directory.to_string_lossy().into_owned(),
        },
        &worker_directory,
    )
    .unwrap();

    let health = supervisor.health(TELEGRAM_BINDING_ID).await.unwrap();

    assert_eq!(health["state"], "ready");
    assert_eq!(health["auth"]["state"], "authenticated");
}
