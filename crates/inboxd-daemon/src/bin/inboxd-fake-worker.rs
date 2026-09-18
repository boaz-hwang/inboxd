#![forbid(unsafe_code)]

use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    env,
    fs::{self, OpenOptions},
    io::{self, BufRead, Write},
    path::Path,
    thread,
    time::Duration,
};

fn response(request: &Value, result: Value) -> Value {
    json!({
        "v":1,
        "type":"worker_response",
        "request_id":request["request_id"],
        "generation":request["generation"],
        "operation":request["operation"]["op"],
        "ok":true,
        "result":result,
    })
}

fn failure(request: &Value, code: &str, message: &str) -> Value {
    json!({
        "v":1,
        "type":"worker_response",
        "request_id":request["request_id"],
        "generation":request["generation"],
        "operation":request["operation"]["op"],
        "ok":false,
        "error":{"code":code,"message":message,"retryable":false,"may_have_sent":false},
    })
}

fn health(request: &Value) -> Value {
    response(
        request,
        json!({
            "state":"ready",
            "auth":{"state":"authenticated","reason":null,"observed_at":1726650002}
        }),
    )
}

fn read_page(request: &Value, mismatched: bool) -> Value {
    let mut page: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/protocol/normalized-worker-page-v1.json"
    ))
    .unwrap();
    if mismatched {
        page["messages"][0]["message"]["key"]["chat_id"] = json!("other");
    }
    response(
        request,
        json!({
            "items":[page.clone()],
            "next_cursor":page["next_cursor"],
            "authoritative":page["authoritative"],
        }),
    )
}

fn state_path() -> Option<String> {
    env::var("INBOXD_FAKE_WORKER_STATE").ok()
}

fn record_call(operation: &str) {
    if let Some(path) = state_path() {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "{operation}").unwrap();
        file.flush().unwrap();
    }
}

fn record_production_call(operation: &str) {
    let path = env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .join("production-calls.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    writeln!(file, "{operation}").unwrap();
    file.flush().unwrap();
}

fn production_worker_kind() -> Option<&'static str> {
    match env::current_exe().ok()?.file_name()?.to_str()? {
        "inboxd-slack-worker" => Some("slack"),
        "inboxd-telegram-worker" => Some("telegram"),
        "inboxd-kakao-local-worker" => Some("kakao-local"),
        "inboxd-kakao-message-worker" => Some("kakao-official"),
        _ => None,
    }
}

fn exact_environment(expected: &[(&str, &str)]) -> bool {
    let expected_names = expected
        .iter()
        .map(|(name, _)| (*name).to_owned())
        .collect::<BTreeSet<_>>();
    let actual = env::vars().collect::<std::collections::BTreeMap<_, _>>();
    actual.keys().cloned().collect::<BTreeSet<_>>() == expected_names
        && expected
            .iter()
            .all(|(name, value)| actual.get(*name).is_some_and(|actual| actual == value))
}

fn exact_json_environment(name: &str, expected: Value) -> bool {
    env::var(name)
        .ok()
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .is_some_and(|actual| actual == expected)
}

fn telegram_environment_is_exact() -> bool {
    const BINDING_HASH: &str = "44e00b8147e28b2132939aac9b08a31de529c8fee0143660c14cb3ad3b822bc2";
    let Ok(database_directory) = env::var("INBOXD_TELEGRAM_DATABASE_DIRECTORY") else {
        return false;
    };
    let Ok(files_directory) = env::var("INBOXD_TELEGRAM_FILES_DIRECTORY") else {
        return false;
    };
    let database_path = Path::new(&database_directory);
    let files_path = Path::new(&files_directory);
    let Some(binding_directory) = database_path.parent() else {
        return false;
    };
    let path_is_fixed = database_path.is_absolute()
        && database_path
            .file_name()
            .is_some_and(|name| name == "database")
        && files_path.file_name().is_some_and(|name| name == "files")
        && files_path.parent() == Some(binding_directory)
        && binding_directory
            .file_name()
            .is_some_and(|name| name == BINDING_HASH)
        && binding_directory
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "telegram");
    path_is_fixed
        && exact_environment(&[
            ("INBOXD_TELEGRAM_ACCOUNT", "personal"),
            (
                "INBOXD_TELEGRAM_API_HASH",
                "0123456789abcdef0123456789abcdef",
            ),
            ("INBOXD_TELEGRAM_API_ID", "12345"),
            ("INBOXD_TELEGRAM_BINDING_ID", "telegram-personal-42"),
            ("INBOXD_TELEGRAM_CHAT_IDS_JSON", "[\"telegram:chat:42\"]"),
            ("INBOXD_TELEGRAM_DATABASE_DIRECTORY", &database_directory),
            ("INBOXD_TELEGRAM_FILES_DIRECTORY", &files_directory),
            ("INBOXD_TELEGRAM_SELF_USER_ID", "7"),
        ])
}

fn production_environment_is_exact(worker: &str) -> bool {
    match worker {
        "slack" => ["slack-work", "slack-work-C0123"].iter().any(|binding_id| {
            exact_environment(&[
                ("INBOXD_SLACK_ACCOUNT", "work"),
                ("INBOXD_SLACK_ALLOWED_CHAT_IDS_JSON", "[\"C0123\"]"),
                ("INBOXD_SLACK_BINDING_ID", binding_id),
                ("INBOXD_SLACK_BOT_TOKEN", "xoxb-synthetic"),
                ("INBOXD_SLACK_TEAM_ID", "T0123"),
            ])
        }),
        "telegram" => telegram_environment_is_exact(),
        "kakao-local" => {
            env::vars().map(|(name, _)| name).collect::<BTreeSet<_>>()
                == BTreeSet::from(["INBOXD_KAKAO_LOCAL_READ_CONFIG".to_owned()])
                && exact_json_environment(
                    "INBOXD_KAKAO_LOCAL_READ_CONFIG",
                    json!({
                        "schema_version":"kakao-local-read-worker/v1",
                        "binding_id":"kakao-local-friends",
                        "allowed_chat":{
                            "v":1,"kind":"chat","platform":"kakao",
                            "account":"stable:personal","chat_id":"stable:friends",
                        },
                        "measurement":null,
                        "max_measurement_age":300,
                        "max_items":100,
                        "max_raw_bytes":16_777_216,
                        "reader":{
                            "kind":"agent-messenger",
                            "transport_account_id":"transport-account",
                            "transport_chat_id":"transport-chat",
                            "page_size":100,
                        },
                    }),
                )
        }
        "kakao-official" => exact_environment(&[
            ("INBOXD_KAKAO_ACCESS_TOKEN", "kakao-synthetic-token"),
            ("INBOXD_KAKAO_ACCOUNT", "official"),
            ("INBOXD_KAKAO_AUTH_MAX_AGE_SECONDS", "300"),
            (
                "INBOXD_KAKAO_AUTH_OBSERVATION",
                "{\"source\":\"kakao_access_token_info\",\"state\":\"authenticated\",\"observed_at\":1726650000.0}",
            ),
            ("INBOXD_KAKAO_BINDING_ID", "kakao-official-recipient"),
            ("INBOXD_KAKAO_FRIENDS_MESSAGE_PERMISSION", "granted"),
            ("INBOXD_KAKAO_OBSERVED_AT", "1726650000"),
            (
                "INBOXD_KAKAO_RECIPIENT_UUID_ALLOWLIST",
                "[\"recipient-uuid\"]",
            ),
            ("INBOXD_KAKAO_TALK_MESSAGE_CONSENT", "granted"),
            ("INBOXD_KAKAO_TEMPLATE_ID_ALLOWLIST", "[\"template-1\"]"),
        ]),
        _ => false,
    }
}

fn production_read_page(request: &Value, worker: &str) -> Value {
    let chat = request["operation"]["chat"].clone();
    let interval = request["operation"]["interval"].clone();
    let chat_key = json!({
        "platform":chat["platform"],
        "account":chat["account"],
        "chat_id":chat["chat_id"],
    });
    let body = if worker == "slack"
        && env::var("INBOXD_SLACK_BINDING_ID").as_deref() == Ok("slack-work")
    {
        "hello".to_owned()
    } else {
        format!("{worker} fixed-worker message")
    };
    let timestamp = interval["from_ts"].as_f64().unwrap_or_default();
    let page = json!({
        "v":1,
        "mode":"bounded_history",
        "chat":chat,
        "interval":interval,
        "messages":[{
            "kind":"create",
            "revision":{"source":"adapter","value":1},
            "message":{
                "key":{
                    "platform":chat_key["platform"],
                    "account":chat_key["account"],
                    "chat_id":chat_key["chat_id"],
                    "msg_id":"m1",
                },
                "author_id":"fixture-author",
                "ts":timestamp,
                "body":body,
                "attachments":[],
            },
        }],
        "tombstones":[],
        "identity":{
            "chat":chat_key,
            "status":"known",
            "self_id":"fixture-self",
            "source":"authenticated_adapter",
            "observed_at":timestamp,
        },
        "unread":{
            "chat":chat_key,
            "status":"known",
            "source":"platform",
            "count":1,
            "observed_at":timestamp,
        },
        "coverage":[{
            "chat":chat_key,
            "interval":request["operation"]["interval"],
            "kind":"backfill",
            "collected_at":timestamp,
            "mutations_verified_at":timestamp,
        }],
        "limits":[],
        "next_cursor":null,
        "authoritative":true,
        "observed_at":timestamp,
    });
    response(
        request,
        json!({"items":[page],"next_cursor":null,"authoritative":true}),
    )
}

fn main() {
    let scenario = env::var("INBOXD_FAKE_WORKER_SCENARIO").ok();
    let production = scenario.is_none();
    let scenario = scenario.unwrap_or_else(|| "production_acceptance".into());
    let mut line = String::new();
    if io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let request: Value = match serde_json::from_str(line.trim_end()) {
        Ok(request) => request,
        Err(_) => return,
    };
    let operation = request["operation"]["op"].as_str().unwrap_or_default();
    let production_worker = production.then(production_worker_kind).flatten();
    if production {
        record_production_call(operation);
        if !production_worker.is_some_and(production_environment_is_exact) {
            println!(
                "{}",
                failure(
                    &request,
                    "environment_isolation_failed",
                    "production worker received an unexpected environment",
                )
            );
            return;
        }
    }
    if scenario == "crash_once" {
        let path = state_path().expect("crash_once requires state path");
        if !std::path::Path::new(&path).exists() {
            fs::write(path, b"crashed").unwrap();
            std::process::exit(23);
        }
    }
    if scenario == "eof" {
        return;
    }
    if scenario == "send_eof" && operation == "send" {
        record_call(operation);
        return;
    }
    if scenario == "timeout" || (scenario == "send_timeout" && operation == "send") {
        if operation == "send" {
            record_call(operation);
        }
        thread::sleep(Duration::from_secs(2));
        return;
    }
    if scenario == "slow_health" {
        thread::sleep(Duration::from_millis(100));
    }
    if scenario == "empty" {
        println!();
        return;
    }
    if scenario == "malformed" {
        println!("not-json");
        return;
    }
    if scenario == "oversized" {
        println!(
            "{}",
            "x".repeat(request["limits"]["max_response_bytes"].as_u64().unwrap() as usize + 1)
        );
        return;
    }

    let mut value = if operation == "send" {
        record_call(operation);
        match scenario.as_str() {
            "send_failed" => response(
                &request,
                json!({"outcome":"failed","reason":"definite_rejection"}),
            ),
            "send_uncertain" => response(
                &request,
                json!({"outcome":"uncertain","reason":"remote_outcome_unknown"}),
            ),
            _ => response(&request, json!({"outcome":"sent","receipt_id":"receipt-1"})),
        }
    } else if operation == "read_receipt" {
        record_call(operation);
        let mut evidence = json!({
            "receipt_id":request["operation"]["receipt_id"],
            "destination":request["operation"]["expected"]["destination"],
            "content":request["operation"]["expected"]["content"],
        });
        if let Some(reply) = request["operation"]["expected"].get("reply") {
            evidence["reply"] = reply.clone();
        }
        if scenario == "send_sent_mismatch" {
            evidence["content"]["body"] = json!("different body");
        }
        response(&request, json!({"outcome":"verified","evidence":evidence}))
    } else {
        match scenario.as_str() {
            "fragmented_health" => response(
                &request,
                json!({
                    "state":"degraded",
                    "auth":{"state":"unknown","reason":"로그인🙂","observed_at":1726650002}
                }),
            ),
            "read_ok" => read_page(&request, false),
            "production_acceptance" if operation == "read_page" => {
                production_read_page(&request, production_worker.unwrap_or("unknown"))
            }
            "read_scope_mismatch" => read_page(&request, true),
            _ => health(&request),
        }
    };
    match scenario.as_str() {
        "wrong_request_id" => value["request_id"] = json!("wrong"),
        "wrong_generation" => value["generation"] = json!(9_999),
        "wrong_operation" => value["operation"] = json!("send"),
        _ => {}
    }
    let mut encoded = serde_json::to_string(&value).unwrap();
    if scenario == "padded" {
        encoded = format!("{}{}", " ".repeat(300), encoded);
    } else if scenario == "escape_inflated" {
        encoded = encoded.replace("ready", "\\u0072\\u0065\\u0061\\u0064\\u0079");
        encoded = format!("{}{}", " ".repeat(300), encoded);
    }
    if scenario == "fragmented_health" {
        let mut stdout = io::stdout().lock();
        for chunk in encoded.as_bytes().chunks(7) {
            stdout.write_all(chunk).unwrap();
            stdout.flush().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        stdout.write_all(b"\n").unwrap();
        stdout.flush().unwrap();
    } else {
        println!("{encoded}");
    }
}
