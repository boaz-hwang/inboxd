use inboxd_protocol::{NormalizedWorkerPage, validate_normalized_worker_page};
use serde_json::{Value, json};
use std::fs;

fn fixture() -> Value {
    serde_json::from_str(
        &fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/protocol/normalized-worker-page-v1.json"
        ))
        .unwrap(),
    )
    .unwrap()
}

fn request() -> Value {
    json!({
        "v":1,"type":"worker_request","request_id":"read-1","generation":1,"binding_id":"slack-work",
        "limits":{"timeout_ms":1000,"max_response_bytes":1048576,"max_queue_depth":8},
        "operation":{
            "op":"read_page",
            "chat":{"v":1,"kind":"chat","platform":"slack","account":"work","chat_id":"C0123"},
            "interval":{"from_ts":1726650000,"to_ts":1726653600},"limit":100,"cursor":null
        }
    })
}

#[test]
fn normalized_page_requires_explicit_identity_unread_coverage_and_exact_scope() {
    let page = fixture();
    let parsed: NormalizedWorkerPage = validate_normalized_worker_page(&page, &request()).unwrap();
    assert_eq!(parsed.messages.len(), 1);
    assert_eq!(parsed.identity["status"], "known");
    assert_eq!(parsed.unread["status"], "known");

    for field in [
        "identity",
        "unread",
        "coverage",
        "limits",
        "messages",
        "tombstones",
    ] {
        let mut invalid = page.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            validate_normalized_worker_page(&invalid, &request()).is_err(),
            "accepted missing {field}"
        );
    }

    for pointer in [
        "/chat/chat_id",
        "/messages/0/message/key/chat_id",
        "/identity/chat/chat_id",
        "/unread/chat/chat_id",
        "/coverage/0/chat/chat_id",
    ] {
        let mut invalid = page.clone();
        *invalid.pointer_mut(pointer).unwrap() = json!("other");
        assert!(
            validate_normalized_worker_page(&invalid, &request()).is_err(),
            "accepted scope mismatch {pointer}"
        );
    }
}

#[test]
fn normalized_page_enforces_interval_cursor_authority_and_atomic_apply_shape() {
    let page = fixture();
    let mut invalid = page.clone();
    invalid["interval"]["from_ts"] = json!(1726650001);
    assert!(validate_normalized_worker_page(&invalid, &request()).is_err());

    invalid = page.clone();
    invalid["coverage"][0]["interval"]["to_ts"] = json!(1726653601);
    assert!(validate_normalized_worker_page(&invalid, &request()).is_err());

    let parsed = validate_normalized_worker_page(&page, &request()).unwrap();
    let batch = parsed.into_apply_sync_batch(0).unwrap();
    assert_eq!(batch["expected_page_sequence"], 0);
    assert_eq!(batch["events"].as_array().unwrap().len(), 1);
    assert_eq!(batch["sync"]["chat"]["chat_id"], "C0123");
    assert_eq!(batch["identity"]["status"], "known");
    assert_eq!(batch["unread"]["status"], "known");
}

#[test]
fn normalized_page_enforces_requested_limit_and_half_open_message_interval() {
    let page = fixture();

    let mut limit_one = request();
    limit_one["operation"]["limit"] = json!(1);
    let mut too_many = page.clone();
    let duplicate = too_many["messages"][0].clone();
    too_many["messages"].as_array_mut().unwrap().push(duplicate);
    assert!(
        validate_normalized_worker_page(&too_many, &limit_one).is_err(),
        "accepted more normalized messages than requested"
    );

    let mut at_from = page.clone();
    at_from["messages"][0]["message"]["ts"] = json!(1726650000);
    validate_normalized_worker_page(&at_from, &request()).unwrap();

    let mut below_from = page.clone();
    below_from["messages"][0]["message"]["ts"] = json!(1726649999.75);
    assert!(validate_normalized_worker_page(&below_from, &request()).is_err());

    let mut below_to = page.clone();
    below_to["messages"][0]["message"]["ts"] = json!(1726653599.999);
    validate_normalized_worker_page(&below_to, &request()).unwrap();

    let mut at_to = page.clone();
    at_to["messages"][0]["message"]["ts"] = json!(1726653600);
    assert!(validate_normalized_worker_page(&at_to, &request()).is_err());

    let mut unsafe_request = request();
    unsafe_request["operation"]["interval"] =
        json!({"from_ts":0,"to_ts":9_007_199_254_740_992_u64});
    let mut unsafe_page = page;
    unsafe_page["interval"] = unsafe_request["operation"]["interval"].clone();
    unsafe_page["coverage"][0]["interval"] = unsafe_page["interval"].clone();
    assert!(validate_normalized_worker_page(&unsafe_page, &unsafe_request).is_err());
}
