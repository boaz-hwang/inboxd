use inboxd_core::SqlHost;
use inboxd_storage::NativeHost;
use serde_json::{Value, json};

const PRE_R1_SCHEMA_V3: &str = r#"
CREATE TABLE IF NOT EXISTS chats (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  display_name TEXT, PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS unread_evidence (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL, observed_at REAL NOT NULL,
  PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS account_self (
  platform TEXT NOT NULL, account TEXT NOT NULL, evidence_json TEXT NOT NULL, observed_at REAL NOT NULL,
  PRIMARY KEY (platform, account)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS identities (
  platform TEXT NOT NULL, account TEXT NOT NULL, identity_id TEXT NOT NULL,
  display_name TEXT, PRIMARY KEY (platform, account, identity_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS messages (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL, msg_id TEXT NOT NULL,
  author_id TEXT, ts REAL NOT NULL, body TEXT,
  parent_platform TEXT, parent_account TEXT, parent_chat_id TEXT, parent_msg_id TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]', edited_at REAL, deleted_at REAL,
  revision_kind TEXT NOT NULL CHECK (revision_kind IN ('number', 'string')),
  revision_value TEXT NOT NULL,
  PRIMARY KEY (platform, account, chat_id, msg_id),
  CHECK ((deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS messages_by_chat_timestamp ON messages(platform, account, chat_id, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  platform UNINDEXED, account UNINDEXED, chat_id UNINDEXED, msg_id UNINDEXED, body,
  tokenize = 'trigram'
);
CREATE TABLE IF NOT EXISTS read_cursors (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  cursor TEXT NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_state (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  cursor TEXT NOT NULL, updated_at REAL NOT NULL,
  PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_page_sequence (
  platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0 AND sequence <= 9007199254740991),
  PRIMARY KEY (platform, account, chat_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_coverage (
  id INTEGER PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  from_ts REAL NOT NULL, to_ts REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('backfill', 'watch', 'verified_empty')),
  collected_at REAL NOT NULL, mutations_verified_at REAL,
  UNIQUE (platform, account, chat_id, from_ts, to_ts, kind), CHECK (from_ts < to_ts)
);
CREATE TABLE IF NOT EXISTS sync_limits (
  id INTEGER PRIMARY KEY, platform TEXT NOT NULL, account TEXT NOT NULL, chat_id TEXT NOT NULL,
  from_ts REAL NOT NULL, to_ts REAL NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('retention', 'permission', 'rate_limit', 'unsupported', 'unknown')),
  observed_at REAL NOT NULL, resolved_at REAL,
  UNIQUE (platform, account, chat_id, from_ts, to_ts, reason), CHECK (from_ts < to_ts)
);
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, approved_at REAL, payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sends (
  id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS quota (
  scope TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, action TEXT NOT NULL, subject TEXT NOT NULL, payload_json TEXT NOT NULL, created_at REAL NOT NULL
);
"#;

const MATERIAL_SCHEMA_QUERY: &str = r#"
SELECT type, name, tbl_name, sql FROM sqlite_master
WHERE name IN (
  'chats', 'unread_evidence', 'account_self', 'identities', 'messages',
  'messages_by_chat_timestamp', 'messages_fts', 'read_cursors', 'sync_state',
  'sync_page_sequence', 'sync_coverage', 'sync_limits', 'intents', 'approvals',
  'sends', 'quota', 'audit'
)
ORDER BY type, name
"#;

fn install_v3(host: &NativeHost, schema: &str) {
    let sql = SqlHost::new(host);
    sql.exec(schema).unwrap();
    sql.run("PRAGMA user_version = 3", &[]).unwrap();
}

fn material_shape(host: &NativeHost) -> Vec<Value> {
    SqlHost::new(host).all(MATERIAL_SCHEMA_QUERY, &[]).unwrap()
}

fn complete_shape(host: &NativeHost) -> Vec<Value> {
    SqlHost::new(host)
        .all(
            "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
            &[],
        )
        .unwrap()
}

fn assert_v3_rejected_without_mutation(host: &NativeHost, label: &str) {
    let before = complete_shape(host);
    assert_eq!(
        host.execute("store.diagnose", &Value::Null).unwrap()["ready"],
        false,
        "{label} was accepted by diagnosis"
    );
    let error = host.execute("store.migrate", &Value::Null).unwrap_err();
    assert_eq!(error.name, "StoreSchemaError", "{label}");
    assert_eq!(error.message, "Store schema 6 failed validation", "{label}");
    assert_eq!(complete_shape(host), before, "{label} was mutated");
}

#[test]
fn exact_pre_r1_schema_v3_migrates_additively_and_material_definition_drift_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let key = [0x70; 32];

    let canonical =
        NativeHost::open_production(&directory.path().join("canonical.db"), &key).unwrap();
    install_v3(&canonical, PRE_R1_SCHEMA_V3);
    let canonical_complete = complete_shape(&canonical);
    let canonical_material = material_shape(&canonical);
    assert_eq!(canonical.execute("store.migrate", &Value::Null).unwrap(), 6);
    assert_eq!(material_shape(&canonical), canonical_material);
    let migrated_complete = complete_shape(&canonical);
    assert_eq!(migrated_complete.len(), canonical_complete.len() + 15);
    assert_eq!(
        SqlHost::new(&canonical)
            .get("PRAGMA user_version", &[])
            .unwrap()["user_version"],
        6
    );
    assert_eq!(
        canonical.execute("store.diagnose", &Value::Null).unwrap()["ready"],
        true
    );

    let fresh = NativeHost::open_production(&directory.path().join("fresh.db"), &key).unwrap();
    assert_eq!(fresh.execute("store.migrate", &Value::Null).unwrap(), 6);
    assert_eq!(material_shape(&fresh), canonical_material);
    assert_eq!(complete_shape(&fresh), migrated_complete);
    assert_eq!(fresh.execute("store.migrate", &Value::Null).unwrap(), 6);
    assert_eq!(complete_shape(&fresh), migrated_complete);

    let drifts = [
        (
            "generated intent_id projection",
            PRE_R1_SCHEMA_V3.replace(
                "id TEXT PRIMARY KEY, kind TEXT NOT NULL",
                "id TEXT PRIMARY KEY, intent_id TEXT GENERATED ALWAYS AS (id) VIRTUAL, kind TEXT NOT NULL",
            ),
        ),
        (
            "messages revision constraint",
            PRE_R1_SCHEMA_V3.replace(
                "revision_kind IN ('number', 'string')",
                "revision_kind IN ('number')",
            ),
        ),
        (
            "messages primary key",
            PRE_R1_SCHEMA_V3.replace(
                "PRIMARY KEY (platform, account, chat_id, msg_id)",
                "PRIMARY KEY (platform, account, chat_id)",
            ),
        ),
        (
            "WITHOUT ROWID",
            PRE_R1_SCHEMA_V3.replacen(") WITHOUT ROWID;", ");", 1),
        ),
        (
            "messages index column order",
            PRE_R1_SCHEMA_V3.replace(
                "messages(platform, account, chat_id, ts)",
                "messages(platform, account, ts, chat_id)",
            ),
        ),
        (
            "FTS tokenizer",
            PRE_R1_SCHEMA_V3.replace("tokenize = 'trigram'", "tokenize = 'unicode61'"),
        ),
        (
            "FTS indexed columns",
            PRE_R1_SCHEMA_V3.replace("msg_id UNINDEXED, body,", "msg_id UNINDEXED, body UNINDEXED,"),
        ),
        (
            "safety idempotency uniqueness",
            PRE_R1_SCHEMA_V3.replace(
                "idempotency_key TEXT NOT NULL UNIQUE",
                "idempotency_key TEXT NOT NULL",
            ),
        ),
    ];

    for (index, (label, schema)) in drifts.iter().enumerate() {
        let host =
            NativeHost::open_production(&directory.path().join(format!("drift-{index}.db")), &key)
                .unwrap();
        install_v3(&host, schema);
        let before = complete_shape(&host);
        assert_eq!(
            host.execute("store.diagnose", &Value::Null).unwrap()["ready"],
            false,
            "{label} was accepted"
        );
        let error = host.execute("store.migrate", &Value::Null).unwrap_err();
        assert_eq!(error.message, "Store schema 6 failed validation", "{label}");
        assert_eq!(complete_shape(&host), before, "{label} was mutated");
    }
}

#[test]
fn exact_v5_migrates_to_v6_without_changing_existing_response_state() {
    let directory = tempfile::tempdir().unwrap();
    let key = [0x68; 32];
    let host = NativeHost::open_production(&directory.path().join("v5.db"), &key).unwrap();
    assert_eq!(host.execute("store.migrate", &Value::Null).unwrap(), 6);
    let sql = SqlHost::new(&host);
    sql.run("INSERT INTO response_seen(platform,account,chat_id,msg_id,seen_at) VALUES('kakao','owner','room','42',1)",&[]).unwrap();
    sql.run("DROP TABLE provider_read_sync", &[]).unwrap();
    sql.run("PRAGMA user_version = 5", &[]).unwrap();
    assert_eq!(host.execute("store.migrate", &Value::Null).unwrap(), 6);
    assert_eq!(
        sql.get(
            "SELECT count(*) AS count FROM response_seen WHERE msg_id='42'",
            &[]
        )
        .unwrap()["count"],
        1
    );
    assert_eq!(sql.get("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='provider_read_sync'",&[]).unwrap()["count"],1);
    assert_eq!(
        host.execute("store.diagnose", &Value::Null).unwrap()["ready"],
        true
    );
}

#[test]
fn exact_schema_v4_migrates_without_recreating_or_losing_owner_sends() {
    let directory = tempfile::tempdir().unwrap();
    let host = NativeHost::open_production(&directory.path().join("v4.db"), &[0x74; 32]).unwrap();
    install_v3(&host, PRE_R1_SCHEMA_V3);
    let sql = SqlHost::new(&host);
    sql.exec(inboxd_core::OWNER_SEND_SCHEMA).unwrap();
    sql.run(
        "INSERT INTO owner_sends(request_id,platform,account,chat_id,body,envelope_json,state,outcome_json) VALUES('request-1','test','a','c','body','{}','Sent','{}')",
        &[],
    )
    .unwrap();
    sql.run("INSERT INTO messages(platform,account,chat_id,msg_id,author_id,ts,body,revision_kind,revision_value) VALUES('test','a','c','old','other',1,'history','number','1')", &[]).unwrap();
    sql.run(
        "INSERT INTO account_self VALUES('test','a','{\"status\":\"known\",\"self_id\":\"me\"}',1)",
        &[],
    )
    .unwrap();
    sql.run("PRAGMA user_version = 4", &[]).unwrap();
    let before = complete_shape(&host);

    assert_eq!(host.execute("store.migrate", &Value::Null).unwrap(), 6);
    assert_eq!(complete_shape(&host).len(), before.len() + 14);
    assert_eq!(
        host.execute(
            "response.unread",
            &json!({"platform":"test","account":"a","chat_id":"c"})
        )
        .unwrap()["status"],
        "unknown"
    );
    sql.run("INSERT INTO messages(platform,account,chat_id,msg_id,author_id,ts,body,revision_kind,revision_value) VALUES('test','a','c','new','other',2,'incoming','number','2')", &[]).unwrap();
    host.execute(
        "response.observe",
        &json!({"platform":"test","account":"a","chat_id":"c","message_ids":["new"]}),
    )
    .unwrap();
    let unread = host
        .execute(
            "response.unread",
            &json!({"platform":"test","account":"a","chat_id":"c"}),
        )
        .unwrap();
    assert_eq!(unread["count"], 1);
    assert_eq!(unread["status"], "at_least");
    assert_eq!(
        SqlHost::new(&host)
            .get(
                "SELECT request_id,state FROM owner_sends WHERE request_id='request-1'",
                &[],
            )
            .unwrap(),
        json!({"request_id":"request-1","state":"Sent"})
    );
    assert_eq!(
        host.execute("store.diagnose", &Value::Null).unwrap()["ready"],
        true
    );
}

#[test]
fn unexpected_trigger_table_index_and_view_are_rejected_without_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let key = [0x73; 32];
    let drifts = [
        (
            "write-aborting trigger",
            "CREATE TRIGGER abort_message_writes BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'blocked'); END",
        ),
        (
            "extra table",
            "CREATE TABLE unexpected_table (id INTEGER PRIMARY KEY)",
        ),
        (
            "extra index",
            "CREATE INDEX unexpected_index ON messages(body)",
        ),
        (
            "extra view",
            "CREATE VIEW unexpected_view AS SELECT platform, account, chat_id FROM chats",
        ),
    ];

    for (index, (label, mutation)) in drifts.iter().enumerate() {
        let host = NativeHost::open_production(
            &directory.path().join(format!("unexpected-{index}.db")),
            &key,
        )
        .unwrap();
        install_v3(&host, PRE_R1_SCHEMA_V3);
        SqlHost::new(&host).exec(mutation).unwrap();
        assert_v3_rejected_without_mutation(&host, label);
    }
}

#[test]
fn missing_or_altered_fts_shadow_objects_are_rejected_without_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let key = [0x74; 32];
    let drifts = [
        (
            "missing FTS docsize shadow",
            "DROP TABLE messages_fts_docsize",
        ),
        (
            "altered FTS docsize shadow",
            "DROP TABLE messages_fts_docsize; CREATE TABLE messages_fts_docsize(id INTEGER PRIMARY KEY, wrong BLOB)",
        ),
    ];

    for (index, (label, mutation)) in drifts.iter().enumerate() {
        let host = NativeHost::open_production(
            &directory.path().join(format!("fts-shadow-{index}.db")),
            &key,
        )
        .unwrap();
        install_v3(&host, PRE_R1_SCHEMA_V3);
        SqlHost::new(&host).exec(mutation).unwrap();
        assert_v3_rejected_without_mutation(&host, label);
    }
}

#[test]
fn version_three_is_not_ready_without_the_complete_schema() {
    let directory = tempfile::tempdir().unwrap();
    let host = NativeHost::open_production(&directory.path().join("incomplete-v3.db"), &[0x71; 32])
        .unwrap();
    SqlHost::new(&host)
        .run("PRAGMA user_version = 3", &[])
        .unwrap();

    assert_eq!(
        host.execute("store.diagnose", &Value::Null).unwrap()["ready"],
        false
    );
    let error = host.execute("store.migrate", &Value::Null).unwrap_err();
    assert_eq!(error.message, "Store schema 6 failed validation");
    assert_eq!(
        SqlHost::new(&host).get("PRAGMA user_version", &[]).unwrap()["user_version"],
        3
    );
}

#[test]
fn incompatible_schema_migration_rolls_back_every_partial_object() {
    let directory = tempfile::tempdir().unwrap();
    let host =
        NativeHost::open_production(&directory.path().join("rollback.db"), &[0x72; 32]).unwrap();
    let sql = SqlHost::new(&host);
    sql.exec("CREATE TABLE chats (wrong_column TEXT)").unwrap();
    let before = sql
        .all(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
            &[],
        )
        .unwrap();

    let error = host.execute("store.migrate", &Value::Null).unwrap_err();
    assert_eq!(error.message, "Store schema 6 failed validation");
    assert_eq!(
        sql.all(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
            &[],
        )
        .unwrap(),
        before
    );
    assert_eq!(
        sql.get("PRAGMA user_version", &[]).unwrap(),
        json!({"user_version": 0})
    );
}
