use inboxd_core::SqlHost;
use inboxd_daemon::{Daemon, DaemonConfig, launch};
#[cfg(feature = "test-worker")]
use inboxd_daemon::{TestWorkerConfig, TrustedBinding};
use inboxd_protocol::MAX_CLIENT_FRAME_BYTES;
use inboxd_storage::{NativeHost, StorageActor, StorageActorConfig, StorageOperation};
use serde_json::{Value, json};
#[cfg(feature = "test-worker")]
use std::path::PathBuf;
use std::{fs, os::unix::fs::PermissionsExt, path::Path, time::Duration};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf},
    net::UnixStream,
    time::timeout,
};

const KEY: [u8; 32] = [0x71; 32];

fn private_tempdir() -> TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn config(path: &Path) -> DaemonConfig {
    DaemonConfig::new(path, path.join("inboxd.db"), path.join("inboxd.sock"), KEY)
}

fn seed(path: &Path) {
    let mut actor =
        StorageActor::start(StorageActorConfig::new(path.join("inboxd.db"), KEY)).unwrap();
    let chat = json!({"platform":"test","account":"one","chat_id":"room"});
    actor
        .call(
            StorageOperation::ApplySyncBatch,
            json!({
                "events":[
                    {"kind":"create","revision":{"source":"adapter","value":1},"message":{"key":{"platform":"test","account":"one","chat_id":"room","msg_id":"m1"},"author_id":"self","ts":10,"body":"find me","attachments":[]}},
                    {"kind":"create","revision":{"source":"adapter","value":1},"message":{"key":{"platform":"test","account":"one","chat_id":"room","msg_id":"m2"},"author_id":"other","ts":11,"body":"second","attachments":[]}}
                ],
                "coverage":[{"chat":chat,"interval":{"from_ts":0,"to_ts":20},"kind":"backfill","collected_at":20,"mutations_verified_at":20}]
            }),
        )
        .unwrap();
    actor.shutdown().unwrap();
}

fn seed_oversized_message(path: &Path) {
    let mut actor =
        StorageActor::start(StorageActorConfig::new(path.join("inboxd.db"), KEY)).unwrap();
    actor
        .call(
            StorageOperation::ApplySyncBatch,
            json!({
                "events":[{"kind":"create","revision":{"source":"adapter","value":1},"message":{
                    "key":{"platform":"test","account":"one","chat_id":"room","msg_id":"large"},
                    "author_id":"other","ts":10,"body":"\"".repeat(40_000),"attachments":[]
                }}]
            }),
        )
        .unwrap();
    actor.shutdown().unwrap();
}

struct Client {
    read: BufReader<ReadHalf<UnixStream>>,
    write: WriteHalf<UnixStream>,
    next_id: u64,
}

impl Client {
    async fn connect(path: &Path) -> Self {
        let stream = UnixStream::connect(path).await.unwrap();
        let (read, write) = tokio::io::split(stream);
        Self {
            read: BufReader::new(read),
            write,
            next_id: 0,
        }
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
            let frame = self.next_frame().await;
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

    async fn next_frame(&mut self) -> Value {
        serde_json::from_slice(&self.next_raw_line().await).unwrap()
    }

    async fn next_raw_line(&mut self) -> Vec<u8> {
        let mut line = Vec::new();
        assert!(self.read.read_until(b'\n', &mut line).await.unwrap() > 0);
        line
    }

    async fn request_raw_line(&mut self, method: &str, params: Value) -> Vec<u8> {
        self.next_id += 1;
        let id = format!("r{}", self.next_id);
        let request = json!({"type":"request","id":id,"method":method,"params":params});
        self.write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        loop {
            let line = self.next_raw_line().await;
            let frame: Value = serde_json::from_slice(&line).unwrap();
            if frame["type"] == "response" && frame["id"] == id {
                return line;
            }
        }
    }

    async fn assert_closed(&mut self) {
        let mut line = String::new();
        let read = timeout(Duration::from_secs(2), self.read.read_line(&mut line))
            .await
            .expect("connection did not close")
            .unwrap();
        assert_eq!(read, 0, "unexpected frame before close: {line}");
    }
}

async fn trusted_approver(path: &Path) -> Client {
    let mut client = Client::connect(&path.join("inboxd.sock")).await;
    let token = fs::read_to_string(path.join("approver.token"))
        .unwrap()
        .trim()
        .to_owned();
    client
        .request(
            "system.hello",
            json!({"role":"approver","approver_token":token}),
        )
        .await;
    client
}

async fn shutdown(daemon: Daemon) {
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn all_legacy_read_methods_are_storage_backed_and_audited_by_session() {
    let directory = private_tempdir();
    seed(directory.path());
    let daemon = launch(config(directory.path())).await.unwrap();
    let mut client = Client::connect(daemon.socket_path()).await;
    assert_eq!(
        client
            .request("system.hello", json!({"role":"reader"}))
            .await,
        json!({"protocol":"inboxd","ready":true})
    );
    assert_eq!(
        client.request("system.ping", json!({})).await,
        json!({"pong":true})
    );
    assert_eq!(
        client.request("system.status", json!({})).await["owner"],
        "daemon"
    );

    let chat = json!({"platform":"test","account":"one","chat_id":"room"});
    let interval = json!({"from_ts":0,"to_ts":20});
    assert_eq!(
        client.request("chat.list", json!({})).await["chats"][0]["chat_id"],
        "room"
    );
    assert_eq!(
        client
            .request("message.inbox", json!({"chat":chat,"interval":interval}))
            .await["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        client
            .request(
                "message.recent",
                json!({"chats":[chat],"interval":interval})
            )
            .await["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        client
            .request(
                "message.evidence",
                json!({"chats":[chat],"interval":interval})
            )
            .await["evidence"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        client
            .request("message.get", json!({"chat":chat,"msg_id":"m1"}))
            .await["message"]["body"],
        "find me"
    );
    assert_eq!(
        client
            .request(
                "message.search",
                json!({"chat":chat,"interval":interval,"query":"find"})
            )
            .await["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        client.request("sync.status", json!({})).await,
        json!({"state":"idle"})
    );
    assert_eq!(
        client.request("auth.status", json!({})).await,
        json!({"authenticated":false})
    );
    assert_eq!(
        client.request("send.status", json!({"id":"missing"})).await,
        json!({"state":"missing"})
    );

    drop(client);
    shutdown(daemon).await;

    let host = NativeHost::open_development(&directory.path().join("inboxd.db"), &KEY).unwrap();
    let rows = SqlHost::new(&host)
        .all(
            "SELECT action, payload_json FROM audit WHERE action LIKE 'read.%' ORDER BY id",
            &[],
        )
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row["action"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "read.chat_list",
            "read.inbox",
            "read.recent",
            "read.evidence",
            "read.message",
            "read.search"
        ]
    );
    let sessions = rows
        .iter()
        .map(|row| serde_json::from_str::<Value>(row["payload_json"].as_str().unwrap()).unwrap()["session_id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert!(sessions[0].len() >= 32);
    assert!(sessions.iter().all(|session| session == &sessions[0]));
}

#[tokio::test]
async fn approval_methods_require_role_and_owner_token_and_codes_are_one_shot() {
    let directory = private_tempdir();
    let daemon = launch(config(directory.path())).await.unwrap();
    let mut agent = Client::connect(daemon.socket_path()).await;
    agent.request("system.hello", json!({"role":"agent"})).await;
    let scope = json!({"platform":"slack","account":"work","chat_id":"C1"});
    let created = agent
        .request(
            "safety.intent.create",
            json!({"actor":"agent:test","scope":scope,"body":"exact body"}),
        )
        .await;
    assert!(created.get("code").is_none());
    for method in [
        "safety.intent.listPending",
        "safety.intent.claimApprovalCode",
        "safety.intent.approve",
        "safety.intent.reject",
    ] {
        let denied = agent
            .request_frame(method, json!({"intent_id":created["intent_id"]}))
            .await;
        assert_eq!(denied["error"]["code"], "BAD_REQUEST");
    }

    let mut untrusted = Client::connect(daemon.socket_path()).await;
    untrusted
        .request(
            "system.hello",
            json!({"role":"approver","approver_token":"wrong"}),
        )
        .await;
    let denied = untrusted
        .request_frame("safety.intent.listPending", json!({}))
        .await;
    assert_eq!(denied["error"]["code"], "UNSUPPORTED");
    assert!(
        denied["error"]["message"]
            .as_str()
            .unwrap()
            .contains("trusted local approver")
    );

    let mut approver = trusted_approver(directory.path()).await;
    let pending = approver
        .request("safety.intent.listPending", json!({}))
        .await;
    assert_eq!(pending["intents"][0]["intent_id"], created["intent_id"]);
    assert!(!pending.to_string().contains("code"));
    let claimed = approver
        .request(
            "safety.intent.claimApprovalCode",
            json!({"intent_id":created["intent_id"]}),
        )
        .await;
    let code = claimed["code"].as_str().unwrap();
    assert_eq!(code.len(), 6);
    let approved = approver
        .request(
            "safety.intent.approve",
            json!({"intent_id":created["intent_id"],"code":code,"actor":"agent:test","scope":scope}),
        )
        .await;
    assert_eq!(approved["state"], "Approved");
    assert_eq!(
        approver
            .request(
                "safety.intent.claimApprovalCode",
                json!({"intent_id":created["intent_id"]}),
            )
            .await,
        json!({"unavailable":true})
    );

    let rejected_intent = agent
        .request(
            "safety.intent.create",
            json!({"actor":"agent:test","scope":scope,"body":"reject me"}),
        )
        .await;
    assert_eq!(
        approver
            .request(
                "safety.intent.reject",
                json!({"intent_id":rejected_intent["intent_id"]}),
            )
            .await["state"],
        "Expired"
    );
    let backfill = approver
        .request_frame(
            "sync.backfill",
            json!({"platform":"slack","account":"work","chat_id":"C1","from_ts":0,"to_ts":1}),
        )
        .await;
    assert_eq!(backfill["error"]["code"], "UNSUPPORTED");
    assert!(
        backfill["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unavailable")
    );

    drop((agent, approver, untrusted));
    shutdown(daemon).await;
}

#[tokio::test]
async fn subscriptions_replace_topics_and_terminal_overflow_closes_the_connection() {
    let directory = private_tempdir();
    let daemon = launch(config(directory.path()).with_max_queued_events(1))
        .await
        .unwrap();
    let mut client = Client::connect(daemon.socket_path()).await;
    client
        .request("system.hello", json!({"role":"reader"}))
        .await;
    assert_eq!(
        client
            .request("subscribe", json!({"topics":["message.upserted"]}))
            .await,
        json!({"subscribed":["message.upserted"]})
    );
    assert_eq!(
        client
            .request("subscribe", json!({"topics":["coverage.changed"]}))
            .await,
        json!({"subscribed":["coverage.changed"]})
    );
    daemon
        .publish_event("message.upserted", json!({"sequence":1}))
        .unwrap();
    daemon
        .publish_event("coverage.changed", json!({"sequence":2}))
        .unwrap();
    let event = timeout(Duration::from_secs(2), client.next_frame())
        .await
        .unwrap();
    assert_eq!(event["method"], "coverage.changed");
    assert_eq!(event["params"]["sequence"], 2);

    let mut overflow = Client::connect(daemon.socket_path()).await;
    overflow
        .request("system.hello", json!({"role":"reader"}))
        .await;
    overflow
        .request("subscribe", json!({"topics":["message.upserted"]}))
        .await;
    assert_eq!(
        daemon
            .publish_event("message.upserted", json!({"sequence":3}))
            .unwrap(),
        0
    );
    assert_eq!(
        daemon
            .publish_event("message.upserted", json!({"sequence":4}))
            .unwrap(),
        1
    );
    overflow.assert_closed().await;

    drop(client);
    shutdown(daemon).await;
}

#[tokio::test]
async fn outbound_responses_and_published_events_never_exceed_the_client_frame_ceiling() {
    fn event_params(prefix: &str, total: usize) -> Value {
        let mut body = prefix.to_owned();
        let event = json!({
            "type":"event","method":"message.upserted","params":{"body":body}
        });
        let base = serde_json::to_vec(&event).unwrap().len() + 1;
        body.push_str(&"a".repeat(total - base));
        json!({"body":body})
    }

    let directory = private_tempdir();
    seed_oversized_message(directory.path());
    let daemon = launch(config(directory.path())).await.unwrap();
    let mut client = Client::connect(daemon.socket_path()).await;
    client
        .request("system.hello", json!({"role":"reader"}))
        .await;

    let line = client
        .request_raw_line(
            "message.get",
            json!({
                "chat":{"platform":"test","account":"one","chat_id":"room"},
                "msg_id":"large"
            }),
        )
        .await;
    assert!(line.len() <= MAX_CLIENT_FRAME_BYTES, "{}", line.len());
    let response: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["error"]["code"], "RESPONSE_TOO_LARGE");
    assert_eq!(
        client.request("system.ping", json!({})).await,
        json!({"pong":true})
    );

    client
        .request("subscribe", json!({"topics":["message.upserted"]}))
        .await;
    for prefix in ["\"", "한🙂"] {
        let exact = event_params(prefix, MAX_CLIENT_FRAME_BYTES);
        daemon.publish_event("message.upserted", exact).unwrap();
        let event_line = client.next_raw_line().await;
        assert_eq!(event_line.len(), MAX_CLIENT_FRAME_BYTES, "{prefix:?}");

        let oversized = event_params(prefix, MAX_CLIENT_FRAME_BYTES + 1);
        assert!(
            daemon
                .publish_event("message.upserted", oversized)
                .unwrap_err()
                .to_string()
                .contains("65536"),
            "{prefix:?}"
        );
    }

    drop(client);
    shutdown(daemon).await;
}

#[cfg(feature = "test-worker")]
#[tokio::test]
async fn capability_registry_refreshes_exact_resources_notifies_and_revokes() {
    fn fake_worker() -> PathBuf {
        PathBuf::from(env!("CARGO_BIN_EXE_inboxd-fake-worker"))
    }
    fn binding(id: &str, chat_id: &str, scenario: &str, writable: bool) -> TrustedBinding {
        TrustedBinding::for_test(
            id,
            json!({
                "v":1,
                "resource":{"v":1,"kind":"chat","platform":"slack","account":"work","chat_id":chat_id},
                "read":{"mode":"bounded_history","limits":{"max_page_size":100,"max_pages":10,"cursor":"opaque"}},
                "write":if writable { json!({"mode":"send","content_mode":"text","reply":true}) } else { json!({"mode":"none","content_mode":"none","reply":false}) },
                "receipt":{"level":if writable { "independent_readback" } else { "none" }}
            }),
            TestWorkerConfig::new(fake_worker(), scenario)
                .with_timeout(Duration::from_millis(500)),
        )
        .unwrap()
    }

    let directory = private_tempdir();
    let daemon = launch(config(directory.path()).with_bindings(vec![
        binding("slack-work", "C0123", "health_ok", true),
        binding("slack-broken", "C999", "malformed", false),
    ]))
    .await
    .unwrap();
    let mut client = Client::connect(daemon.socket_path()).await;
    client
        .request("system.hello", json!({"role":"reader"}))
        .await;
    client
        .request("subscribe", json!({"topics":["capability.changed"]}))
        .await;
    let initial = client.request("capability.list", json!({})).await;
    assert_eq!(initial["v"], 1);
    assert_eq!(initial["resources"].as_array().unwrap().len(), 2);
    assert!(
        initial["resources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| {
                entry["auth"]["state"] == "unknown" && entry["auth"]["reason"] == "unobserved"
            })
    );

    let refreshed = client
        .request("capability.list", json!({"refresh":true}))
        .await;
    let resources = refreshed["resources"].as_array().unwrap();
    let ready = resources
        .iter()
        .find(|entry| entry["resource"]["chat_id"] == "C0123")
        .unwrap();
    assert_eq!(ready["auth"]["state"], "authenticated");
    let broken = resources
        .iter()
        .find(|entry| entry["resource"]["chat_id"] == "C999")
        .unwrap();
    assert_eq!(broken["auth"]["state"], "unknown");
    assert_eq!(broken["auth"]["reason"], "malformed_response");
    for _ in 0..2 {
        assert_eq!(client.next_frame().await["method"], "capability.changed");
    }

    let invalid = client
        .request_frame("capability.list", json!({"refresh":false,"extra":true}))
        .await;
    assert_eq!(invalid["error"]["code"], "BAD_REQUEST");

    assert!(daemon.revoke_binding("slack-work").await.unwrap());
    assert_eq!(client.next_frame().await["method"], "capability.changed");
    let remaining = client.request("capability.list", json!({})).await;
    assert_eq!(remaining["resources"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["resources"][0]["resource"]["chat_id"], "C999");

    for role in ["agent", "mcp", "approver"] {
        let mut role_client = Client::connect(daemon.socket_path()).await;
        role_client
            .request("system.hello", json!({"role":role}))
            .await;
        assert_eq!(
            role_client.request("capability.list", json!({})).await["resources"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    drop(client);
    shutdown(daemon).await;
}

#[cfg(feature = "test-worker")]
#[tokio::test]
async fn backfill_uses_a_private_durable_checkpoint_and_enforces_page_budget() {
    let directory = private_tempdir();
    let claims = json!({
        "v":1,
        "resource":{"v":1,"kind":"chat","platform":"slack","account":"work","chat_id":"C0123"},
        "read":{"mode":"bounded_history","limits":{"max_page_size":100,"max_pages":1,"cursor":"opaque"}},
        "write":{"mode":"none","content_mode":"none","reply":false},
        "receipt":{"level":"none"}
    });
    let binding = TrustedBinding::for_test(
        "slack-work",
        claims,
        TestWorkerConfig::new(
            PathBuf::from(env!("CARGO_BIN_EXE_inboxd-fake-worker")),
            "read_ok",
        )
        .with_timeout(Duration::from_millis(500)),
    )
    .unwrap();
    let daemon = launch(config(directory.path()).with_bindings(vec![binding]))
        .await
        .unwrap();
    let mut approver = trusted_approver(directory.path()).await;
    let params = json!({
        "platform":"slack","account":"work","chat_id":"C0123",
        "from_ts":1726650000,"to_ts":1726653600
    });

    let first = approver.request("sync.backfill", params.clone()).await;
    assert_eq!(first, json!({"event_count":1,"authoritative":true}));
    assert!(!first.to_string().contains("opaque_1"));

    let exhausted = approver.request_frame("sync.backfill", params).await;
    assert_eq!(exhausted["ok"], false, "{exhausted}");
    assert_eq!(exhausted["error"]["code"], "UNSUPPORTED");
    assert!(!exhausted.to_string().contains("opaque_1"));
    assert!(
        exhausted["error"]["message"]
            .as_str()
            .unwrap()
            .contains("max_pages")
    );
    drop(approver);
    shutdown(daemon).await;
    let host = NativeHost::open_development(&directory.path().join("inboxd.db"), &KEY).unwrap();
    let stored = host
        .execute(
            "store.readSyncState",
            &json!({"platform":"slack","account":"work","chat_id":"C0123"}),
        )
        .unwrap();
    let checkpoint: Value = serde_json::from_str(stored["cursor"].as_str().unwrap()).unwrap();
    assert_eq!(
        checkpoint["interval"],
        json!({"from_ts":1726650000,"to_ts":1726653600})
    );
    assert_eq!(checkpoint["provider_cursor"], "opaque_1");
    assert_eq!(checkpoint["committed_pages"], 1);
    assert_eq!(checkpoint["terminal"], false);
}
