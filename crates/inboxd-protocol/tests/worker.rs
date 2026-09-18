use inboxd_protocol::{
    ClientRole, ProtocolError, parse_request, validate_worker_request_frame,
    validate_worker_response_frame,
};
use serde_json::{Value, json};
use std::fs;

fn fixture() -> Value {
    serde_json::from_str(
        &fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/protocol/worker-contract-v1.json"
        ))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn request_parser_preserves_roles_handshake_and_unsupported_settings() {
    let hello =
        json!({"type":"request","id":"h","method":"system.hello","params":{"role":"reader"}});
    assert_eq!(parse_request(&hello, None).unwrap().method, "system.hello");
    let denied =
        json!({"type":"request","id":"p","method":"safety.intent.listPending","params":{}});
    assert_eq!(
        parse_request(&denied, Some(ClientRole::Agent))
            .unwrap_err()
            .code,
        "BAD_REQUEST"
    );
    for method in ["settings.get", "settings.update", "capability.list"] {
        let request = json!({"type":"request","id":"x","method":method,"params":{}});
        assert_eq!(
            parse_request(&request, Some(ClientRole::Reader))
                .unwrap()
                .method,
            method
        );
    }
    let unknown = json!({"type":"request","id":"x","method":"send.now","params":{}});
    assert!(matches!(
        parse_request(&unknown, None),
        Err(ProtocolError { .. })
    ));
}

#[test]
fn worker_frames_are_raw_bounded_and_correlated() {
    let fixture = fixture();
    let request = &fixture["requests"]["send"];
    let response = &fixture["responses"]["send"];
    let request_line = serde_json::to_vec(request).unwrap();
    assert_eq!(
        validate_worker_request_frame(&request_line).unwrap(),
        *request
    );
    let response_line = serde_json::to_vec(response).unwrap();
    assert_eq!(
        validate_worker_response_frame(&response_line, request).unwrap(),
        *response
    );

    let mut wrong = response.clone();
    wrong["request_id"] = json!("wrong");
    assert!(validate_worker_response_frame(&serde_json::to_vec(&wrong).unwrap(), request).is_err());
    wrong = response.clone();
    wrong["generation"] = json!(8);
    assert!(validate_worker_response_frame(&serde_json::to_vec(&wrong).unwrap(), request).is_err());
    wrong = response.clone();
    wrong["operation"] = json!("health");
    assert!(validate_worker_response_frame(&serde_json::to_vec(&wrong).unwrap(), request).is_err());

    let mut ambiguous = json!({
        "v":1,"type":"worker_response","request_id":"req-send-1","generation":7,
        "operation":"send","ok":false,
        "error":{"code":"worker_io","message":"lost","retryable":true,"may_have_sent":true}
    });
    assert!(
        validate_worker_response_frame(&serde_json::to_vec(&ambiguous).unwrap(), request).is_err()
    );
    ambiguous["error"]["retryable"] = json!(false);
    assert!(
        validate_worker_response_frame(&serde_json::to_vec(&ambiguous).unwrap(), request).is_ok()
    );
}

#[test]
fn worker_response_honors_negotiated_raw_byte_limit_before_json_decode() {
    let fixture = fixture();
    let mut request = fixture["requests"]["read_page"].clone();
    let response = &fixture["responses"]["read_page"];
    let compact = serde_json::to_vec(response).unwrap();
    request["limits"]["max_response_bytes"] = json!(compact.len() + 4);
    assert!(validate_worker_response_frame(&compact, &request).is_ok());
    let mut padded = vec![b' '; 8];
    padded.extend_from_slice(&compact);
    assert!(validate_worker_response_frame(&padded, &request).is_err());
}
