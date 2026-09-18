use inboxd_core::Host;
use inboxd_storage::NativeHost;
use serde_json::{Value, json};
#[test]
fn native_crypto_time_and_encoding_match_js_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("cap.db"), &[42; 32]).unwrap();
    assert_eq!(
        host.call("host.sha256Text", json!("abc")).unwrap(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        host.call("host.canonicalSha256", json!({"b":2,"a":1}))
            .unwrap(),
        host.call("host.sha256Text", json!("{\"a\":1,\"b\":2}"))
            .unwrap()
    );
    assert_eq!(
        host.call("host.base64urlEncode", json!("\u{F0000}"))
            .unwrap(),
        "77-9"
    );
    assert_eq!(host.call("host.base64urlDecode", json!("Yf")).unwrap(), "a");
    assert_eq!(host.call("host.base64urlDecode", json!("Y")).unwrap(), "");
    assert!(host.call("host.base64urlDecode", json!("a=")).is_err());
    let id = host.call("host.id", Value::Null).unwrap();
    assert_eq!(
        uuid::Uuid::parse_str(id.as_str().unwrap())
            .unwrap()
            .get_version_num(),
        4
    );
    assert_ne!(id, host.call("host.id", Value::Null).unwrap());
    let now = host
        .call("host.now", Value::Null)
        .unwrap()
        .as_u64()
        .unwrap();
    assert!(now > 1_000_000_000_000);
}
