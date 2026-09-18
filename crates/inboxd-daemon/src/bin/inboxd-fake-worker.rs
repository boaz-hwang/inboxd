#![forbid(unsafe_code)]

use serde_json::{Value, json};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, BufRead, Write},
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

fn record_call() {
    if let Some(path) = state_path() {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(file, "send").unwrap();
        file.flush().unwrap();
    }
}

fn main() {
    let scenario = env::var("INBOXD_FAKE_WORKER_SCENARIO").unwrap_or_else(|_| "health_ok".into());
    let mut line = String::new();
    if io::stdin().lock().read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let request: Value = match serde_json::from_str(line.trim_end()) {
        Ok(request) => request,
        Err(_) => return,
    };
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
    if matches!(scenario.as_str(), "timeout" | "send_timeout") {
        if scenario == "send_timeout" {
            record_call();
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

    let mut value = match scenario.as_str() {
        "fragmented_health" => response(
            &request,
            json!({
                "state":"degraded",
                "auth":{"state":"unknown","reason":"로그인🙂","observed_at":1726650002}
            }),
        ),
        "read_ok" => read_page(&request, false),
        "read_scope_mismatch" => read_page(&request, true),
        _ => health(&request),
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
