//! Bounded, in-memory work evidence. Cancellation never implies storage rollback.
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0., |t| t.as_secs_f64())
}
#[derive(Clone, Default)]
pub(crate) struct WorkStatus(Arc<Mutex<VecDeque<Value>>>);
pub(crate) struct WorkGuard {
    status: WorkStatus,
    id: String,
    completed: bool,
}
impl WorkStatus {
    pub(crate) fn start(&self, operation: &str, scope: Value) -> Result<WorkGuard, String> {
        // Diagnostics are a bounded summary, never another copy of caller JSON.
        let scope: serde_json::Map<String, Value> = ["platform", "account", "chat_id"]
            .into_iter()
            .filter_map(|key| {
                scope[key].as_str().map(|value| {
                    let end = value
                        .char_indices()
                        .take_while(|(i, c)| i + c.len_utf8() <= 128)
                        .last()
                        .map_or(0, |(i, c)| i + c.len_utf8());
                    (key.into(), json!(&value[..end]))
                })
            })
            .collect();
        let id = uuid::Uuid::new_v4().to_string();
        let mut jobs = self.0.lock().unwrap();
        while jobs.len() >= 64 {
            let Some(index) = jobs.iter().position(|j| j["state"] != "running") else {
                return Err("too many active read jobs".into());
            };
            jobs.remove(index);
        }
        jobs.push_back(json!({"id":id,"operation":operation,"scope":scope,"state":"running","started_at":now()}));
        Ok(WorkGuard {
            status: self.clone(),
            id,
            completed: false,
        })
    }
    pub(crate) fn snapshot(&self) -> Value {
        let jobs = self.0.lock().unwrap();
        let active = jobs.iter().filter(|j| j["state"] == "running").count();
        let latest = jobs
            .iter()
            .filter(|j| j["finished_at"].is_number())
            .max_by(|a, b| {
                a["finished_at"]
                    .as_f64()
                    .unwrap()
                    .total_cmp(&b["finished_at"].as_f64().unwrap())
            });
        json!({"state":if active>0 {"running"} else if latest.is_some_and(|j|j["state"]!="succeeded") {"failed"} else {"idle"},"active":active,"jobs":*jobs,"last_successful_work_at":jobs.iter().filter(|j|j["state"]=="succeeded").filter_map(|j|j["finished_at"].as_f64()).max_by(f64::total_cmp)})
    }
}
impl WorkGuard {
    fn complete(&mut self, state: &str) {
        if let Some(job) = self
            .status
            .0
            .lock()
            .unwrap()
            .iter_mut()
            .find(|j| j["id"] == self.id)
        {
            job["state"] = json!(state);
            job["finished_at"] = json!(now());
        }
        self.completed = true;
    }
    pub(crate) fn finish(mut self, success: bool) {
        self.complete(if success { "succeeded" } else { "failed" });
    }
}
impl Drop for WorkGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.complete("interrupted");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_tracks_completion_failure_and_cancellation_without_leaking_query_text() {
        let status = WorkStatus::default();
        assert_eq!(status.snapshot()["state"], "idle");
        let job = status
            .start(
                "account.messages",
                json!({"platform":"slack","account":"a"}),
            )
            .unwrap();
        assert_eq!(status.snapshot()["active"], 1);
        job.finish(true);
        assert_eq!(status.snapshot()["state"], "idle");
        drop(status.start("sync.backfill", Value::Null).unwrap());
        assert_eq!(status.snapshot()["state"], "failed");
        for _ in 0..100 {
            status.start("read", Value::Null).unwrap().finish(true);
        }
        assert_eq!(status.snapshot()["jobs"].as_array().unwrap().len(), 64);
        let active = (0..64).map(|_|status.start("read",json!({"platform":"slack","account":"a","chat_id":"가".repeat(2000),"query":"private query"})).unwrap()).collect::<Vec<_>>();
        assert!(status.start("read", Value::Null).is_err());
        let encoded = serde_json::to_string(&status.snapshot()).unwrap();
        assert!(encoded.len() < 58000);
        assert!(!encoded.contains("private query"));
        drop(active);
        assert_eq!(status.snapshot()["active"], 0);
    }
}
