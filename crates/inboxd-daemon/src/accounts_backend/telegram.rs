use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub(super) struct TelegramBackend {
    names: HashMap<(String, String), String>,
}

impl TelegramBackend {
    pub(super) async fn run(
        &mut self,
        request: &Value,
        io: &mut impl super::ProviderIo,
    ) -> Result<Value, String> {
        let op = request["op"].as_str().unwrap_or("");
        if op == "chats" {
            let mut ids = Vec::new();
            let mut seen = HashSet::new();
            for list in ["main", "archive"] {
                let mut complete = false;
                for _ in 0..100 {
                    let result = io.call(json!({"op":"telegram_load_directory","params":{"list":list},"limit":200})).await?;
                    if result["complete"] == true {
                        complete = true;
                        break;
                    }
                }
                if !complete {
                    return Err("Telegram 목록 로드 제한".into());
                }
                let result = io.call(json!({"op":"telegram_list_directory","params":{"list":list},"limit":20000})).await?;
                let page = result["ids"]
                    .as_array()
                    .ok_or("Malformed Telegram directory")?;
                if page.len() >= 20000 {
                    return Err("Telegram 목록 로드 제한".into());
                }
                for id in page {
                    let id = id.as_str().ok_or("Malformed Telegram chat id")?;
                    if seen.insert(id.to_owned()) {
                        ids.push(id.to_owned());
                    }
                    if ids.len() > 20000 {
                        return Err("Telegram 목록 로드 제한".into());
                    }
                }
            }
            let mut chats = Vec::new();
            for chunk in ids.chunks(8) {
                let requests: Vec<_> = chunk
                    .iter()
                    .map(|id| json!({"op":"telegram_chat","chat_id":id}))
                    .collect();
                let result = io.call(json!({"op":"batch","requests":requests})).await?;
                let results = batch_results(&result, chunk.len())?;
                for (result, expected_id) in results.iter().zip(chunk) {
                    let rows = result["chats"]
                        .as_array()
                        .ok_or("Malformed Telegram chat")?;
                    if rows.len() != 1 || rows[0]["chat_id"].as_str() != Some(expected_id) {
                        return Err("Malformed Telegram chat batch".into());
                    }
                    chats.push(rows[0].clone());
                }
            }
            return Ok(json!({"chats":chats,"complete":true}));
        }
        let provider = match op {
            "send" => {
                if let Some(file) = request.get("file") {
                    json!({"op":"telegram_send_file","chat_id":request["chat_id"],"file":file})
                } else {
                    json!({"op":"telegram_send","chat_id":request["chat_id"],"body":request["body"]})
                }
            }
            "search" => {
                json!({"op":"telegram_search","chat_id":request["chat_id"],"query":request["query"],"cursor":request["cursor"],"limit":100})
            }
            "messages" => {
                json!({"op":"telegram_history","chat_id":request["chat_id"],"limit":30,"message_id":request
                .get("message_id").filter(|v| !v.is_null())
                .or_else(|| request.get("cursor").filter(|v| !v.is_null()))
                .cloned().unwrap_or(json!("0"))})
            }
            _ => return Err(format!("Unsupported Telegram operation: {op}")),
        };
        let mut result = io.call(provider).await?;
        // Once the provider acknowledges a send, never await optional enrichment:
        // cancellation during it would discard a known receipt as Uncertain.
        if op == "send" {
            if let Some(messages) = result["messages"].as_array_mut() {
                for message in messages {
                    let key = (
                        message["author_kind"].as_str().unwrap_or("chat").to_owned(),
                        message["author_id"].as_str().unwrap_or("").to_owned(),
                    );
                    if let Some(object) = message.as_object_mut() {
                        object.insert(
                            "author_name".into(),
                            json!(
                                self.names
                                    .get(&key)
                                    .map(String::as_str)
                                    .unwrap_or("이름 없음")
                            ),
                        );
                        object.remove("author_kind");
                    }
                }
            }
            return Ok(result);
        }
        let mut messages = result["messages"]
            .as_array()
            .cloned()
            .ok_or("Malformed Telegram messages")?;
        if messages.len() > 100 {
            return Err("Telegram message limit exceeded".into());
        }
        // Cache is account-local and bounded; reset between requests before resolving this page.
        if self.names.len() + messages.len() > 20000 {
            self.names.clear();
        }
        let next_cursor = if op == "search"
            && request["chat_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .is_none()
        {
            result
                .get("next_offset")
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                .cloned()
        } else {
            messages.last().and_then(|m| m.get("id")).cloned()
        };
        let mut missing = Vec::new();
        let mut seen = HashSet::new();
        for message in &messages {
            let key = (
                message["author_kind"].as_str().unwrap_or("chat").to_owned(),
                message["author_id"].as_str().unwrap_or("").to_owned(),
            );
            if !self.names.contains_key(&key) && seen.insert(key.clone()) {
                missing.push(key);
            }
        }
        for chunk in missing.chunks(4) {
            let requests: Vec<_> = chunk
                .iter()
                .map(|(kind, id)| json!({"op":"telegram_sender","params":{"kind":kind,"id":id}}))
                .collect();
            let names = io.call(json!({"op":"batch","requests":requests})).await?;
            let values = batch_results(&names, chunk.len())?;
            if !values.iter().all(|value| value["name"].is_string()) {
                return Err("Malformed Telegram sender batch".into());
            }
            for (index, key) in chunk.iter().enumerate() {
                let name = values[index]["name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .unwrap_or("이름 없음");
                self.names.insert(key.clone(), name.to_owned());
            }
        }
        for message in &mut messages {
            let key = (
                message["author_kind"].as_str().unwrap_or("chat").to_owned(),
                message["author_id"].as_str().unwrap_or("").to_owned(),
            );
            message["author_name"] = json!(
                self.names
                    .get(&key)
                    .map(String::as_str)
                    .unwrap_or("이름 없음")
            );
            if let Some(object) = message.as_object_mut() {
                object.remove("author_kind");
            }
        }
        if op == "messages" {
            messages.reverse();
        }
        if op != "send" {
            result = json!({"complete":messages.is_empty()});
            if let Some(cursor) = next_cursor {
                result["next_cursor"] = cursor;
            }
        }
        result["messages"] = json!(messages);
        Ok(result)
    }
}

fn batch_results(result: &Value, expected: usize) -> Result<&Vec<Value>, String> {
    result["results"]
        .as_array()
        .filter(|items| items.len() == expected)
        .ok_or_else(|| "Malformed Telegram batch".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct FakeIo {
        calls: Vec<Value>,
        fail_names: bool,
        never_complete: bool,
        empty_messages: bool,
        malformed_batch: bool,
        oversized_directory: bool,
    }
    impl super::super::ProviderIo for FakeIo {
        async fn call(&mut self, request: Value) -> Result<Value, String> {
            self.calls.push(request.clone());
            Ok(match request["op"].as_str().unwrap() {
                "telegram_load_directory" => json!({"complete":!self.never_complete}),
                "telegram_list_directory" if self.oversized_directory => {
                    json!({"ids": vec!["1";20000]})
                }
                "telegram_list_directory" => {
                    if request["params"]["list"] == "main" {
                        json!({"ids":["1","2"]})
                    } else {
                        json!({"ids":["2","3"]})
                    }
                }
                "batch" if self.malformed_batch => json!({"results":[]}),
                "batch" => {
                    if self.fail_names {
                        return Err("name lookup failed".into());
                    }
                    json!({"results":request["requests"].as_array().unwrap().iter().map(|r| {
                        if r["op"] == "telegram_chat" {json!({"chats":[{"chat_id":r["chat_id"]}]})}
                        else {json!({"name":format!("{}:{}",r["params"]["kind"].as_str().unwrap(),r["params"]["id"].as_str().unwrap())})}
                    }).collect::<Vec<_>>()})
                }
                "telegram_send" => {
                    json!({"state":"Sent","receipt":"3","messages":[{"id":"3","author_id":"7","author_kind":"user"}]})
                }
                "telegram_history" | "telegram_search" if self.empty_messages => {
                    json!({"messages":[]})
                }
                "telegram_history" | "telegram_search" => {
                    json!({"messages":[{"id":"2","author_id":"7","author_kind":"user"},{"id":"1","author_id":"7","author_kind":"chat"}],"next_offset":"opaque"})
                }
                _ => panic!("unexpected request {request}"),
            })
        }
    }
    #[tokio::test]
    async fn history_identity_cache_and_orientation() {
        let mut backend = TelegramBackend::default();
        let mut io = FakeIo::default();
        let result = backend
            .run(
                &json!({"op":"messages","chat_id":"1","cursor":"9"}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(io.calls[0]["message_id"], "9");
        assert_eq!(io.calls[0]["limit"], 30);
        assert_eq!(result["next_cursor"], "1");
        assert_eq!(result["messages"][0]["id"], "1");
        assert_eq!(result["messages"][0]["author_name"], "chat:7");
        assert_eq!(result["messages"][1]["author_name"], "user:7");
        assert!(result["messages"][0].get("author_kind").is_none());
        backend
            .run(&json!({"op":"messages","chat_id":"1"}), &mut io)
            .await
            .unwrap();
        assert_eq!(io.calls.len(), 3);
    }
    #[tokio::test]
    async fn directory_and_search_scopes() {
        let mut backend = TelegramBackend::default();
        let mut io = FakeIo::default();
        let result = backend.run(&json!({"op":"chats"}), &mut io).await.unwrap();
        assert_eq!(result["chats"].as_array().unwrap().len(), 3);
        let result = backend
            .run(&json!({"op":"search","query":"hello"}), &mut io)
            .await
            .unwrap();
        assert_eq!(result["next_cursor"], "opaque");
        assert_eq!(result["messages"][0]["id"], "2");
        let result = backend
            .run(
                &json!({"op":"search","chat_id":"1","query":"hello"}),
                &mut io,
            )
            .await
            .unwrap();
        assert_eq!(result["next_cursor"], "1");
    }
    #[tokio::test]
    async fn acknowledged_send_never_calls_optional_sender_lookup() {
        let mut backend = TelegramBackend::default();
        let mut io = FakeIo {
            fail_names: true,
            ..Default::default()
        };
        let result = backend
            .run(&json!({"op":"send","chat_id":"1","body":"hello"}), &mut io)
            .await
            .unwrap();
        assert_eq!(result["state"], "Sent");
        assert_eq!(result["receipt"], "3");
        assert_eq!(result["messages"][0]["author_name"], "이름 없음");
        assert_eq!(
            io.calls.len(),
            1,
            "No provider call may follow send acknowledgement"
        );
        assert_eq!(
            io.calls
                .iter()
                .filter(|r| r["op"] == "telegram_send")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn directory_load_limit_and_empty_page_termination() {
        let mut backend = TelegramBackend::default();
        let mut io = FakeIo {
            never_complete: true,
            ..Default::default()
        };
        assert_eq!(
            backend
                .run(&json!({"op":"chats"}), &mut io)
                .await
                .unwrap_err(),
            "Telegram 목록 로드 제한"
        );
        assert_eq!(io.calls.len(), 100);
        let mut io = FakeIo {
            empty_messages: true,
            ..Default::default()
        };
        let result = backend
            .run(&json!({"op":"messages","chat_id":"1"}), &mut io)
            .await
            .unwrap();
        assert_eq!(result["complete"], true);
        assert!(result.get("next_cursor").is_none());
        assert_eq!(io.calls.len(), 1);
    }
    #[tokio::test]
    async fn incomplete_batches_fail_without_claiming_complete_and_send_stays_sent() {
        let mut backend = TelegramBackend::default();
        let mut io = FakeIo {
            malformed_batch: true,
            ..Default::default()
        };
        assert!(backend.run(&json!({"op":"chats"}), &mut io).await.is_err());
        assert!(
            backend
                .run(&json!({"op":"messages","chat_id":"1"}), &mut io)
                .await
                .is_err()
        );
        let result = backend
            .run(&json!({"op":"send","chat_id":"1","body":"hello"}), &mut io)
            .await
            .unwrap();
        assert_eq!(result["state"], "Sent");
        let mut io = FakeIo {
            oversized_directory: true,
            ..Default::default()
        };
        assert!(backend.run(&json!({"op":"chats"}), &mut io).await.is_err());
        assert!(!io.calls.iter().any(|r| r["op"] == "batch"));
    }
    #[tokio::test]
    async fn sender_cache_is_bounded_between_requests() {
        let mut backend = TelegramBackend::default();
        for i in 0..20000 {
            backend
                .names
                .insert(("user".into(), i.to_string()), "cached".into());
        }
        let mut io = FakeIo::default();
        backend
            .run(&json!({"op":"messages","chat_id":"1"}), &mut io)
            .await
            .unwrap();
        assert_eq!(backend.names.len(), 2);
    }
    #[tokio::test]
    async fn acknowledged_send_finishes_when_sender_service_would_hang() {
        struct HangingSender;
        impl super::super::ProviderIo for HangingSender {
            async fn call(&mut self, request: Value) -> Result<Value, String> {
                if request["op"] == "telegram_send" {
                    return Ok(
                        json!({"state":"Sent","receipt":"done","messages":[{"id":"done","author_id":"new","author_kind":"user"}]}),
                    );
                }
                std::future::pending().await
            }
        }
        let mut backend = TelegramBackend::default();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            backend.run(
                &json!({"op":"send","chat_id":"1","body":"hello"}),
                &mut HangingSender,
            ),
        )
        .await
        .expect("send must not await sender lookup")
        .unwrap();
        assert_eq!(result["receipt"], "done");
        assert_eq!(result["state"], "Sent");
    }
}
