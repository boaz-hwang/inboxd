use inboxd_protocol::{
    EVENT_METHODS, JsonLinesDecoder, LEGACY_REQUEST_METHODS, MAX_CLIENT_FRAME_BYTES,
    REQUEST_METHODS, encode_json_line,
};
use serde_json::json;

#[test]
fn frozen_method_surface_and_additive_capability_event_are_exact() {
    assert_eq!(LEGACY_REQUEST_METHODS.len(), 21);
    assert_eq!(REQUEST_METHODS.len(), 22);
    assert_eq!(
        LEGACY_REQUEST_METHODS[18..],
        ["settings.get", "settings.update", "subscribe"]
    );
    assert_eq!(REQUEST_METHODS.last(), Some(&"capability.list"));
    assert_eq!(
        EVENT_METHODS,
        [
            "message.upserted",
            "coverage.changed",
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
