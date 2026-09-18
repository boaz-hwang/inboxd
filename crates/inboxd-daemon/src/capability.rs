use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{OwnedRwLockReadGuard, RwLock as AsyncRwLock};

#[cfg(feature = "test-worker")]
use crate::TestWorkerConfig;
use crate::{DaemonError, Result, WorkerSupervisor};

#[derive(Clone, Debug)]
pub struct TrustedBinding {
    id: String,
    claims: Value,
    worker: Option<WorkerSupervisor>,
}

impl TrustedBinding {
    pub fn new_static(id: impl Into<String>, claims: Value) -> Result<Self> {
        Self::build(id.into(), claims, None)
    }

    #[cfg(feature = "test-worker")]
    pub fn for_test(
        id: impl Into<String>,
        claims: Value,
        worker: TestWorkerConfig,
    ) -> Result<Self> {
        let id = id.into();
        let worker = WorkerSupervisor::for_test(id.clone(), worker)
            .map_err(|error| DaemonError::new(error.to_string()))?;
        Self::build(id, claims, Some(worker))
    }

    fn build(id: String, claims: Value, worker: Option<WorkerSupervisor>) -> Result<Self> {
        if id.is_empty() || id.len() > 512 {
            return Err(DaemonError::new(
                "binding id must contain from 1 to 512 characters",
            ));
        }
        Ok(Self {
            id,
            claims: validate_static_claims(&claims)?,
            worker,
        })
    }
}

#[derive(Clone)]
struct BindingEntry {
    generation: u64,
    claims: Value,
    auth: Value,
    worker: Option<WorkerSupervisor>,
    resource_key: String,
    dispatch_gate: Arc<AsyncRwLock<()>>,
}

pub(crate) struct CapabilityRegistry {
    entries: RwLock<BTreeMap<String, BindingEntry>>,
    #[cfg(feature = "test-worker")]
    post_claim_revocation: Mutex<Option<String>>,
}

#[derive(Clone)]
pub(crate) struct BindingAccess {
    pub id: String,
    generation: u64,
    pub claims: Value,
    pub worker: Option<WorkerSupervisor>,
    dispatch_gate: Arc<AsyncRwLock<()>>,
}

pub(crate) struct DispatchLease {
    pub binding: BindingAccess,
    _guard: OwnedRwLockReadGuard<()>,
}

impl BindingAccess {
    pub(crate) fn allows_send(&self, intent: &Value) -> bool {
        self.worker.is_some()
            && self.claims["write"]["mode"] == "send"
            && (self.claims["write"]["reply"] == true || !intent_requests_reply(intent))
    }
}

impl CapabilityRegistry {
    pub(crate) fn new(bindings: Vec<TrustedBinding>) -> Result<Self> {
        let observed_at = epoch_seconds();
        let mut entries = BTreeMap::new();
        let mut resources = BTreeSet::new();
        for binding in bindings {
            if entries.contains_key(&binding.id) {
                return Err(DaemonError::new(
                    "capability bindings contain a duplicate id",
                ));
            }
            let resource_key = resource_key(&binding.claims["resource"])?;
            if !resources.insert(resource_key.clone()) {
                return Err(DaemonError::new(
                    "capability bindings contain a duplicate exact resource",
                ));
            }
            entries.insert(
                binding.id,
                BindingEntry {
                    generation: u64::try_from(entries.len() + 1)
                        .map_err(|_| DaemonError::new("too many capability bindings"))?,
                    claims: binding.claims,
                    auth: json!({
                        "state":"unknown",
                        "reason":"unobserved",
                        "observed_at":observed_at,
                    }),
                    worker: binding.worker,
                    resource_key,
                    dispatch_gate: Arc::new(AsyncRwLock::new(())),
                },
            );
        }
        Ok(Self {
            entries: RwLock::new(entries),
            #[cfg(feature = "test-worker")]
            post_claim_revocation: Mutex::new(None),
        })
    }

    pub(crate) fn list(&self) -> Value {
        let entries = self.entries.read().unwrap();
        let resources = entries
            .values()
            .map(|entry| capability_value(&entry.claims, &entry.auth))
            .collect::<Vec<_>>();
        json!({"v":1,"resources":resources})
    }

    pub(crate) async fn refresh(&self) -> Vec<String> {
        let workers = self
            .entries
            .read()
            .unwrap()
            .iter()
            .map(|(id, entry)| (id.clone(), entry.worker.clone()))
            .collect::<Vec<_>>();
        let mut changed = Vec::new();
        for (id, worker) in workers {
            let auth = match worker {
                Some(worker) => match worker.health(&id).await {
                    Ok(result) => result
                        .get("auth")
                        .cloned()
                        .unwrap_or_else(|| unknown_auth("malformed_response")),
                    Err(error) => unknown_auth(error.reason()),
                },
                None => unknown_auth("worker_unavailable"),
            };
            let mut entries = self.entries.write().unwrap();
            if let Some(entry) = entries.get_mut(&id) {
                if entry.auth != auth {
                    entry.auth = auth;
                    changed.push(id);
                }
            }
        }
        changed
    }

    pub(crate) async fn revoke(&self, id: &str) -> bool {
        let Some((generation, gate)) = self
            .entries
            .read()
            .unwrap()
            .get(id)
            .map(|entry| (entry.generation, Arc::clone(&entry.dispatch_gate)))
        else {
            return false;
        };
        let _dispatch_exclusion = gate.write_owned().await;
        let mut entries = self.entries.write().unwrap();
        if entries
            .get(id)
            .is_some_and(|entry| entry.generation == generation)
        {
            entries.remove(id);
            true
        } else {
            false
        }
    }

    #[cfg(feature = "test-worker")]
    pub(crate) fn revoke_after_next_claim(&self, id: impl Into<String>) {
        *self.post_claim_revocation.lock().unwrap() = Some(id.into());
    }

    #[cfg(feature = "test-worker")]
    pub(crate) async fn run_post_claim_test_hook(&self) {
        let id = self.post_claim_revocation.lock().unwrap().take();
        if let Some(id) = id {
            self.revoke(&id).await;
        }
    }

    #[cfg(not(feature = "test-worker"))]
    pub(crate) async fn run_post_claim_test_hook(&self) {}

    pub(crate) fn has_workers(&self) -> bool {
        self.entries
            .read()
            .unwrap()
            .values()
            .any(|entry| entry.worker.is_some())
    }

    pub(crate) fn exact_for_intent(&self, intent: &Value) -> Option<BindingAccess> {
        self.exact(&intent_resource(intent)?)
    }

    pub(crate) async fn acquire_dispatch_lease(
        &self,
        intent: &Value,
        expected: &BindingAccess,
    ) -> Option<DispatchLease> {
        let guard = Arc::clone(&expected.dispatch_gate).read_owned().await;
        let binding = self.exact_for_intent(intent).filter(|current| {
            current.id == expected.id && current.generation == expected.generation
        })?;
        Some(DispatchLease {
            binding,
            _guard: guard,
        })
    }

    pub(crate) fn allows_send(&self, intent: &Value) -> bool {
        self.exact_for_intent(intent)
            .is_some_and(|binding| binding.allows_send(intent))
    }

    pub(crate) fn exact(&self, resource: &Value) -> Option<BindingAccess> {
        let key = resource_key(resource).ok()?;
        self.entries
            .read()
            .unwrap()
            .iter()
            .find(|(_, entry)| entry.resource_key == key)
            .map(|(id, entry)| BindingAccess {
                id: id.clone(),
                generation: entry.generation,
                claims: entry.claims.clone(),
                worker: entry.worker.clone(),
                dispatch_gate: Arc::clone(&entry.dispatch_gate),
            })
    }
}

fn intent_requests_reply(intent: &Value) -> bool {
    intent.get("parent_id").is_some() || intent.pointer("/envelope/reply").is_some()
}

fn intent_resource(intent: &Value) -> Option<Value> {
    if let Some(destination) = intent.pointer("/envelope/destination") {
        return Some(destination.clone());
    }
    let scope = intent.get("scope")?;
    Some(json!({
        "v":1,
        "kind":"chat",
        "platform":scope.get("platform")?,
        "account":scope.get("account")?,
        "chat_id":scope.get("chat_id")?,
    }))
}

fn unknown_auth(reason: &str) -> Value {
    json!({
        "state":"unknown",
        "reason":reason,
        "observed_at":epoch_seconds(),
    })
}

fn epoch_seconds() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn capability_value(claims: &Value, auth: &Value) -> Value {
    json!({
        "v":1,
        "resource":claims["resource"],
        "read":claims["read"],
        "write":claims["write"],
        "receipt":claims["receipt"],
        "auth":auth,
    })
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| DaemonError::new(format!("{label} must be an object")))
}

fn exact_keys(value: &Map<String, Value>, allowed: &[&str], label: &str) -> Result<()> {
    if value.len() != allowed.len() || value.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(DaemonError::new(format!(
            "{label} must contain exactly the trusted fields"
        )));
    }
    Ok(())
}

fn non_empty<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DaemonError::new(format!("{label} must be a non-empty string")))
}

fn positive(value: Option<&Value>, maximum: u64, label: &str) -> Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= maximum)
        .ok_or_else(|| DaemonError::new(format!("{label} must be a positive integer")))
}

fn validate_resource(value: &Value) -> Result<Value> {
    let resource = object(value, "resource")?;
    if resource.get("v") != Some(&json!(1)) {
        return Err(DaemonError::new("resource version must be 1"));
    }
    let kind = non_empty(resource.get("kind"), "resource kind")?;
    let platform = non_empty(resource.get("platform"), "resource platform")?;
    let account = non_empty(resource.get("account"), "resource account")?;
    match kind {
        "chat" => {
            exact_keys(
                resource,
                &["v", "kind", "platform", "account", "chat_id"],
                "chat resource",
            )?;
            Ok(json!({
                "v":1,"kind":"chat","platform":platform,"account":account,
                "chat_id":non_empty(resource.get("chat_id"), "resource chat_id")?,
            }))
        }
        "destination" => {
            exact_keys(
                resource,
                &["v", "kind", "platform", "account", "destination_id"],
                "destination resource",
            )?;
            Ok(json!({
                "v":1,"kind":"destination","platform":platform,"account":account,
                "destination_id":non_empty(resource.get("destination_id"), "resource destination_id")?,
            }))
        }
        _ => Err(DaemonError::new(
            "resource kind must be chat or destination",
        )),
    }
}

fn validate_read(value: &Value) -> Result<Value> {
    let read = object(value, "read capability")?;
    exact_keys(read, &["mode", "limits"], "read capability")?;
    let mode = non_empty(read.get("mode"), "read mode")?;
    if mode == "none" {
        if read.get("limits") != Some(&Value::Null) {
            return Err(DaemonError::new(
                "read limits must be null when read mode is none",
            ));
        }
        return Ok(json!({"mode":"none","limits":null}));
    }
    if !matches!(mode, "bounded_history" | "measured_local") {
        return Err(DaemonError::new("read mode is invalid"));
    }
    let limits = object(&read["limits"], "read limits")?;
    exact_keys(
        limits,
        &["max_page_size", "max_pages", "cursor"],
        "read limits",
    )?;
    let max_page_size = positive(limits.get("max_page_size"), 10_000, "max_page_size")?;
    let max_pages = positive(limits.get("max_pages"), 100, "max_pages")?;
    let cursor = non_empty(limits.get("cursor"), "cursor mode")?;
    if !matches!(cursor, "none" | "opaque") {
        return Err(DaemonError::new("read cursor mode is invalid"));
    }
    if mode == "measured_local" && (max_pages != 1 || cursor != "none") {
        return Err(DaemonError::new(
            "measured local reads are one page without a cursor",
        ));
    }
    Ok(json!({
        "mode":mode,
        "limits":{"max_page_size":max_page_size,"max_pages":max_pages,"cursor":cursor},
    }))
}

fn validate_write(value: &Value) -> Result<Value> {
    let write = object(value, "write capability")?;
    exact_keys(
        write,
        &["mode", "content_mode", "reply"],
        "write capability",
    )?;
    let mode = non_empty(write.get("mode"), "write mode")?;
    let content = non_empty(write.get("content_mode"), "content mode")?;
    let reply = write
        .get("reply")
        .and_then(Value::as_bool)
        .ok_or_else(|| DaemonError::new("write reply support must be boolean"))?;
    if !matches!(mode, "none" | "send") || !matches!(content, "none" | "text" | "approved_template")
    {
        return Err(DaemonError::new("write capability is invalid"));
    }
    if (mode == "none" && (content != "none" || reply))
        || (mode == "send" && content == "none")
        || (content == "approved_template" && reply)
    {
        return Err(DaemonError::new("write capability is inconsistent"));
    }
    Ok(json!({"mode":mode,"content_mode":content,"reply":reply}))
}

fn validate_receipt(value: &Value) -> Result<Value> {
    let receipt = object(value, "receipt capability")?;
    exact_keys(receipt, &["level"], "receipt capability")?;
    let level = non_empty(receipt.get("level"), "receipt level")?;
    if !matches!(level, "none" | "ack_only" | "independent_readback") {
        return Err(DaemonError::new("receipt level is invalid"));
    }
    Ok(json!({"level":level}))
}

fn validate_static_claims(value: &Value) -> Result<Value> {
    let claims = object(value, "trusted binding")?;
    exact_keys(
        claims,
        &["v", "resource", "read", "write", "receipt"],
        "trusted binding",
    )?;
    if claims.get("v") != Some(&json!(1)) {
        return Err(DaemonError::new("trusted binding version must be 1"));
    }
    let resource = validate_resource(&claims["resource"])?;
    let read = validate_read(&claims["read"])?;
    let write = validate_write(&claims["write"])?;
    let receipt = validate_receipt(&claims["receipt"])?;
    let kind = resource["kind"].as_str().unwrap_or_default();
    let read_mode = read["mode"].as_str().unwrap_or_default();
    let write_mode = write["mode"].as_str().unwrap_or_default();
    let content_mode = write["content_mode"].as_str().unwrap_or_default();
    let receipt_level = receipt["level"].as_str().unwrap_or_default();
    if (kind == "destination" && read_mode != "none")
        || (read_mode == "measured_local" && write_mode != "none")
        || (write_mode == "send" && kind == "chat" && content_mode != "text")
        || (write_mode == "send" && kind == "destination" && content_mode != "approved_template")
        || (write_mode == "none" && receipt_level != "none")
        || (receipt_level == "independent_readback" && (kind != "chat" || read_mode == "none"))
    {
        return Err(DaemonError::new(
            "trusted resource capabilities are inconsistent",
        ));
    }
    Ok(json!({
        "v":1,"resource":resource,"read":read,"write":write,"receipt":receipt,
    }))
}

fn resource_key(resource: &Value) -> Result<String> {
    let resource = validate_resource(resource)?;
    serde_json::to_string(&resource)
        .map_err(|_| DaemonError::new("resource could not be serialized"))
}
