//! Opt-in encrypted ingestion regression gate owned by the Rust storage crate.
//!
//! Run it in release mode so the fixed budget measures production-like code:
//! `cargo test -p inboxd-storage --release --test performance_100k encrypted_production_apply_sync_batch_ingests_100k_within_budget -- --exact --ignored --nocapture`

use std::{
    fs::File,
    io::Read,
    time::{Duration, Instant},
};

use inboxd_core::SqlHost;
use inboxd_storage::NativeHost;
use serde_json::{Value, json};

const ROW_COUNT: usize = 100_000;
const BATCH_SIZE: usize = 1_000;
const INGEST_BUDGET: Duration = Duration::from_secs(120);
const KEY: [u8; 32] = [0x73; 32];
const PLATFORM: &str = "rust-perf";
const ACCOUNT: &str = "anonymous";
const CHAT_ID: &str = "encrypted-100k";

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn nearest_rank(samples: &[Duration], percentile: usize) -> Duration {
    assert!(!samples.is_empty());
    assert!((1..=100).contains(&percentile));
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let rank = (sorted.len() * percentile).div_ceil(100);
    sorted[rank - 1]
}

fn chat() -> Value {
    json!({"platform": PLATFORM, "account": ACCOUNT, "chat_id": CHAT_ID})
}

fn make_batch(start: usize, end: usize) -> Value {
    let events = (start..end)
        .map(|index| {
            json!({
                "kind": "create",
                "revision": {"source": "adapter", "value": 1},
                "message": {
                    "key": {
                        "platform": PLATFORM,
                        "account": ACCOUNT,
                        "chat_id": CHAT_ID,
                        "msg_id": format!("bench-{index:06}"),
                    },
                    "author_id": "benchmark-person",
                    "ts": index,
                    "body": format!("encrypted Rust ingest benchmark row {index}: 이전안건 초안"),
                    "attachments": [],
                },
            })
        })
        .collect::<Vec<_>>();
    let coverage = if end == ROW_COUNT {
        json!([{
            "chat": chat(),
            "interval": {"from_ts": 0, "to_ts": ROW_COUNT},
            "kind": "backfill",
            "collected_at": ROW_COUNT + 1,
            "mutations_verified_at": null,
        }])
    } else {
        json!([])
    };
    json!({
        "events": events,
        "expected_page_sequence": start / BATCH_SIZE,
        "sync": {
            "chat": chat(),
            "cursor": end.to_string(),
            "updated_at": ROW_COUNT + 1,
        },
        "coverage": coverage,
    })
}

fn assert_persisted_state(host: &NativeHost) {
    let sql = SqlHost::new(host);
    assert_eq!(
        sql.get("SELECT count(*) AS count FROM messages", &[])
            .unwrap()["count"],
        ROW_COUNT
    );
    assert_eq!(
        sql.get("SELECT count(*) AS count FROM messages_fts", &[])
            .unwrap()["count"],
        ROW_COUNT
    );
    let state = host.execute("store.readSyncState", &chat()).unwrap();
    assert_eq!(state["cursor"], ROW_COUNT.to_string());
    assert_eq!(state["page_sequence"], ROW_COUNT / BATCH_SIZE);
    let last = host
        .execute(
            "store.getMessage",
            &json!({
                "platform": PLATFORM,
                "account": ACCOUNT,
                "chat_id": CHAT_ID,
                "msg_id": format!("bench-{:06}", ROW_COUNT - 1),
            }),
        )
        .unwrap();
    assert_eq!(last["ts"].as_f64(), Some((ROW_COUNT - 1) as f64));
    assert_eq!(last["deleted_at"], Value::Null);
}

#[test]
#[ignore = "opt-in 100k encrypted performance regression gate; run in release mode"]
fn encrypted_production_apply_sync_batch_ingests_100k_within_budget() {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("rust-encrypted-ingest-100k.db");
    let host = NativeHost::open_production(&database_path, &KEY).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    let diagnosis = host.execute("store.diagnose", &Value::Null).unwrap();
    assert_eq!(diagnosis["ready"], true);
    assert!(
        diagnosis["cipher_version"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
    );
    assert_eq!(diagnosis["provenance"]["enforced"], true);

    let wall_started = Instant::now();
    let mut ingest_elapsed = Duration::ZERO;
    let mut batch_durations = Vec::with_capacity(ROW_COUNT / BATCH_SIZE);
    for start in (0..ROW_COUNT).step_by(BATCH_SIZE) {
        let end = (start + BATCH_SIZE).min(ROW_COUNT);
        let batch = make_batch(start, end);
        let batch_started = Instant::now();
        host.execute("store.applySyncBatch", &batch).unwrap();
        let batch_elapsed = batch_started.elapsed();
        ingest_elapsed += batch_elapsed;
        batch_durations.push(batch_elapsed);

        assert!(
            ingest_elapsed <= INGEST_BUDGET,
            "encrypted production ingestion exceeded {} ms after {end} rows ({} ms)",
            milliseconds(INGEST_BUDGET),
            milliseconds(ingest_elapsed),
        );
        if end % 10_000 == 0 {
            println!(
                "{}",
                json!({
                    "benchmark": "rust-encrypted-production-ingest-100k",
                    "phase": "ingesting",
                    "rows": end,
                    "ingest_ms": milliseconds(ingest_elapsed),
                    "wall_ms": milliseconds(wall_started.elapsed()),
                })
            );
        }
    }
    let wall_elapsed = wall_started.elapsed();

    assert_eq!(batch_durations.len(), ROW_COUNT / BATCH_SIZE);
    assert_persisted_state(&host);
    SqlHost::new(&host)
        .run("PRAGMA wal_checkpoint(TRUNCATE)", &[])
        .unwrap();
    drop(host);

    let mut header = [0_u8; 16];
    File::open(&database_path)
        .unwrap()
        .read_exact(&mut header)
        .unwrap();
    assert_ne!(&header, b"SQLite format 3\0");

    let reopened = NativeHost::open_production(&database_path, &KEY).unwrap();
    assert_persisted_state(&reopened);
    let reopened_diagnosis = reopened.execute("store.diagnose", &Value::Null).unwrap();
    assert_eq!(reopened_diagnosis["ready"], true);

    let batch_max = *batch_durations.iter().max().unwrap();
    let report = json!({
        "benchmark": "rust-encrypted-production-ingest-100k",
        "runtime": "Rust release test",
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "rows": ROW_COUNT,
        "ingestion": {
            "path": "NativeHost::execute(store.applySyncBatch)",
            "batch_size": BATCH_SIZE,
            "batches": batch_durations.len(),
            "budget_ms": milliseconds(INGEST_BUDGET),
            "ingest_ms": milliseconds(ingest_elapsed),
            "wall_ms": milliseconds(wall_elapsed),
            "batch_p50_ms": milliseconds(nearest_rank(&batch_durations, 50)),
            "batch_p95_ms": milliseconds(nearest_rank(&batch_durations, 95)),
            "batch_max_ms": milliseconds(batch_max),
        },
        "verification": {
            "messages": ROW_COUNT,
            "fts_rows": ROW_COUNT,
            "cursor": ROW_COUNT.to_string(),
            "page_sequence": ROW_COUNT / BATCH_SIZE,
            "reopened": true,
            "encrypted_header": true,
            "database_bytes": std::fs::metadata(&database_path).unwrap().len(),
        },
        "sqlcipher": {
            "cipher_version": reopened_diagnosis["cipher_version"],
            "sqlite_version": reopened_diagnosis["provenance"]["sqlite_version"],
            "target": reopened_diagnosis["provenance"]["target"],
            "linkage": reopened_diagnosis["provenance"]["linkage"],
        },
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());

    assert!(
        ingest_elapsed <= INGEST_BUDGET,
        "encrypted production ingestion took {} ms; budget is {} ms",
        milliseconds(ingest_elapsed),
        milliseconds(INGEST_BUDGET),
    );
}
