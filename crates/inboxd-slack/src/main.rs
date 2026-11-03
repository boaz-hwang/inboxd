//! Account-isolated Slack transport. No SDK/JS runtime remains resident.
#![forbid(unsafe_code)]
#[path = "../../inboxd-daemon/src/accounts_backend/contract.rs"]
mod contract;
mod runtime;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // Only allowlisted protocol errors can cross stdout/stderr. In particular,
    // reqwest and WebSocket errors can contain credential-bearing URLs.
    if runtime::serve().await.is_err() {
        std::process::exit(1);
    }
}
