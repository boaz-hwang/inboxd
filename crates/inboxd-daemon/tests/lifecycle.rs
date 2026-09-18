use inboxd_daemon::{DaemonConfig, launch};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};
use tempfile::TempDir;
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, net::UnixStream};

fn private_tempdir() -> TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

fn config(directory: &Path) -> DaemonConfig {
    DaemonConfig::new(
        directory,
        directory.join("inboxd.db"),
        directory.join("sock"),
        [0x44; 32],
    )
}

async fn read_frame(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) -> Value {
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap()
}

#[tokio::test]
async fn rust_owner_serves_fragmented_json_lines_and_explicit_unsupported_settings() {
    let directory = private_tempdir();
    let daemon = launch(config(directory.path())).await.unwrap();
    let stream = UnixStream::connect(daemon.socket_path()).await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut read = BufReader::new(read);

    let hello = serde_json::to_vec(&json!({"type":"request","id":"hello","method":"system.hello","params":{"role":"reader","label":"한🙂"}})).unwrap();
    let split = hello.windows(3).position(|bytes| bytes == "한".as_bytes()).unwrap() + 1;
    write.write_all(&hello[..split]).await.unwrap();
    write.write_all(&hello[split..]).await.unwrap();
    write.write_all(b"\n").await.unwrap();
    assert_eq!(read_frame(&mut read).await["result"], json!({"protocol":"inboxd","ready":true}));

    write.write_all(b"{\"type\":\"request\",\"id\":\"ping\",\"method\":\"system.ping\",\"params\":{}}\n").await.unwrap();
    assert_eq!(read_frame(&mut read).await["result"], json!({"pong":true}));

    for method in ["settings.get", "settings.update"] {
        let frame = json!({"type":"request","id":method,"method":method,"params":{}});
        write.write_all(serde_json::to_string(&frame).unwrap().as_bytes()).await.unwrap();
        write.write_all(b"\n").await.unwrap();
        let response = read_frame(&mut read).await;
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "UNSUPPORTED");
    }
    daemon.shutdown().await.unwrap();
}

#[tokio::test]
async fn lifecycle_is_private_single_instance_and_reclaims_stale_resources() {
    let directory = private_tempdir();
    let config = config(directory.path());
    let daemon = launch(config.clone()).await.unwrap();
    for path in [daemon.socket_path(), &directory.path().join("inboxd.lock"), &directory.path().join("approver.token")] {
        assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(launch(config.clone()).await.is_err());
    daemon.shutdown().await.unwrap();
    assert!(!config.socket_path.exists());
    assert!(!directory.path().join("inboxd.lock").exists());

    fs::write(&config.socket_path, b"not-a-socket").unwrap();
    assert!(launch(config.clone()).await.is_err());
    fs::remove_file(&config.socket_path).unwrap();

    let restarted = launch(config).await.unwrap();
    restarted.shutdown().await.unwrap();
}

#[tokio::test]
async fn hello_is_required_and_malformed_stream_fails_closed() {
    let directory = private_tempdir();
    let daemon = launch(config(directory.path())).await.unwrap();
    let stream = UnixStream::connect(daemon.socket_path()).await.unwrap();
    let (read, mut write) = stream.into_split();
    let mut read = BufReader::new(read);
    write.write_all(b"{\"type\":\"request\",\"id\":\"p\",\"method\":\"system.ping\",\"params\":{}}\n").await.unwrap();
    let response = read_frame(&mut read).await;
    assert_eq!(response["error"]["code"], "UNSUPPORTED");
    assert!(response["error"]["message"].as_str().unwrap().contains("system.hello"));

    write.write_all(b"not-json\n").await.unwrap();
    let malformed = read_frame(&mut read).await;
    assert_eq!(malformed["error"]["code"], "BAD_REQUEST");
    let mut trailing = String::new();
    assert_eq!(read.read_line(&mut trailing).await.unwrap(), 0);
    daemon.shutdown().await.unwrap();
}
