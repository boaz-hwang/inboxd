//! One generation request over a preflight-validated current-chat snapshot.
use crate::reply::Worker;
use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) async fn run(worker: &mut Worker, mut request: Value) -> Result<Value, String> {
    request["op"] = json!("generate");
    let result = worker.generate(&request).await.unwrap_or_else(|_| {
        json!({"id":request["id"],"status":"failed","text":null,
            "error":"local_worker_transport_failed","reset_worker":true,
            "prompt_version":request["prompt_version"]})
    });
    Ok(record_result(&request, result))
}

fn record_result(request: &Value, mut result: Value) -> Value {
    if result["status"] == "failed" && result["steps"].is_null() {
        result["steps"] = json!([{"step_id":Uuid::new_v4().to_string(),
            "node_type":"generate","status":"failed","duration_ms":0,
            "input_refs":request["incoming_message_ids"],
            "outcome":{"error":result["error"]}}]);
    }
    result["versions"] = json!({"pipeline":"single-generation-v2",
        "source_scope":"current-chat-snapshot-v1","preflight":"context-preflight-v1"});
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abstention_and_single_generation_are_preserved_without_fake_checks() {
        let steps = json!([{"node_type":"generate"}]);
        let result = record_result(
            &json!({}),
            json!({"status":"abstained",
            "error":"model_abstained","text":null,"steps":steps}),
        );
        assert_eq!(result["status"], "abstained");
        assert_eq!(result["steps"], steps);
        assert!(result["route_plan"].is_null());
        assert!(result["check_input"].is_null());
    }

    #[test]
    fn transport_failure_retains_diagnostic_and_reset() {
        let result = record_result(
            &json!({"incoming_message_ids":["m"]}),
            json!({"status":"failed","error":"local_worker_transport_failed","reset_worker":true}),
        );
        assert_eq!(
            result["steps"][0]["outcome"]["error"],
            "local_worker_transport_failed"
        );
        assert_eq!(result["reset_worker"], true);
    }
}
