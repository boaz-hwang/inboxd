#![forbid(unsafe_code)]

mod config;
mod keychain;

use inboxd_daemon::{DaemonConfig, launch};
use std::{ffi::OsString, path::PathBuf, time::Duration};
use tokio::{
    runtime::Builder,
    signal::unix::{SignalKind, signal},
    time::timeout,
};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const USAGE: &str = "usage: inboxd-daemon --config <owner-only-config.json>";

fn main() {
    if let Err(error) = run() {
        eprintln!("inboxd-daemon: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let config_path = parse_config_path(std::env::args_os())?;
    let mut loaded = config::load(&config_path)?;
    let bindings = loaded.take_provider_bindings()?;
    let database_key = keychain::database_key(&loaded.keychain)?;
    let daemon_config = DaemonConfig::new(
        &loaded.state_dir,
        &loaded.database_path,
        &loaded.socket_path,
        database_key.as_slice().to_vec(),
    )
    .with_bindings(bindings);
    let runtime = Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| "unable to initialize daemon runtime".to_owned())?;
    runtime.block_on(serve(daemon_config))
}

fn parse_config_path(arguments: impl IntoIterator<Item = OsString>) -> Result<PathBuf, String> {
    let mut arguments = arguments.into_iter();
    let _program = arguments.next();
    match (arguments.next(), arguments.next(), arguments.next()) {
        (Some(flag), Some(path), None) if flag == "--config" => Ok(PathBuf::from(path)),
        _ => Err(USAGE.into()),
    }
}

async fn serve(config: DaemonConfig) -> Result<(), String> {
    let mut interrupt = signal(SignalKind::interrupt())
        .map_err(|_| "unable to register SIGINT handler".to_owned())?;
    let mut terminate = signal(SignalKind::terminate())
        .map_err(|_| "unable to register SIGTERM handler".to_owned())?;
    let daemon = launch(config).await.map_err(|error| error.to_string())?;

    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
    }

    match timeout(SHUTDOWN_TIMEOUT, daemon.shutdown()).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("daemon shutdown failed: {error}")),
        Err(_) => Err("daemon shutdown exceeded its bounded deadline".into()),
    }
}
