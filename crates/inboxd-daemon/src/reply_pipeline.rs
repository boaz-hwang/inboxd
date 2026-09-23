//! Local decision graph. The model proposes; this executor owns read scope and budgets.
use crate::reply::Worker;
use inboxd_storage::{StorageActor, StorageOperation};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn step(
    node: &str,
    parent: &Option<String>,
    decision: Value,
    action: Value,
    outcome: Value,
    ms: u128,
) -> Value {
    json!({"step_id":Uuid::new_v4().to_string(),"parent_step_id":parent,"node_type":node,
        "decision":decision,"action":action,"outcome":outcome,"status":"completed","duration_ms":ms})
}

fn graph_failure(
    request: &Value,
    steps: &mut Vec<Value>,
    parent: &Option<String>,
    node: &str,
    code: &str,
) -> Value {
    let mut failure = step(
        node,
        parent,
        Value::Null,
        json!({"kind":node}),
        json!({"error":code}),
        0,
    );
    failure["status"] = json!("failed");
    failure["input_refs"] = request["incoming_message_ids"].clone();
    steps.push(failure);
    json!({"id":request["id"],"status":"failed","text":null,"error":code,"prompt_version":request["prompt_version"]})
}

pub(crate) async fn run(
    worker: &mut Worker,
    actor: &StorageActor,
    mut request: Value,
) -> Result<Value, String> {
    let source = json!({"id":"current_chat_history","kind":"chat","context_scope":"thread",
        "scope":request["chat"],"permissions":["query"],"availability":"available","freshness":"stored_snapshot",
        "query_templates":{"previous_agreement":"조건","availability":"일정","project_state":"진행"}});
    request["source_registry"] = json!([source]);
    let mut evidence = Vec::<Value>::new();
    let mut steps = Vec::<Value>::new();
    let mut parent = None;
    let mut rounds = 0;
    let mut calls = 0;
    let mut reasoning = Vec::<String>::new();
    let mut seen_queries = Vec::<Value>::new();
    let mut seen_fingerprints = HashSet::<String>::new();
    let mut final_plan = json!({"action":"defer","reasonCode":"execution_budget_exhausted"});
    let mut final_decision = Value::Null;
    let mut final_state = Value::Null;
    let mut result = Value::Null;
    // Initial + two retrieval rounds, each with at most one local reasoning pass.
    'graph: for _ in 0..6 {
        request["evidence"] = json!(evidence);
        request["execution_budget"] = json!({"max_retrieval_rounds":2,"max_query_calls":3,
            "retrieval_rounds_used":rounds,"query_calls_used":calls,
            "reasoning_state_ids":reasoning,"seen_queries":seen_queries});
        request["op"] = json!("decide");
        let started = Instant::now();
        let decision = match worker.generate(&request).await {
            Ok(value) => value,
            Err(_) => {
                json!({"id":request["id"],"status":"failed","error":"local_worker_transport_failed","reset_worker":true})
            }
        };
        let plan = decision["plan"].clone();
        let node = if request["reasoning"] == true {
            "reason"
        } else {
            "route"
        };
        let mut observed = step(
            node,
            &parent,
            decision["decision"].clone(),
            plan.clone(),
            json!({"state_id":decision["state_id"]}),
            started.elapsed().as_millis(),
        );
        observed["state"] = decision["state"].clone();
        observed["model_input"] = decision["model_input"].clone();
        observed["input_refs"] = request["incoming_message_ids"].clone();
        parent = observed["step_id"].as_str().map(str::to_owned);
        if decision["status"] != "decided" {
            observed["status"] = json!("failed");
            observed["outcome"] =
                json!({"error":decision["error"],"raw_proposal":decision["raw_proposal"]});
            final_state = decision["state"].clone();
            steps.push(observed);
            result = decision;
            break;
        }
        steps.push(observed);
        final_plan = plan.clone();
        final_decision = decision["decision"].clone();
        final_state = decision["state"].clone();
        match plan["action"].as_str().unwrap_or("defer") {
            "reason" => {
                let Some(id) = decision["state_id"].as_str().map(str::to_owned) else {
                    result = graph_failure(
                        &request,
                        &mut steps,
                        &parent,
                        "reason",
                        "missing_decision_state_id",
                    );
                    break;
                };
                if reasoning.contains(&id) {
                    final_plan = json!({"action":"defer","reasonCode":"repeated_reasoning"});
                    break;
                }
                reasoning.push(id);
                request["reasoning"] = json!(true);
            }
            "retrieve" => {
                request["reasoning"] = json!(false);
                if rounds >= 2 || calls >= 3 {
                    final_plan =
                        json!({"action":"defer","reasonCode":"retrieval_budget_exhausted"});
                    break;
                }
                let Some(queries) = plan["queries"].as_array() else {
                    result = graph_failure(
                        &request,
                        &mut steps,
                        &parent,
                        "retrieve",
                        "missing_bounded_retrieval_query",
                    );
                    break;
                };
                if queries.is_empty() {
                    final_plan = json!({"action":"defer","reasonCode":"no_permitted_query"});
                    break;
                }
                rounds += 1;
                let mut queried = false;
                for query in queries.iter().take(3 - calls) {
                    // No model output can widen this source to other accounts or rooms.
                    if query["sourceId"] != "current_chat_history"
                        || query["scope"] != request["chat"]
                    {
                        result = graph_failure(
                            &request,
                            &mut steps,
                            &parent,
                            "retrieve",
                            "retrieval_scope_denied",
                        );
                        break 'graph;
                    }
                    let Some(text) = query["query"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty() && s.len() <= 1000)
                    else {
                        result = graph_failure(
                            &request,
                            &mut steps,
                            &parent,
                            "retrieve",
                            "invalid_retrieval_query",
                        );
                        break 'graph;
                    };
                    let signature = digest(query);
                    if !seen_fingerprints.insert(signature) {
                        continue;
                    }
                    queried = true;
                    calls += 1;
                    seen_queries.push(json!({"source_id":"current_chat_history","query":text,"scope":request["chat"]}));
                    let started = Instant::now();
                    let scope = &request["chat"];
                    let found=actor.call_async(StorageOperation::SearchAccountMessages,json!({"platform":scope["platform"],"account":scope["account"],"chat_id":scope["chat_id"],"query":text,"limit":6,"interval":{"from_ts":0,"to_ts":now()+1.0}})).await;
                    let mut ids = Vec::new();
                    let status = match found {
                        Ok(found) => {
                            for message in found["messages"].as_array().into_iter().flatten() {
                                if request["context"].as_array().is_some_and(|rows| {
                                    rows.iter()
                                        .any(|row| row["message_id"] == message["msg_id"])
                                }) {
                                    continue;
                                }
                                let key = json!({"platform":scope["platform"],"account":scope["account"],"chat_id":scope["chat_id"],"msg_id":message["msg_id"]});
                                let version = digest(&json!([
                                    message["body"],
                                    message["edited_at"],
                                    message["author_id"]
                                ]));
                                let id = digest(&json!([key, version]));
                                if evidence.iter().any(|e| e["id"] == id) {
                                    continue;
                                }
                                let excerpt = message["body"]
                                    .as_str()
                                    .unwrap_or("")
                                    .chars()
                                    .take(2000)
                                    .collect::<String>();
                                if evidence
                                    .iter()
                                    .filter_map(|e| e["excerpt"].as_str())
                                    .map(str::len)
                                    .sum::<usize>()
                                    + excerpt.len()
                                    > 16_000
                                {
                                    break;
                                }
                                evidence.push(json!({"id":id,"source_id":"current_chat_history","key":key,"version":version,"excerpt":excerpt,"ts":message["ts"],"observed_at":now(),"author_id":message["author_id"]}));
                                ids.push(id);
                            }
                            "available"
                        }
                        Err(_) => "unavailable",
                    };
                    let observed = step(
                        "retrieve",
                        &parent,
                        Value::Null,
                        query.clone(),
                        json!({"status":status,"evidence_ids":ids}),
                        started.elapsed().as_millis(),
                    );
                    parent = observed["step_id"].as_str().map(str::to_owned);
                    steps.push(observed);
                }
                if !queried {
                    final_plan = json!({"action":"defer","reasonCode":"repeated_query"});
                    break;
                }
            }
            "reply" | "clarify" => {
                request["op"] = json!("generate");
                request["plan"] = plan;
                request["evidence"] = json!(evidence);
                result = match worker.generate(&request).await {
                    Ok(value) => value,
                    Err(_) => {
                        let mut failure = graph_failure(
                            &request,
                            &mut steps,
                            &parent,
                            "generate",
                            "local_worker_transport_failed",
                        );
                        failure["reset_worker"] = json!(true);
                        failure
                    }
                };
                if result["status"] == "failed"
                    && result["steps"].is_null()
                    && result["reset_worker"] != true
                {
                    let _ = graph_failure(
                        &request,
                        &mut steps,
                        &parent,
                        "generate",
                        result["error"]
                            .as_str()
                            .unwrap_or("local_generation_failed"),
                    );
                }
                if let Some(generated) = result["steps"].as_array() {
                    for node in generated {
                        let mut node = node.clone();
                        if node["parent_step_id"].is_null() {
                            node["parent_step_id"] = json!(parent);
                        }
                        parent = node["step_id"].as_str().map(str::to_owned);
                        steps.push(node);
                    }
                }
                break;
            }
            "no_reply" | "defer" => break,
            _ => {
                result = graph_failure(
                    &request,
                    &mut steps,
                    &parent,
                    "route",
                    "unsupported_policy_action",
                );
                break;
            }
        }
    }
    if result.is_null() {
        // A policy decision not to answer is not a decision to omit the user's
        // requested draft. Generate a contextual clarification, still checked
        // for grounding by the same worker as ordinary replies.
        request["op"] = json!("generate");
        final_plan = json!({"action":if final_plan["action"] == "no_reply" {"reply"} else {"clarify"},"reasonCode":final_plan["reasonCode"]});
        request["plan"] = final_plan.clone();
        request["evidence"] = json!(evidence);
        result = worker.generate(&request).await?;
        if let Some(generated) = result["steps"].as_array() {
            for node in generated {
                let mut node = node.clone();
                if node["parent_step_id"].is_null() {
                    node["parent_step_id"] = json!(parent);
                }
                parent = node["step_id"].as_str().map(str::to_owned);
                steps.push(node);
            }
        }
    }
    result["steps"] = json!(steps);
    result["evidence"] = json!(evidence);
    result["route_plan"] = final_plan;
    result["decision"] = final_decision;
    result["state"] = final_state;
    result["retrieval_cost"] = json!({"rounds":rounds,"query_calls":calls});
    result["versions"] =
        json!({"pipeline":"decision-graph-v1","source_scope":"current-chat-local-v1"});
    Ok(result)
}
