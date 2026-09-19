use super::ProviderIo;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(300);
#[derive(Default)]
pub(super) struct SlackBackend {
    names: HashMap<String, String>,
    names_updated: Option<Instant>,
    names_epoch: Option<Instant>,
    members: HashMap<String, (Instant, Vec<String>)>,
    summaries: HashMap<String, (String, Value)>,
}
fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn items(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn name(v: &Value) -> String {
    [&v["profile"]["display_name"], &v["real_name"], &v["name"]]
        .into_iter()
        .map(string)
        .find(|s| !s.is_empty())
        .unwrap_or("이름 없음")
        .to_owned()
}
fn data(response: &Value, method: &str) -> Result<Value, String> {
    let value = &response["data"];
    let valid = value.is_object()
        && match method {
            "users.list" | "conversations.members" => value["members"].is_array(),
            "users.info" => value["user"].is_object(),
            "conversations.list" => value["channels"].is_array(),
            "conversations.history" => value["messages"].is_array(),
            "search.messages" => value["messages"]["matches"].is_array(),
            "chat.postMessage" => value["ts"].as_str().is_some_and(|s| !s.is_empty()),
            _ => true,
        };
    if valid {
        Ok(value.clone())
    } else {
        Err(format!("Slack 응답 형식 오류: {method}"))
    }
}
async fn call(io: &mut impl ProviderIo, method: &str, params: Value) -> Result<Value, String> {
    let result = io
        .call(json!({"op": format!("slack.{method}"), "params": params}))
        .await?;
    data(&result, method)
}
fn marker(c: &Value) -> String {
    let invalid = &c["history_invalid"];
    let numeric = invalid.as_str().is_some_and(|s| {
        let mut parts = s.split('.');
        let first = parts.next().unwrap_or("");
        !first.is_empty()
            && first.bytes().all(|b| b.is_ascii_digit())
            && parts
                .next()
                .is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            && parts.next().is_none()
    });
    if c["latest"].is_string()
        && (c.get("history_invalid").is_none() || invalid == false || invalid == 0 || numeric)
    {
        json!([c["latest"], c["updated"], invalid]).to_string()
    } else {
        String::new()
    }
}
impl SlackBackend {
    async fn load_names(&mut self, io: &mut impl ProviderIo) -> Result<(), String> {
        if self.names_updated.is_some_and(|at| at.elapsed() < TTL) {
            return Ok(());
        }
        // Failed refreshes are also throttled; individual profile lookups remain available.
        self.names_updated = Some(Instant::now());
        let mut cursor = String::new();
        for page in 0..3 {
            let result = call(io, "users.list", json!({"limit":200,"cursor":cursor})).await?;
            if page == 0 {
                self.names.clear();
            }
            for u in items(&result["members"]) {
                self.names.insert(string(&u["id"]).to_owned(), name(&u));
            }
            cursor = string(&result["response_metadata"]["next_cursor"]).to_owned();
            if cursor.is_empty() {
                break;
            }
        }
        Ok(())
    }
    async fn resolve(
        &mut self,
        ids: impl IntoIterator<Item = String>,
        io: &mut impl ProviderIo,
    ) -> Result<(), String> {
        let mut seen = HashSet::new();
        let missing: Vec<_> = ids
            .into_iter()
            .filter(|id| !id.is_empty() && !self.names.contains_key(id) && seen.insert(id.clone()))
            .collect();
        for chunk in missing.chunks(3) {
            let requests: Vec<_> = chunk
                .iter()
                .map(|id| json!({"op":"slack.users.info","params":{"user":id}}))
                .collect();
            let response = io.call(json!({"op":"batch","requests":requests})).await?;
            let results = response["results"]
                .as_array()
                .ok_or("Slack 프로필 응답 없음")?;
            if results.len() != chunk.len() {
                return Err("Slack 프로필 응답 누락".into());
            }
            for (id, result) in chunk.iter().zip(results) {
                self.names
                    .insert(id.clone(), name(&data(result, "users.info")?["user"]));
            }
        }
        Ok(())
    }
    async fn messages(
        &mut self,
        rows: Vec<Value>,
        chat: &str,
        io: &mut impl ProviderIo,
    ) -> Result<Vec<Value>, String> {
        self.resolve(rows.iter().map(|m| string(&m["user"]).to_owned()), io)
            .await?;
        Ok(self.normalize_messages(rows, chat))
    }
    fn normalize_messages(&self, rows: Vec<Value>, chat: &str) -> Vec<Value> {
        rows.into_iter().map(|m| {
            let author = string(&m["user"]);
            let author_name = self.names.get(author).map(String::as_str).unwrap_or_else(|| {
                m["bot_profile"]["name"].as_str().or(m["username"].as_str()).unwrap_or("이름 없음")
            });
            json!({"id":string(&m["ts"]),"chat_id":m["channel"]["id"].as_str().unwrap_or(chat),"author_id":author,"author_name":author_name,
                "ts":string(&m["ts"]).parse::<f64>().unwrap_or(0.0),"body":m["text"].as_str().unwrap_or("")})
        }).collect()
    }
    async fn chats(&mut self, io: &mut impl ProviderIo) -> Result<Value, String> {
        let _ = self.load_names(io).await;
        let counts = if self.summaries.is_empty() {
            Value::Null
        } else {
            call(io, "client.counts", json!({}))
                .await
                .unwrap_or(Value::Null)
        };
        let markers: HashMap<String, Value> = ["channels", "ims", "mpims"]
            .into_iter()
            .flat_map(|k| items(&counts[k]))
            .map(|c| (string(&c["id"]).to_owned(), c))
            .collect();
        let mut rooms = Vec::new();
        let mut cursor = String::new();
        let mut seen = HashSet::new();
        for page_index in 0..=100 {
            if page_index == 100 {
                return Err("Slack 목록 제한".into());
            }
            let page = call(io,"conversations.list",json!({"types":"public_channel,private_channel,im,mpim","exclude_archived":false,"limit":200,"cursor":cursor})).await?;
            rooms.extend(
                items(&page["channels"]).into_iter().filter(|c| {
                    c["is_member"] == true || c["is_im"] == true || c["is_mpim"] == true
                }),
            );
            if rooms.len() > 20000 {
                return Err("Slack 목록 제한".into());
            }
            cursor = string(&page["response_metadata"]["next_cursor"]).to_owned();
            if cursor.is_empty() {
                break;
            }
            if !seen.insert(cursor.clone()) {
                return Err("Slack 목록 커서 반복".into());
            }
        }
        let mut titles = HashMap::<String, Vec<String>>::new();
        struct MemberPlan {
            chat: String,
            ids: Vec<String>,
            cursor: String,
            seen: HashSet<String>,
            pages: usize,
        }
        let mut pending = VecDeque::new();
        let mut scheduled = HashSet::new();
        for c in &rooms {
            let id = string(&c["id"]);
            if c["is_im"] == true {
                titles.insert(id.to_owned(), vec![string(&c["user"]).to_owned()]);
            } else if c["is_mpim"] == true {
                if let Some((_, ids)) = self.members.get(id).filter(|(at, _)| at.elapsed() <= TTL) {
                    titles.insert(id.to_owned(), ids.clone());
                } else if scheduled.insert(id.to_owned()) {
                    pending.push_back(MemberPlan {
                        chat: id.to_owned(),
                        ids: Vec::new(),
                        cursor: String::new(),
                        seen: HashSet::new(),
                        pages: 0,
                    });
                }
            }
        }
        // Keep at most three rooms in flight; each room's next page waits for
        // its own preceding cursor, while other rooms can progress together.
        while !pending.is_empty() {
            let plans: Vec<_> = pending.drain(..pending.len().min(3)).collect();
            if plans.iter().any(|p| p.pages >= 100) {
                return Err("Slack 멤버 제한".into());
            }
            let requests: Vec<_> = plans.iter().map(|p|json!({"op":"slack.conversations.members","params":{"channel":p.chat,"limit":200,"cursor":p.cursor}})).collect();
            let response = io.call(json!({"op":"batch","requests":requests})).await?;
            let results = response["results"]
                .as_array()
                .filter(|r| r.len() == plans.len())
                .ok_or("Slack 멤버 응답 누락")?;
            for (mut plan, result) in plans.into_iter().zip(results) {
                let page = data(result, "conversations.members")?;
                plan.pages += 1;
                plan.ids
                    .extend(items(&page["members"]).iter().map(|v| string(v).to_owned()));
                if plan.ids.len() > 20000 {
                    return Err("Slack 멤버 제한".into());
                }
                plan.cursor = string(&page["response_metadata"]["next_cursor"]).to_owned();
                if plan.cursor.is_empty() {
                    titles.insert(plan.chat.clone(), plan.ids.clone());
                    self.members.insert(plan.chat, (Instant::now(), plan.ids));
                } else {
                    if !plan.seen.insert(plan.cursor.clone()) {
                        return Err("Slack 멤버 커서 반복".into());
                    }
                    pending.push_back(plan);
                }
            }
        }
        self.resolve(titles.values().flatten().cloned(), io).await?;
        let mut latest_by_id = HashMap::new();
        let mut missing = Vec::new();
        for c in &rooms {
            let id = string(&c["id"]);
            let watermark = markers.get(id).map(marker).unwrap_or_default();
            let latest = if !c["latest"].is_null() {
                c["latest"].clone()
            } else {
                self.summaries
                    .get(id)
                    .filter(|(m, _)| !watermark.is_empty() && *m == watermark)
                    .map(|(_, v)| v.clone())
                    .unwrap_or(Value::Null)
            };
            if latest.is_null() {
                missing.push(id.to_owned());
            } else {
                latest_by_id.insert(id.to_owned(), latest);
            }
        }
        for chunk in missing.chunks(3) {
            let requests: Vec<_> = chunk.iter().map(|id|json!({"op":"slack.conversations.history","params":{"channel":id,"limit":1}})).collect();
            let response = io.call(json!({"op":"batch","requests":requests})).await?;
            let results = response["results"]
                .as_array()
                .ok_or("Slack 기록 응답 없음")?;
            if results.len() != chunk.len() {
                return Err("Slack 기록 응답 누락".into());
            }
            for (id, result) in chunk.iter().zip(results) {
                latest_by_id.insert(
                    id.clone(),
                    data(result, "conversations.history")?["messages"][0].clone(),
                );
            }
        }
        let mut summaries = HashMap::new();
        let mut chats = Vec::new();
        for c in rooms {
            let id = string(&c["id"]);
            let latest = latest_by_id.get(id).cloned().unwrap_or(Value::Null);
            let title = titles
                .get(id)
                .map(|ids| {
                    ids.iter()
                        .map(|id| {
                            self.names
                                .get(id)
                                .map(String::as_str)
                                .unwrap_or("이름 없음")
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_else(|| string(&c["name"]).to_owned());
            summaries.insert(
                id.to_owned(),
                (
                    markers.get(id).map(marker).unwrap_or_default(),
                    latest.clone(),
                ),
            );
            let mut chat = json!({"chat_id":id,"title":if title.is_empty(){"이름 없음"}else{&title},"latest_ts":string(&latest["ts"]).parse::<f64>().unwrap_or(0.0),"preview":latest["text"].as_str().unwrap_or(""),"can_send":c["is_archived"] != true});
            if !c["unread_count"].is_null() {
                chat["unread"] = c["unread_count"].clone();
            }
            chats.push(chat);
        }
        self.members.retain(|id, _| summaries.contains_key(id));
        self.summaries = summaries;
        Ok(json!({"chats":chats,"complete":true}))
    }
    pub(super) async fn run(
        &mut self,
        req: &Value,
        io: &mut impl ProviderIo,
    ) -> Result<Value, String> {
        if self.names_epoch.is_none_or(|at| at.elapsed() >= TTL) {
            self.names.clear();
            self.names_updated = None;
            self.names_epoch = Some(Instant::now());
        }
        self.members.retain(|_, (at, _)| at.elapsed() <= TTL);
        if req["refresh"] == true {
            self.names.clear();
            self.names_updated = None;
            self.members.clear();
            self.summaries.clear();
        }
        let result = self.run_inner(req, io).await;
        // Keep successful enrichment in this response, but bound retained state.
        let mut remaining = 20_000usize;
        self.names.retain(|_, _| {
            let keep = remaining > 0;
            remaining = remaining.saturating_sub(1);
            keep
        });
        remaining = 20_000;
        self.members.retain(|_, _| {
            let keep = remaining > 0;
            remaining = remaining.saturating_sub(1);
            keep
        });
        result
    }
    async fn run_inner(&mut self, req: &Value, io: &mut impl ProviderIo) -> Result<Value, String> {
        let chat = string(&req["chat_id"]);
        match string(&req["op"]) {
            "chats" => self.chats(io).await,
            "send" => {
                // Cancellation can hide delivery; invalidate before the irreversible await.
                self.summaries.remove(chat);
                if let Some(file) = req.get("file") {
                    return io
                        .call(json!({"op":"slack_send_file","chat_id":chat,"file":file}))
                        .await;
                }
                let result = call(
                    io,
                    "chat.postMessage",
                    json!({"channel":chat,"text":req["body"],"client_msg_id":req["request_id"]}),
                )
                .await?;
                let mut message = result["message"].as_object().cloned().unwrap_or_default();
                message.insert("ts".into(), result["ts"].clone());
                if message.get("text").is_none_or(Value::is_null) {
                    message.insert("text".into(), req["body"].clone());
                }
                // No awaits after acknowledgement: optional enrichment must not lose a receipt.
                let messages = self.normalize_messages(vec![Value::Object(message)], chat);
                Ok(json!({"state":"Sent","receipt":result["ts"],"messages":messages}))
            }
            "search" => {
                let page = req["cursor"]
                    .as_str()
                    .unwrap_or("1")
                    .parse::<u64>()
                    .map_err(|_| "Slack 검색 커서 오류")?;
                if page == 0 {
                    return Err("Slack 검색 커서 오류".into());
                }
                let query = format!(
                    "{}{}",
                    string(&req["query"]),
                    if chat.is_empty() {
                        String::new()
                    } else {
                        format!(" in:{chat}")
                    }
                );
                let result = call(io,"search.messages",json!({"query":query,"count":100,"page":page,"sort":"timestamp","sort_dir":"desc"})).await?;
                let more = page
                    < result["messages"]["pagination"]["page_count"]
                        .as_u64()
                        .unwrap_or(page);
                Ok(
                    json!({"messages":self.messages(items(&result["messages"]["matches"]),"",io).await?,"next_cursor":if more{Some((page+1).to_string())}else{None},"complete":!more}),
                )
            }
            "messages" => {
                let mut params = json!({"channel":chat,"limit":30});
                if req["cursor"].as_str().is_some_and(|s| !s.is_empty()) {
                    params["cursor"] = req["cursor"].clone();
                }
                if req["message_id"].as_str().is_some_and(|s| !s.is_empty()) {
                    params["latest"] = req["message_id"].clone();
                    params["inclusive"] = json!(true);
                }
                let result = call(io, "conversations.history", params).await?;
                let mut messages = self.messages(items(&result["messages"]), chat, io).await?;
                messages.reverse();
                let cursor = string(&result["response_metadata"]["next_cursor"]);
                Ok(
                    json!({"messages":messages,"next_cursor":if cursor.is_empty(){None}else{Some(cursor)},"complete":result["has_more"] != true}),
                )
            }
            _ => Err("지원하지 않는 Slack 작업".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Mock {
        calls: Vec<Value>,
        invalid: Value,
        members_cursor: bool,
        list_cursor: bool,
        fail_profile: bool,
    }
    impl Mock {
        fn one(&mut self, req: Value) -> Result<Value, String> {
            self.calls.push(req.clone());
            let data = match string(&req["op"]) {
                "slack.users.list" => {
                    json!({"members":[{"id":"u","profile":{"display_name":"원래 이름"}}]})
                }
                "slack.users.info" => {
                    if self.fail_profile {
                        return Err("profile failed".into());
                    }
                    json!({"user":{"name":"외부 이름"}})
                }
                "slack.conversations.list" => {
                    json!({"channels":[{"id":"a","is_im":true,"user":"u"},{"id":"b","is_im":true,"user":"external"},{"id":"g","is_mpim":true}],"response_metadata":{"next_cursor":if self.list_cursor{"repeat"}else{""}}})
                }
                "slack.client.counts" => {
                    json!({"ims":[{"id":"a","latest":"42","updated":"1","history_invalid":if self.invalid.is_null(){json!(false)}else{self.invalid.clone()}}]})
                }
                "slack.conversations.members" => {
                    json!({"members":["u","external"],"response_metadata":{"next_cursor":if self.members_cursor{"repeat"}else{""}}})
                }
                "slack.conversations.history" => {
                    if req["params"]["limit"] == 1 {
                        json!({"messages":[{"ts":"42","text":req["params"]["channel"]}]})
                    } else {
                        json!({"messages":[{"ts":"42","user":"same","text":"new"},{"ts":"41","user":"same","text":"old"}],"has_more":true,"response_metadata":{"next_cursor":"next"}})
                    }
                }
                "slack.search.messages" => {
                    json!({"messages":{"matches":[{"ts":"42","channel":{"id":"b"},"user":"u","text":"match"}],"pagination":{"page_count":2}}})
                }
                "slack.chat.postMessage" => json!({"ts":"43","message":{"user":"sender"}}),
                op => panic!("unexpected {op}"),
            };
            Ok(json!({"data":data}))
        }
        fn count(&self, method: &str) -> usize {
            self.calls
                .iter()
                .filter(|r| r["op"] == format!("slack.{method}"))
                .count()
        }
    }
    impl ProviderIo for Mock {
        async fn call(&mut self, req: Value) -> Result<Value, String> {
            if req["op"] == "batch" {
                let mut results = Vec::new();
                for r in items(&req["requests"]) {
                    results.push(self.one(r)?);
                }
                Ok(json!({"results":results}))
            } else {
                self.one(req)
            }
        }
    }
    #[tokio::test]
    async fn names_members_ttl_and_watermark_reuse() {
        let mut backend = SlackBackend::default();
        let mut io = Mock::default();
        let first = backend.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        assert_eq!(first["chats"][0]["title"], "원래 이름");
        assert_eq!(first["chats"][1]["title"], "외부 이름");
        assert_eq!(first["chats"][2]["title"], "원래 이름, 외부 이름");
        assert_eq!(io.count("users.info"), 1);
        backend.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        io.calls.clear();
        backend.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        assert_eq!(io.count("conversations.history"), 2);
        assert_eq!(io.count("conversations.members"), 0);
        assert_eq!(io.count("users.list"), 0);
        io.invalid = json!(true);
        io.calls.clear();
        backend.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        assert_eq!(io.count("conversations.history"), 3);
        backend.names_updated = Some(Instant::now() - TTL - Duration::from_secs(1));
        for (at, _) in backend.members.values_mut() {
            *at = Instant::now() - TTL - Duration::from_secs(1);
        }
        io.calls.clear();
        backend.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        assert_eq!(io.count("users.list"), 1);
        assert_eq!(io.count("conversations.members"), 1);
    }
    #[tokio::test]
    async fn messages_deduplicate_profiles_reverse_and_preserve_pagination() {
        let mut backend = SlackBackend::default();
        let mut io = Mock::default();
        let result = backend
            .run(
                &json!({"op":"messages","chat_id":"a","cursor":"older","message_id":"44"}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(io.count("users.info"), 1);
        assert_eq!(result["messages"][0]["body"], "old");
        assert_eq!(result["messages"][1]["author_name"], "외부 이름");
        assert_eq!(result["next_cursor"], "next");
        assert_eq!(result["complete"], false);
        assert_eq!(io.calls[0]["params"]["cursor"], "older");
        assert_eq!(io.calls[0]["params"]["latest"], "44");
    }
    #[tokio::test]
    async fn search_pages_scope_and_send_invalidation() {
        let mut backend = SlackBackend::default();
        let mut io = Mock::default();
        let result = backend
            .run(
                &json!({"op":"search","chat_id":"a","query":"hello"}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(result["next_cursor"], "2");
        assert_eq!(result["messages"][0]["chat_id"], "b");
        assert_eq!(io.calls[0]["params"]["query"], "hello in:a");
        backend
            .summaries
            .insert("a".into(), ("marker".into(), json!({"ts":"42"})));
        io.fail_profile = true;
        let sent = backend
            .run(
                &json!({"op":"send","chat_id":"a","body":"hello","request_id":"dedup"}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(sent["state"], "Sent");
        assert_eq!(sent["receipt"], "43");
        assert_eq!(sent["messages"][0]["body"], "hello");
        assert_eq!(io.count("chat.postMessage"), 1);
        assert!(!backend.summaries.contains_key("a"));
    }
    #[tokio::test]
    async fn repeated_list_and_members_cursors_fail() {
        for members in [false, true] {
            let mut backend = SlackBackend::default();
            let mut io = Mock {
                members_cursor: members,
                list_cursor: !members,
                ..Default::default()
            };
            assert!(
                backend
                    .run(&json!({"op":"chats"}), &mut io)
                    .await
                    .unwrap_err()
                    .contains("커서 반복")
            );
        }
    }
    #[test]
    fn history_watermarks_accept_numeric_strings_only() {
        assert!(!marker(&json!({"latest":"42"})).is_empty());
        for invalid in [json!(false), json!(0), json!("123.45"), json!("42")] {
            assert!(!marker(&json!({"latest":"42","history_invalid":invalid})).is_empty());
        }
        for invalid in [
            Value::Null,
            json!(true),
            json!(1),
            json!("1e3"),
            json!(".4"),
            json!("1."),
            json!("1.2.3"),
        ] {
            assert!(marker(&json!({"latest":"42","history_invalid":invalid})).is_empty());
        }
    }
    #[tokio::test]
    async fn explicit_refresh_and_expiry_clear_backend_state() {
        let mut backend = SlackBackend::default();
        let mut io = Mock::default();
        backend.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        backend.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        backend
            .members
            .insert("removed".into(), (Instant::now(), vec![]));
        io.calls.clear();
        backend
            .run(&json!({"op":"chats","refresh":true}), &mut io)
            .await
            .unwrap();
        assert_eq!(io.count("users.list"), 1);
        assert_eq!(io.count("conversations.history"), 3);
        assert_eq!(io.count("conversations.members"), 1);
        assert!(!backend.members.contains_key("removed"));
        backend.names.insert("stale".into(), "old".into());
        backend.names_epoch = Some(Instant::now() - TTL - Duration::from_secs(1));
        backend
            .run(&json!({"op":"messages","chat_id":"a"}), &mut io)
            .await
            .unwrap();
        assert!(!backend.names.contains_key("stale"));
    }
    #[tokio::test]
    async fn retained_caches_are_bounded() {
        let mut backend = SlackBackend::default();
        let mut io = Mock::default();
        backend.names_epoch = Some(Instant::now());
        for i in 0..20_100 {
            backend.names.insert(i.to_string(), "name".into());
            backend
                .members
                .insert(i.to_string(), (Instant::now(), vec![]));
        }
        let _ = backend.run(&json!({"op":"unknown"}), &mut io).await;
        assert_eq!(backend.names.len(), 20_000);
        assert_eq!(backend.members.len(), 20_000);
    }
    #[tokio::test]
    async fn malformed_directory_response_cannot_complete_empty_directory() {
        struct Malformed;
        impl ProviderIo for Malformed {
            async fn call(&mut self, _: Value) -> Result<Value, String> {
                Ok(json!({"data":{}}))
            }
        }
        let error = SlackBackend::default()
            .run(&json!({"op":"chats"}), &mut Malformed)
            .await
            .unwrap_err();
        assert!(error.contains("conversations.list"));
        for method in [
            "users.list",
            "users.info",
            "conversations.members",
            "conversations.history",
            "search.messages",
            "chat.postMessage",
        ] {
            assert!(data(&json!({"data":{}}), method).is_err());
        }
    }
    #[tokio::test]
    async fn acknowledged_send_does_not_await_optional_profile_lookup() {
        struct HangingProfile {
            sends: usize,
        }
        impl ProviderIo for HangingProfile {
            async fn call(&mut self, r: Value) -> Result<Value, String> {
                if r["op"] == "slack.chat.postMessage" {
                    self.sends += 1;
                    Ok(json!({"data":{"ts":"43","message":{"user":"unknown"}}}))
                } else {
                    std::future::pending().await
                }
            }
        }
        let mut backend = SlackBackend::default();
        let mut io = HangingProfile { sends: 0 };
        let request = json!({"op":"send","chat_id":"a","body":"sent"});
        let result =
            tokio::time::timeout(Duration::from_millis(50), backend.run(&request, &mut io))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(result["receipt"], "43");
        assert_eq!(io.sends, 1);
        assert_eq!(result["messages"][0]["author_name"], "이름 없음");
    }
    #[tokio::test]
    async fn cancelled_send_invalidates_summary_before_mutation_await() {
        struct Pending;
        impl ProviderIo for Pending {
            async fn call(&mut self, _: Value) -> Result<Value, String> {
                std::future::pending().await
            }
        }
        let mut backend = SlackBackend::default();
        backend
            .summaries
            .insert("a".into(), ("marker".into(), json!({"ts":"42"})));
        let request = json!({"op":"send","chat_id":"a","body":"sent"});
        assert!(
            tokio::time::timeout(
                Duration::from_millis(5),
                backend.run(&request, &mut Pending)
            )
            .await
            .is_err()
        );
        assert!(!backend.summaries.contains_key("a"));
    }
    #[tokio::test]
    async fn profile_and_history_batches_preserve_three_request_limit() {
        struct ManyRooms {
            batches: Vec<usize>,
            profiles: usize,
            histories: usize,
        }
        impl ProviderIo for ManyRooms {
            async fn call(&mut self, req: Value) -> Result<Value, String> {
                match string(&req["op"]) {
                    "slack.users.list" => Ok(json!({"data":{"members":[]}})),
                    "slack.conversations.list" => Ok(
                        json!({"data":{"channels":(0..10).map(|i|json!({"id":format!("c{i}"),"is_im":true,"user":format!("u{i}")})).collect::<Vec<_>>()}}),
                    ),
                    "batch" => {
                        let requests = items(&req["requests"]);
                        self.batches.push(requests.len());
                        let results: Vec<_> = requests.iter().map(|r| {
                            if r["op"] == "slack.users.info" {
                                self.profiles += 1;
                                json!({"data":{"user":{"name":r["params"]["user"]}}})
                            } else {
                                assert_eq!(r["op"],"slack.conversations.history");
                                self.histories += 1;
                                json!({"data":{"messages":[{"ts":"42","text":r["params"]["channel"]}]}})
                            }
                        }).collect();
                        Ok(json!({"results":results}))
                    }
                    _ => panic!("unexpected request {req}"),
                }
            }
        }
        let mut io = ManyRooms {
            batches: vec![],
            profiles: 0,
            histories: 0,
        };
        let result = SlackBackend::default()
            .run(&json!({"op":"chats"}), &mut io)
            .await
            .unwrap();
        assert_eq!(io.profiles, 10);
        assert_eq!(io.histories, 10);
        assert_eq!(io.batches, vec![3, 3, 3, 1, 3, 3, 3, 1]);
        let chats = result["chats"].as_array().unwrap();
        assert_eq!(chats.len(), 10);
        for (i, chat) in chats.iter().enumerate() {
            assert_eq!(chat["title"], format!("u{i}"));
            assert_eq!(chat["preview"], format!("c{i}"));
        }
    }
    #[tokio::test]
    async fn mpim_member_pages_batch_three_rooms_preserve_order_and_cache() {
        #[derive(Default)]
        struct ManyGroups {
            batches: Vec<usize>,
            cursors: HashMap<String, Vec<String>>,
        }
        impl ProviderIo for ManyGroups {
            async fn call(&mut self, req: Value) -> Result<Value, String> {
                Ok(match string(&req["op"]) {
                    "slack.users.list" => {
                        json!({"data":{"members":(0..5).flat_map(|i|(0..2).map(move|p|json!({"id":format!("u{i}-{p}"),"name":format!("member{i}-{p}")}))).collect::<Vec<_>>()}})
                    }
                    "slack.conversations.list" => {
                        json!({"data":{"channels":(0..5).map(|i|json!({"id":format!("g{i}"),"is_mpim":true,"latest":{"ts":"42","text":"latest"}})).collect::<Vec<_>>()}})
                    }
                    "slack.client.counts" => json!({"data":{}}),
                    "batch" => {
                        let requests = items(&req["requests"]);
                        self.batches.push(requests.len());
                        assert!(requests.len() <= 3);
                        let mut room_ids = HashSet::new();
                        let mut results = Vec::new();
                        for r in requests {
                            assert_eq!(r["op"], "slack.conversations.members");
                            let room = string(&r["params"]["channel"]);
                            assert!(room_ids.insert(room.to_owned()));
                            let cursor = string(&r["params"]["cursor"]);
                            let seen = self.cursors.entry(room.into()).or_default();
                            assert_eq!(cursor, if seen.is_empty() { "" } else { "second" });
                            seen.push(cursor.into());
                            let p = usize::from(!cursor.is_empty());
                            results.push(json!({"data":{"members":[format!("u{}-{p}",&room[1..])],"response_metadata":{"next_cursor":if p==0{"second"}else{""}}}}));
                        }
                        json!({"results":results})
                    }
                    _ => panic!("unexpected request {req}"),
                })
            }
        }
        let mut b = SlackBackend::default();
        let mut io = ManyGroups::default();
        for _ in 0..2 {
            let result = b.run(&json!({"op":"chats"}), &mut io).await.unwrap();
            let chats = items(&result["chats"]);
            assert_eq!(chats.len(), 5);
            for (i, c) in chats.iter().enumerate() {
                assert_eq!(c["chat_id"], format!("g{i}"));
                assert_eq!(c["title"], format!("member{i}-0, member{i}-1"));
            }
        }
        assert_eq!(io.batches, vec![3, 3, 3, 1]);
        assert_eq!(io.cursors.len(), 5);
        assert!(io.cursors.values().all(|c| c == &["", "second"]));
        assert_eq!(b.members.len(), 5);
    }
    #[tokio::test]
    async fn member_batches_preserve_page_member_and_response_limits() {
        struct Limited {
            mode: &'static str,
            pages: usize,
        }
        impl ProviderIo for Limited {
            async fn call(&mut self, req: Value) -> Result<Value, String> {
                Ok(match string(&req["op"]) {
                    "slack.users.list" => json!({"data":{"members":[]}}),
                    "slack.conversations.list" => {
                        json!({"data":{"channels":[{"id":"g","is_mpim":true}]}})
                    }
                    "batch" => {
                        self.pages += 1;
                        assert_eq!(req["requests"][0]["op"], "slack.conversations.members");
                        match self.mode {
                            "malformed" => json!({"results":[]}),
                            "members" => json!({"results":[{"data":{"members":vec!["u";20001]}}]}),
                            _ => {
                                json!({"results":[{"data":{"members":[],"response_metadata":{"next_cursor":self.pages.to_string()}}}]})
                            }
                        }
                    }
                    _ => panic!("unexpected {req}"),
                })
            }
        }
        for mode in ["malformed", "members", "pages"] {
            let mut b = SlackBackend::default();
            let mut io = Limited { mode, pages: 0 };
            let error = b.run(&json!({"op":"chats"}), &mut io).await.unwrap_err();
            assert!(error.contains(if mode == "malformed" {
                "응답 누락"
            } else {
                "멤버 제한"
            }));
            assert_eq!(io.pages, if mode == "pages" { 100 } else { 1 });
            assert!(b.members.is_empty());
        }
    }
}
