use inboxd_core::{Host, SqlHost};
use inboxd_storage::NativeHost;
use serde_json::{Value, json};

#[test]
fn owns_encrypted_connection_and_migrates_reopens_schema_v3() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("synthetic.db");
    let key = [0x41; 32];
    {
        let host = NativeHost::open_development(&path, &key).unwrap();
        assert_eq!(host.execute("store.migrate", &Value::Null).unwrap(), 3);
        assert_eq!(
            host.execute("store.diagnose", &Value::Null).unwrap()["ready"],
            true
        );
        SqlHost::new(&host)
            .run(
                "INSERT INTO chats VALUES (?, ?, ?, ?)",
                &[json!("p"), json!("a"), json!("c"), Value::Null],
            )
            .unwrap();
        assert_eq!(host.call("host.allowSend", Value::Null).unwrap(), false);
    }
    assert_ne!(&std::fs::read(&path).unwrap()[..16], b"SQLite format 3\0");
    let host = NativeHost::open_development(&path, &key).unwrap();
    assert_eq!(
        host.execute("daemon.chatList", &json!({})).unwrap()["chats"][0]["chat_id"],
        "c"
    );
}
