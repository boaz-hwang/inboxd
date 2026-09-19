use crate::config::KeychainConfig;
#[cfg(feature = "test-key-provider")]
use zeroize::Zeroize;
use zeroize::Zeroizing;

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

fn helper(operation: &str, service: &str, account: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    for label in [service, account] {
        if label.is_empty() || label.len() > 256 || label.as_bytes().contains(&0) {
            return Err("invalid Keychain label".into());
        }
    }
    let executable = std::env::current_exe()
        .map_err(|_| "Keychain helper path unavailable")?
        .with_file_name("inboxd-keychain");
    inboxd_daemon::validate_trusted_executable_for_owner(
        &executable,
        rustix::process::geteuid().as_raw(),
    )
    .map_err(|_| "Keychain helper must be installed as an owner-only trusted executable")?;
    let output = std::process::Command::new(executable)
        .args([operation, service, account])
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|_| "Keychain helper could not start")?;
    let key = Zeroizing::new(output.stdout);
    if !output.status.success() {
        return Err("saved SQLCipher key is not accessible; unlock Keychain or authorize the stable inboxd-keychain helper once (Always Allow); automatic password prompts are disabled".into());
    }
    Ok(key)
}
fn keychain_database_key(config: &KeychainConfig) -> Result<Zeroizing<Vec<u8>>, String> {
    let key = helper("get", &config.service, &config.account)?;
    if key.is_empty()
        || key.len() > MAX_DATABASE_KEY_BYTES
        || key.contains(&0)
        || std::str::from_utf8(key.as_slice()).is_err()
    {
        return Err("Keychain returned invalid SQLCipher key material".into());
    }
    Ok(key)
}
pub(crate) fn ensure_database_key(service: &str, account: &str) -> Result<(), String> {
    helper("ensure", service, account).map(|_| ())
}
