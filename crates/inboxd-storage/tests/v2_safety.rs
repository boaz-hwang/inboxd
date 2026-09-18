use inboxd_core::{Host, SqlHost, wire_from_utf16_units};
use inboxd_storage::{NativeHooks, NativeHost};
use serde_json::{Map, Value, json};

fn stored_payload(host: &NativeHost, table: &str, intent_id: &Value) -> Value {
    let key = if table == "intents" {
        "id"
    } else {
        "intent_id"
    };
    let row = SqlHost::new(host)
        .get(
            &format!("SELECT payload_json FROM {table} WHERE {key} = ? LIMIT 1"),
            std::slice::from_ref(intent_id),
        )
        .unwrap();
    host.call("host.jsonParse", row["payload_json"].clone())
        .unwrap()
}

fn template_envelope(arguments: Value) -> Value {
    json!({
        "v":2,
        "destination":{
            "v":1,"kind":"destination","platform":"kakao","account":"official-app",
            "destination_id":"friend-uuid"
        },
        "content":{
            "mode":"approved_template","template_id":"notice-7",
            "arguments":arguments,"preview":"preview"
        }
    })
}

fn row_counts(host: &NativeHost) -> Value {
    SqlHost::new(host)
        .get(
            "SELECT (SELECT count(*) FROM intents) AS intents, (SELECT count(*) FROM approvals) AS approvals, (SELECT count(*) FROM audit) AS audit",
            &[],
        )
        .unwrap()
}

fn propose_envelope(host: &NativeHost, envelope: Value) -> inboxd_core::CoreResult<Value> {
    host.execute(
        "safety.propose",
        &json!({
            "proposal":{"actor":"agent:bounds","envelope":envelope},
            "approval_ttl_ms":60_000,
        }),
    )
}

fn assert_rejected_without_write(host: &NativeHost, arguments: Value, expected: &str) {
    let before = row_counts(host);
    let error = propose_envelope(host, template_envelope(arguments)).unwrap_err();
    assert!(
        error.message.contains(expected),
        "expected {expected:?}, got {:?}",
        error.message
    );
    assert_eq!(row_counts(host), before);
}

#[test]
fn v2_template_approval_hash_quota_resource_and_outbox_are_exactly_bound() {
    let directory = tempfile::tempdir().unwrap();
    let mut host =
        NativeHost::open_development(&directory.path().join("v2.db"), &[0x91; 32]).unwrap();
    host.set_hooks(NativeHooks {
        approval_code: Some(Box::new(|| "654321".into())),
        allow_send: Some(Box::new(|_| true)),
    });
    host.execute("store.migrate", &Value::Null).unwrap();
    host.execute("safety.initialize", &Value::Null).unwrap();

    let destination = json!({
        "v":1,"kind":"destination","platform":"kakao","account":"official-app",
        "destination_id":"friend-uuid"
    });
    let envelope = json!({
        "v":2,
        "destination":destination,
        "content":{
            "mode":"approved_template","template_id":"notice-7",
            "arguments":{"amount":1000,"label":"승인"},"preview":"승인: 1000"
        }
    });
    let approval_payload = json!({"actor":"agent:template","envelope":envelope});
    let created = host
        .execute(
            "safety.propose",
            &json!({"proposal":approval_payload,"approval_ttl_ms":60_000}),
        )
        .unwrap();
    let intent_id = created["intent_id"].clone();
    let intent = stored_payload(&host, "intents", &intent_id);
    let payload_hash = host
        .call("host.canonicalSha256", approval_payload.clone())
        .unwrap();
    assert_eq!(intent["payload_hash"], payload_hash);

    let approval = stored_payload(&host, "approvals", &intent_id);
    let expected_bound_hash = host
        .call(
            "host.canonicalSha256",
            json!({
                "intent_id":intent_id,"actor":"agent:template","resource":destination,
                "payload_hash":payload_hash,"expires_at":created["expires_at"],
            }),
        )
        .unwrap();
    assert_eq!(approval["bound_hash"], expected_bound_hash);

    let code = host
        .execute("safety.claimApprovalCode", &json!({"intent_id":intent_id}))
        .unwrap()["code"]
        .clone();
    assert_eq!(code, "654321");
    assert_eq!(
        host.execute(
            "safety.approve",
            &json!({
                "intent_id":intent_id,"code":code,"actor":"agent:template",
                "resource":destination,
            }),
        )
        .unwrap()["state"],
        "Approved"
    );

    let claim = host
        .execute(
            "safety.claim",
            &json!({
                "intent_id":intent_id,"transport_present":true,"send_capable":true,
                "quota_limit":1,"global_quota_limit":1,
            }),
        )
        .unwrap();
    assert_eq!(claim["request"]["actor"], "agent:template");
    assert_eq!(claim["request"]["envelope"], envelope);
    assert!(claim["request"].get("scope").is_none());
    let expected_idempotency = host
        .call(
            "host.canonicalSha256",
            json!({
                "intent_id":intent_id,"resource":destination,"payload_hash":payload_hash,
                "expires_at":created["expires_at"],
            }),
        )
        .unwrap();
    assert_eq!(claim["request"]["idempotency_key"], expected_idempotency);

    let quota_key = host
        .call("host.canonicalJson", destination.clone())
        .unwrap();
    let quota = SqlHost::new(&host)
        .all("SELECT scope, used FROM quota ORDER BY scope", &[])
        .unwrap();
    assert_eq!(quota.len(), 2);
    assert!(quota.contains(&json!({"scope":"__global__","used":1})));
    assert!(quota.contains(&json!({"scope":quota_key,"used":1})));

    let sent = host
        .execute(
            "safety.finalize",
            &json!({
                "intent_id":intent_id,"state":"Sent",
                "transport_payload":{"receipt_id":"kakao-receipt-1"},
            }),
        )
        .unwrap();
    assert_eq!(sent["state"], "Sent");
    assert_eq!(sent["receipt"], "kakao-receipt-1");
    let still_sent = host
        .execute(
            "safety.verifyReceipt",
            &json!({
                "intent_id":intent_id,
                "evidence":{
                    "destination":destination,"receipt_id":"kakao-receipt-1",
                    "content":envelope["content"],
                },
            }),
        )
        .unwrap();
    assert_eq!(still_sent["state"], "Sent");

    let audit = SqlHost::new(&host)
        .all("SELECT payload_json FROM audit ORDER BY id", &[])
        .unwrap();
    let audit_json = serde_json::to_string(&audit).unwrap();
    assert!(!audit_json.contains("승인: 1000"));
    assert!(!audit_json.contains("kakao-receipt-1"));
    assert!(!audit_json.contains("654321"));
}

#[test]
fn v2_approval_rejects_any_template_or_destination_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let mut host =
        NativeHost::open_development(&directory.path().join("tamper.db"), &[0x92; 32]).unwrap();
    host.set_hooks(NativeHooks {
        approval_code: Some(Box::new(|| "654321".into())),
        allow_send: None,
    });
    host.execute("store.migrate", &Value::Null).unwrap();
    let destination = json!({
        "v":1,"kind":"destination","platform":"kakao","account":"official-app",
        "destination_id":"friend-uuid"
    });
    let created = host
        .execute(
            "safety.propose",
            &json!({
                "proposal":{
                    "actor":"agent:template",
                    "envelope":{
                        "v":2,"destination":destination,
                        "content":{
                            "mode":"approved_template","template_id":"notice-7",
                            "arguments":{"amount":1000},"preview":"original"
                        }
                    }
                },
                "approval_ttl_ms":60_000,
            }),
        )
        .unwrap();
    let code = host
        .execute(
            "safety.claimApprovalCode",
            &json!({"intent_id":created["intent_id"]}),
        )
        .unwrap()["code"]
        .clone();
    let row = SqlHost::new(&host)
        .get(
            "SELECT payload_json FROM intents WHERE id = ?",
            &[created["intent_id"].clone()],
        )
        .unwrap();
    let tampered = row["payload_json"]
        .as_str()
        .unwrap()
        .replace("original", "mutated");
    SqlHost::new(&host)
        .run(
            "UPDATE intents SET payload_json = ? WHERE id = ?",
            &[json!(tampered), created["intent_id"].clone()],
        )
        .unwrap();
    let error = host
        .execute(
            "safety.approve",
            &json!({
                "intent_id":created["intent_id"],"code":code,
                "actor":"agent:template","resource":destination,
            }),
        )
        .unwrap_err();
    assert_eq!(error.name, "ApprovalRejectedError");
    assert!(error.message.contains("binding"));
}

#[test]
fn frozen_v2_envelope_encoded_json_and_persistence_bounds_match_typescript() {
    let directory = tempfile::tempdir().unwrap();
    let host =
        NativeHost::open_development(&directory.path().join("v2-bounds.db"), &[0x93; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();

    for arguments in [
        json!({"x":"a".repeat(65_528)}),
        json!({"x":format!("{}{}", "a".repeat(65_522), wire_from_utf16_units(&[0xd800]))}),
        json!({"x":format!("{}{}", "a".repeat(65_524), wire_from_utf16_units(&[0xdb80, 0xdc00]))}),
    ] {
        let before = row_counts(&host);
        propose_envelope(&host, template_envelope(arguments)).unwrap();
        let after = row_counts(&host);
        assert_eq!(
            after["intents"].as_u64(),
            before["intents"].as_u64().map(|n| n + 1)
        );
        assert_eq!(
            after["approvals"].as_u64(),
            before["approvals"].as_u64().map(|n| n + 1)
        );
    }

    assert_rejected_without_write(&host, json!({"x":"a".repeat(65_529)}), "encoded JSON byte");
    assert_rejected_without_write(
        &host,
        json!({"x":format!("{}{}", "a".repeat(65_523), wire_from_utf16_units(&[0xd800]))}),
        "encoded JSON byte",
    );
    assert_rejected_without_write(
        &host,
        json!({"x":format!("{}{}", "a".repeat(65_525), wire_from_utf16_units(&[0xdb80, 0xdc00]))}),
        "encoded JSON byte",
    );

    let prototype_arguments = Value::Object(Map::from_iter([
        ("__proto__".into(), json!({"polluted":true})),
        ("constructor".into(), json!({"safe":1})),
        ("prototype".into(), json!({"safe":2})),
    ]));
    let created = propose_envelope(&host, template_envelope(prototype_arguments.clone())).unwrap();
    let stored = stored_payload(&host, "intents", &created["intent_id"]);
    assert_eq!(
        stored["envelope"]["content"]["arguments"],
        prototype_arguments
    );
}

#[test]
fn frozen_v2_bounds_preserve_v1_golden_hash_binding_idempotency_and_quota_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let mut host =
        NativeHost::open_development(&directory.path().join("v1-golden.db"), &[0x94; 32]).unwrap();
    host.set_hooks(NativeHooks {
        approval_code: Some(Box::new(|| "654321".into())),
        allow_send: Some(Box::new(|_| true)),
    });
    host.set_clock(|| 841_234);
    host.execute("store.migrate", &Value::Null).unwrap();

    let mut body_units = "Deploy 😀 ".encode_utf16().collect::<Vec<_>>();
    body_units.push(0xd800);
    body_units.extend(" \u{e000}".encode_utf16());
    let body = wire_from_utf16_units(&body_units);
    let scope = json!({"platform":"slack","account":"work","chat_id":"C0123"});
    let proposal = json!({
        "actor":"agent:fixture","scope":scope,"body":body,
        "parent_id":"1700000000.000001"
    });
    let created = host
        .execute(
            "safety.propose",
            &json!({"proposal":proposal,"approval_ttl_ms":60_000.75}),
        )
        .unwrap();
    let intent_id = created["intent_id"].clone();
    let intent = stored_payload(&host, "intents", &intent_id);
    assert_eq!(
        intent["payload_hash"],
        "0a27697c7e6330232ca1f4862992c90bd28e49e0bba796149f032a8b22daba64"
    );

    let approval = stored_payload(&host, "approvals", &intent_id);
    let expected_bound_hash = host
        .call(
            "host.canonicalSha256",
            json!({
                "intent_id":intent_id,"actor":"agent:fixture","scope":scope,
                "payload_hash":intent["payload_hash"],"expires_at":created["expires_at"],
            }),
        )
        .unwrap();
    assert_eq!(approval["bound_hash"], expected_bound_hash);

    let code = host
        .execute("safety.claimApprovalCode", &json!({"intent_id":intent_id}))
        .unwrap()["code"]
        .clone();
    host.execute(
        "safety.approve",
        &json!({
            "intent_id":intent_id,"code":code,"actor":"agent:fixture","scope":scope,
        }),
    )
    .unwrap();
    let claim = host
        .execute(
            "safety.claim",
            &json!({
                "intent_id":intent_id,"transport_present":true,"send_capable":true,
                "quota_limit":1,"global_quota_limit":1,
            }),
        )
        .unwrap();
    let expected_idempotency = host
        .call(
            "host.canonicalSha256",
            json!({
                "intent_id":intent_id,"scope":scope,
                "payload_hash":intent["payload_hash"],"expires_at":created["expires_at"],
            }),
        )
        .unwrap();
    assert_eq!(claim["request"]["idempotency_key"], expected_idempotency);
    assert_eq!(
        host.call("host.canonicalJson", scope.clone()).unwrap(),
        "{\"account\":\"work\",\"chat_id\":\"C0123\",\"platform\":\"slack\"}"
    );
    assert!(
        SqlHost::new(&host)
            .all("SELECT scope FROM quota", &[])
            .unwrap()
            .contains(&json!({
                "scope":"{\"account\":\"work\",\"chat_id\":\"C0123\",\"platform\":\"slack\"}"
            }))
    );
}
