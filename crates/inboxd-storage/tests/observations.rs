use inboxd_storage::NativeHost;
use serde_json::{Value, json};

fn page(at: u64, rows: Value) -> Value {
    json!({"platform":"test","account":"a","observed_at":at,"messages":rows})
}
fn message(id: &str, chat: &str, body: &str) -> Value {
    json!({"id":id,"chat_id":chat,"author_id":"7","author_kind":"user","author_name":"작성자","ts":10,"body":body})
}
fn query() -> Value {
    json!({"platform":"test","account":"a","query":"검색","limit":1})
}

#[test]
fn observations_share_the_index_survive_restart_and_do_not_assert_coverage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("observations.db");
    {
        let host = NativeHost::open_development(&path, &[44; 32]).unwrap();
        host.execute("store.migrate", &Value::Null).unwrap();
        host.execute(
            "observations.store",
            &page(
                2,
                json!([
                    message("1", "20", "검색 원본"),
                    message("2", "30", "검색 다른 방")
                ]),
            ),
        )
        .unwrap();
        host.execute(
            "observations.store",
            &page(3, json!([message("1", "20", "검색 수정 🙂\u{f0000}")])),
        )
        .unwrap();
        host.execute(
            "observations.store",
            &page(1, json!([message("1", "20", "stale")])),
        )
        .unwrap();
    }
    let host = NativeHost::open_development(&path, &[44; 32]).unwrap();
    let first = host.execute("observations.search", &query()).unwrap();
    assert_eq!(first["messages"][0]["body"], "검색 수정 🙂\u{f0000}");
    assert_eq!(first["messages"][0]["author_name"], "작성자");
    assert_eq!(first["messages"][0]["chat_id"], "20");
    let mut next = query();
    next["cursor"] = first["next_cursor"].clone();
    let second = host.execute("observations.search", &next).unwrap();
    assert_eq!(second["messages"][0]["chat_id"], "30");
    next["account"] = json!("other");
    assert!(host.execute("observations.search", &next).is_err());
    next["account"] = json!("a");
    next["query"] = json!("다른");
    assert!(host.execute("observations.search", &next).is_err());
    let chat = json!({"platform":"test","account":"a","chat_id":"20"});
    assert!(
        host.execute("store.readSyncState", &chat)
            .unwrap()
            .is_null()
    );
    let coverage = host
        .execute(
            "store.coverageFor",
            &json!({"chat":chat,"interval":{"from_ts":0,"to_ts":20}}),
        )
        .unwrap();
    assert!(coverage["covered"].as_array().unwrap().is_empty());
    assert!(!coverage["gaps"].as_array().unwrap().is_empty());
    // Existing single-chat/core search sees the very same FTS rows.
    let result = host.execute("store.searchMessages",&json!({"chat":chat,"interval":{"from_ts":0,"to_ts":20},"query":"검색","scope_codec":"test"})).unwrap();
    assert_eq!(result["messages"].as_array().unwrap().len(), 1);
}

#[test]
fn malformed_pages_rollback_and_tombstones_never_resurrect() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("atomic.db"), &[45; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    assert!(
        host.execute(
            "observations.store",
            &page(1, json!([message("1","20","검색"),{"id":"invalid"}]))
        )
        .is_err()
    );
    assert!(
        host.execute("observations.search", &query()).unwrap()["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let key = json!({"platform":"test","account":"a","chat_id":"20","msg_id":"1"});
    host.execute("store.applySyncBatch",&json!({"events":[{"kind":"delete","revision":{"source":"observation","value":"unversioned"},"tombstone":{"key":key,"body":null,"deleted_at":11}}]})).unwrap();
    host.execute(
        "observations.store",
        &page(2, json!([message("1", "20", "검색")])),
    )
    .unwrap();
    assert!(
        host.execute("observations.search", &query()).unwrap()["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn escaped_short_queries_and_fts_phrases_have_scope_bound_pagination() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("search.db"), &[46; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    host.execute(
        "observations.store",
        &page(
            1,
            json!([
                message("1", "20", "100% _ abc\"def"),
                message("2", "30", "plain abcdef")
            ]),
        ),
    )
    .unwrap();
    for q in ["%", "_", "abc\"def"] {
        let mut input = query();
        input["query"] = json!(q);
        let result = host.execute("observations.search", &input).unwrap();
        assert_eq!(result["messages"][0]["msg_id"], "1");
        assert!(result["next_cursor"].is_null());
    }
}

#[test]
fn bounded_provider_revisions_can_follow_partial_observations_and_rich_fields_survive() {
    use inboxd_core::SqlHost;
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("mixed.db"), &[47; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    host.execute(
        "observations.store",
        &page(1, json!([message("1", "20", "검색 partial")])),
    )
    .unwrap();
    let key = json!({"platform":"test","account":"a","chat_id":"20","msg_id":"1"});
    let event = json!({"kind":"create","revision":{"source":"adapter","value":50},"message":{"key":key,"author_id":"telegram:user:7","ts":10,"body":"검색 full","edited_at":15,"parent_id":{"platform":"test","account":"a","chat_id":"20","msg_id":"parent"},"attachments":[{"filename":"a.txt","mime":"text/plain","size":4}]}});
    host.execute("store.applySyncBatch", &json!({"events":[event]}))
        .unwrap();
    host.execute(
        "observations.store",
        &page(2, json!([message("1", "20", "검색 partial again")])),
    )
    .unwrap();
    let row = SqlHost::new(&host)
        .get(
            "SELECT edited_at,parent_msg_id,attachments_json FROM messages",
            &[],
        )
        .unwrap();
    assert_eq!(row["edited_at"], 15.0);
    assert_eq!(row["parent_msg_id"], "parent");
    assert!(row["attachments_json"].as_str().unwrap().contains("a.txt"));
}

#[test]
fn pages_obey_byte_budget_and_long_queries_use_compact_scope_cursors() {
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("bounded.db"), &[48; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    let long = "검색".repeat(500);
    let body = format!("{}{}", long, "x".repeat(26000));
    host.execute(
        "observations.store",
        &page(
            1,
            json!([message("1", "20", &body), message("2", "20", &body)]),
        ),
    )
    .unwrap();
    let input = json!({"platform":"test","account":"a","query":long,"limit":80});
    let result = host.execute("observations.search", &input).unwrap();
    assert_eq!(result["messages"].as_array().unwrap().len(), 1);
    assert!(serde_json::to_vec(&result).unwrap().len() < 58000);
    assert!(result["next_cursor"].as_str().unwrap().len() < 4096);
    let mut next = input.clone();
    next["cursor"] = result["next_cursor"].clone();
    assert_eq!(
        host.execute("observations.search", &next).unwrap()["messages"][0]["msg_id"],
        "2"
    );
}

#[test]
fn authoritative_deletions_are_atomic_scoped_durable_and_prevent_resurrection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deletions.db");
    {
        let host = NativeHost::open_development(&path, &[44; 32]).unwrap();
        host.execute("store.migrate", &Value::Null).unwrap();
        host.execute(
            "observations.store",
            &page(
                2,
                json!([
                    message("1", "20", "검색 원본"),
                    message("1", "30", "검색 다른 방")
                ]),
            ),
        )
        .unwrap();
        let deletion = json!({"platform":"test","account":"a","chat_id":"20","deleted_at":20,"ids":["1","unseen"]});
        assert_eq!(
            host.execute("observations.delete", &deletion).unwrap()["changed"],
            2
        );
        assert_eq!(
            host.execute("observations.delete", &deletion).unwrap()["changed"],
            0
        );
        assert!(host.execute("observations.delete", &json!({"platform":"test","account":"a","chat_id":"30","deleted_at":20,"ids":["1",null]})).is_err());
    }
    let host = NativeHost::open_development(&path, &[44; 32]).unwrap();
    host.execute(
        "observations.store",
        &page(
            999,
            json!([
                message("1", "20", "검색 부활"),
                message("unseen", "20", "검색 부활")
            ]),
        ),
    )
    .unwrap();
    let found = host
        .execute(
            "observations.search",
            &json!({"platform":"test","account":"a","query":"검색","limit":80}),
        )
        .unwrap();
    assert_eq!(found["messages"].as_array().unwrap().len(), 1);
    assert_eq!(found["messages"][0]["chat_id"], "30");
}

#[test]
fn semantic_observation_changes_stale_reply_cache_but_identical_repolls_do_not() {
    use inboxd_core::SqlHost;
    let dir = tempfile::tempdir().unwrap();
    let host = NativeHost::open_development(&dir.path().join("reply-stale.db"), &[49; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    host.execute(
        "store.recordAccountIdentity",
        &json!({"platform":"test","account":"a","status":"known","source":"authenticated_adapter","self_id":"me","observed_at":1}),
    )
    .unwrap();
    host.execute(
        "observations.store",
        &page(1, json!([message("old", "20", "older context")])),
    )
    .unwrap();
    host.execute(
        "response.observe",
        &json!({"platform":"test","account":"a","chat_id":"20","message_ids":["old"]}),
    )
    .unwrap();
    host.execute(
        "observations.store",
        &page(2, json!([message("new", "20", "new message")])),
    )
    .unwrap();
    host.execute(
        "response.observe",
        &json!({"platform":"test","account":"a","chat_id":"20","message_ids":["new"]}),
    )
    .unwrap();
    let prepared = host
        .execute(
            "response.prepare",
            &json!({"platform":"test","account":"a","chat_id":"20","runtime_version":"test"}),
        )
        .unwrap();
    let suggestion_id = prepared["suggestion_id"].as_str().unwrap();
    host.execute(
        "response.generationClaim",
        &json!({"suggestion_id":suggestion_id}),
    )
    .unwrap();

    host.execute(
        "observations.store",
        &page(3, json!([message("old", "20", "older context")])),
    )
    .unwrap();
    assert_eq!(
        SqlHost::new(&host)
            .get(
                "SELECT status FROM reply_suggestions WHERE suggestion_id=?",
                &[json!(suggestion_id)],
            )
            .unwrap()["status"],
        "generating"
    );

    host.execute(
        "observations.store",
        &page(4, json!([message("old", "20", "edited older context")])),
    )
    .unwrap();
    assert_eq!(
        SqlHost::new(&host)
            .get(
                "SELECT status FROM reply_suggestions WHERE suggestion_id=?",
                &[json!(suggestion_id)],
            )
            .unwrap()["status"],
        "stale"
    );
}
