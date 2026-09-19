use inboxd_core::{Host, wire_from_utf16_units};
use inboxd_storage::NativeHost;
use serde_json::json;

#[test]
fn equivalent_json_number_spellings_keep_integer_validation_compatible() {
    for spelling in ["1", "1.0", "1e0", "1E+0"] {
        let parsed = inboxd_storage::decode_json(&format!("{{\"limit\":{spelling}}}")).unwrap();
        assert_eq!(parsed["limit"].as_u64(), Some(1), "{spelling}");
    }
}

#[test]
fn js_serialization_preserves_wire_surrogates_order_and_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("fixture.db"), &[42; 32]).unwrap();
    let value = json!({"z": -0.0, "10":1e21, "2":1e-7, "x":wire_from_utf16_units(&[0xd800]), "p":"\u{F0800}\u{F0000}", "null":null});
    let encoded = host.call("host.jsonStringify", value.clone()).unwrap();
    assert_eq!(
        encoded,
        json!(
            "{\"2\":1e-7,\"10\":1e+21,\"z\":0,\"x\":\"\\ud800\",\"p\":\"\u{F0800}\u{F0000}\",\"null\":null}"
        )
    );
    // JSON.stringify intentionally normalizes negative zero to integer zero.
    let mut expected = value;
    expected["z"] = json!(0);
    assert_eq!(host.call("host.jsonParse", encoded).unwrap(), expected);
    assert_eq!(
        host.call("host.numberToString", json!(1e20)).unwrap(),
        "100000000000000000000"
    );
    assert_eq!(
        host.call("host.canonicalJson", json!({"\u{e000}":1,"😀":2}))
            .unwrap(),
        "{\"😀\":2,\"\u{e000}\":1}"
    );
    assert_eq!(
        host.call(
            "host.codePointLength",
            json!("\u{F0800}\u{F0000}😀\u{F0000}")
        )
        .unwrap(),
        3
    );
    assert_eq!(
        host.call("host.utf16Compare", json!({"left":"a", "right":"a\0"}))
            .unwrap(),
        -1
    );
    assert!(host.call("host.jsonParse", json!("{invalid")).is_err());
}
