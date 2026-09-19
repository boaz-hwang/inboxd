//! One durable reservation for all authenticated direct sends. A reserved request
//! is never replayed, including after cancellation or restart.
use crate::{CapabilityRegistry, accounts::AccountService};
use inboxd_storage::{StorageActor, StorageOperation};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) async fn with_ledger<F>(
    actor: &StorageActor,
    mut identity: Value,
    dispatch: F,
) -> Result<Value, String>
where
    F: std::future::Future<Output = Result<Value, String>>,
{
    let reservation = actor
        .call_async(StorageOperation::OwnerSendReserve, identity.clone())
        .await
        .map_err(|e| e.message)?;
    if reservation["reserved"] != true {
        return Ok(reservation["outcome"].clone());
    }
    // Dispatch failures after reservation are conservative. Callers must not
    // infer that retrying with a new ID is safe from a transport failure.
    let mut outcome = dispatch
        .await
        .unwrap_or_else(|_| json!({"state":"Uncertain"}));
    if !matches!(
        outcome["state"].as_str(),
        Some("Sent" | "Verified" | "Failed" | "Uncertain")
    ) {
        outcome = json!({"state":"Uncertain"});
    }
    identity["outcome"] = outcome.clone();
    if actor
        .call_async(StorageOperation::OwnerSendComplete, identity)
        .await
        .is_err()
    {
        return Ok(json!({"state":"Uncertain"}));
    }
    Ok(outcome)
}

pub(crate) fn normalize(params: &Value) -> Result<(Value, Value), String> {
    let allowed: &[&str] = if params.get("envelope").is_some() {
        &["request_id", "envelope"]
    } else if params.get("file").is_some() {
        &["request_id", "chat", "file"]
    } else {
        &["request_id", "chat", "body", "parent_id"]
    };
    if params
        .as_object()
        .is_none_or(|p| p.keys().any(|key| !allowed.contains(&key.as_str())))
    {
        return Err("unknown message.send parameter".into());
    }
    if params.get("envelope").is_none()
        && params["chat"].as_object().is_none_or(|chat| {
            chat.len() != 3
                || chat
                    .keys()
                    .any(|key| !["platform", "account", "chat_id"].contains(&key.as_str()))
        })
    {
        return Err("chat must contain platform/account/chat_id".into());
    }
    let request_id = params["request_id"]
        .as_str()
        .filter(|id| (16..=80).contains(&id.len()))
        .ok_or("request_id must contain 16 to 80 bytes")?;
    let mut envelope = if let Some(envelope) = params.get("envelope") {
        if params.get("body").is_some()
            || params.get("chat").is_some()
            || params.get("parent_id").is_some()
        {
            return Err("supply either envelope or chat/body".into());
        }
        envelope.clone()
    } else {
        let chat = &params["chat"];
        let body = if let Some(file) = params.get("file") {
            inboxd_protocol::validate_local_attachment(file).map_err(|e| e.message)?;
            json!(format!("[파일] {}", file["name"].as_str().unwrap()))
        } else {
            params["body"].clone()
        };
        let mut envelope = json!({"v":2,"destination":{"v":1,"kind":"chat","platform":chat["platform"],"account":chat["account"],"chat_id":chat["chat_id"]},"content":{"mode":"text","body":body}});
        if let Some(parent) = params.get("parent_id") {
            envelope["reply"] = json!({"parent_id":parent});
        }
        envelope
    };
    inboxd_protocol::validate_send_envelope(&envelope).map_err(|e| e.message)?;
    if let Some(file) = params.get("file") {
        envelope["content"] = json!({"mode":"file","file":file});
    }
    let destination = &envelope["destination"];
    let content = &envelope["content"];
    let body = match content["mode"].as_str() {
        Some("text") => content["body"].clone(),
        Some("file") => json!(format!(
            "[파일] {}",
            content["file"]["name"].as_str().unwrap()
        )),
        _ => content["preview"].clone(),
    };
    let identity = json!({"request_id":request_id,"platform":destination["platform"],"account":destination["account"],"chat_id":destination.get("chat_id").or_else(|| destination.get("destination_id")).unwrap_or(&Value::Null),"body":body,"envelope":envelope});
    Ok((identity, envelope))
}

pub(crate) async fn execute(
    actor: &StorageActor,
    capabilities: &CapabilityRegistry,
    accounts: &AccountService,
    params: &Value,
    authorization: Value,
) -> Result<Value, String> {
    let (mut identity, envelope) = normalize(params)?;
    identity["authorization"] = authorization;
    // Look up before capability checks: a completed request remains inspectable
    // even if a provider account was subsequently removed.
    let previous = actor
        .call_async(StorageOperation::OwnerSendLookup, identity.clone())
        .await
        .map_err(|e| e.message)?;
    if !previous.is_null() {
        return Ok(previous);
    }
    if envelope["content"]["mode"] == "file" {
        // Account SDK uploads share the same authority and durable reservation.
        // A configured fixed binding still constrains this destination.
        let permission = json!({"envelope":{"v":2,"destination":envelope["destination"],"content":{"mode":"text","body":identity["body"]}}});
        let lease = if let Some(binding) = capabilities.exact_for_intent(&permission) {
            if !binding.allows_send(&permission) {
                return Err("destination does not permit file sends".into());
            }
            Some(
                capabilities
                    .acquire_dispatch_lease(&permission, &binding)
                    .await
                    .ok_or("binding revoked")?,
            )
        } else {
            if capabilities.was_configured(&envelope["destination"]) {
                return Err("fixed binding was revoked".into());
            }
            None
        };
        let result = dispatch_account(
            actor,
            accounts,
            identity,
            Some(envelope["content"]["file"].clone()),
        )
        .await;
        drop(lease);
        return result;
    }
    let request = json!({"envelope":envelope});
    if let Some(binding) = capabilities.exact_for_intent(&request) {
        if !binding.allows_send(&request) {
            return Err("bound destination does not permit this send".into());
        }
        return with_ledger(actor, identity.clone(), async {
            accounts.with_external_send(&envelope["destination"], async {
            capabilities.run_post_claim_test_hook().await;
            let Some(lease) = capabilities.acquire_dispatch_lease(&request, &binding).await else { return Ok(json!({"state":"Failed","reason":"binding_revoked"})); };
            let binding = &lease.binding;
            if !binding.allows_send(&request) { return Ok(json!({"state":"Failed","reason":"binding_disallows_send"})); }
            let worker = binding.worker.as_ref().ok_or("bound worker unavailable")?;
            let idempotency_key = format!("{:x}", Sha256::digest(format!("inboxd.direct-send.v1\0{}", identity["request_id"].as_str().unwrap()).as_bytes()));
            let sent = match worker.send(&binding.id, envelope.clone(), &idempotency_key).await {
                Ok(result) => result,
                Err(error) => return Ok(json!({"state":if error.may_have_sent(){"Uncertain"}else{"Failed"},"reason":error.reason()})),
            };
            match sent["outcome"].as_str() {
                Some("failed") => return Ok(json!({"state":"Failed","reason":sent["reason"]})),
                Some("sent") => {},
                _ => return Ok(json!({"state":"Uncertain","reason":sent["reason"]})),
            }
            let receipt = sent["receipt_id"].as_str().ok_or("missing receipt")?;
            let mut result = json!({"state":"Sent","receipt":receipt});
            let mut checkpoint = identity.clone();
            checkpoint["outcome"] = result.clone();
            if actor.call_async(StorageOperation::OwnerSendComplete, checkpoint).await.is_err() { return Ok(json!({"state":"Uncertain"})); }
            if binding.claims["receipt"]["level"] == "independent_readback" {
                if let Ok(readback) = worker.read_receipt(&binding.id, binding.claims["resource"].clone(), receipt, envelope.clone()).await {
                    if readback["outcome"] == "verified" { result["state"] = json!("Verified"); result["evidence"] = readback["evidence"].clone(); }
                }
            }
            Ok(result)
            }).await
        }).await;
    }
    if capabilities.was_configured(&envelope["destination"]) {
        return Err("fixed binding was revoked; account fallback is forbidden".into());
    }
    if envelope["content"]["mode"] != "text" || envelope.get("reply").is_some() {
        return Err("this reply/template requires a compatible fixed provider binding".into());
    }
    dispatch_account(actor, accounts, identity, None).await
}

async fn dispatch_account(
    actor: &StorageActor,
    accounts: &AccountService,
    identity: Value,
    file: Option<Value>,
) -> Result<Value, String> {
    let mut account_params = identity.clone();
    account_params.as_object_mut().unwrap().remove("envelope");
    if let Some(file) = file {
        account_params["file"] = file;
    }
    accounts.prepare_send(&account_params).await?;
    accounts.validate_send(&account_params).await?;
    with_ledger(
        actor,
        identity,
        accounts.dispatch_query("send", &account_params),
    )
    .await
}
