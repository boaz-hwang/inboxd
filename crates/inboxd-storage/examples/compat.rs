//! Synthetic differential-test runner, not a daemon or production entry point.
#![forbid(unsafe_code)]
use inboxd_storage::{NativeHost, decode_json, encode_json};
use serde_json::json;
use std::{io::Read, path::Path};

fn main() {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .expect("fixture stdin");
    let request = decode_json(&input).expect("fixture JSON");
    let host = NativeHost::open_production(
        Path::new(request["path"].as_str().expect("fixture path")),
        &[42; 32],
    )
    .expect("synthetic database");
    let results = request["calls"]
        .as_array()
        .expect("fixture calls")
        .iter()
        .map(
            |call| match host.execute(call["op"].as_str().expect("fixture op"), &call["input"]) {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error}),
            },
        )
        .collect::<Vec<_>>();
    println!("{}", encode_json(&json!(results)).expect("fixture output"));
}
