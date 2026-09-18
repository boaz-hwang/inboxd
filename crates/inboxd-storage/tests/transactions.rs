use inboxd_core::{Host, SqlHost};
use inboxd_storage::{NativeHooks, NativeHost};
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
fn policy_default_deny_cannot_be_bypassed_and_quota_outbox_are_atomic() {
    let dir = tempfile::tempdir().unwrap();
    for allow in [false, true] {
        let mut host =
            NativeHost::open_development(&dir.path().join(format!("safety-{allow}.db")), &[42; 32])
                .unwrap();
        host.set_hooks(NativeHooks {
            approval_code: Some(Box::new(|| "synthetic-approval".into())),
            allow_send: allow.then(|| Box::new(|_: &Value| true) as Box<dyn Fn(&Value) -> bool>),
        });
        host.execute("store.migrate", &Value::Null).unwrap();
        let scope = json!({"platform":"p","account":"a","chat_id":"c"});
        let id = host.execute("safety.propose",&json!({"proposal":{"actor":"test","scope":scope,"body":"never sent"},"approval_ttl_ms":60000})).unwrap()["intent_id"].clone();
        host.execute(
            "safety.approve",
            &json!({"intent_id":id,"code":"synthetic-approval","actor":"test","scope":scope}),
        )
        .unwrap();
        let claim = json!({"intent_id":id,"transport_present":true,"send_capable":true,"quota_limit":1,"global_quota_limit":1,"use_allow_send":false});
        let result = host.execute("safety.claim", &claim).unwrap();
        let sql = SqlHost::new(&host);
        if allow {
            assert!(result.get("request").is_some());
            assert!(host.execute("safety.claim", &claim).is_err());
            assert_eq!(
                sql.get("SELECT count(*) AS n FROM sends", &[]).unwrap()["n"],
                1
            );
            assert_eq!(
                sql.get("SELECT sum(used) AS n FROM quota", &[]).unwrap()["n"],
                2
            );
            assert_eq!(
                host.execute("daemon.recoverInterruptedSends", &Value::Null)
                    .unwrap(),
                1
            );
            assert!(host.execute("safety.claim", &claim).is_err());
        } else {
            assert_eq!(result["summary"]["state"], "Failed");
            assert_eq!(
                sql.get("SELECT count(*) AS n FROM sends", &[]).unwrap()["n"],
                0
            );
            assert_eq!(
                sql.get("SELECT count(*) AS n FROM quota", &[]).unwrap()["n"],
                0
            );
        }
        assert_eq!(host.call("host.allowSend", Value::Null).unwrap(), allow);
    }
}
