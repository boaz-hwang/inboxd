use inboxd_core::SqlHost;
use inboxd_storage::NativeHost;
use serde_json::{Value, json};

#[test]
fn rollback_cas_tombstone_and_fts_use_the_owned_connection() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("tx.db"), &[42; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    let chat = json!({"platform":"p","account":"a","chat_id":"c"});
    let key = json!({"platform":"p","account":"a","chat_id":"c","msg_id":"m"});
    let batch = json!({"events":[{"kind":"create","revision":{"source":"adapter","value":1},"message":{"key":key,"author_id":"a","ts":1,"body":"needle","attachments":[]}}],"sync":{"chat":chat,"cursor":"one","updated_at":1},"expected_page_sequence":0});
    let mut invalid = batch.clone();
    invalid["coverage"] = json!([{"chat":chat,"interval":{"from_ts":10,"to_ts":0},"kind":"backfill","collected_at":1}]);
    assert!(host.execute("store.applySyncBatch", &invalid).is_err());
    assert!(host.execute("store.getMessage", &key).unwrap().is_null());
    assert!(
        host.execute("store.readSyncState", &chat)
            .unwrap()
            .is_null()
    );
    host.execute("store.applySyncBatch", &batch).unwrap();
    assert!(host.execute("store.applySyncBatch", &batch).is_err());
    host.execute("store.applySyncBatch",&json!({"events":[{"kind":"delete","revision":{"source":"adapter","value":2},"tombstone":{"key":key,"body":null,"deleted_at":2}}]})).unwrap();
    assert_eq!(
        host.execute("store.getMessage", &key).unwrap()["deleted_at"],
        2.0
    );
    assert_eq!(
        SqlHost::new(&host)
            .get("SELECT count(*) AS n FROM messages_fts", &[])
            .unwrap()["n"],
        0
    );
}
