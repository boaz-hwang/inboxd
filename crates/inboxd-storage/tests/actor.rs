use std::{
    fs,
    process::Command,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use inboxd_core::Host;
use inboxd_storage::{NativeHost, StorageActor, StorageActorConfig, StorageOperation};
use serde_json::{Value, json};
use static_assertions::assert_not_impl_any;

assert_not_impl_any!(StorageActorConfig: Clone);

fn private_tempdir() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    directory
}

#[test]
fn cross_process_writer_lock_helper() {
    if std::env::var_os("INBOXD_WRITER_LOCK_CHILD").is_none() {
        return;
    }
    let path = std::env::var_os("INBOXD_WRITER_LOCK_PATH").unwrap();
    let ready = std::env::var_os("INBOXD_WRITER_LOCK_READY").unwrap();
    let stop = std::env::var_os("INBOXD_WRITER_LOCK_STOP").unwrap();
    let mut actor = StorageActor::start(StorageActorConfig::new(path, [0x54; 32])).unwrap();
    fs::write(ready, b"ready").unwrap();
    while !std::path::Path::new(&stop).exists() {
        thread::sleep(Duration::from_millis(10));
    }
    actor.shutdown().unwrap();
}

#[test]
fn cross_process_sqlite_transaction_helper() {
    if std::env::var_os("INBOXD_SQLITE_TRANSACTION_CHILD").is_none() {
        return;
    }
    let path = std::env::var_os("INBOXD_SQLITE_TRANSACTION_PATH").unwrap();
    let ready = std::env::var_os("INBOXD_SQLITE_TRANSACTION_READY").unwrap();
    let stop = std::env::var_os("INBOXD_SQLITE_TRANSACTION_STOP").unwrap();
    let locker = NativeHost::open_production(std::path::Path::new(&path), &[0x55; 32]).unwrap();
    locker.call("sql.transaction.begin", Value::Null).unwrap();
    fs::write(ready, b"ready").unwrap();
    while !std::path::Path::new(&stop).exists() {
        thread::sleep(Duration::from_millis(10));
    }
    locker
        .call("sql.transaction.rollback", Value::Null)
        .unwrap();
}

#[test]
fn cross_process_sqlite_transaction_attempt_helper() {
    if std::env::var_os("INBOXD_SQLITE_TRANSACTION_ATTEMPT_CHILD").is_none() {
        return;
    }
    let path = std::env::var_os("INBOXD_SQLITE_TRANSACTION_ATTEMPT_PATH").unwrap();
    let result = std::env::var_os("INBOXD_SQLITE_TRANSACTION_ATTEMPT_RESULT").unwrap();
    let contender = NativeHost::open_production(std::path::Path::new(&path), &[0x55; 32]).unwrap();
    let outcome = match contender.call("sql.transaction.begin", Value::Null) {
        Ok(_) => {
            contender
                .call("sql.transaction.rollback", Value::Null)
                .unwrap();
            "acquired".to_owned()
        }
        Err(error) => format!("error:{}", error.name),
    };
    fs::write(result, outcome).unwrap();
}

fn cross_process_sqlite_transaction_attempt(
    path: &std::path::Path,
    result: &std::path::Path,
) -> String {
    match fs::remove_file(result) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("unable to clear transaction attempt result: {error}"),
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("cross_process_sqlite_transaction_attempt_helper")
        .arg("--nocapture")
        .env("INBOXD_SQLITE_TRANSACTION_ATTEMPT_CHILD", "1")
        .env("INBOXD_SQLITE_TRANSACTION_ATTEMPT_PATH", path)
        .env("INBOXD_SQLITE_TRANSACTION_ATTEMPT_RESULT", result)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "transaction attempt child failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    fs::read_to_string(result).unwrap()
}

#[test]
fn key_bearing_actor_configuration_is_not_cloneable_and_debug_is_redacted() {
    let config = StorageActorConfig::new("redacted.db", b"visible-secret-key".to_vec());
    let debug = format!("{config:?}");
    assert!(debug.contains("<redacted>"));
    assert!(!debug.contains("visible-secret-key"));
    assert!(!debug.contains("118, 105, 115"));
}

#[test]
fn bounded_actor_owns_one_writer_and_releases_it_on_shutdown() {
    let directory = private_tempdir();
    let path = directory.path().join("actor.db");
    let config = || StorageActorConfig::new(&path, [0x51; 32]).with_queue_capacity(2);

    let mut actor = StorageActor::start(config()).unwrap();
    assert_eq!(
        actor.call(StorageOperation::Diagnose, Value::Null).unwrap()["ready"],
        true
    );
    assert_eq!(
        actor
            .call(StorageOperation::ChatList, json!({"limit": 1}),)
            .unwrap()["chats"],
        json!([])
    );

    let error = StorageActor::start(config()).unwrap_err();
    assert_eq!(error.name, "WriterAlreadyActiveError");
    actor.shutdown().unwrap();

    let reopened = StorageActor::start(config()).unwrap();
    assert_eq!(
        reopened
            .call(StorageOperation::Diagnose, Value::Null)
            .unwrap()["ready"],
        true
    );
}

#[cfg(unix)]
#[test]
fn writer_identity_is_alias_safe_cross_process_and_error_precise() {
    use std::os::unix::fs::symlink;

    let directory = private_tempdir();
    let path = directory.path().join("identity.db");
    let mut actor = StorageActor::start(StorageActorConfig::new(&path, [0x54; 32])).unwrap();

    let symlink_path = directory.path().join("identity-symlink.db");
    symlink(&path, &symlink_path).unwrap();
    let symlink_error =
        StorageActor::start(StorageActorConfig::new(&symlink_path, [0x54; 32])).unwrap_err();
    assert_eq!(symlink_error.name, "WriterSymlinkError");

    let hard_link_path = directory.path().join("identity-hard-link.db");
    fs::hard_link(&path, &hard_link_path).unwrap();
    let hard_link_error =
        StorageActor::start(StorageActorConfig::new(&hard_link_path, [0x54; 32])).unwrap_err();
    assert_eq!(hard_link_error.name, "WriterHardLinkError");
    actor.shutdown().unwrap();

    let missing_parent = directory.path().join("missing").join("database.db");
    let canonicalization_error =
        StorageActor::start(StorageActorConfig::new(missing_parent, [0x54; 32])).unwrap_err();
    assert_eq!(
        canonicalization_error.name,
        "WriterPathCanonicalizationError"
    );
    let unsupported_error =
        StorageActor::start(StorageActorConfig::new(directory.path(), [0x54; 32])).unwrap_err();
    assert_eq!(unsupported_error.name, "WriterLockUnsupportedError");

    use std::os::unix::fs::PermissionsExt;
    let shared_parent = directory.path().join("shared-parent");
    fs::create_dir(&shared_parent).unwrap();
    fs::set_permissions(&shared_parent, fs::Permissions::from_mode(0o755)).unwrap();
    let shared_error = StorageActor::start(StorageActorConfig::new(
        shared_parent.join("database.db"),
        [0x54; 32],
    ))
    .unwrap_err();
    assert_eq!(shared_error.name, "WriterPathOwnershipError");

    let child_path = directory.path().join("child.db");
    let ready = directory.path().join("child.ready");
    let stop = directory.path().join("child.stop");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("cross_process_writer_lock_helper")
        .arg("--nocapture")
        .env("INBOXD_WRITER_LOCK_CHILD", "1")
        .env("INBOXD_WRITER_LOCK_PATH", &child_path)
        .env("INBOXD_WRITER_LOCK_READY", &ready)
        .env("INBOXD_WRITER_LOCK_STOP", &stop)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        assert!(
            child.try_wait().unwrap().is_none(),
            "lock child exited early"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(ready.exists(), "lock child did not become ready");
    let cross_process_error =
        StorageActor::start(StorageActorConfig::new(&child_path, [0x54; 32])).unwrap_err();
    assert_eq!(cross_process_error.name, "WriterAlreadyActiveError");
    fs::write(&stop, b"stop").unwrap();
    assert!(child.wait().unwrap().success());
}

#[test]
fn calls_backpressure_and_shutdown_are_bounded_and_distinct() {
    let directory = private_tempdir();
    let path = directory.path().join("bounded.db");
    let (entered_sender, entered_receiver) = mpsc::sync_channel(1);
    let (release_sender, release_receiver) = mpsc::sync_channel(1);
    let release_receiver = Arc::new(Mutex::new(release_receiver));
    let policy_release = Arc::clone(&release_receiver);
    let actor = Arc::new(
        StorageActor::start(
            StorageActorConfig::new(&path, [0x53; 32])
                .with_queue_capacity(1)
                .with_call_timeout(Duration::from_millis(40))
                .with_shutdown_timeout(Duration::from_millis(40))
                .with_send_policy(move |_| {
                    let _ = entered_sender.try_send(());
                    policy_release.lock().unwrap().recv().is_ok()
                }),
        )
        .unwrap(),
    );
    let scope = json!({"platform":"slack","account":"work","chat_id":"C1"});
    let created = actor
        .call(
            StorageOperation::SafetyPropose,
            json!({
                "proposal":{"actor":"agent:bounded","scope":scope,"body":"body"},
                "approval_ttl_ms":60_000,
            }),
        )
        .unwrap();
    let code = actor
        .call(
            StorageOperation::SafetyClaimApprovalCode,
            json!({"intent_id":created["intent_id"]}),
        )
        .unwrap()["code"]
        .clone();
    actor
        .call(
            StorageOperation::SafetyApprove,
            json!({
                "intent_id":created["intent_id"],"code":code,
                "actor":"agent:bounded","scope":scope,
            }),
        )
        .unwrap();

    let blocked_actor = Arc::clone(&actor);
    let intent_id = created["intent_id"].clone();
    let blocked = thread::spawn(move || {
        blocked_actor.call(
            StorageOperation::SafetyClaim,
            json!({
                "intent_id":intent_id,"transport_present":true,"send_capable":true,
                "quota_limit":1,"global_quota_limit":1,
            }),
        )
    });
    entered_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();

    let queued = actor
        .call(StorageOperation::Diagnose, Value::Null)
        .unwrap_err();
    assert_eq!(queued.name, "ActorCallTimeoutError");
    let overloaded = actor
        .call(StorageOperation::Diagnose, Value::Null)
        .unwrap_err();
    assert_eq!(overloaded.name, "ActorOverloadedError");
    assert_eq!(
        blocked.join().unwrap().unwrap_err().name,
        "ActorCallTimeoutError"
    );

    let mut actor = Arc::try_unwrap(actor).ok().unwrap();
    let started = Instant::now();
    let shutdown = actor.shutdown().unwrap_err();
    assert_eq!(shutdown.name, "ActorShutdownTimeoutError");
    assert!(started.elapsed() < Duration::from_secs(1));
    release_sender.send(()).unwrap();
    actor.shutdown().unwrap();

    let mut reopened = StorageActor::start(StorageActorConfig::new(&path, [0x53; 32])).unwrap();
    reopened.shutdown().unwrap();
}

#[test]
fn synchronous_startup_cannot_timeout_and_detach_a_sqlcipher_owner() {
    let directory = private_tempdir();
    let path = directory.path().join("startup.db");
    let ready = directory.path().join("transaction.ready");
    let stop = directory.path().join("transaction.stop");
    let mut locker = Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("cross_process_sqlite_transaction_helper")
        .arg("--nocapture")
        .env("INBOXD_SQLITE_TRANSACTION_CHILD", "1")
        .env("INBOXD_SQLITE_TRANSACTION_PATH", &path)
        .env("INBOXD_SQLITE_TRANSACTION_READY", &ready)
        .env("INBOXD_SQLITE_TRANSACTION_STOP", &stop)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() && Instant::now() < deadline {
        assert!(
            locker.try_wait().unwrap().is_none(),
            "transaction child exited early"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(ready.exists(), "transaction child did not become ready");

    let (started_sender, started_receiver) = mpsc::sync_channel(1);
    let startup_path = path.clone();
    let starter = thread::spawn(move || {
        let result = StorageActor::start(
            StorageActorConfig::new(startup_path, [0x55; 32])
                .with_startup_timeout(Duration::from_millis(40)),
        );
        started_sender.send(result).unwrap();
    });

    assert!(matches!(
        started_receiver.recv_timeout(Duration::from_millis(150)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    fs::write(&stop, b"stop").unwrap();
    assert!(locker.wait().unwrap().success());
    let startup_error = started_receiver
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .unwrap_err();
    assert_eq!(startup_error.name, "ActorStartupTimeoutError");
    starter.join().unwrap();
    let mut actor = StorageActor::start(StorageActorConfig::new(&path, [0x55; 32])).unwrap();
    actor.shutdown().unwrap();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn starting_distinct_actor_preserves_existing_sqlite_transaction_lock() {
    let directory = private_tempdir();
    let locked_path = directory.path().join("locked.db");
    let distinct_path = directory.path().join("distinct.db");
    let attempt_result = directory.path().join("transaction-attempt.result");
    let locker = NativeHost::open_production(&locked_path, &[0x55; 32]).unwrap();
    locker.execute("store.migrate", &Value::Null).unwrap();
    locker.call("sql.transaction.begin", Value::Null).unwrap();

    assert_eq!(
        cross_process_sqlite_transaction_attempt(&locked_path, &attempt_result),
        "error:SQLiteError",
        "the independent process must observe the real transaction lock before actor startup"
    );

    let mut distinct_actor =
        StorageActor::start(StorageActorConfig::new(&distinct_path, [0x56; 32])).unwrap();
    assert_eq!(
        cross_process_sqlite_transaction_attempt(&locked_path, &attempt_result),
        "error:SQLiteError",
        "starting a distinct actor must not release another production connection's SQLite lock"
    );

    locker
        .call("sql.transaction.rollback", Value::Null)
        .unwrap();
    assert_eq!(
        cross_process_sqlite_transaction_attempt(&locked_path, &attempt_result),
        "acquired",
        "the independent process must acquire the lock after the owner rolls back"
    );
    distinct_actor.shutdown().unwrap();
}

#[test]
fn drop_waits_for_worker_completion_and_writer_lease_release() {
    let directory = private_tempdir();
    let path = directory.path().join("drop-joins.db");
    let (entered_sender, entered_receiver) = mpsc::sync_channel(1);
    let (release_sender, release_receiver) = mpsc::sync_channel(1);
    let release_receiver = Arc::new(Mutex::new(release_receiver));
    let policy_release = Arc::clone(&release_receiver);
    let actor = Arc::new(
        StorageActor::start(
            StorageActorConfig::new(&path, [0x56; 32])
                .with_call_timeout(Duration::from_millis(40))
                .with_shutdown_timeout(Duration::from_millis(40))
                .with_send_policy(move |_| {
                    let _ = entered_sender.try_send(());
                    policy_release.lock().unwrap().recv().is_ok()
                }),
        )
        .unwrap(),
    );
    let scope = json!({"platform":"slack","account":"work","chat_id":"C1"});
    let created = actor
        .call(
            StorageOperation::SafetyPropose,
            json!({"proposal":{"actor":"agent:drop","scope":scope,"body":"body"},"approval_ttl_ms":60_000}),
        )
        .unwrap();
    let code = actor
        .call(
            StorageOperation::SafetyClaimApprovalCode,
            json!({"intent_id":created["intent_id"]}),
        )
        .unwrap()["code"]
        .clone();
    actor
        .call(
            StorageOperation::SafetyApprove,
            json!({"intent_id":created["intent_id"],"code":code,"actor":"agent:drop","scope":scope}),
        )
        .unwrap();
    let blocked_actor = Arc::clone(&actor);
    let intent_id = created["intent_id"].clone();
    let blocked = thread::spawn(move || {
        blocked_actor.call(
            StorageOperation::SafetyClaim,
            json!({"intent_id":intent_id,"transport_present":true,"send_capable":true,"quota_limit":1,"global_quota_limit":1}),
        )
    });
    entered_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert_eq!(
        blocked.join().unwrap().unwrap_err().name,
        "ActorCallTimeoutError"
    );
    let actor = Arc::try_unwrap(actor).ok().unwrap();
    let (dropped_sender, dropped_receiver) = mpsc::sync_channel(1);
    let dropper = thread::spawn(move || {
        drop(actor);
        dropped_sender.send(()).unwrap();
    });
    assert!(matches!(
        dropped_receiver.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    release_sender.send(()).unwrap();
    dropped_receiver
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    dropper.join().unwrap();

    let mut reopened = StorageActor::start(StorageActorConfig::new(&path, [0x56; 32])).unwrap();
    reopened.shutdown().unwrap();
}

#[test]
fn panicked_actor_is_joined_before_shutdown_returns() {
    let directory = private_tempdir();
    let path = directory.path().join("panic-joins.db");
    let mut actor = StorageActor::start(
        StorageActorConfig::new(&path, [0x57; 32]).with_send_policy(|_| {
            panic!("injected policy panic");
        }),
    )
    .unwrap();
    let scope = json!({"platform":"slack","account":"work","chat_id":"C1"});
    let created = actor
        .call(
            StorageOperation::SafetyPropose,
            json!({"proposal":{"actor":"agent:panic","scope":scope,"body":"body"},"approval_ttl_ms":60_000}),
        )
        .unwrap();
    let code = actor
        .call(
            StorageOperation::SafetyClaimApprovalCode,
            json!({"intent_id":created["intent_id"]}),
        )
        .unwrap()["code"]
        .clone();
    actor
        .call(
            StorageOperation::SafetyApprove,
            json!({"intent_id":created["intent_id"],"code":code,"actor":"agent:panic","scope":scope}),
        )
        .unwrap();
    assert_eq!(
        actor
            .call(
                StorageOperation::SafetyClaim,
                json!({"intent_id":created["intent_id"],"transport_present":true,"send_capable":true,"quota_limit":1,"global_quota_limit":1}),
            )
            .unwrap_err()
            .name,
        "ActorPanickedError"
    );
    assert_eq!(actor.shutdown().unwrap_err().name, "ActorPanickedError");

    let mut reopened = StorageActor::start(StorageActorConfig::new(&path, [0x57; 32])).unwrap();
    reopened.shutdown().unwrap();
}

#[test]
fn actor_configuration_rejects_an_unbounded_or_empty_queue() {
    let directory = private_tempdir();
    let path = directory.path().join("invalid-capacity.db");
    let error =
        StorageActor::start(StorageActorConfig::new(&path, [0x52; 32]).with_queue_capacity(0))
            .unwrap_err();
    assert_eq!(error.name, "ActorConfigurationError");
}
