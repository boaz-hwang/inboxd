use crate::config::KeychainConfig;
use std::process::{Command, Stdio};
use zeroize::{Zeroize, Zeroizing};

const MAX_DATABASE_KEY_BYTES: usize = 4_096;

pub(crate) fn database_key(config: &KeychainConfig) -> Result<Zeroizing<Vec<u8>>, String> {
    #[cfg(feature = "test-key-provider")]
    if let Some(value) = std::env::var_os("INBOXD_TEST_DATABASE_KEY_HEX") {
        return test_database_key(value);
    }

    keychain_database_key(config)
}

#[cfg(feature = "test-key-provider")]
fn test_database_key(value: std::ffi::OsString) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut encoded = Zeroizing::new(
        value
            .into_string()
            .map_err(|_| "test database key must be lowercase hexadecimal".to_owned())?,
    );
    if encoded.len() != 64
        || !encoded
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err("test database key must be exactly 64 lowercase hexadecimal bytes".into());
    }
    let mut key = Zeroizing::new(Vec::with_capacity(32));
    for pair in encoded.as_bytes().chunks_exact(2) {
        key.push((hex_nibble(pair[0]) << 4) | hex_nibble(pair[1]));
    }
    encoded.zeroize();
    Ok(key)
}

#[cfg(feature = "test-key-provider")]
fn hex_nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        _ => unreachable!("validated lowercase hexadecimal byte"),
    }
}

#[cfg(target_os = "macos")]
fn keychain_database_key(config: &KeychainConfig) -> Result<Zeroizing<Vec<u8>>, String> {
    let mut output = Command::new("/usr/bin/security")
        .arg("find-generic-password")
        .arg("-s")
        .arg(&config.service)
        .arg("-a")
        .arg(&config.account)
        .arg("-w")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "unable to retrieve SQLCipher key from macOS Keychain".to_owned())?;
    if !output.status.success() {
        output.stdout.zeroize();
        return Err("unable to retrieve SQLCipher key from macOS Keychain".into());
    }

    let mut key = Zeroizing::new(std::mem::take(&mut output.stdout));
    while key.last().is_some_and(|byte| matches!(byte, b'\r' | b'\n')) {
        key.pop();
    }
    if key.is_empty()
        || key.len() > MAX_DATABASE_KEY_BYTES
        || key.as_slice().contains(&0)
        || std::str::from_utf8(key.as_slice()).is_err()
    {
        return Err("macOS Keychain returned invalid SQLCipher key material".into());
    }
    Ok(key)
}

#[cfg(not(target_os = "macos"))]
fn keychain_database_key(_config: &KeychainConfig) -> Result<Zeroizing<Vec<u8>>, String> {
    Err("macOS Keychain is unavailable on this platform".into())
}
