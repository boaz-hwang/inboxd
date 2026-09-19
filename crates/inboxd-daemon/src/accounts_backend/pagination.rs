use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use uuid::Uuid;

const TTL: Duration = Duration::from_secs(120);
const CACHE_BYTES: usize = 16_000_000;
const PAGE_BYTES: usize = 58_000;

#[derive(Clone)]
enum Continuation {
    Buffered(Value),
    Upstream(String),
}
struct Page {
    id: String,
    scope: Value,
    at: Instant,
    bytes: usize,
    continuation: Continuation,
    seen: Vec<String>,
}
#[derive(Default)]
pub(crate) struct MessagePages {
    entries: VecDeque<Page>,
    seen: Vec<String>,
}

fn scope(request: &Value) -> Value {
    json!([request["op"], request["chat_id"], request["query"]])
}
impl MessagePages {
    /// Extract the per-request cycle chain before releasing the account lock.
    pub(crate) fn begin(
        &mut self,
        request: &mut Value,
    ) -> Result<(Option<Value>, Vec<String>), String> {
        let buffered = self.resolve(request)?;
        Ok((buffered, std::mem::take(&mut self.seen)))
    }

    pub(crate) fn finish(
        &mut self,
        result: Value,
        request: &Value,
        seen: Vec<String>,
    ) -> Result<Value, String> {
        self.seen = seen;
        let result = self.fit(result, request);
        self.seen.clear();
        result
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.seen.clear();
    }

    /// Resolve only daemon-issued, same-account/same-query cursors. Upstream tokens
    /// never cross the public RPC boundary, even when a provider page already fits.
    pub(crate) fn resolve(&mut self, request: &mut Value) -> Result<Option<Value>, String> {
        self.seen.clear();
        let Some(cursor) = request.get("cursor") else {
            return Ok(None);
        };
        let cursor = cursor.as_str().ok_or("잘못된 페이지 커서")?;
        self.entries.retain(|p| p.at.elapsed() < TTL);
        let page = self
            .entries
            .iter()
            .find(|p| p.id == cursor && p.scope == scope(request))
            .ok_or("페이지가 만료되었거나 조회 범위가 다릅니다")?;
        self.seen.clone_from(&page.seen);
        match &page.continuation {
            Continuation::Buffered(result) => Ok(Some(result.clone())),
            Continuation::Upstream(cursor) => {
                if self.seen.len() >= 1000 {
                    return Err("연속 페이지 조회 제한".into());
                }
                self.seen.push(cursor.clone());
                request["cursor"] = json!(cursor);
                Ok(None)
            }
        }
    }

    fn insert(&mut self, request: &Value, continuation: Continuation) -> Result<String, String> {
        let bytes = match &continuation {
            Continuation::Buffered(v) => serde_json::to_vec(v)
                .map_err(|_| "페이지 인코딩 실패")?
                .len(),
            Continuation::Upstream(s) => s.len(),
        } + self.seen.iter().map(String::len).sum::<usize>()
            + scope(request).to_string().len();
        if bytes > CACHE_BYTES {
            return Err("메시지 캐시 크기 제한".into());
        }
        self.entries.retain(|p| p.at.elapsed() < TTL);
        let mut total: usize = self.entries.iter().map(|p| p.bytes).sum();
        while self.entries.len() >= 32 || total + bytes > CACHE_BYTES {
            if let Some(old) = self.entries.pop_front() {
                total -= old.bytes;
            } else {
                break;
            }
        }
        let id = format!("account:{}", Uuid::new_v4());
        self.entries.push_back(Page {
            id: id.clone(),
            scope: scope(request),
            at: Instant::now(),
            bytes,
            continuation,
            seen: self.seen.clone(),
        });
        Ok(id)
    }

    pub(crate) fn fit(&mut self, result: Value, request: &Value) -> Result<Value, String> {
        let messages = result["messages"].as_array().ok_or("메시지 응답 오류")?;
        let upstream = result["next_cursor"].as_str().filter(|s| !s.is_empty());
        if upstream.is_some_and(|s| s.len() > 4096) {
            return Err("제공자 커서 크기 제한".into());
        }
        if upstream.is_some_and(|s| self.seen.iter().any(|old| old == s)) {
            return Err("제공자 페이지 커서 반복".into());
        }
        let mut output = result.clone();
        // Reserve the exact length of a daemon-issued cursor while fitting the full
        // response, including platform/account tags and all result metadata.
        output["next_cursor"] = json!(format!("account:{}", Uuid::nil()));
        let mut count = messages.len().min(80);
        loop {
            output["messages"] = json!(&messages[..count]);
            if serde_json::to_vec(&output)
                .map_err(|_| "페이지 인코딩 실패")?
                .len()
                <= PAGE_BYTES
            {
                break;
            }
            if count <= 1 {
                return Err("메시지 페이지 크기 제한".into());
            }
            count -= 1;
        }
        if count < messages.len() {
            let mut rest = result.clone();
            rest["messages"] = json!(&messages[count..]);
            output["next_cursor"] = json!(self.insert(request, Continuation::Buffered(rest))?);
            output["complete"] = json!(false);
        } else if let Some(cursor) = upstream {
            output["next_cursor"] =
                json!(self.insert(request, Continuation::Upstream(cursor.into()))?);
        } else {
            output
                .as_object_mut()
                .ok_or("페이지 응답 오류")?
                .remove("next_cursor");
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_jobs_keep_separate_cycle_chains_in_shared_registry() {
        let mut pages = MessagePages::default();
        let a = json!({"op":"search","query":"a"});
        let b = json!({"op":"search","query":"b"});
        let first_a = pages
            .finish(json!({"messages":[],"next_cursor":"a-next"}), &a, vec![])
            .unwrap();
        let first_b = pages
            .finish(json!({"messages":[],"next_cursor":"b-next"}), &b, vec![])
            .unwrap();
        let mut a = json!({"op":"search","query":"a","cursor":first_a["next_cursor"]});
        let mut b = json!({"op":"search","query":"b","cursor":first_b["next_cursor"]});
        let (_, chain_a) = pages.begin(&mut a).unwrap();
        let (_, chain_b) = pages.begin(&mut b).unwrap();
        assert!(
            pages
                .finish(json!({"messages":[],"next_cursor":"a-next"}), &b, chain_b)
                .is_ok()
        );
        assert!(
            pages
                .finish(json!({"messages":[],"next_cursor":"a-next"}), &a, chain_a)
                .is_err()
        );
    }

    #[test]
    fn wrapped_provider_cursors_must_make_progress_even_across_buffered_pages() {
        let mut pages = MessagePages::default();
        let mut request = json!({"op":"messages","chat_id":"r"});
        let first = pages
            .fit(json!({"messages":[],"next_cursor":"a"}), &request)
            .unwrap();
        request["cursor"] = first["next_cursor"].clone();
        assert!(pages.resolve(&mut request).unwrap().is_none());
        assert_eq!(request["cursor"], "a");
        assert!(
            pages
                .fit(json!({"messages":[],"next_cursor":"a"}), &request)
                .is_err()
        );
        let mut result = pages.fit(json!({"messages":(0..100).map(|i|json!({"id":i})).collect::<Vec<_>>(),"next_cursor":"b"}), &request).unwrap();
        request["cursor"] = result["next_cursor"].clone();
        let rest = pages.resolve(&mut request).unwrap().unwrap();
        result = pages.fit(rest, &request).unwrap();
        request["cursor"] = result["next_cursor"].clone();
        assert!(pages.resolve(&mut request).unwrap().is_none());
        assert_eq!(request["cursor"], "b");
        assert!(
            pages
                .fit(json!({"messages":[],"next_cursor":"a"}), &request)
                .is_err()
        );
    }
    #[test]
    fn large_pages_preserve_every_message_and_upstream_cursor_without_refetch() {
        let mut pages = MessagePages::default();
        let request = json!({"op":"search","query":"word"});
        let result = json!({"messages":(0..100).map(|i| json!({"id":i.to_string(),"body":"가".repeat(400),"platform":"slack","account":"a"})).collect::<Vec<_>>(),"next_cursor":"upstream-next","complete":false});
        let mut page = pages.fit(result, &request).unwrap();
        let mut ids = vec![];
        loop {
            assert!(serde_json::to_vec(&page).unwrap().len() < 60_000);
            ids.extend(
                page["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| m["id"].as_str().unwrap().to_owned()),
            );
            let cursor = page["next_cursor"].clone();
            assert!(
                pages
                    .resolve(&mut json!({"op":"search","query":"other","cursor":cursor}))
                    .is_err()
            );
            let mut next = json!({"op":"search","query":"word","cursor":cursor});
            match pages.resolve(&mut next).unwrap() {
                Some(buffered) => page = pages.fit(buffered, &next).unwrap(),
                None => {
                    assert_eq!(next["cursor"], "upstream-next");
                    break;
                }
            }
        }
        assert_eq!(ids, (0..100).map(|i| i.to_string()).collect::<Vec<_>>());
    }
    #[test]
    fn cursor_is_bound_to_account_operation_chat_and_ttl() {
        let mut a = MessagePages::default();
        let req = json!({"op":"messages","chat_id":"room"});
        let page = a
            .fit(json!({"messages":[],"next_cursor":"provider"}), &req)
            .unwrap();
        let mut next = json!({"op":"messages","chat_id":"room","cursor":page["next_cursor"]});
        assert!(MessagePages::default().resolve(&mut next).is_err());
        assert!(
            a.resolve(
                &mut json!({"op":"messages","chat_id":"foreign","cursor":page["next_cursor"]})
            )
            .is_err()
        );
        assert!(
            a.resolve(&mut json!({"op":"search","chat_id":"room","cursor":page["next_cursor"]}))
                .is_err()
        );
        a.entries[0].at = Instant::now() - TTL;
        assert!(a.resolve(&mut next).is_err());
        assert!(
            a.resolve(&mut json!({"op":"messages","chat_id":"room","cursor":"provider"}))
                .is_err()
        );
    }
    #[test]
    fn cache_limits_refresh_and_oversized_messages_are_enforced() {
        let mut pages = MessagePages::default();
        let req = json!({"op":"messages","chat_id":"room"});
        for _ in 0..40 {
            pages
                .fit(json!({"messages":[],"next_cursor":"p"}), &req)
                .unwrap();
        }
        assert_eq!(pages.entries.len(), 32);
        assert!(
            pages
                .fit(json!({"messages":[{"body":"x".repeat(PAGE_BYTES)}]}), &req)
                .is_err()
        );
        assert!(
            pages
                .fit(
                    json!({"messages":[{}, {"body":"x".repeat(CACHE_BYTES+1)}]}),
                    &req
                )
                .is_err()
        );
        pages.clear();
        assert!(pages.entries.is_empty());
    }
}
