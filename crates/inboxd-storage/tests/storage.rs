use inboxd_core::SqlHost;
use inboxd_storage::NativeHost;
use serde_json::{Value, json};

#[test]
fn history_export_uses_migrated_schema_and_only_observed_prefix() {
    let directory = tempfile::tempdir().unwrap();
    let host =
        NativeHost::open_development(&directory.path().join("history.db"), &[0x44; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    let sql = SqlHost::new(&host);
    sql.run(
        "INSERT INTO chats(platform,account,chat_id) VALUES('p','a','c')",
        &[],
    )
    .unwrap();
    sql.run("INSERT INTO account_self(platform,account,evidence_json,observed_at) VALUES('p','a','{\"status\":\"known\",\"self_id\":\"me\"}',1)",&[]).unwrap();
    for (id, author, ts, parent) in [
        ("incoming", "other", 1.0, None),
        ("answer", "me", 2.0, Some("incoming")),
        ("future", "other", 3.0, None),
    ] {
        sql.run("INSERT INTO messages(platform,account,chat_id,msg_id,author_id,ts,body,parent_msg_id,revision_kind,revision_value) VALUES('p','a','c',?,?,?,?,?,'string','1')",&[json!(id),json!(author),json!(ts),json!(id),json!(parent)]).unwrap();
    }
    let result = host
        .execute(
            "response.trajectory.list",
            &json!({"history_candidates":true,"limit":1}),
        )
        .unwrap();
    assert_eq!(
        result["candidates"][0]["targets"][0]["message_id"],
        "answer"
    );
    assert_eq!(
        result["candidates"][0]["context"][0]["message_id"],
        "incoming"
    );
    assert_eq!(
        result["candidates"][0]["context"].as_array().unwrap().len(),
        1
    );
    let inventory = host
        .execute(
            "response.trajectory.list",
            &json!({"history_inventory":true}),
        )
        .unwrap();
    assert_eq!(inventory["rooms"][0]["self_message_count"], 1);
}

#[test]
fn owns_encrypted_connection_and_migrates_reopens_schema_v7() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("synthetic.db");
    let key = [0x41; 32];
    {
        let host = NativeHost::open_development(&path, &key).unwrap();
        assert_eq!(host.execute("store.migrate", &Value::Null).unwrap(), 7);
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

#[test]
fn historical_page_and_private_continuation_commit_atomically_and_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.db");
    let key = [0x43; 32];
    let scope = json!({"platform":"kakao","account":"a","chat_id":"r"});
    let checkpoint = json!({"cursor":"provider-private","committed_pages":1,"terminal":false});
    {
        let host = NativeHost::open_development(&path, &key).unwrap();
        host.execute("store.migrate", &Value::Null).unwrap();
        assert_eq!(
            host.execute("observations.historyState", &scope).unwrap(),
            Value::Null
        );
        let batch = json!({"platform":"kakao","account":"a","chat_id":"r","observed_at":1,"messages":[{"id":"1","chat_id":"r","author_id":"u","ts":1,"body":"synthetic"}],"expected_history_checkpoint":null,"history_checkpoint":checkpoint});
        host.execute("observations.store", &batch).unwrap();
        let mut stale = batch;
        stale["messages"][0]["id"] = json!("must-rollback");
        assert!(host.execute("observations.store", &stale).is_err());
        let count = SqlHost::new(&host)
            .get(
                "SELECT COUNT(*) AS n FROM messages WHERE msg_id='must-rollback'",
                &[],
            )
            .unwrap();
        assert_eq!(count["n"], 0);
    }
    let host = NativeHost::open_development(&path, &key).unwrap();
    assert_eq!(
        host.execute("observations.historyState", &scope).unwrap(),
        checkpoint
    );
    let foreign = json!({"platform":"kakao","account":"other","chat_id":"r"});
    assert_eq!(
        host.execute("observations.historyState", &foreign).unwrap(),
        Value::Null
    );
    let raw = std::fs::read(path).unwrap();
    assert!(!raw.windows(16).any(|w| w == b"provider-private"));
}

#[test]
fn local_archive_replay_preserves_raw_source_and_existing_canonical_edits() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("archive.db"), &[0x51; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    host.execute("observations.store",&json!({"platform":"kakao","account":"a","observed_at":2,"messages":[{"id":"1","chat_id":"archived","author_id":"u","ts":1,"body":"new canonical edit"}]})).unwrap();
    let source = json!({"snapshot_sha256":"a".repeat(64),"schema":"kakao-mac-sqlcipher-v1"});
    let batch = json!({"platform":"kakao","account":"a","chat_id":"archived","observed_at":3,"local_archive":{"page_id":"p1","digest":"digest1","source":source,"self_user_id":"u"},"messages":[{"id":"1","chat_id":"archived","author_id":"u","ts":1,"body":"older archive text","type":1},{"id":"2","chat_id":"archived","author_id":"u","ts":2,"body":"quoted reply","type":26,"parent_id":"1","archive_metadata":{"revision":7}},{"id":"3","chat_id":"archived","author_id":"u","ts":3,"body":"media caption","type":2,"archive_metadata":{"attachment":{"private_token":"synthetic private token"}}}]});
    let result = host.execute("observations.store", &batch).unwrap();
    assert_eq!(result["inserted"].as_array().unwrap().len(), 2);
    let replay = host.execute("observations.store", &batch).unwrap();
    assert_eq!(replay["replayed"], true);
    assert!(replay["inserted"].as_array().unwrap().is_empty());
    let summary=host.execute("observations.archiveSummary",&json!({"platform":"kakao","account":"a","source_id":"a".repeat(64),"self_user_id":"u"})).unwrap();
    assert_eq!(summary["raw_records"], 3);
    assert_eq!(summary["rooms"], 1);
    assert_eq!(summary["pages"], 1);
    assert_eq!(summary["acknowledged_events"], 3);
    assert_eq!(summary["canonical_inserted"], 2);
    assert_eq!(summary["self_records"], 3);
    assert_eq!(summary["self_exact_text_records"], 2);
    assert!(!summary.to_string().contains("private"));
    let sql = SqlHost::new(&host);
    assert_eq!(
        sql.get("SELECT COUNT(*) AS n FROM local_archive_records", &[])
            .unwrap()["n"],
        3
    );
    assert_eq!(
        sql.get("SELECT body FROM messages WHERE msg_id='1'", &[])
            .unwrap()["body"],
        "new canonical edit"
    );
    assert_eq!(
        sql.get("SELECT COUNT(*) AS n FROM messages WHERE msg_id='3'", &[])
            .unwrap()["n"],
        1
    );
    assert_eq!(
        sql.get("SELECT body FROM messages WHERE msg_id='3'", &[])
            .unwrap()["body"],
        "[사진]"
    );
    assert_eq!(sql.get("SELECT parent_msg_id,parent_platform,parent_account,parent_chat_id FROM messages WHERE msg_id='2'",&[]).unwrap(),json!({"parent_msg_id":"1","parent_platform":"kakao","parent_account":"a","parent_chat_id":"archived"}));
    let mut conflict = batch.clone();
    conflict["local_archive"]["digest"] = json!("different");
    assert!(host.execute("observations.store", &conflict).is_err());
    let mut invalid = batch;
    invalid["local_archive"]["page_id"] = json!("p2");
    invalid["messages"][1]["id"] = json!("4");
    invalid["messages"][1]["ts"] = Value::Null;
    assert!(host.execute("observations.store", &invalid).is_err());
    assert_eq!(
        sql.get(
            "SELECT COUNT(*) AS n FROM local_archive_records WHERE msg_id='4'",
            &[]
        )
        .unwrap()["n"],
        0
    );
    assert_eq!(
        sql.get("SELECT COUNT(*) AS n FROM reply_suggestions", &[])
            .unwrap()["n"],
        0
    );
}

#[test]
fn local_archive_media_deleted_and_revision_evidence_survive_historical_context() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("quality.db"), &[0x54; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    let source = json!({"snapshot_sha256":"b".repeat(64),"schema":"kakao-mac-sqlcipher-v1"});
    host.execute("observations.store",&json!({"platform":"kakao","account":"a","chat_id":"r","observed_at":1,"local_archive":{"page_id":"p1","digest":"digest","source":source,"self_user_id":"me"},"messages":[{"id":"1","chat_id":"r","author_id":"other","ts":1,"body":"incoming","type":1},{"id":"2","chat_id":"r","author_id":"me","ts":2,"body":"photo private token must not leak","type":2},{"id":"3","chat_id":"r","author_id":"other","ts":3,"body":"deleted original must not train","type":16385},{"id":"4","chat_id":"r","author_id":"other","ts":4,"body":"edited text","type":1,"archive_metadata":{"revision":1}},{"id":"5","chat_id":"r","author_id":"me","ts":5,"body":"answer","type":26,"parent_id":"4"}]})).unwrap();
    let export = host
        .execute(
            "response.trajectory.list",
            &json!({"history_candidates":true}),
        )
        .unwrap();
    let rows = export["candidates"].as_array().unwrap();
    let media = rows
        .iter()
        .find(|r| r["targets"][0]["message_id"] == "2")
        .unwrap();
    assert_eq!(media["targets"][0]["content_kind"], "media");
    let answer = rows
        .iter()
        .find(|r| r["targets"][0]["message_id"] == "5")
        .unwrap();
    assert_eq!(answer["targets"][0]["content_kind"], "text");
    assert_eq!(answer["flags"]["external_content_likely"], true);
    assert_eq!(
        answer["flags"]["archive_deleted_context_unrecoverable"],
        true
    );
    assert_eq!(answer["flags"]["archive_revision_unrecoverable"], true);
    assert!(!answer.to_string().contains("deleted original"));
    assert!(!answer.to_string().contains("private token"));
    assert!(
        answer["context"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["body"] == "[사진]")
    );
    let sql = SqlHost::new(&host);
    let chronological = sql
        .all(
            "SELECT body FROM messages WHERE ts<5 ORDER BY ts,msg_id",
            &[],
        )
        .unwrap();
    assert_eq!(
        chronological
            .iter()
            .map(|m| m["body"].clone())
            .collect::<Vec<_>>(),
        answer["context"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["body"].clone())
            .collect::<Vec<_>>()
    );
}

#[test]
fn actual_storage_actor_migrates_v6_collector_checkpoint_and_reopens_archive_schema() {
    use inboxd_storage::{StorageActor, StorageActorConfig, StorageOperation};
    let dir = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.path().canonicalize().unwrap().join("upgrade.db");
    let key = [0x57; 32];
    let scope = json!({"platform":"kakao","account":"a","chat_id":"r"});
    let checkpoint = json!({"cursor":"preserved-private-provider-cursor","committed_pages":115,"terminal":false});
    {
        let host = NativeHost::open_development(&path, &key).unwrap();
        host.execute("store.migrate", &Value::Null).unwrap();
        let sql = SqlHost::new(&host);
        sql.exec(
            "DROP TABLE local_archive_pages;DROP TABLE local_archive_records;PRAGMA user_version=6",
        )
        .unwrap();
        sql.run(
            "INSERT INTO account_history VALUES('kakao','a','r',?)",
            &[json!(checkpoint.to_string())],
        )
        .unwrap();
        host.execute("observations.store",&json!({"platform":"kakao","account":"a","observed_at":1,"messages":[{"id":"1","chat_id":"r","author_id":"u","ts":1,"body":"synthetic retained"}]})).unwrap();
    }
    {
        let mut actor = StorageActor::start(StorageActorConfig::new(&path, key)).unwrap();
        assert_eq!(
            actor.call(StorageOperation::Diagnose, Value::Null).unwrap()["schema_version"],
            7
        );
        assert_eq!(
            actor
                .call(StorageOperation::ReadHistoryState, scope.clone())
                .unwrap(),
            checkpoint
        );
        actor.call(StorageOperation::ObserveMessages,json!({"platform":"kakao","account":"a","chat_id":"r","observed_at":2,"local_archive":{"page_id":"p1","digest":"digest","source":{"snapshot_sha256":"a".repeat(64)},"self_user_id":"u"},"messages":[{"id":"2","chat_id":"r","author_id":"u","ts":2,"body":"imported","type":1}]})).unwrap();
        actor.shutdown().unwrap();
    }
    let mut actor = StorageActor::start(StorageActorConfig::new(&path, key)).unwrap();
    assert_eq!(
        actor.call(StorageOperation::Diagnose, Value::Null).unwrap()["ready"],
        true
    );
    let summary = actor
        .call(
            StorageOperation::ReadLocalArchiveSummary,
            json!({"platform":"kakao","account":"a","source_id":"a".repeat(64),"self_user_id":"u"}),
        )
        .unwrap();
    assert_eq!(summary["raw_records"], 1);
    assert_eq!(summary["pages"], 1);
    assert_eq!(
        actor
            .call(StorageOperation::ReadHistoryState, scope)
            .unwrap(),
        checkpoint
    );
    actor.shutdown().unwrap();
}

#[test]
fn known_sticker_and_call_context_has_external_content_without_unknown_type_hold() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("kinds.db"), &[0x59; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    for kind in [12, 51, 0, 16396] {
        let room = format!("r-{kind}");
        // Prior generic placeholders are canonical observations: classification
        // changes must not rewrite their bodies or historical/inference order.
        host.execute("observations.store", &json!({"platform":"kakao","account":"a","observed_at":1,"messages":[{"id":"1","chat_id":room,"author_id":"other","ts":1,"body":"[카카오 메시지 형식 미확인]"}]})).unwrap();
        host.execute("observations.store", &json!({"platform":"kakao","account":"a","chat_id":room,"observed_at":2,"local_archive":{"page_id":format!("p-{kind}"),"digest":format!("d-{kind}"),"source":{"snapshot_sha256":"c".repeat(64)},"self_user_id":"me"},"messages":[{"id":"1","chat_id":room,"author_id":"other","ts":1,"body":"private structured payload","type":kind},{"id":"2","chat_id":room,"author_id":"me","ts":2,"body":"answer","type":1}]})).unwrap();
    }
    let output = host
        .execute(
            "response.trajectory.list",
            &json!({"history_candidates":true}),
        )
        .unwrap();
    for kind in [12, 51, 0, 16396] {
        let room = format!("r-{kind}");
        let answer = output["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["chat"]["chat_id"] == room && r["targets"][0]["message_id"] == "2")
            .unwrap();
        assert_eq!(answer["flags"]["external_content_likely"], true);
        assert_eq!(
            answer["flags"]["archive_type_unverified"] == true,
            kind == 0
        );
        assert_eq!(
            answer["flags"]["archive_deleted_context_unrecoverable"] == true,
            kind >= 16384
        );
        assert!(
            answer["context"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["body"] == "[카카오 메시지 형식 미확인]")
        );
        assert!(!answer.to_string().contains("private structured payload"));
    }
}

#[test]
fn archived_explicit_parent_missing_from_existing_canonical_reply_requires_review_hold() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("parent.db"), &[0x5a; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    host.execute("observations.store",&json!({"platform":"kakao","account":"a","observed_at":1,"messages":[{"id":"2","chat_id":"r","author_id":"me","ts":2,"body":"legacy quoted answer"}]})).unwrap();
    host.execute("observations.store",&json!({"platform":"kakao","account":"a","chat_id":"r","observed_at":2,"local_archive":{"page_id":"p1","digest":"d1","source":{"snapshot_sha256":"d".repeat(64)},"self_user_id":"me"},"messages":[{"id":"1","chat_id":"r","author_id":"other","ts":1,"body":"question","type":1},{"id":"2","chat_id":"r","author_id":"me","ts":2,"body":"legacy quoted answer","type":26,"archive_metadata":{"attachment":"{\"src_logId\":\"1\"}"}},{"id":"3","chat_id":"r","author_id":"other","ts":3,"body":"next question","type":1},{"id":"4","chat_id":"r","author_id":"me","ts":4,"body":"next answer","type":1}]})).unwrap();
    let candidates = host
        .execute(
            "response.trajectory.list",
            &json!({"history_candidates":true}),
        )
        .unwrap();
    let rows = candidates["candidates"].as_array().unwrap();
    let reply = rows
        .iter()
        .find(|r| r["targets"][0]["message_id"] == "2")
        .unwrap();
    assert_eq!(reply["flags"]["archive_linkage_unrecoverable"], true);
    assert_eq!(reply["targets"][0]["archive_source"]["parent_id"], "1");
    assert_eq!(
        reply["targets"][0]["archive_source"]["linkage_unrecoverable"],
        true
    );
    let later = rows
        .iter()
        .find(|r| r["targets"][0]["message_id"] == "4")
        .unwrap();
    assert_eq!(later["flags"]["archive_linkage_unrecoverable"], true);
    let sql = SqlHost::new(&host);
    assert_eq!(
        sql.get("SELECT parent_msg_id FROM messages WHERE msg_id='2'", &[])
            .unwrap()["parent_msg_id"],
        Value::Null
    );
    assert_eq!(
        sql.get("SELECT body FROM messages WHERE msg_id='2'", &[])
            .unwrap()["body"],
        "legacy quoted answer"
    );
}
