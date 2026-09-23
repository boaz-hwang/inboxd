use inboxd_core::SqlHost;
use inboxd_storage::NativeHost;
use serde_json::{Value, json};

#[test]
fn owns_encrypted_connection_and_migrates_reopens_schema_v6() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("synthetic.db");
    let key = [0x41; 32];
    {
        let host = NativeHost::open_development(&path, &key).unwrap();
        assert_eq!(host.execute("store.migrate", &Value::Null).unwrap(), 6);
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
        host.execute("response.evidence", &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":0,"read_through":"9007199254740993"}]})).unwrap();
    }
    assert_ne!(&std::fs::read(&path).unwrap()[..16], b"SQLite format 3\0");
    let host = NativeHost::open_development(&path, &key).unwrap();
    // Reopening and replaying an older provider directory cannot forget a phone read.
    host.execute("response.evidence", &json!({"chats":[{"platform":"p","account":"a","chat_id":"c","unread_count":1,"read_through":"9007199254740992"}]})).unwrap();
    assert_eq!(
        host.execute(
            "response.unread",
            &json!({"platform":"p","account":"a","chat_id":"c"})
        )
        .unwrap()["count"],
        0
    );
    assert_eq!(
        host.execute("daemon.chatList", &json!({})).unwrap()["chats"][0]["chat_id"],
        "c"
    );
}

#[test]
fn internal_feed_repair_removes_unread_and_search_but_preserves_real_messages() {
    let directory = tempfile::tempdir().unwrap();
    let host =
        NativeHost::open_development(&directory.path().join("feeds.db"), &[0x42; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    let sql = SqlHost::new(&host);
    for feed in [
        r#"{"logId":1,"targetRevision":1,"hidden":true,"feedType":25}"#,
        r#"{"logId":1,"byHost":false,"hidden":true,"feedType":14}"#,
    ] {
        sql.run("DELETE FROM response_unseen", &[]).unwrap();
        sql.run("DELETE FROM messages_fts", &[]).unwrap();
        sql.run("DELETE FROM messages", &[]).unwrap();
        sql.run("DELETE FROM chats", &[]).unwrap();
        sql.run("INSERT INTO chats VALUES ('kakao','a','c',NULL)", &[])
            .unwrap();
        for (id, body) in [("1", "real unread"), ("2", feed)] {
            sql.run("INSERT INTO messages(platform,account,chat_id,msg_id,author_id,ts,body,revision_kind,revision_value) VALUES('kakao','a','c',?,'other',1,?,'string','old')", &[json!(id),json!(body)]).unwrap();
            sql.run("INSERT INTO messages_fts(platform,account,chat_id,msg_id,body) VALUES('kakao','a','c',?,?)", &[json!(id),json!(body)]).unwrap();
            sql.run(
                "INSERT INTO response_unseen VALUES('kakao','a','c',?,1)",
                &[json!(id)],
            )
            .unwrap();
        }
        let key = json!({"platform":"kakao","account":"a","chat_id":"c"});
        assert_eq!(host.execute("response.unread", &key).unwrap()["count"], 2);
        host.execute("response.recover", &Value::Null).unwrap();
        host.execute("response.recover", &Value::Null).unwrap();
        assert_eq!(host.execute("response.unread", &key).unwrap()["count"], 1);
        let result=host.execute("observations.store", &json!({"platform":"kakao","account":"a","observed_at":2,"messages":[{"chat_id":"c","id":"3","author_id":"other","body":feed,"ts":2}]})).unwrap();
        assert_eq!(result["stored"], 0);
        assert_eq!(result["inserted"], json!([]));
        let found = host
            .execute(
                "observations.search",
                &json!({"platform":"kakao","account":"a","query":"logId"}),
            )
            .unwrap();
        assert_eq!(found["messages"], json!([]));
        assert_eq!(host.execute("response.unread", &key).unwrap()["count"], 1);
    }
}
