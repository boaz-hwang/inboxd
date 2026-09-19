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

#[test]
fn serialized_unversioned_observations_replace_old_id_revisions_without_resurrecting_deletes() {
    let dir = tempfile::tempdir().unwrap();
    let host =
        NativeHost::open_development(&dir.path().join("observations.db"), &[43; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    let chat = json!({"platform":"telegram","account":"a","chat_id":"telegram:chat:1"});
    let key = json!({"platform":"telegram","account":"a","chat_id":"telegram:chat:1","msg_id":"telegram:message:1:200"});
    let batch = |sequence, revision: Value, body| json!({"events":[{"kind":"create","revision":revision,"message":{"key":key,"author_id":"telegram:user:1","ts":10,"body":body,"attachments":[]}}],"sync":{"chat":chat,"cursor":"page","updated_at":20},"expected_page_sequence":sequence});
    host.execute(
        "store.applySyncBatch",
        &batch(0, json!({"source":"adapter","value":"200"}), "old body"),
    )
    .unwrap();
    let observation = json!({"source":"observation","value":"unversioned"});
    host.execute(
        "store.applySyncBatch",
        &batch(1, observation.clone(), "edited body"),
    )
    .unwrap();
    assert_eq!(
        host.execute("store.getMessage", &key).unwrap()["body"],
        "edited body"
    );
    assert!(
        host.execute(
            "store.applySyncBatch",
            &batch(1, observation.clone(), "stale body")
        )
        .is_err()
    );
    host.execute("store.applySyncBatch", &json!({"events":[{"kind":"delete","revision":observation,"tombstone":{"key":key,"body":null,"deleted_at":30}}]})).unwrap();
    host.execute(
        "store.applySyncBatch",
        &batch(2, observation, "resurrection"),
    )
    .unwrap();
    assert_eq!(
        host.execute("store.getMessage", &key).unwrap()["deleted_at"],
        30.0
    );
}
