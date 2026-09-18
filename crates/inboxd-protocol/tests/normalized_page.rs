use inboxd_protocol::{NormalizedWorkerPage, validate_normalized_worker_page};
use serde_json::{Value, json};
use std::fs;

fn fixture() -> Value {
    serde_json::from_str(&fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/protocol/normalized-worker-page-v1.json"
    )).unwrap()).unwrap()
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

    for field in ["identity", "unread", "coverage", "limits", "messages", "tombstones"] {
        let mut invalid = page.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(validate_normalized_worker_page(&invalid, &request()).is_err(), "accepted missing {field}");
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
        assert!(validate_normalized_worker_page(&invalid, &request()).is_err(), "accepted scope mismatch {pointer}");
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
