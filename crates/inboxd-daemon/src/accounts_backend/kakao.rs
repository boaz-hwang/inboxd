use super::ProviderIo;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use unicode_normalization::UnicodeNormalization;

const TTL: Duration = Duration::from_secs(30);
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn array(v: &Value, key: &str) -> Vec<Value> {
    v[key].as_array().cloned().unwrap_or_default()
}
fn checked_array(v: &Value, key: &str) -> Result<Vec<Value>, String> {
    v[key]
        .as_array()
        .cloned()
        .ok_or_else(|| format!("Malformed Kakao {key} response"))
}
fn validate_page(v: &Value, chat: &str) -> Result<(), String> {
    let messages = checked_array(v, "messages")?;
    if !v["complete"].is_boolean()
        || messages.iter().any(|m| {
            s(m, "id").is_empty()
                || s(m, "chat_id") != chat
                || !m["author_id"].is_string()
                || !m["body"].is_string()
        })
    {
        return Err("Malformed Kakao page response".into());
    }
    Ok(())
}
fn fresh(at: Option<Instant>, ttl: Duration) -> bool {
    at.is_some_and(|at| at.elapsed() < ttl)
}
fn fold(s: &str) -> String {
    s.nfc().collect::<String>().to_lowercase()
}
#[derive(Clone)]
struct Page {
    chat: String,
    cursor: String,
    at: Instant,
    value: Value,
    bytes: usize,
}
#[derive(Clone)]
struct History {
    chat: String,
    messages: Vec<Value>,
    cursor: String,
    complete: bool,
    at: Option<Instant>,
}
#[derive(Clone)]
struct Search {
    token: String,
    at: Instant,
    query: String,
    chat: String,
    queue: VecDeque<(String, String)>,
    seen: HashMap<String, HashSet<String>>,
}
#[derive(Default)]
pub(super) struct KakaoBackend {
    metadata: Option<Value>,
    directory: Vec<Value>,
    directory_at: Option<Instant>,
    titles_at: Option<Instant>,
    own_name: String,
    names: HashMap<(String, String), String>,
    pages: VecDeque<Page>,
    histories: VecDeque<History>,
    searches: Arc<Mutex<VecDeque<Search>>>,
}
impl KakaoBackend {
    pub(super) fn fork(&self) -> Self {
        Self {
            searches: Arc::clone(&self.searches),
            ..Self::default()
        }
    }
    async fn metadata(&mut self, io: &mut impl ProviderIo) -> Result<Value, String> {
        if self.metadata.is_none() {
            self.metadata = Some(io.call(json!({"op":"kakao_metadata"})).await?);
        }
        Ok(self.metadata.clone().unwrap())
    }
    fn invalidate(&mut self, chat: &str) {
        self.pages.retain(|p| p.chat != chat);
        if let Some(h) = self.histories.iter_mut().find(|h| h.chat == chat) {
            h.at = None;
        }
    }
    async fn rooms(
        &mut self,
        titles: bool,
        force: bool,
        io: &mut impl ProviderIo,
    ) -> Result<Vec<Value>, String> {
        if !force
            && !self.directory.is_empty()
            && fresh(self.directory_at, TTL)
            && (!titles || fresh(self.titles_at, Duration::from_secs(300)))
        {
            return Ok(self.directory.clone());
        }
        let resolve = titles && !fresh(self.titles_at, Duration::from_secs(300));
        let details = if titles {
            self.metadata(io).await?["has_details"]
                .as_bool()
                .unwrap_or(false)
        } else {
            false
        };
        let mut rooms = checked_array(
            &io.call(json!({"op":"kakao_rooms","params":{"resolve_titles":resolve && !details}}))
                .await?,
            "data",
        )?;
        if rooms.iter().any(|c| s(c, "chat_id").is_empty()) {
            return Err("Malformed Kakao room response".into());
        }
        let need: Vec<usize> = rooms
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                details
                    && (resolve
                        || !self
                            .directory
                            .iter()
                            .any(|old| old["chat_id"] == c["chat_id"]))
            })
            .map(|(i, _)| i)
            .collect();
        for need in need.chunks(8) {
            let requests: Vec<Value> = need
                .iter()
                .map(|i| json!({"op":"kakao_detail","chat_id":rooms[*i]["chat_id"]}))
                .collect();
            let result = io.call(json!({"op":"batch","requests":requests})).await?;
            let results = array(&result, "results");
            if results.len() != need.len() {
                return Err("Kakao detail batch mismatch".into());
            }
            for (&i, r) in need.iter().zip(results) {
                let d = &r["data"];
                if d["chat_id"] != rooms[i]["chat_id"] {
                    return Err("Kakao chat mismatch".into());
                }
                rooms[i]["title"] = d["title"].clone();
                if s(&rooms[i], "type") == "MemoChat" {
                    if s(d, "type") != "MemoChat" {
                        return Err("Kakao self chat mismatch".into());
                    }
                    rooms[i]["display_name"] = d["display_name"].clone();
                    if !s(d, "display_name").is_empty() {
                        self.own_name = s(d, "display_name").into();
                    }
                }
            }
        }
        for c in &mut rooms {
            if let Some(old) = self
                .directory
                .iter()
                .find(|old| old["chat_id"] == c["chat_id"])
                .cloned()
            {
                if old["last_message"] != c["last_message"] {
                    self.invalidate(s(c, "chat_id"));
                }
                if !resolve && !old["title"].is_null() {
                    c["title"] = old["title"].clone();
                }
            }
        }
        self.directory = rooms.clone();
        self.directory_at = Some(Instant::now());
        if resolve {
            self.titles_at = Some(Instant::now());
        }
        Ok(rooms)
    }
    async fn self_name(
        &mut self,
        memo: Option<String>,
        io: &mut impl ProviderIo,
    ) -> Result<String, String> {
        if !self.own_name.is_empty() {
            return Ok(self.own_name.clone());
        }
        let own = self.metadata(io).await?;
        let memo = match memo {
            Some(m) => Some(m),
            None => self
                .rooms(false, false, io)
                .await?
                .iter()
                .find(|c| s(c, "type") == "MemoChat")
                .map(|c| s(c, "chat_id").to_owned()),
        };
        if let Some(memo) = memo {
            let members = io
                .call(json!({"op":"kakao_self_members","chat_id":memo}))
                .await?;
            if let Some(m) = checked_array(&members, "data")?
                .iter()
                .find(|m| m["user_id"] == own["own_id"])
            {
                self.own_name = s(m, "nickname").into();
            }
        }
        Ok(if self.own_name.is_empty() {
            "이름 없음".into()
        } else {
            self.own_name.clone()
        })
    }
    fn cached_page(&self, chat: &str, cursor: &str) -> Option<Value> {
        self.pages
            .iter()
            .find(|p| p.chat == chat && p.cursor == cursor && p.at.elapsed() < TTL)
            .map(|p| p.value.clone())
    }
    fn store_page(&mut self, chat: &str, cursor: &str, value: Value) {
        self.pages.retain(|p| p.chat != chat || p.cursor != cursor);
        let bytes = value.to_string().len();
        self.pages.push_back(Page {
            chat: chat.into(),
            cursor: cursor.into(),
            at: Instant::now(),
            value,
            bytes,
        });
        let mut total: usize = self.pages.iter().map(|p| p.bytes).sum();
        while self.pages.len() > 256 || total > 16_000_000 {
            if let Some(p) = self.pages.pop_front() {
                total -= p.bytes;
            } else {
                break;
            }
        }
    }
    async fn resolve_page(
        &mut self,
        chat: &str,
        mut value: Value,
        query: Option<&str>,
        io: &mut impl ProviderIo,
    ) -> Result<Value, String> {
        validate_page(&value, chat)?;
        let mut messages = array(&value, "messages");
        if let Some(query) = query {
            let q = fold(query);
            messages.retain(|m| fold(s(m, "body")).contains(&q));
        }
        for m in &messages {
            if !s(m, "author_name").trim().is_empty() {
                self.names.insert(
                    (chat.into(), s(m, "author_id").into()),
                    s(m, "author_name").into(),
                );
            }
        }
        let mut missing: Vec<String> = messages
            .iter()
            .map(|m| s(m, "author_id").to_owned())
            .filter(|id| !self.names.contains_key(&(chat.into(), id.clone())))
            .collect();
        missing.sort();
        missing.dedup();
        if !missing.is_empty() {
            let result = io
                .call(json!({"op":"kakao_members","chat_id":chat,"ids":missing}))
                .await?;
            for m in checked_array(&result, "data")? {
                self.names.insert(
                    (chat.into(), s(&m, "user_id").into()),
                    s(&m, "nickname").into(),
                );
            }
            let own = self.metadata(io).await?;
            let own = s(&own, "own_id");
            if missing.iter().any(|id| id == own)
                && self
                    .names
                    .get(&(chat.into(), own.into()))
                    .is_none_or(|n| n.is_empty())
            {
                let name = self.self_name(None, io).await?;
                self.names.insert((chat.into(), own.into()), name);
            }
        }
        for m in &mut messages {
            m["author_name"] = json!(
                self.names
                    .get(&(chat.into(), s(m, "author_id").into()))
                    .cloned()
                    .unwrap_or_else(|| "이름 없음".into())
            );
        }
        // Provider member records are reusable, but their cache remains bounded.
        if self.names.len() > 100_000 {
            self.names.clear();
        }
        value["messages"] = json!(messages);
        Ok(value)
    }
    async fn page(
        &mut self,
        chat: &str,
        cursor: &str,
        query: Option<&str>,
        io: &mut impl ProviderIo,
    ) -> Result<Value, String> {
        let raw = if let Some(p) = self.cached_page(chat, cursor) {
            p
        } else {
            let p = io
                .call(json!({"op":"kakao_page","chat_id":chat,"cursor":cursor,"limit":100}))
                .await?;
            validate_page(&p, chat)?;
            self.store_page(chat, cursor, p.clone());
            p
        };
        self.resolve_page(chat, raw, query, io).await
    }
    fn save_history(&mut self, h: History) {
        self.histories.retain(|old| old.chat != h.chat);
        self.histories.push_back(h);
        let mut bytes: usize = self
            .histories
            .iter()
            .map(|h| serde_json::to_vec(&h.messages).unwrap().len())
            .sum();
        while self.histories.len() > 100 || bytes > 16_000_000 {
            if let Some(h) = self.histories.pop_front() {
                bytes -= serde_json::to_vec(&h.messages).unwrap().len();
            } else {
                break;
            }
        }
    }
    pub(super) async fn run(
        &mut self,
        req: &Value,
        io: &mut impl ProviderIo,
    ) -> Result<Value, String> {
        let chat = s(req, "chat_id");
        let cursor = s(req, "cursor");
        match s(req, "op") {
            "chats" => {
                let rooms = self.rooms(true, req["refresh"] == true, io).await?;
                if let Some(m) = rooms.iter().find(|c| s(c, "type") == "MemoChat") {
                    self.self_name(Some(s(m, "chat_id").into()), io).await?;
                }
                let chats:Vec<Value>=rooms.iter().map(|c| {
                    let title=[s(c,"title"),s(c,"display_name"),if s(c,"type")=="MemoChat" { &self.own_name } else { "" },"이름 없음"].into_iter().find(|v|!v.is_empty()).unwrap();
                    json!({"chat_id":c["chat_id"],"title":title,"latest_ts":c["last_message"]["sent_at"].as_f64().unwrap_or(0.0),"preview":s(&c["last_message"],"message"),"can_send":true,"unread":c["unread_count"]})
                }).collect();
                Ok(json!({"chats":chats,"complete":true}))
            }
            "send" => {
                if let Some(file) = req.get("file") {
                    self.pages.clear();
                    self.directory_at = None;
                    self.invalidate(chat);
                    return io
                        .call(json!({"op":"kakao_send_file","chat_id":chat,"file":file}))
                        .await;
                }
                // Optional display-name enrichment must never delay or prevent delivery.
                let own = self.metadata(io).await?;
                let name = if self.own_name.is_empty() {
                    "이름 없음".to_owned()
                } else {
                    self.own_name.clone()
                };
                // Invalidate before awaiting: cancellation may hide a successful send.
                self.pages.clear();
                self.directory_at = None;
                self.invalidate(chat);
                let result = io
                    .call(json!({"op":"kakao_send","chat_id":chat,"body":req["body"]}))
                    .await;
                let mut result = result?;
                result["messages"] = json!([{"id":result["receipt"],"chat_id":chat,"author_id":own["own_id"],"author_name":name,"ts":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64(),"body":req["body"]}]);
                Ok(result)
            }
            "search" => {
                let query = s(req, "query");
                self.searches
                    .lock()
                    .unwrap()
                    .retain(|p| p.at.elapsed() < Duration::from_secs(120));
                let mut plan = if !cursor.is_empty() {
                    self.searches
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|p| p.token == cursor && p.query == query && p.chat == chat)
                        .cloned()
                        .ok_or("Kakao search cursor expired")?
                } else {
                    let queue = if chat.is_empty() {
                        self.rooms(false, false, io)
                            .await?
                            .iter()
                            .map(|c| (s(c, "chat_id").into(), String::new()))
                            .collect()
                    } else {
                        VecDeque::from([(chat.into(), String::new())])
                    };
                    Search {
                        token: String::new(),
                        at: Instant::now(),
                        query: query.into(),
                        chat: chat.into(),
                        queue,
                        seen: HashMap::new(),
                    }
                };
                let mut found = Vec::new();
                let mut scanned = 0;
                while scanned < 8 && found.len() < 30 && !plan.queue.is_empty() {
                    let batch: Vec<_> = plan
                        .queue
                        .drain(..usize::min(8 - scanned, plan.queue.len()))
                        .collect();
                    for (chat, cursor) in &batch {
                        if !plan
                            .seen
                            .entry(chat.clone())
                            .or_default()
                            .insert(cursor.clone())
                        {
                            return Err("Kakao search cursor repeated".into());
                        }
                    }
                    scanned += batch.len();
                    let mut raw_pages: HashMap<(String, String), Value> = batch
                        .iter()
                        .filter_map(|(c, k)| {
                            self.cached_page(c, k).map(|p| ((c.clone(), k.clone()), p))
                        })
                        .collect();
                    let requests: Vec<_> = batch
                        .iter()
                        .filter(|(c, k)| !raw_pages.contains_key(&(c.clone(), k.clone())))
                        .map(|(c, k)| json!({"op":"kakao_page","chat_id":c,"cursor":k,"limit":100}))
                        .collect();
                    if !requests.is_empty() {
                        let response = io.call(json!({"op":"batch","requests":requests})).await?;
                        let results = array(&response, "results");
                        if results.len() != requests.len() {
                            return Err("Kakao page batch mismatch".into());
                        }
                        for (r, p) in requests.iter().zip(results) {
                            validate_page(&p, s(r, "chat_id"))?;
                            self.store_page(s(r, "chat_id"), s(r, "cursor"), p.clone());
                            raw_pages.insert((s(r, "chat_id").into(), s(r, "cursor").into()), p);
                        }
                    }
                    for (c, k) in batch {
                        let raw = raw_pages
                            .remove(&(c.clone(), k.clone()))
                            .ok_or("Kakao page batch missing result")?;
                        let p = self.resolve_page(&c, raw, Some(query), io).await?;
                        found.extend(array(&p, "messages"));
                        if p["complete"] != true {
                            let next = s(&p, "next_cursor");
                            if next.is_empty()
                                || plan.seen.get(&c).is_some_and(|seen| seen.contains(next))
                            {
                                return Err("Kakao search cursor missing or repeated".into());
                            }
                            plan.queue.push_back((c, next.into()));
                        }
                    }
                }
                let mut result = json!({"messages":found,"complete":plan.queue.is_empty()});
                if !plan.queue.is_empty() {
                    plan.token = uuid::Uuid::new_v4().to_string();
                    plan.at = Instant::now();
                    result["next_cursor"] = json!(plan.token);
                    result["note"] = json!("카카오 기록 검색 중 · n으로 계속 검색");
                    let mut searches = self.searches.lock().unwrap();
                    while searches.len() >= 32 {
                        searches.pop_front();
                    }
                    searches.push_back(plan);
                }
                Ok(result)
            }
            "messages" => {
                if req["refresh"] == true {
                    self.histories.retain(|h| h.chat != chat);
                    self.invalidate(chat);
                }
                if !cursor.is_empty() {
                    let mut result = self.page(chat, cursor, None, io).await?;
                    if result["complete"] == true || s(&result, "next_cursor").is_empty() {
                        result.as_object_mut().unwrap().remove("next_cursor");
                    }
                    return Ok(result);
                }
                let previous = self.histories.iter().find(|h| h.chat == chat).cloned();
                let target = s(req, "message_id");
                if let Some(h) = &previous {
                    if !target.is_empty() {
                        if let Some(i) = h.messages.iter().position(|m| s(m, "id") == target) {
                            return Ok(
                                json!({"messages":&h.messages[i.saturating_sub(29)..usize::min(i+31,h.messages.len())],"complete":false}),
                            );
                        }
                    } else if h.complete && fresh(h.at, TTL) {
                        return Ok(
                            json!({"messages":&h.messages[h.messages.len().saturating_sub(30)..],"complete":true}),
                        );
                    }
                }
                // Context scans start from old provider pages and must not mix their
                // ordering or cursor into the current latest-history snapshot.
                let mut stored = if target.is_empty() {
                    previous
                        .as_ref()
                        .map(|h| h.messages.clone())
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };
                let mut positions: HashMap<String, usize> = stored
                    .iter()
                    .enumerate()
                    .map(|(i, m)| (s(m, "id").to_owned(), i))
                    .collect();
                let mut current = if target.is_empty() {
                    previous.map(|h| h.cursor).unwrap_or_default()
                } else {
                    String::new()
                };
                let mut complete = false;
                let mut context = None;
                for _ in 0..100 {
                    let p = self.page(chat, &current, None, io).await?;
                    let messages = array(&p, "messages");
                    for m in &messages {
                        if let Some(&index) = positions.get(s(m, "id")) {
                            stored[index] = m.clone();
                        } else {
                            positions.insert(s(m, "id").to_owned(), stored.len());
                            stored.push(m.clone());
                        }
                    }
                    complete = p["complete"] == true;
                    let next = s(&p, "next_cursor");
                    if !target.is_empty() {
                        if let Some(&i) = positions.get(target) {
                            context = Some(
                                stored[i.saturating_sub(29)..usize::min(i + 31, stored.len())]
                                    .to_vec(),
                            );
                            current = next.into();
                            break;
                        }
                    }
                    if complete || next.is_empty() || next == current {
                        current = messages
                            .last()
                            .map(|m| s(m, "id").to_owned())
                            .unwrap_or(current);
                        break;
                    }
                    current = next.into();
                }
                let messages =
                    context.unwrap_or_else(|| stored[stored.len().saturating_sub(30)..].to_vec());
                if stored.len() > 10000 {
                    stored.drain(..stored.len() - 10000);
                }
                if target.is_empty() {
                    self.save_history(History {
                        chat: chat.into(),
                        messages: stored,
                        cursor: current.clone(),
                        complete,
                        at: Some(Instant::now()),
                    });
                }
                let mut result = json!({"messages":messages,"complete":complete});
                if !complete {
                    result["note"] = json!("일부 기록만 조회했습니다");
                    if !current.is_empty() {
                        result["next_cursor"] = json!(current);
                    }
                }
                Ok(result)
            }
            _ => Err("Unsupported Kakao operation".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        calls: Vec<Value>,
        named: bool,
        memo: bool,
        details: bool,
        body: String,
        size: usize,
        pages: usize,
        rooms: usize,
    }
    impl Fake {
        fn answer(&mut self, r: Value) -> Result<Value, String> {
            self.calls.push(r.clone());
            Ok(match s(&r, "op") {
                "batch" => {
                    json!({"results":array(&r,"requests").into_iter().map(|r|self.answer(r)).collect::<Result<Vec<_>,_>>()?})
                }
                "kakao_metadata" => json!({"own_id":"7","has_details":self.details}),
                "kakao_rooms" => {
                    json!({"data":(0..self.rooms.max(1)).map(|i|json!({"chat_id":if self.memo {"self".into()} else if self.rooms>1 {format!("r{i}")} else {"r".into()},"type":if self.memo {"MemoChat"} else {"MultiChat"},"title":if self.memo {""} else {"원래 이름"},"last_message":{"message":self.body,"sent_at":1}})).collect::<Vec<_>>()})
                }
                "kakao_detail" => {
                    json!({"data":{"chat_id":r["chat_id"],"type":"MemoChat","display_name":"내 이름"}})
                }
                "kakao_members" => {
                    json!({"data":if self.memo {vec![]} else {vec![json!({"user_id":"7","nickname":"제공자 이름"})]}})
                }
                "kakao_self_members" => json!({"data":[{"user_id":"7","nickname":"내 이름"}]}),
                "kakao_send" => json!({"state":"Sent","receipt":"sent"}),
                "kakao_page" => {
                    let from = s(&r, "cursor").parse::<usize>().unwrap_or(0);
                    let size = self.size.max(1);
                    let total = size * self.pages.max(1);
                    let end = usize::min(from + size, total);
                    json!({"messages":(from..end).map(|i|json!({"id":(i+1).to_string(),"chat_id":r["chat_id"],"author_id":"7","author_name":if self.named {"제공자 이름"} else {""},"ts":i+1,"body":if self.body.is_empty(){format!("message {}",i+1)}else{self.body.clone()}})).collect::<Vec<_>>(),"complete":end==total,"next_cursor":if end==total{Value::Null}else{json!(end.to_string())}})
                }
                _ => return Err(format!("unexpected {r}")),
            })
        }
        fn count(&self, op: &str) -> usize {
            self.calls.iter().filter(|r| s(r, "op") == op).count()
        }
    }
    impl ProviderIo for Fake {
        async fn call(&mut self, r: Value) -> Result<Value, String> {
            self.answer(r)
        }
    }
    #[tokio::test]
    async fn independent_jobs_share_scoped_search_continuations_and_cycle_history() {
        let mut first = KakaoBackend::default();
        let mut io = Fake {
            named: true,
            pages: 10,
            body: "other".into(),
            ..Default::default()
        };
        let result = first
            .run(
                &json!({"op":"search","chat_id":"r","query":"absent"}),
                &mut io,
            )
            .await
            .unwrap();
        let mut next = first.fork();
        let request =
            json!({"op":"search","chat_id":"r","query":"absent","cursor":result["next_cursor"]});
        let mut wrong = request.clone();
        wrong["chat_id"] = json!("foreign");
        assert!(next.run(&wrong, &mut io).await.is_err());
        assert_eq!(next.run(&request, &mut io).await.unwrap()["complete"], true);
        struct Cycle;
        impl ProviderIo for Cycle {
            async fn call(&mut self, _: Value) -> Result<Value, String> {
                Ok(json!({"results":[{"messages":[],"complete":false,"next_cursor":"1"}]}))
            }
        }
        // The old snapshot's visited cursors survive changing job/backend owner.
        assert!(first.fork().run(&request, &mut Cycle).await.is_err());
    }

    #[tokio::test]
    async fn forward_history_latest_dedup_context_and_search() {
        let mut b = KakaoBackend::default();
        let mut io = Fake {
            size: 30,
            pages: 2,
            ..Default::default()
        };
        let r = b
            .run(&json!({"op":"messages","chat_id":"r"}), &mut io)
            .await
            .unwrap();
        assert_eq!(r["messages"][0]["id"], "31");
        assert_eq!(r["messages"][29]["id"], "60");
        assert_eq!(io.count("kakao_page"), 2);
        assert_eq!(io.count("kakao_members"), 1);
        let r = b
            .run(
                &json!({"op":"messages","chat_id":"r","message_id":"12"}),
                &mut io,
            )
            .await
            .unwrap();
        assert!(array(&r, "messages").iter().any(|m| s(m, "id") == "12"));
        let r = b
            .run(&json!({"op":"search","query":"message 60"}), &mut io)
            .await
            .unwrap();
        assert_eq!(r["messages"][0]["id"], "60");
        assert_eq!(array(&r, "messages").len(), 1);
        assert_eq!(io.count("kakao_page"), 2);
        // Expiration resumes from the last seen log, without duplicating retained records.
        b.histories[0].at = None;
        b.run(&json!({"op":"messages","chat_id":"r"}), &mut io)
            .await
            .unwrap();
        assert_eq!(b.histories[0].messages.len(), 60);
    }
    #[tokio::test]
    async fn names_only_for_matches_unicode_and_provider_reuse() {
        let mut b = KakaoBackend::default();
        let mut io = Fake {
            body: "Café".into(),
            ..Default::default()
        };
        assert!(
            array(
                &b.run(
                    &json!({"op":"search","chat_id":"r","query":"absent"}),
                    &mut io
                )
                .await
                .unwrap(),
                "messages"
            )
            .is_empty()
        );
        assert_eq!(io.count("kakao_members"), 0);
        let r = b
            .run(
                &json!({"op":"search","chat_id":"r","query":"CAFE\u{301}"}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(r["messages"][0]["author_name"], "제공자 이름");
        assert_eq!(io.count("kakao_page"), 1);
        let mut b = KakaoBackend::default();
        io.named = true;
        io.calls.clear();
        b.run(&json!({"op":"messages","chat_id":"r"}), &mut io)
            .await
            .unwrap();
        assert_eq!(io.count("kakao_members"), 0);
    }
    #[tokio::test]
    async fn memo_fallback_and_detail_reuse() {
        for details in [false, true] {
            let mut b = KakaoBackend::default();
            let mut io = Fake {
                memo: true,
                details,
                ..Default::default()
            };
            let r = b.run(&json!({"op":"chats"}), &mut io).await.unwrap();
            assert_eq!(r["chats"][0]["title"], "내 이름");
            let r = b
                .run(&json!({"op":"messages","chat_id":"self"}), &mut io)
                .await
                .unwrap();
            assert_eq!(r["messages"][0]["author_name"], "내 이름");
            assert_eq!(io.count("kakao_self_members"), usize::from(!details));
            assert_eq!(io.count("kakao_detail"), usize::from(details));
        }
    }
    #[tokio::test]
    async fn refresh_expiry_and_directory_change_invalidate() {
        let mut b = KakaoBackend::default();
        let mut io = Fake {
            named: true,
            body: "before".into(),
            ..Default::default()
        };
        b.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        b.run(&json!({"op":"messages","chat_id":"r"}), &mut io)
            .await
            .unwrap();
        io.body = "after".into();
        let r = b
            .run(
                &json!({"op":"messages","chat_id":"r","refresh":true}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(r["messages"][0]["body"], "after");
        assert_eq!(io.count("kakao_page"), 2);
        io.body = "changed".into();
        b.run(&json!({"op":"chats","refresh":true}), &mut io)
            .await
            .unwrap();
        assert!(b.pages.is_empty());
        assert!(b.histories[0].at.is_none());
        b.run(
            &json!({"op":"messages","chat_id":"r","refresh":true}),
            &mut io,
        )
        .await
        .unwrap();
        b.pages[0].at = Instant::now() - Duration::from_secs(31);
        b.histories[0].at = None;
        b.run(
            &json!({"op":"messages","chat_id":"r","cursor":"0"}),
            &mut io,
        )
        .await
        .unwrap();
        assert_eq!(io.count("kakao_page"), 4);
    }
    #[tokio::test]
    async fn early_context_is_bounded_and_cached() {
        let mut b = KakaoBackend::default();
        let mut io = Fake {
            named: true,
            size: 100,
            ..Default::default()
        };
        let req = json!({"op":"messages","chat_id":"r","message_id":"12"});
        for _ in 0..2 {
            let r = b.run(&req, &mut io).await.unwrap();
            assert!(array(&r, "messages").len() <= 60);
            assert!(array(&r, "messages").iter().any(|m| s(m, "id") == "12"));
        }
        assert_eq!(io.count("kakao_page"), 1);
    }
    #[tokio::test]
    async fn search_budget_scope_expiry_and_queue_progress() {
        let mut b = KakaoBackend::default();
        let mut io = Fake {
            named: true,
            pages: 10,
            body: "other".into(),
            ..Default::default()
        };
        let first = b
            .run(
                &json!({"op":"search","chat_id":"r","query":"absent"}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(io.count("kakao_page"), 8);
        assert_eq!(first["complete"], false);
        let cursor = first["next_cursor"].clone();
        assert!(
            b.run(
                &json!({"op":"search","chat_id":"other","query":"absent","cursor":cursor}),
                &mut io
            )
            .await
            .is_err()
        );
        assert!(
            b.run(
                &json!({"op":"search","chat_id":"r","query":"changed","cursor":cursor}),
                &mut io
            )
            .await
            .is_err()
        );
        let r = b
            .run(
                &json!({"op":"search","chat_id":"r","query":"absent","cursor":cursor}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(r["complete"], true);
        assert_eq!(io.count("kakao_page"), 10);
        b.searches.lock().unwrap()[0].at = Instant::now() - Duration::from_secs(121);
        assert!(
            b.run(
                &json!({"op":"search","chat_id":"r","query":"absent","cursor":cursor}),
                &mut io
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn traversal_cap_send_and_memory_caps() {
        let mut b = KakaoBackend::default();
        let mut io = Fake {
            named: true,
            pages: 101,
            ..Default::default()
        };
        let r = b
            .run(&json!({"op":"messages","chat_id":"r"}), &mut io)
            .await
            .unwrap();
        assert_eq!(io.count("kakao_page"), 100);
        assert_eq!(r["complete"], false);
        b.run(&json!({"op":"send","chat_id":"r","body":"hello"}), &mut io)
            .await
            .unwrap();
        assert_eq!(io.count("kakao_send"), 1);
        assert!(b.pages.is_empty());
        assert!(b.histories[0].at.is_none());
        for i in 0..300 {
            b.store_page("r", &i.to_string(), json!({"messages":[]}));
        }
        assert_eq!(b.pages.len(), 256);
        b.store_page("r", "huge", json!({"body":"x".repeat(16_000_001)}));
        assert!(b.pages.is_empty());
    }
    #[tokio::test]
    async fn large_directory_uses_bounded_batches_and_reuses_titles() {
        let mut b = KakaoBackend::default();
        let mut io = Fake {
            details: true,
            rooms: 19,
            ..Default::default()
        };
        b.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        assert_eq!(io.count("kakao_detail"), 19);
        assert!(
            io.calls
                .iter()
                .filter(|r| s(r, "op") == "batch")
                .all(|r| array(r, "requests").len() <= 8)
        );
        b.run(&json!({"op":"chats","refresh":true}), &mut io)
            .await
            .unwrap();
        assert_eq!(io.count("kakao_detail"), 19);
        b.titles_at = Some(Instant::now() - Duration::from_secs(301));
        b.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        assert_eq!(io.count("kakao_detail"), 38);
    }
    #[tokio::test]
    async fn malformed_provider_results_are_errors() {
        struct Bad;
        impl ProviderIo for Bad {
            async fn call(&mut self, _: Value) -> Result<Value, String> {
                Ok(json!({}))
            }
        }
        for req in [
            json!({"op":"messages","chat_id":"r"}),
            json!({"op":"chats"}),
            json!({"op":"search","query":"test"}),
        ] {
            assert!(KakaoBackend::default().run(&req, &mut Bad).await.is_err());
        }
    }
    #[tokio::test]
    async fn send_cancellation_invalidates_before_the_provider_await() {
        struct Pending(Fake);
        impl ProviderIo for Pending {
            async fn call(&mut self, r: Value) -> Result<Value, String> {
                if s(&r, "op") == "kakao_send" {
                    std::future::pending().await
                } else {
                    self.0.answer(r)
                }
            }
        }
        let mut b = KakaoBackend::default();
        let mut io = Pending(Fake {
            named: true,
            ..Default::default()
        });
        b.run(&json!({"op":"messages","chat_id":"r"}), &mut io)
            .await
            .unwrap();
        let request = json!({"op":"send","chat_id":"r","body":"hello"});
        assert!(
            tokio::time::timeout(Duration::from_millis(5), b.run(&request, &mut io))
                .await
                .is_err()
        );
        assert!(b.pages.is_empty());
        assert!(b.directory_at.is_none());
        assert!(b.histories[0].at.is_none());
    }
    #[tokio::test]
    async fn oversized_search_page_is_not_read_twice_when_cache_evicts_it() {
        let mut b = KakaoBackend::default();
        let mut io = Fake {
            named: true,
            body: "x".repeat(16_000_001),
            ..Default::default()
        };
        let r = b
            .run(
                &json!({"op":"search","chat_id":"r","query":"absent"}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(r["complete"], true);
        assert_eq!(io.count("kakao_page"), 1);
        assert!(b.pages.is_empty());
    }
    #[tokio::test]
    async fn send_never_requests_optional_names_and_uses_cached_identity() {
        struct SendOnly {
            sends: usize,
        }
        impl ProviderIo for SendOnly {
            async fn call(&mut self, r: Value) -> Result<Value, String> {
                match s(&r, "op") {
                    "kakao_metadata" => Ok(json!({"own_id":"7","has_details":true})),
                    "kakao_send" => {
                        self.sends += 1;
                        Ok(json!({"state":"Sent","receipt":"sent"}))
                    }
                    _ => panic!("send must not request optional enrichment: {r}"),
                }
            }
        }
        let mut b = KakaoBackend::default();
        let mut io = SendOnly { sends: 0 };
        let req = json!({"op":"send","chat_id":"r","body":"hello"});
        let result = b.run(&req, &mut io).await.unwrap();
        assert_eq!(io.sends, 1);
        assert_eq!(result["state"], "Sent");
        assert_eq!(result["messages"][0]["author_id"], "7");
        assert_eq!(result["messages"][0]["author_name"], "이름 없음");
        b.own_name = "내 이름".into();
        let result = b.run(&req, &mut io).await.unwrap();
        assert_eq!(io.sends, 2);
        assert_eq!(result["messages"][0]["author_name"], "내 이름");
    }
    #[tokio::test]
    async fn complete_cursor_page_omits_provider_terminal_cursor() {
        struct Terminal;
        impl ProviderIo for Terminal {
            async fn call(&mut self, r: Value) -> Result<Value, String> {
                assert_eq!(r["op"], "kakao_page");
                Ok(json!({"messages":[],"complete":true,"next_cursor":"provider-terminal"}))
            }
        }
        let result = KakaoBackend::default()
            .run(
                &json!({"op":"messages","chat_id":"r","cursor":"last"}),
                &mut Terminal,
            )
            .await
            .unwrap();
        assert_eq!(result["complete"], true);
        assert!(result.get("next_cursor").is_none());
    }
    #[tokio::test]
    async fn large_history_replacements_preserve_insertion_order_and_deduplicate() {
        let mut b = KakaoBackend::default();
        b.save_history(History{chat:"r".into(),messages:(1..=10000).map(|i|json!({"id":i.to_string(),"chat_id":"r","author_id":"7","author_name":"name","ts":i,"body":"old"})).collect(),cursor:"9900".into(),complete:false,at:None});
        let mut io = Fake {
            size: 100,
            pages: 101,
            named: true,
            body: "changed".into(),
            ..Default::default()
        };
        let result = b
            .run(&json!({"op":"messages","chat_id":"r"}), &mut io)
            .await
            .unwrap();
        assert_eq!(io.count("kakao_page"), 2);
        assert_eq!(b.histories[0].messages.len(), 10000);
        assert_eq!(b.histories[0].messages[0]["id"], "101");
        assert_eq!(b.histories[0].messages[9800]["id"], "9901");
        assert_eq!(b.histories[0].messages[9800]["body"], "changed");
        assert_eq!(result["messages"][29]["id"], "10100");
        assert_eq!(
            b.histories[0]
                .messages
                .iter()
                .map(|m| s(m, "id"))
                .collect::<std::collections::HashSet<_>>()
                .len(),
            10000
        );
    }
    #[tokio::test]
    async fn historical_context_does_not_replace_latest_history_snapshot() {
        for complete in [false, true] {
            let mut b = KakaoBackend::default();
            let original:Vec<Value>=(10001..=10030).map(|i|json!({"id":i.to_string(),"chat_id":"r","author_id":"7","author_name":"name","ts":i,"body":"recent"})).collect();
            let at = Some(Instant::now());
            b.save_history(History {
                chat: "r".into(),
                messages: original.clone(),
                cursor: "10030".into(),
                complete,
                at,
            });
            let mut io = Fake {
                size: 100,
                pages: 101,
                named: true,
                ..Default::default()
            };
            let result = b
                .run(
                    &json!({"op":"messages","chat_id":"r","message_id":"12"}),
                    &mut io,
                )
                .await
                .unwrap();
            assert!(
                array(&result, "messages")
                    .iter()
                    .any(|m| s(m, "id") == "12")
            );
            assert!(
                array(&result, "messages")
                    .iter()
                    .all(|m| s(m, "id").parse::<usize>().unwrap() <= 100)
            );
            let history = &b.histories[0];
            assert_eq!(history.messages, original);
            assert_eq!(history.cursor, "10030");
            assert_eq!(history.complete, complete);
            assert_eq!(history.at, at);
            let result = b
                .run(&json!({"op":"messages","chat_id":"r"}), &mut io)
                .await
                .unwrap();
            if complete {
                assert_eq!(result["messages"], json!(original));
                assert_eq!(io.count("kakao_page"), 1);
            } else {
                assert_eq!(result["messages"][29]["id"], "10100");
            }
        }
    }
}
