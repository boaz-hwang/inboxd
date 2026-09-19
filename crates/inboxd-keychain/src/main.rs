#![forbid(unsafe_code)]
// Intentionally independent of the daemon and UI crates. Its designated code
// requirement remains stable when the rest of Inboxd is rebuilt.
#[cfg(target_os = "macos")]
use security_framework::passwords::{get_generic_password, set_generic_password};
use std::io::{IsTerminal, Write};
#[cfg(target_os = "macos")]
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;
const MAX_DATABASE_KEY_BYTES: usize = 4096;
const DATABASE_KEY_BYTES: usize = 32;
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
struct KeychainConfig {
    service: String,
    account: String,
}
fn main() {
    if let Err(message) = run() {
        eprintln!("inboxd-keychain: {message}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("inboxd-keychain/v1");
        return Ok(());
    }
    if args.len() != 3 || !matches!(args[0].as_str(), "get" | "ensure") {
        return Err("usage: inboxd-keychain <get|ensure> <service> <account>".into());
    }
    validate_label(&args[1])?;
    validate_label(&args[2])?;
    if args[0] == "ensure" {
        return ensure_database_key(&args[1], &args[2]);
    }
    if std::io::stdout().is_terminal() {
        return Err("key output requires a private pipe".into());
    }
    #[cfg(target_os = "macos")]
    let _interaction =
        security_framework::os::macos::keychain::SecKeychain::disable_user_interaction()
            .map_err(|_| "unable to disable automatic Keychain prompts")?;
    let key = keychain_database_key(&KeychainConfig {
        service: args[1].clone(),
        account: args[2].clone(),
    })?;
    std::io::stdout()
        .lock()
        .write_all(key.as_slice())
        .map_err(|_| "private key pipe unavailable".to_owned())
}
#[cfg(target_os = "macos")]
fn keychain_database_key(config: &KeychainConfig) -> Result<Zeroizing<Vec<u8>>, String> {
    let key = Zeroizing::new(
        get_generic_password(&config.service, &config.account)
            .map_err(|_| "unable to retrieve SQLCipher key from macOS Keychain".to_owned())?,
    );
    validate_database_key(key)
}

#[cfg(target_os = "macos")]
fn ensure_database_key(service: &str, account: &str) -> Result<(), String> {
    validate_label(service)?;
    validate_label(account)?;
    match get_generic_password(service, account) {
        Ok(existing) => {
            validate_database_key(Zeroizing::new(existing))?;
            return Ok(());
        }
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {}
        Err(_) => return Err("unable to inspect SQLCipher key in macOS Keychain".into()),
    }

    let mut bytes = Zeroizing::new([0_u8; DATABASE_KEY_BYTES]);
    getrandom::fill(bytes.as_mut())
        .map_err(|_| "secure SQLCipher key generation failed".to_owned())?;
    let encoded = Zeroizing::new(hex(bytes.as_ref()));
    set_generic_password(service, account, encoded.as_bytes())
        .map_err(|_| "unable to initialize SQLCipher key in macOS Keychain".to_owned())?;
    let stored = Zeroizing::new(
        get_generic_password(service, account)
            .map_err(|_| "unable to verify SQLCipher key in macOS Keychain".to_owned())?,
    );
    if stored.as_slice().ct_eq(encoded.as_bytes()).unwrap_u8() != 1 {
        return Err("SQLCipher key read-back did not match".into());
    }
    validate_database_key(stored).map(|_| ())
}

#[cfg(target_os = "macos")]
fn validate_database_key(key: Zeroizing<Vec<u8>>) -> Result<Zeroizing<Vec<u8>>, String> {
    if key.is_empty()
        || key.len() > MAX_DATABASE_KEY_BYTES
        || key.as_slice().contains(&0)
        || std::str::from_utf8(key.as_slice()).is_err()
    {
        return Err("macOS Keychain returned invalid SQLCipher key material".into());
    }
    Ok(key)
}

fn validate_label(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.as_bytes().contains(&0) {
        return Err("Keychain label must be a bounded non-empty string without NUL bytes".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

#[cfg(not(target_os = "macos"))]
fn keychain_database_key(_config: &KeychainConfig) -> Result<Zeroizing<Vec<u8>>, String> {
    Err("macOS Keychain is unavailable on this platform".into())
}

#[cfg(not(target_os = "macos"))]
fn ensure_database_key(_service: &str, _account: &str) -> Result<(), String> {
    Err("macOS Keychain is unavailable on this platform".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn validates_labels_before_keychain_access() {
        for label in ["", "bad\0label", &"x".repeat(257)] {
            assert!(validate_label(label).is_err());
        }
        assert!(validate_label("com.inboxd.database").is_ok());
    }
    #[test]
    fn rejects_empty_binary_or_oversized_database_material() {
        for bytes in [vec![], vec![0], vec![255], vec![b'x'; 4097]] {
            assert!(validate_database_key(Zeroizing::new(bytes)).is_err());
        }
        assert!(validate_database_key(Zeroizing::new(vec![b'a'; 64])).is_ok());
    }
}
