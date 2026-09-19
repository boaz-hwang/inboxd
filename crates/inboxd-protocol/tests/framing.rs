use inboxd_protocol::{
    EVENT_METHODS, JsonLinesDecoder, LEGACY_REQUEST_METHODS, MAX_CLIENT_FRAME_BYTES,
    REQUEST_METHODS, encode_json_line,
};
use serde_json::json;

#[test]
fn frozen_method_surface_and_additive_capability_event_are_exact() {
    assert_eq!(LEGACY_REQUEST_METHODS.len(), 21);
    assert_eq!(REQUEST_METHODS.len(), 23);
    assert_eq!(
        LEGACY_REQUEST_METHODS[18..],
        ["settings.get", "settings.update", "subscribe"]
    );
    assert_eq!(
        &REQUEST_METHODS[18..],
        &[
            "capability.list",
            "account.list",
            "account.messages",
            "account.search",
            "message.send"
        ]
    );
    assert_eq!(
        EVENT_METHODS,
        [
            "message.upserted",
            "coverage.changed",
            "account.changed",
            "safety.intent.changed",
            "capability.changed",
        ]
    );
}

#[test]
fn json_lines_preserve_fragmented_utf8_and_enforce_raw_byte_bounds() {
    let line = encode_json_line(&json!({"body":"한🙂"}), MAX_CLIENT_FRAME_BYTES).unwrap();
    let bytes = line.as_bytes();
    let split = line.find('한').unwrap() + 1;
    let mut decoder = JsonLinesDecoder::new(MAX_CLIENT_FRAME_BYTES).unwrap();
    assert!(decoder.push(&bytes[..split]).unwrap().is_empty());
    assert_eq!(
        decoder.push(&bytes[split..]).unwrap(),
        vec![json!({"body":"한🙂"})]
    );

    let mut malformed = JsonLinesDecoder::new(32).unwrap();
    assert!(
        malformed
            .push(b"\n")
            .unwrap_err()
            .to_string()
            .contains("empty")
    );
    let mut invalid_utf8 = JsonLinesDecoder::new(32).unwrap();
    assert!(invalid_utf8.push(&[0xf0, 0x28, 0x8c, 0x28, b'\n']).is_err());
    let mut oversized = JsonLinesDecoder::new(8).unwrap();
    assert!(
        oversized
            .push(b"123456789")
            .unwrap_err()
            .to_string()
            .contains("8")
    );
}

#[test]
fn encoded_json_line_limit_includes_newline_escapes_and_multibyte_utf8() {
    fn padded(prefix: &str, total: usize) -> serde_json::Value {
        let mut body = prefix.to_owned();
        let base = serde_json::to_vec(&json!({"body":body})).unwrap().len() + 1;
        body.push_str(&"a".repeat(total - base));
        json!({"body":body})
    }

    for prefix in ["", "\"", "한🙂"] {
        let exact = padded(prefix, MAX_CLIENT_FRAME_BYTES);
        let encoded = encode_json_line(&exact, MAX_CLIENT_FRAME_BYTES).unwrap();
        assert_eq!(encoded.len(), MAX_CLIENT_FRAME_BYTES, "{prefix:?}");

        let oversized = padded(prefix, MAX_CLIENT_FRAME_BYTES + 1);
        assert!(
            encode_json_line(&oversized, MAX_CLIENT_FRAME_BYTES).is_err(),
            "accepted oversized encoded line for {prefix:?}"
        );
    }
}

#[test]
fn direct_send_requires_sender_or_owner_role() {
    use inboxd_protocol::{ClientRole, parse_request};
    let request = json!({"type":"request","id":"send","method":"message.send","params":{}});
    for role in [ClientRole::Reader, ClientRole::Agent, ClientRole::Mcp] {
        assert!(parse_request(&request, Some(role)).is_err());
    }
    assert!(parse_request(&request, Some(ClientRole::Approver)).is_ok());
    assert!(parse_request(&request, Some(ClientRole::Sender)).is_ok());
}
