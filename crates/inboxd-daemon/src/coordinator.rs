use inboxd_storage::{StorageActor, StorageOperation};
use serde_json::{Map, Value, json};

use crate::CapabilityRegistry;

const DEFAULT_QUOTA_LIMIT: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
pub(crate) struct CoordinatorError {
    pub(crate) message: String,
}

impl CoordinatorError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

type Result<T> = std::result::Result<T, CoordinatorError>;

fn actor_call(actor: &StorageActor, operation: StorageOperation, input: Value) -> Result<Value> {
    actor
        .call(operation, input)
        .map_err(|error| CoordinatorError::new(error.message))
}

fn envelope_for(request: &Value, destination: &Value) -> Result<Value> {
    if let Some(envelope) = request.get("envelope") {
        return Ok(envelope.clone());
    }
    let body = request
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| CoordinatorError::new("claimed send request omitted its body"))?;
    let mut envelope = json!({
        "v":2,
        "destination":destination,
        "content":{"mode":"text","body":body},
    });
    if let Some(parent_id) = request.get("parent_id") {
        envelope["reply"] = json!({"parent_id":parent_id});
    }
    Ok(envelope)
}

fn final_payload(request: &Value, field: &str, value: Value) -> Value {
    let mut payload = Map::new();
    payload.insert(field.into(), value);
    if let Some(actor) = request.get("actor") {
        payload.insert("actor".into(), actor.clone());
    }
    if let Some(scope) = request.get("scope") {
        payload.insert("scope".into(), scope.clone());
    }
    if let Some(body) = request.get("body") {
        payload.insert("body".into(), body.clone());
    }
    if let Some(parent_id) = request.get("parent_id") {
        payload.insert("parent_id".into(), parent_id.clone());
    }
    Value::Object(payload)
}

fn finalize(actor: &StorageActor, intent_id: &str, state: &str, payload: Value) -> Result<Value> {
    actor_call(
        actor,
        StorageOperation::SafetyFinalize,
        json!({"intent_id":intent_id,"state":state,"transport_payload":payload}),
    )
}

fn receipt_evidence(request: &Value, evidence: Value) -> Value {
    if request.get("envelope").is_some() {
        return evidence;
    }
    let mut legacy = json!({
        "receipt":evidence["receipt_id"],
        "scope":request["scope"],
        "body":request["body"],
    });
    if let Some(parent_id) = request.get("parent_id") {
        legacy["parent_id"] = parent_id.clone();
    }
    legacy
}

pub(crate) async fn execute(
    actor: &StorageActor,
    capabilities: &CapabilityRegistry,
    intent_id: &str,
    approved: Value,
) -> Result<Value> {
    let binding = capabilities.exact_for_intent(&approved);
    let send_capable = binding.as_ref().is_some_and(|binding| {
        binding.worker.is_some() && binding.claims["write"]["mode"] == "send"
    });
    let claimed = actor_call(
        actor,
        StorageOperation::SafetyClaim,
        json!({
            "intent_id":intent_id,
            "transport_present":true,
            "send_capable":send_capable,
            "quota_limit":DEFAULT_QUOTA_LIMIT,
            "global_quota_limit":DEFAULT_QUOTA_LIMIT,
        }),
    )?;
    if let Some(summary) = claimed.get("summary") {
        return Ok(summary.clone());
    }
    let request = claimed
        .get("request")
        .ok_or_else(|| CoordinatorError::new("storage safety claim omitted its send request"))?;
    let binding = binding.ok_or_else(|| {
        CoordinatorError::new("storage claimed a send without an exact trusted binding")
    })?;
    let worker = binding
        .worker
        .as_ref()
        .ok_or_else(|| CoordinatorError::new("storage claimed a send without a fixed worker"))?;
    let idempotency_key = request
        .get("idempotency_key")
        .and_then(Value::as_str)
        .ok_or_else(|| CoordinatorError::new("storage safety claim omitted its idempotency key"))?;
    let envelope = envelope_for(request, &binding.claims["resource"])?;

    let sent = match worker
        .send(&binding.id, envelope.clone(), idempotency_key)
        .await
    {
        Ok(result) => match result.get("outcome").and_then(Value::as_str) {
            Some("sent") => {
                let receipt_id = result.get("receipt_id").cloned().ok_or_else(|| {
                    CoordinatorError::new("sent worker outcome omitted its receipt")
                })?;
                let field = if request.get("envelope").is_some() {
                    "receipt_id"
                } else {
                    "receipt"
                };
                finalize(
                    actor,
                    intent_id,
                    "Sent",
                    final_payload(request, field, receipt_id),
                )?
            }
            Some("failed") => {
                let reason = result
                    .get("reason")
                    .cloned()
                    .unwrap_or(json!("worker_failed"));
                return finalize(
                    actor,
                    intent_id,
                    "Failed",
                    final_payload(request, "reason", reason),
                );
            }
            Some("uncertain") => {
                let reason = result
                    .get("reason")
                    .cloned()
                    .unwrap_or(json!("worker_uncertain"));
                return finalize(
                    actor,
                    intent_id,
                    "Uncertain",
                    final_payload(request, "reason", reason),
                );
            }
            _ => {
                return finalize(
                    actor,
                    intent_id,
                    "Uncertain",
                    final_payload(request, "reason", json!("malformed_worker_outcome")),
                );
            }
        },
        Err(error) => {
            let state = if error.may_have_sent() {
                "Uncertain"
            } else {
                "Failed"
            };
            return finalize(
                actor,
                intent_id,
                state,
                final_payload(request, "reason", json!(error.reason())),
            );
        }
    };

    if binding.claims["receipt"]["level"] != "independent_readback" {
        return Ok(sent);
    }
    let Some(receipt_id) = sent.get("receipt").and_then(Value::as_str) else {
        return Ok(sent);
    };
    let readback = worker
        .read_receipt(
            &binding.id,
            binding.claims["resource"].clone(),
            receipt_id,
            envelope,
        )
        .await;
    let Ok(readback) = readback else {
        return Ok(sent);
    };
    if readback.get("outcome").and_then(Value::as_str) != Some("verified") {
        return Ok(sent);
    }
    let evidence = receipt_evidence(request, readback["evidence"].clone());
    actor_call(
        actor,
        StorageOperation::SafetyVerifyReceipt,
        json!({"intent_id":intent_id,"evidence":evidence}),
    )
}
