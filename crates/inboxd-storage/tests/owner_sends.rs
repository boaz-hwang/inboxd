use inboxd_core::SqlHost;
use inboxd_storage::{NativeHost, StorageActor, StorageActorConfig, StorageOperation};
use serde_json::{Value, json};

fn request(id: &str) -> Value {
    json!({"request_id":id,"platform":"telegram","account":"personal","chat_id":"room:part","body":"원문:🙂\u{f0000}\u{f0800}"})
}

#[test]
fn reservation_survives_restart_and_never_becomes_dispatchable_again() {
    let directory = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().canonicalize().unwrap().join("owner.db");
    let input = request("pending-request-123456");
    // Persist only the pre-dispatch reservation, modeling process loss in either
    // the before-dispatch or after-provider-call-before-result crash window.
    {
        let host = NativeHost::open_production(&path, &[0x67; 32]).unwrap();
        host.execute("store.migrate", &Value::Null).unwrap();
        assert_eq!(
            host.execute("ownerSend.reserve", &input).unwrap()["reserved"],
            true
        );
    }
    let mut actor = StorageActor::start(StorageActorConfig::new(&path, vec![0x67; 32])).unwrap();
    assert_eq!(
        actor
            .call(StorageOperation::OwnerSendLookup, input.clone())
            .unwrap(),
        json!({"state":"Uncertain"})
    );
    assert_eq!(
        actor
            .call(StorageOperation::OwnerSendReserve, input.clone())
            .unwrap(),
        json!({"reserved":false,"outcome":{"state":"Uncertain"}})
    );
    let mut late = input.clone();
    late["outcome"] = json!({"state":"Sent"});
    assert!(
        actor
            .call(StorageOperation::OwnerSendComplete, late)
            .is_err()
    );
    actor.shutdown().unwrap();
}

#[test]
fn exact_identity_and_final_outcomes_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("owner.db");
    let input = request("completed-request-123456");
    let outcome =
        json!({"state":"Sent","receipt":"native:🙂\u{f0800}","messages":[{"body":input["body"]}]});
    {
        let host = NativeHost::open_production(&path, &[0x68; 32]).unwrap();
        host.execute("store.migrate", &Value::Null).unwrap();
        host.execute("ownerSend.reserve", &input).unwrap();
        let mut completion = input.clone();
        completion["outcome"] = outcome.clone();
        host.execute("ownerSend.complete", &completion).unwrap();
        host.execute("ownerSend.complete", &completion).unwrap();
        completion["outcome"] = json!({"state":"Failed"});
        assert!(host.execute("ownerSend.complete", &completion).is_err());
    }
    let host = NativeHost::open_production(&path, &[0x68; 32]).unwrap();
    host.execute("ownerSend.recover", &Value::Null).unwrap();
    assert_eq!(host.execute("ownerSend.lookup", &input).unwrap(), outcome);
    for field in ["platform", "account", "chat_id", "body"] {
        let mut changed = input.clone();
        changed[field] = json!(format!("{}-different", input[field].as_str().unwrap()));
        for operation in ["ownerSend.lookup", "ownerSend.reserve"] {
            assert_eq!(
                host.execute(operation, &changed).unwrap_err().name,
                "OwnerSendIdentityError"
            );
        }
    }
    // Structural identity, not ambiguous chat:body string concatenation.
    let mut collision = input.clone();
    collision["chat_id"] = json!("room");
    collision["body"] = json!(format!("part:{}", input["body"].as_str().unwrap()));
    assert!(host.execute("ownerSend.reserve", &collision).is_err());
}

#[test]
fn failed_writes_leave_no_dispatchable_false_success() {
    let directory = tempfile::tempdir().unwrap();
    let host =
        NativeHost::open_production(&directory.path().join("owner.db"), &[0x69; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();
    let input = request("failure-request-123456");
    SqlHost::new(&host).exec("PRAGMA query_only = ON").unwrap();
    assert!(host.execute("ownerSend.reserve", &input).is_err());
    assert_eq!(
        host.execute("ownerSend.lookup", &input).unwrap(),
        Value::Null
    );
    SqlHost::new(&host).exec("PRAGMA query_only = OFF").unwrap();
    host.execute("ownerSend.reserve", &input).unwrap();
    SqlHost::new(&host).exec("PRAGMA query_only = ON").unwrap();
    let mut completion = input.clone();
    completion["outcome"] = json!({"state":"Sent"});
    assert!(host.execute("ownerSend.complete", &completion).is_err());
    assert_eq!(
        host.execute("ownerSend.lookup", &input).unwrap(),
        json!({"state":"Uncertain"})
    );
    assert_eq!(
        host.execute("ownerSend.reserve", &input).unwrap()["reserved"],
        false
    );
}
