use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use inboxd_storage::{NativeHooks, NativeHost, StorageActor, StorageActorConfig, StorageOperation};
use serde_json::{Value, json};

fn private_tempdir() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::{fs, os::unix::fs::PermissionsExt};
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    directory
}

#[test]
fn production_actor_applies_an_owned_trusted_send_policy() {
    fn claim_with_policy(path: &std::path::Path, allow: bool) -> Value {
        let actor = StorageActor::start(
            StorageActorConfig::new(path, [0x82; 32])
                .with_send_policy(move |intent| allow && intent["actor"] == "agent:trusted"),
        )
        .unwrap();
        let scope = json!({"platform":"slack","account":"work","chat_id":"C1"});
        let created = actor
            .call(
                StorageOperation::SafetyPropose,
                json!({
                    "proposal":{"actor":"agent:trusted","scope":scope,"body":"exact body"},
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
                    "actor":"agent:trusted","scope":scope,
                }),
            )
            .unwrap();
        actor
            .call(
                StorageOperation::SafetyClaim,
                json!({
                    "intent_id":created["intent_id"],"transport_present":true,
                    "send_capable":true,"quota_limit":1,"global_quota_limit":1,
                }),
            )
            .unwrap()
    }

    let directory = private_tempdir();
    let allowed = claim_with_policy(&directory.path().join("allowed.db"), true);
    assert!(allowed.get("request").is_some());
    let denied = claim_with_policy(&directory.path().join("denied.db"), false);
    assert_eq!(denied["summary"]["state"], "Failed");
}

#[test]
fn actor_owns_one_shot_approval_codes_and_loses_them_on_restart() {
    let directory = private_tempdir();
    let path = directory.path().join("approval-codes.db");
    let config = || StorageActorConfig::new(&path, [0x81; 32]);
    let actor = StorageActor::start(config()).unwrap();
    let scope = json!({"platform":"slack","account":"work","chat_id":"C1"});

    let created = actor
        .call(
            StorageOperation::SafetyPropose,
            json!({
                "proposal":{"actor":"agent:test","scope":scope,"body":"exact body"},
                "approval_ttl_ms":60_000,
            }),
        )
        .unwrap();
    assert!(created.get("code").is_none());
    let claimed = actor
        .call(
            StorageOperation::SafetyClaimApprovalCode,
            json!({"intent_id":created["intent_id"]}),
        )
        .unwrap();
    let code = claimed["code"].as_str().unwrap();
    assert_eq!(code.len(), 6);
    assert!(code.bytes().all(|byte| byte.is_ascii_digit()));
    let approved = actor
        .call(
            StorageOperation::SafetyApprove,
            json!({
                "intent_id":created["intent_id"],
                "code":code,
                "actor":"agent:test",
                "scope":scope,
            }),
        )
        .unwrap();
    assert_eq!(approved["state"], "Approved");
    assert!(
        actor
            .call(
                StorageOperation::SafetyApprove,
                json!({
                    "intent_id":created["intent_id"],
                    "code":code,
                    "actor":"agent:test",
                    "scope":scope,
                }),
            )
            .is_err()
    );

    let orphan = actor
        .call(
            StorageOperation::SafetyPropose,
            json!({
                "proposal":{"actor":"agent:test","scope":scope,"body":"orphan"},
                "approval_ttl_ms":60_000,
            }),
        )
        .unwrap();
    drop(actor);

    let restarted = StorageActor::start(config()).unwrap();
    assert_eq!(
        restarted
            .call(
                StorageOperation::SafetyGetIntent,
                json!({"intent_id":orphan["intent_id"]}),
            )
            .unwrap()["state"],
        "Expired"
    );
    assert_eq!(
        restarted
            .call(
                StorageOperation::SafetyClaimApprovalCode,
                json!({"intent_id":orphan["intent_id"]}),
            )
            .unwrap(),
        json!({"unavailable":true})
    );
    assert_ne!(orphan["intent_id"], Value::Null);
}

#[test]
fn approval_code_store_is_bounded_and_evicts_the_oldest_pending_intent() {
    let directory = private_tempdir();
    let mut host = NativeHost::open_development(
        &directory.path().join("bounded-approval-codes.db"),
        &[0x83; 32],
    )
    .unwrap();
    host.set_hooks(NativeHooks {
        approval_code: Some(Box::new(|| "123456".into())),
        allow_send: None,
    });
    host.execute("store.migrate", &Value::Null).unwrap();
    host.execute("safety.initialize", &Value::Null).unwrap();
    let scope = json!({"platform":"slack","account":"work","chat_id":"C1"});
    let mut first = Value::Null;
    for index in 0..=100 {
        let created = host
            .execute(
                "safety.propose",
                &json!({
                    "proposal":{
                        "actor":"agent:bounded-codes","scope":scope,
                        "body":format!("body-{index}")
                    },
                    "approval_ttl_ms":60_000,
                }),
            )
            .unwrap();
        if index == 0 {
            first = created["intent_id"].clone();
        }
    }
    assert_eq!(
        host.execute("safety.getIntent", &json!({"intent_id":first}))
            .unwrap()["state"],
        "Expired"
    );
    assert_eq!(
        host.execute("safety.claimApprovalCode", &json!({"intent_id":first}),)
            .unwrap(),
        json!({"unavailable":true})
    );
}

#[test]
fn approval_code_store_purges_expired_codes_with_a_controlled_clock() {
    let directory = private_tempdir();
    let mut host = NativeHost::open_development(
        &directory.path().join("expiring-approval-codes.db"),
        &[0x84; 32],
    )
    .unwrap();
    let now = Arc::new(AtomicU64::new(1_000));
    let host_now = Arc::clone(&now);
    host.set_clock(move || host_now.load(Ordering::Relaxed));
    host.set_pending_intent_capacity(2).unwrap();
    host.set_hooks(NativeHooks {
        approval_code: Some(Box::new(|| "123456".into())),
        allow_send: None,
    });
    host.execute("store.migrate", &Value::Null).unwrap();
    host.execute("safety.initialize", &Value::Null).unwrap();
    let scope = json!({"platform":"slack","account":"work","chat_id":"C1"});
    let created = host
        .execute(
            "safety.propose",
            &json!({
                "proposal":{"actor":"agent:expiry","scope":scope,"body":"body"},
                "approval_ttl_ms":50,
            }),
        )
        .unwrap();
    now.store(1_050, Ordering::Relaxed);
    assert_eq!(
        host.execute(
            "safety.claimApprovalCode",
            &json!({"intent_id":created["intent_id"]}),
        )
        .unwrap(),
        json!({"unavailable":true})
    );
    assert_eq!(
        host.execute(
            "safety.getIntent",
            &json!({"intent_id":created["intent_id"]}),
        )
        .unwrap()["state"],
        "Expired"
    );
}
