use super::*;
use std::os::unix::fs::PermissionsExt;

fn creds() -> Credentials {
    Credentials {
        bot_token: "fixture-old".into(),
        session_cookie: Some("fixture-cookie".into()),
        team_id: Some("T1".into()),
        user_id: Some("U1".into()),
    }
}
async fn mock(
    responses: Vec<(u16, Value)>,
) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&requests);
    let task = tokio::spawn(async move {
        for (code, body) in responses {
            let (stream, _) = listener.accept().await.unwrap();
            let mut input = BufReader::new(stream);
            let mut raw = String::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                input.read_line(&mut line).await.unwrap();
                if line.to_ascii_lowercase().starts_with("content-length:") {
                    length = line
                        .split(':')
                        .nth(1)
                        .unwrap()
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                }
                raw.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut bytes = vec![0; length];
            input.read_exact(&mut bytes).await.unwrap();
            raw.push_str(&String::from_utf8(bytes).unwrap());
            captured.lock().await.push(raw);
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 {code} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            input
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        }
    });
    (url, requests, task)
}
fn account(base: String, helper: PathBuf) -> Account {
    Account {
        client: Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .http1_only()
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap(),
        credentials: watch::channel(creds()).0,
        recovery: Mutex::new(()),
        remembered: AtomicBool::new(true),
        helper,
        api_base: base,
    }
}
#[tokio::test]
async fn native_read_preserves_form_auth_and_normalizes_huddle_channels() {
    let (url, requests, server) = mock(vec![(
        200,
        json!({"ok":true,"messages":[{"ts":"1","channel":"C1","text":"fixture"}]}),
    )])
    .await;
    let a = account(url, "/nonexistent-helper".into());
    let result = a
        .dispatch(json!({"op":"slack.conversations.history","params":{"channel":"C1","limit":30}}))
        .await
        .unwrap();
    assert_eq!(result["data"]["messages"][0]["channel"], json!({"id":"C1"}));
    server.await.unwrap();
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("authorization: Bearer fixture-old"));
    assert!(requests[0].contains("cookie: d=fixture-cookie"));
    assert!(requests[0].contains("channel=C1"));
}
#[tokio::test]
async fn send_auth_failure_never_retries_or_launches_recovery() {
    let (url, requests, server) =
        mock(vec![(200, json!({"ok":false,"error":"invalid_auth"}))]).await;
    let a = account(url, "/nonexistent-helper".into());
    assert_eq!(a.dispatch(json!({"op":"slack.chat.postMessage","params":{"channel":"C1","text":"fixture","client_msg_id":"idempotency-fixture"}})).await,Err(Error::Auth));
    server.await.unwrap();
    assert_eq!(requests.lock().await.len(), 1);
}
#[tokio::test]
async fn batch_drains_reads_prioritizes_rate_limit_and_rejects_mutations_before_io() {
    let (url, requests, server) =
        mock(vec![(500, json!({"ok":false})), (429, json!({"ok":false}))]).await;
    let a = account(url, "/nonexistent-helper".into());
    let result=a.dispatch(json!({"op":"batch","requests":[{"op":"slack.users.info","params":{"user":"U1"}},{"op":"slack.users.info","params":{"user":"U2"}}]})).await;
    assert_eq!(result, Err(Error::Rate));
    server.await.unwrap();
    assert_eq!(requests.lock().await.len(), 2);
    assert_eq!(a.dispatch(json!({"op":"batch","requests":[{"op":"slack.chat.postMessage","params":{"channel":"C1","text":"x","client_msg_id":"x"}}]})).await,Err(Error::Request));
}
#[tokio::test]
async fn recovery_is_single_flight_for_concurrent_read_failures() {
    let dir = tempfile::tempdir().unwrap();
    let helper = dir.path().join("helper");
    std::fs::write(&helper,"#!/bin/sh\ncat >/dev/null\nprintf '%s' '{\"ok\":true,\"result\":{\"bot_token\":\"fixture-new\",\"session_cookie\":\"fixture-cookie\",\"team_id\":\"T1\",\"user_id\":\"U1\"}}'\n").unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let (url, requests, server) = mock(vec![
        (200, json!({"ok":false,"error":"token_expired"})),
        (200, json!({"ok":false,"error":"token_expired"})),
        (200, json!({"ok":true,"user":{"id":"U1"}})),
        (200, json!({"ok":true,"user":{"id":"U2"}})),
    ])
    .await;
    let a = account(url, helper);
    let result=a.dispatch(json!({"op":"batch","requests":[{"op":"slack.users.info","params":{"user":"U1"}},{"op":"slack.users.info","params":{"user":"U2"}}]})).await.unwrap();
    assert_eq!(result["results"].as_array().unwrap().len(), 2);
    server.await.unwrap();
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 4);
    assert!(
        requests[2..]
            .iter()
            .all(|r| r.contains("Bearer fixture-new"))
    );
}
#[tokio::test]
async fn oversized_or_redirected_api_responses_fail_closed() {
    let (url, _, server) = mock(vec![
        (200, json!({"ok":true,"padding":"x".repeat(RESPONSE_LIMIT)})),
        (302, json!({"ok":true})),
    ])
    .await;
    let a = account(url, "/nonexistent-helper".into());
    assert_eq!(
        a.once(&creds(), "users.list", &json!({})).await,
        Err(Error::Frame)
    );
    assert_eq!(
        a.once(&creds(), "users.list", &json!({})).await,
        Err(Error::Request)
    );
    let _ = server.await;
}
#[test]
fn hints_are_content_free_and_edits_keep_original_ids() {
    assert_eq!(
        event_hint(
            &json!({"type":"message","subtype":"message_changed","channel":"C","ts":"9","message":{"ts":"1","text":"private"}})
        ),
        Some(json!({"event":"changed","chat_id":"C","message_id":"1"}))
    );
    assert_eq!(
        event_hint(
            &json!({"type":"message","subtype":"message_deleted","channel":"C","deleted_ts":"1","previous_message":{"text":"private"}})
        ),
        Some(json!({"event":"deleted","chat_id":"C","message_id":"1"}))
    );
    assert!(event_hint(&json!({"type":"user_typing","user":"secret"})).is_none());
    let (tx, _rx) = mpsc::channel(1);
    let events = Events {
        hints: tx,
        state: watch::channel(None).0,
        gap: Arc::new(AtomicBool::new(false)),
    };
    events.emit(json!({"event":"changed"}));
    events.emit(json!({"event":"changed"}));
    assert!(events.gap.load(Ordering::SeqCst));
}
#[test]
fn endpoints_and_selected_attachment_identity_are_strict() {
    assert!(allowed_socket(
        &Url::parse("wss://wss-primary.slack.com/?ticket=fixture").unwrap()
    ));
    for u in [
        "ws://wss-primary.slack.com",
        "wss://slack.com.attacker.test",
        "wss://user@wss-primary.slack.com",
    ] {
        assert!(!allowed_socket(&Url::parse(u).unwrap()));
    }
    for u in [
        "http://files.slack.com/a",
        "https://files.slack.com.attacker.test/a",
        "https://user@files.slack.com/a",
    ] {
        assert!(!allowed_upload(&Url::parse(u).unwrap()));
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    std::fs::write(&path, b"abc").unwrap();
    let file = json!({"path":path,"size":3,"sha256":format!("{:x}",Sha256::digest(b"abc"))});
    assert_eq!(read_attachment(&file).unwrap(), b"abc");
    std::fs::write(&path, b"xyz").unwrap();
    assert_eq!(read_attachment(&file), Err(Error::Request));
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert_eq!(
        read_attachment(&json!({"path":link,"size":3})),
        Err(Error::Request)
    );
}
#[tokio::test]
async fn input_is_bounded_and_unterminated_frames_are_rejected() {
    let mut input = BufReader::new(&b"{\"op\":\"bad\"}"[..]);
    assert_eq!(read_frame(&mut input).await, Err(Error::Frame));
    let bytes = vec![b'x'; 65537];
    let mut input = BufReader::new(bytes.as_slice());
    assert_eq!(read_frame(&mut input).await, Err(Error::Frame));
}
#[tokio::test(start_paused = true)]
async fn socket_heartbeats_hints_and_credential_change_are_independent_of_rpc() {
    use tokio_tungstenite::{WebSocketStream, tungstenite::protocol::Role};
    let (a, b) = tokio::io::duplex(16384);
    let client = WebSocketStream::from_raw_socket(a, Role::Client, None).await;
    let mut server = WebSocketStream::from_raw_socket(b, Role::Server, None).await;
    let (tx, mut rx) = mpsc::channel(8);
    let (state, mut states) = watch::channel(None);
    let events = Events {
        hints: tx,
        state,
        gap: Arc::new(AtomicBool::new(false)),
    };
    let (credentials, mut changes) = watch::channel(creds());
    let task = tokio::spawn(async move { drive_socket(client, &events, &mut changes).await });
    server
        .send(Message::Text(json!({"type":"hello"}).to_string().into()))
        .await
        .unwrap();
    states.changed().await.unwrap();
    assert_eq!(states.borrow().as_ref().unwrap()["state"], "connected");
    let _ = rx.recv().await;
    tokio::time::advance(Duration::from_secs(30)).await;
    let ping = server.next().await.unwrap().unwrap().into_text().unwrap();
    let ping: Value = serde_json::from_str(&ping).unwrap();
    assert_eq!(ping["type"], "ping");
    server
        .send(Message::Text(
            json!({"type":"pong","reply_to":ping["id"]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    server
        .send(Message::Text(
            json!({"type":"message","channel":"C","ts":"1","text":"private"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        rx.recv().await.unwrap(),
        json!({"event":"changed","chat_id":"C","message_id":"1"})
    );
    let mut next = creds();
    next.bot_token = "fixture-new".into();
    credentials.send_replace(next);
    assert_eq!(task.await.unwrap(), Ok(()));
}
#[tokio::test(start_paused = true)]
async fn missing_pong_forces_reconnect() {
    use tokio_tungstenite::{WebSocketStream, tungstenite::protocol::Role};
    let (a, b) = tokio::io::duplex(16384);
    let client = WebSocketStream::from_raw_socket(a, Role::Client, None).await;
    let mut server = WebSocketStream::from_raw_socket(b, Role::Server, None).await;
    let (tx, _rx) = mpsc::channel(8);
    let events = Events {
        hints: tx,
        state: watch::channel(None).0,
        gap: Arc::new(AtomicBool::new(false)),
    };
    let (_credentials, mut changes) = watch::channel(creds());
    let task = tokio::spawn(async move { drive_socket(client, &events, &mut changes).await });
    tokio::time::advance(Duration::from_secs(30)).await;
    server.next().await.unwrap().unwrap();
    tokio::time::advance(Duration::from_secs(11)).await;
    assert_eq!(task.await.unwrap(), Err(Error::Request));
}

#[tokio::test]
async fn native_successful_send_and_leave_preserve_single_mutation_contract() {
    let (url, requests, server) = mock(vec![
        (200, json!({"ok":true,"ts":"42","message":{"user":"U1"}})),
        (200, json!({"ok":true,"channel":{"id":"C1","is_im":true}})),
        (200, json!({"ok":true})),
    ])
    .await;
    let a = account(url, "/nonexistent-helper".into());
    let sent=a.dispatch(json!({"op":"slack.chat.postMessage","params":{"channel":"C1","text":"fixture","client_msg_id":"stable-fixture"}})).await.unwrap();
    assert_eq!(sent["data"]["ts"], "42");
    assert_eq!(
        a.dispatch(json!({"op":"slack_leave","chat_id":"C1"}))
            .await
            .unwrap(),
        json!({"state":"Left"})
    );
    server.await.unwrap();
    let requests = requests.lock().await;
    assert_eq!(requests.len(), 3);
    assert!(requests[0].starts_with("POST /chat.postMessage "));
    assert!(requests[0].contains("client_msg_id=stable-fixture"));
    assert!(requests[2].starts_with("POST /conversations.close "));
}
#[tokio::test]
async fn file_identity_is_verified_before_io_and_untrusted_upload_destination_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file");
    std::fs::write(&path, b"abc").unwrap();
    let (url, requests, server) = mock(vec![(
        200,
        json!({"ok":true,"file_id":"F1","upload_url":"https://attacker.test/upload"}),
    )])
    .await;
    let a = account(url, "/nonexistent-helper".into());
    let mut request = json!({"op":"slack_send_file","chat_id":"C1","file":{"path":path,"name":"file.txt","size":3,"sha256":"0".repeat(64)}});
    assert_eq!(a.dispatch(request.clone()).await, Err(Error::Request));
    assert!(requests.lock().await.is_empty());
    request["file"]["sha256"] = json!(format!("{:x}", Sha256::digest(b"abc")));
    assert_eq!(a.dispatch(request).await, Err(Error::Request));
    server.await.unwrap();
    assert_eq!(requests.lock().await.len(), 1);
}

#[test]
fn malformed_vendor_ids_become_rescans_without_poisoning_the_hint_pipe() {
    assert_eq!(
        event_hint(&json!({"type":"message","channel":"","ts":"1"})),
        Some(json!({"event":"gap"}))
    );
    assert_eq!(
        event_hint(&json!({"type":"message","channel":"C","ts":"x".repeat(300)})),
        Some(json!({"event":"gap"}))
    );
    let (tx, mut rx) = mpsc::channel(1);
    let events = Events {
        hints: tx,
        state: watch::channel(None).0,
        gap: Arc::new(AtomicBool::new(false)),
    };
    events.emit(json!({"event":"changed","chat_id":"x".repeat(2000)}));
    assert!(events.gap.load(Ordering::SeqCst));
    assert_eq!(rx.try_recv().unwrap(), json!({"event":"changed"}));
}
