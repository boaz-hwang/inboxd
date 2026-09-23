use inboxd_daemon::{ProductionWorkerConfig, TrustedBinding, WorkerSupervisor};
use rustix::process::geteuid;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_KEYCHAIN_LABEL_BYTES: usize = 256;

pub(crate) struct SecretString(Zeroizing<String>);

impl SecretString {
    fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    fn expose(&self) -> &str {
        self.0.as_str()
    }

    fn into_inner(mut self) -> String {
        std::mem::take(&mut *self.0)
    }
}

impl<'de> Deserialize<'de> for SecretString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self::new)
    }
}

impl Zeroize for SecretString {
    fn zeroize(&mut self) {
        self.0.zeroize();
    }
}

impl ZeroizeOnDrop for SecretString {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigFile {
    version: u8,
    state_dir: PathBuf,
    database_path: PathBuf,
    socket_path: PathBuf,
    keychain: KeychainConfig,
    #[serde(default)]
    providers: Vec<ProviderConfig>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct KeychainConfig {
    pub(crate) service: String,
    pub(crate) account: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ProviderConfig {
    Slack {
        binding_id: String,
        account: String,
        chat_id: String,
        team_id: String,
        bot_token: SecretString,
        #[serde(default)]
        session_cookie: Option<SecretString>,
    },
    Telegram {
        binding_id: String,
        account: String,
        chat_id: String,
        self_user_id: String,
        api_id: u32,
        api_hash: SecretString,
    },
    KakaoPersonal {
        binding_id: String,
        account: String,
        chat_id: String,
        credentials: SecretString,
    },
    KakaoLocal {
        binding_id: String,
        account: String,
        chat_id: String,
        measurement: Option<KakaoMeasurementConfig>,
        max_measurement_age: u64,
        transport_account_id: String,
        transport_chat_id: String,
    },
    KakaoOfficial {
        binding_id: String,
        account: String,
        destination_id: String,
        template_ids: Vec<String>,
        talk_message_consent: KakaoAccessState,
        friends_message_permission: KakaoAccessState,
        observed_at: f64,
        auth_observation: KakaoAuthObservation,
        auth_max_age_seconds: u64,
        access_token: SecretString,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct KakaoMeasurementConfig {
    schema_version: String,
    kind: String,
    status: String,
    observation: String,
    source: String,
    observed_at: f64,
    send: bool,
    supported_read_fields: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KakaoAccessState {
    Granted,
    Denied,
    Unknown,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct KakaoAuthObservation {
    source: String,
    state: KakaoAuthState,
    observed_at: f64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum KakaoAuthState {
    Authenticated,
    Revoked,
    Unknown,
}

pub(crate) struct LoadedConfig {
    pub(crate) state_dir: PathBuf,
    pub(crate) database_path: PathBuf,
    pub(crate) socket_path: PathBuf,
    pub(crate) keychain: KeychainConfig,
    providers: Vec<ProviderConfig>,
}

impl LoadedConfig {
    pub(crate) fn account_configs(&self) -> Result<Vec<inboxd_daemon::AccountConfig>, String> {
        let mut configs = std::collections::BTreeMap::new();
        for provider in &self.providers {
            let (platform, account, config) = match provider {
                ProviderConfig::Slack {
                    account,
                    bot_token,
                    session_cookie,
                    team_id,
                    ..
                } => (
                    "slack",
                    account,
                    json!({"kind":"slack","team_id":team_id,"bot_token":bot_token.expose(),"session_cookie":session_cookie.as_ref().map(SecretString::expose)}),
                ),
                ProviderConfig::Telegram {
                    account,
                    binding_id,
                    api_id,
                    api_hash,
                    ..
                } => {
                    let hash = telegram_binding_hash(binding_id);
                    let (database, files) = WorkerSupervisor::prepare_telegram_state_directories(
                        &self.state_dir,
                        &hash,
                    )?;
                    let tdjson = std::env::current_exe()
                        .map_err(|_| "executable path unavailable")?
                        .with_file_name("inboxd-telegram-libtdjson.dylib");
                    (
                        "telegram",
                        account,
                        json!({"kind":"telegram","api_id":api_id,"api_hash":api_hash.expose(),"database_directory":database,"files_directory":files,"tdjson_path":tdjson}),
                    )
                }
                ProviderConfig::KakaoPersonal {
                    account,
                    credentials,
                    ..
                } => (
                    "kakao",
                    account,
                    json!({"kind":"kakao_personal","credentials":credentials.expose()}),
                ),
                _ => continue,
            };
            configs
                .entry((platform.to_owned(), account.clone()))
                .or_insert(inboxd_daemon::AccountConfig {
                    platform: platform.to_owned(),
                    account: account.clone(),
                    config: Zeroizing::new(config.to_string()),
                });
        }
        Ok(configs.into_values().collect())
    }

    pub(crate) fn take_provider_bindings(&mut self) -> Result<Vec<TrustedBinding>, String> {
        if self.providers.len() > 128 {
            return Err("provider count exceeds the production bound".into());
        }
        let state_directory = self.state_dir.clone();
        self.providers
            .drain(..)
            .map(|provider| provider.into_binding(&state_directory))
            .collect()
    }
}

impl ProviderConfig {
    fn into_binding(self, state_directory: &Path) -> Result<TrustedBinding, String> {
        let (binding_id, claims, worker) = match self {
            Self::Slack {
                binding_id,
                account,
                chat_id,
                team_id,
                bot_token,
                session_cookie,
            } => {
                validate_common(&binding_id, &account)?;
                validate_ascii_identifier(&chat_id, 128, "slack chat_id")?;
                validate_ascii_identifier(&team_id, 128, "slack team_id")?;
                validate_secret(bot_token.expose(), 8_192, "slack bot_token")?;
                let claims = chat_claims("slack", &account, &chat_id, "bounded_history", true);
                let worker = ProductionWorkerConfig::Slack {
                    account,
                    team_id,
                    allowed_chat_ids_json: serde_json::to_string(&[&chat_id])
                        .map_err(|_| "slack configuration could not be encoded".to_owned())?,
                    bot_token: bot_token.into_inner(),
                    session_cookie: session_cookie.map(SecretString::into_inner),
                };
                (binding_id, claims, worker)
            }
            Self::Telegram {
                binding_id,
                account,
                chat_id,
                self_user_id,
                api_id,
                api_hash,
            } => {
                validate_common(&binding_id, &account)?;
                validate_nfc(&binding_id, "telegram binding_id")?;
                validate_nfc(&account, "telegram account")?;
                validate_telegram_chat_id(&chat_id)?;
                validate_canonical_int53(&self_user_id, true, "telegram self_user_id")?;
                if api_id == 0 || api_id > i32::MAX as u32 {
                    return Err("telegram api_id is invalid".into());
                }
                if api_hash.expose().len() != 32
                    || !api_hash
                        .expose()
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err("telegram api_hash is invalid".into());
                }
                let claims = chat_claims("telegram", &account, &chat_id, "bounded_history", true);
                let binding_hash = telegram_binding_hash(&binding_id);
                let (database_directory, files_directory) =
                    WorkerSupervisor::prepare_telegram_state_directories(
                        state_directory,
                        &binding_hash,
                    )?;
                let database_directory = database_directory
                    .to_str()
                    .ok_or_else(|| "telegram database directory must be valid UTF-8".to_owned())?
                    .to_owned();
                let files_directory = files_directory
                    .to_str()
                    .ok_or_else(|| "telegram files directory must be valid UTF-8".to_owned())?
                    .to_owned();
                let worker = ProductionWorkerConfig::Telegram {
                    account,
                    self_user_id,
                    chat_ids_json: serde_json::to_string(&[&chat_id])
                        .map_err(|_| "telegram configuration could not be encoded".to_owned())?,
                    api_id: api_id.to_string(),
                    api_hash: api_hash.into_inner(),
                    database_directory,
                    files_directory,
                };
                (binding_id, claims, worker)
            }
            Self::KakaoPersonal {
                binding_id,
                account,
                chat_id,
                credentials,
            } => {
                validate_common(&binding_id, &account)?;
                validate_value(&chat_id, 128, "kakao chat_id")?;
                validate_secret(credentials.expose(), 16_384, "kakao credentials")?;
                if !chat_id.bytes().all(|b| b.is_ascii_digit()) {
                    return Err("invalid Kakao personal chat".into());
                }
                let mut claims = chat_claims("kakao", &account, &chat_id, "bounded_history", true);
                claims["write"]["reply"] = json!(false);
                claims["read"]["limits"] =
                    json!({"max_page_size":100,"max_pages":1,"cursor":"none"});
                let worker = ProductionWorkerConfig::KakaoPersonal {
                    account,
                    chat_id,
                    credentials_json: credentials.into_inner(),
                };
                (binding_id, claims, worker)
            }
            Self::KakaoLocal {
                binding_id,
                account,
                chat_id,
                measurement,
                max_measurement_age,
                transport_account_id,
                transport_chat_id,
            } => {
                validate_common(&binding_id, &account)?;
                validate_stable_kakao_id(&account, "kakao local account")?;
                validate_stable_kakao_id(&chat_id, "kakao local chat_id")?;
                if max_measurement_age == 0 || max_measurement_age > 86_400 {
                    return Err("kakao local max_measurement_age is invalid".into());
                }
                validate_value(&transport_account_id, 512, "kakao transport account")?;
                validate_value(&transport_chat_id, 512, "kakao transport chat")?;
                validate_measurement(measurement.as_ref())?;
                let fixed_config_json = serde_json::to_string(&json!({
                    "schema_version":"kakao-local-read-worker/v1",
                    "binding_id":binding_id,
                    "allowed_chat":{
                        "v":1,"kind":"chat","platform":"kakao",
                        "account":account,"chat_id":chat_id,
                    },
                    "measurement":measurement,
                    "max_measurement_age":max_measurement_age,
                    "max_items":100,
                    "max_raw_bytes":16_777_216,
                    "reader":{
                        "kind":"agent-messenger",
                        "transport_account_id":transport_account_id,
                        "transport_chat_id":transport_chat_id,
                        "page_size":100,
                    },
                }))
                .map_err(|_| "kakao local configuration could not be encoded".to_owned())?;
                let claims = chat_claims("kakao", &account, &chat_id, "measured_local", false);
                (
                    binding_id,
                    claims,
                    ProductionWorkerConfig::KakaoLocal { fixed_config_json },
                )
            }
            Self::KakaoOfficial {
                binding_id,
                account,
                destination_id,
                template_ids,
                talk_message_consent,
                friends_message_permission,
                observed_at,
                auth_observation,
                auth_max_age_seconds,
                access_token,
            } => {
                validate_common(&binding_id, &account)?;
                validate_value(&destination_id, 512, "kakao destination_id")?;
                if template_ids.is_empty()
                    || template_ids.len() > 128
                    || template_ids.iter().collect::<BTreeSet<_>>().len() != template_ids.len()
                {
                    return Err("kakao template allowlist is invalid".into());
                }
                for template_id in &template_ids {
                    validate_value(template_id, 512, "kakao template_id")?;
                }
                if !observed_at.is_finite() || observed_at < 0.0 {
                    return Err("kakao observation time is invalid".into());
                }
                validate_auth_observation(&auth_observation)?;
                if auth_max_age_seconds == 0 || auth_max_age_seconds > 3_600 {
                    return Err("kakao auth age bound is invalid".into());
                }
                validate_secret(access_token.expose(), 8_192, "kakao access_token")?;
                let claims = json!({
                    "v":1,
                    "resource":{
                        "v":1,"kind":"destination","platform":"kakao",
                        "account":account,"destination_id":destination_id,
                    },
                    "read":{"mode":"none","limits":null},
                    "write":{"mode":"send","content_mode":"approved_template","reply":false},
                    "receipt":{"level":"ack_only"},
                });
                let worker = ProductionWorkerConfig::KakaoOfficial {
                    account,
                    recipient_uuid_allowlist_json: serde_json::to_string(&[&destination_id])
                        .map_err(|_| "kakao configuration could not be encoded".to_owned())?,
                    template_id_allowlist_json: serde_json::to_string(&template_ids)
                        .map_err(|_| "kakao configuration could not be encoded".to_owned())?,
                    talk_message_consent: serde_json::to_value(talk_message_consent)
                        .map_err(|_| "kakao configuration could not be encoded".to_owned())?
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    friends_message_permission: serde_json::to_value(friends_message_permission)
                        .map_err(|_| "kakao configuration could not be encoded".to_owned())?
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    observed_at: observed_at.to_string(),
                    auth_observation_json: serde_json::to_string(&auth_observation)
                        .map_err(|_| "kakao configuration could not be encoded".to_owned())?,
                    auth_max_age_seconds: auth_max_age_seconds.to_string(),
                    access_token: access_token.into_inner(),
                };
                (binding_id, claims, worker)
            }
        };
        TrustedBinding::production(binding_id, claims, worker)
            .map_err(|error| format!("provider binding is invalid: {error}"))
    }
}

fn telegram_binding_hash(binding_id: &str) -> String {
    use std::fmt::Write as _;

    let digest = Sha256::digest(binding_id.as_bytes());
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}")
            .expect("writing lowercase hex into a String cannot fail");
    }
    encoded
}

fn chat_claims(
    platform: &str,
    account: &str,
    chat_id: &str,
    read_mode: &str,
    writable: bool,
) -> serde_json::Value {
    let limits = if read_mode == "measured_local" {
        json!({"max_page_size":100,"max_pages":1,"cursor":"none"})
    } else {
        json!({"max_page_size":100,"max_pages":100,"cursor":"opaque"})
    };
    json!({
        "v":1,
        "resource":{
            "v":1,"kind":"chat","platform":platform,
            "account":account,"chat_id":chat_id,
        },
        "read":{"mode":read_mode,"limits":limits},
        "write": if writable {
            json!({"mode":"send","content_mode":"text","reply":true})
        } else {
            json!({"mode":"none","content_mode":"none","reply":false})
        },
        "receipt": if writable {
            json!({"level":"independent_readback"})
        } else {
            json!({"level":"none"})
        },
    })
}

fn validate_common(binding_id: &str, account: &str) -> Result<(), String> {
    validate_value(binding_id, 512, "provider binding_id")?;
    validate_value(account, 512, "provider account")
}

fn validate_value(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > maximum || value.as_bytes().contains(&0) {
        return Err(format!("{label} must be a bounded non-empty string"));
    }
    Ok(())
}

fn validate_secret(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    validate_value(value, maximum, label)
}

fn validate_nfc(value: &str, label: &str) -> Result<(), String> {
    if !value.nfc().eq(value.chars()) {
        return Err(format!("{label} must be NFC-normalized"));
    }
    Ok(())
}

fn validate_ascii_identifier(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    validate_value(value, maximum, label)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_stable_kakao_id(value: &str, label: &str) -> Result<(), String> {
    let suffix = value
        .strip_prefix("stable:")
        .ok_or_else(|| format!("{label} is invalid"))?;
    if suffix.is_empty()
        || suffix.len() > 128
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_telegram_chat_id(value: &str) -> Result<(), String> {
    let raw = value
        .strip_prefix("telegram:chat:")
        .ok_or_else(|| "telegram chat_id is invalid".to_owned())?;
    validate_canonical_int53(raw, false, "telegram chat_id")
}

fn validate_canonical_int53(value: &str, positive: bool, label: &str) -> Result<(), String> {
    let parsed = value
        .parse::<i64>()
        .map_err(|_| format!("{label} is invalid"))?;
    if value != parsed.to_string()
        || parsed.unsigned_abs() > 9_007_199_254_740_991
        || if positive { parsed <= 0 } else { parsed == 0 }
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_measurement(value: Option<&KakaoMeasurementConfig>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.schema_version != "kakao-contrib-read-measurement/v1"
        || value.kind != "kakao-read-field-measurement"
        || value.status != "VALIDATED"
        || value.observation != "observed"
        || value.source != "authorized-live-measurement"
        || value.send
        || !value.observed_at.is_finite()
        || value.observed_at < 0.0
    {
        return Err("kakao measurement is invalid".into());
    }
    const REQUIRED_FIELDS: [&str; 6] = [
        "account_id",
        "chat_id",
        "message_id",
        "author_id",
        "ts",
        "body",
    ];
    const ALLOWED_FIELDS: [&str; 7] = [
        "account_id",
        "chat_id",
        "message_id",
        "author_id",
        "ts",
        "body",
        "revision",
    ];
    let fields = value
        .supported_read_fields
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if fields.len() != value.supported_read_fields.len()
        || fields.iter().any(|field| !ALLOWED_FIELDS.contains(field))
        || REQUIRED_FIELDS.iter().any(|field| !fields.contains(field))
    {
        return Err("kakao measurement fields are invalid".into());
    }
    Ok(())
}

fn validate_auth_observation(value: &KakaoAuthObservation) -> Result<(), String> {
    if value.source != "kakao_access_token_info"
        || !value.observed_at.is_finite()
        || value.observed_at < 0.0
    {
        return Err("kakao auth observation is invalid".into());
    }
    Ok(())
}

pub(crate) fn load(path: &Path) -> Result<LoadedConfig, String> {
    let descriptor = WorkerSupervisor::open_trusted_owner_file(path, MAX_CONFIG_BYTES)?;
    let contents = read_config_contents(descriptor)?;
    let parsed: ConfigFile = serde_json::from_str(contents.as_str())
        .map_err(|_| "daemon config has unknown, missing, or invalid fields".to_owned())?;
    if parsed.version != 1 {
        return Err("daemon config version must be 1".into());
    }

    for (value, label) in [
        (parsed.keychain.service.as_str(), "keychain.service"),
        (parsed.keychain.account.as_str(), "keychain.account"),
    ] {
        if value.is_empty()
            || value.len() > MAX_KEYCHAIN_LABEL_BYTES
            || value.as_bytes().contains(&0)
        {
            return Err(format!(
                "{label} must be a bounded non-empty string without NUL bytes"
            ));
        }
    }

    for (path, label) in [
        (&parsed.state_dir, "state_dir"),
        (&parsed.database_path, "database_path"),
        (&parsed.socket_path, "socket_path"),
    ] {
        validate_absolute_path(path, label)?;
    }
    if parsed.database_path.parent() != Some(parsed.state_dir.as_path())
        || parsed.socket_path.parent() != Some(parsed.state_dir.as_path())
    {
        return Err("database_path and socket_path must be direct children of state_dir".into());
    }
    validate_state_directory(&parsed.state_dir)?;
    reject_final_symlink(&parsed.database_path, "database_path")?;
    reject_final_symlink(&parsed.socket_path, "socket_path")?;

    Ok(LoadedConfig {
        state_dir: parsed.state_dir,
        database_path: parsed.database_path,
        socket_path: parsed.socket_path,
        keychain: parsed.keychain,
        providers: parsed.providers,
    })
}

fn read_config_contents(descriptor: fs::File) -> Result<Zeroizing<String>, String> {
    let mut contents = Zeroizing::new(String::new());
    descriptor
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_string(&mut contents)
        .map_err(|_| "daemon config must contain valid UTF-8 JSON".to_owned())?;
    if contents.len() as u64 > MAX_CONFIG_BYTES {
        return Err("daemon config size is invalid".into());
    }
    Ok(contents)
}

fn validate_absolute_path(path: &Path, label: &str) -> Result<(), String> {
    let normalized = path.components().collect::<PathBuf>();
    let nfc = path
        .to_str()
        .is_some_and(|value| value.nfc().eq(value.chars()));
    if !path.is_absolute()
        || normalized.as_os_str().as_bytes() != path.as_os_str().as_bytes()
        || !nfc
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(format!(
            "{label} must be an absolute normalized path without dot components"
        ));
    }
    reject_symlink_components(path, label)
}

fn reject_symlink_components(path: &Path, label: &str) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!("{label} must not traverse a symlink"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err(format!("unable to inspect {label}")),
        }
    }
    Ok(())
}

fn reject_final_symlink(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("{label} must not be a symlink"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(format!("unable to inspect {label}")),
    }
}

fn validate_state_directory(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("unable to inspect state_dir".into()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("state_dir must be a real directory".into());
    }
    if metadata.uid() != geteuid().as_raw() {
        return Err("state_dir must be owned by the current user".into());
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("state_dir must be owner-only".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MAX_CONFIG_BYTES, SecretString, load, read_config_contents};
    use inboxd_daemon::{DaemonConfig, WorkerSupervisor, launch};
    use serde_json::{Value, json};
    #[cfg(target_os = "macos")]
    use std::process::Command;
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::Path,
    };
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixStream,
    };
    use zeroize::{Zeroize, ZeroizeOnDrop};

    fn trusted_tempdir() -> tempfile::TempDir {
        // Trusted configuration fixtures require canonical, non-writable ancestors.
        let home = fs::canonicalize(std::env::var_os("HOME").expect("HOME for config fixture"))
            .expect("canonical home for config fixture");
        tempfile::Builder::new()
            .prefix(".inboxd-cfg-")
            .tempdir_in(home)
            .expect("private config fixture directory")
    }

    fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
    fn assert_value_zeroizes_on_drop<T: ZeroizeOnDrop>(_: &T) {}

    #[test]
    fn provider_secret_values_have_an_enforced_zeroize_on_drop_contract() {
        assert_zeroize_on_drop::<SecretString>();
        let mut secret = SecretString::new("synthetic-provider-secret".to_owned());

        secret.zeroize();

        assert!(secret.expose().is_empty());
    }

    #[test]
    fn raw_provider_config_buffer_has_an_enforced_zeroize_on_drop_contract() {
        let directory = trusted_tempdir();
        let path = write_config(directory.path(), &provider_config(directory.path()));

        let descriptor =
            WorkerSupervisor::open_trusted_owner_file(&path, MAX_CONFIG_BYTES).unwrap();
        let contents = read_config_contents(descriptor).unwrap();

        assert_value_zeroizes_on_drop(&contents);
        assert!(contents.contains("xoxb-synthetic"));
    }

    #[test]
    fn config_contents_are_read_from_the_validated_final_descriptor() {
        let directory = trusted_tempdir();
        let path = write_config(directory.path(), &provider_config(directory.path()));
        let descriptor = WorkerSupervisor::open_trusted_owner_file(&path, MAX_CONFIG_BYTES)
            .expect("owner-only config should open through the shared trusted-path gate");
        let validated_path = directory.path().join("validated-config.json");
        fs::rename(&path, &validated_path).unwrap();
        fs::write(&path, br#"{"replacement":true}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        let contents = read_config_contents(descriptor).unwrap();

        assert!(contents.contains("xoxb-synthetic"));
        assert!(!contents.contains("replacement"));
    }

    #[test]
    fn config_descriptor_read_stays_bounded_if_the_open_file_grows() {
        let directory = trusted_tempdir();
        let path = write_config(directory.path(), &provider_config(directory.path()));
        let descriptor = WorkerSupervisor::open_trusted_owner_file(&path, MAX_CONFIG_BYTES)
            .expect("initial config is within the byte bound");
        let mut writer = fs::OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(&mut writer, &vec![b'x'; MAX_CONFIG_BYTES as usize]).unwrap();

        assert!(
            read_config_contents(descriptor).is_err(),
            "reading the validated descriptor must enforce the byte bound again"
        );
    }

    #[test]
    fn config_descriptor_rejects_invalid_utf8() {
        let directory = trusted_tempdir();
        let path = directory.path().join("config.json");
        fs::write(&path, [0xff]).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let descriptor = WorkerSupervisor::open_trusted_owner_file(&path, MAX_CONFIG_BYTES)
            .expect("owner-only nonempty file should pass path validation");

        let error = read_config_contents(descriptor).unwrap_err();

        assert!(error.contains("UTF-8"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn config_rejects_cross_uid_acl_mutation_on_mode_0700_ancestor() {
        let directory = trusted_tempdir();
        let trusted = directory.path().join("trusted");
        fs::create_dir(&trusted).unwrap();
        fs::set_permissions(&trusted, fs::Permissions::from_mode(0o700)).unwrap();
        let path = write_config(&trusted, &provider_config(&trusted));

        let status = Command::new("chmod")
            .args([
                "+a",
                "group:everyone allow add_file,add_subdirectory,delete_child",
            ])
            .arg(&trusted)
            .status()
            .expect("chmod must be available to construct the real macOS ACL exploit");
        assert!(status.success(), "chmod +a failed to construct ACL fixture");
        assert_eq!(
            fs::metadata(&trusted).unwrap().permissions().mode() & 0o777,
            0o700,
            "the exploit fixture must remain invisible to mode-bit-only validation"
        );

        assert!(
            load(&path).is_err(),
            "cross-UID ACL mutation rights on a config ancestor must be rejected"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn config_rejects_cross_uid_acl_mutation_on_final_file() {
        let directory = trusted_tempdir();
        let path = write_config(directory.path(), &provider_config(directory.path()));

        let status = Command::new("chmod")
            .args(["+a", "group:everyone allow write,delete"])
            .arg(&path)
            .status()
            .expect("chmod must be available to construct the real macOS ACL exploit");
        assert!(status.success(), "chmod +a failed to construct ACL fixture");

        assert!(
            load(&path).is_err(),
            "cross-UID ACL mutation rights on the config file must be rejected"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn config_rejects_cross_uid_acl_read_on_final_file() {
        let directory = trusted_tempdir();
        let path = write_config(directory.path(), &provider_config(directory.path()));

        let status = Command::new("chmod")
            .args(["+a", "group:everyone allow read"])
            .arg(&path)
            .status()
            .expect("chmod must be available to construct the real macOS ACL exploit");
        assert!(status.success(), "chmod +a failed to construct ACL fixture");

        assert!(
            load(&path).is_err(),
            "cross-UID ACL read rights on the owner-only config must be rejected"
        );
    }

    fn provider_config(state_dir: &Path) -> Value {
        json!({
            "version":1,
            "state_dir":state_dir,
            "database_path":state_dir.join("inboxd.db"),
            "socket_path":state_dir.join("inboxd.sock"),
            "keychain":{"service":"inboxd-test","account":"database"},
            "providers":[
                {
                    "kind":"slack",
                    "binding_id":"slack-work-C0123",
                    "account":"work",
                    "chat_id":"C0123",
                    "team_id":"T0123",
                    "bot_token":"xoxb-synthetic"
                },
                {
                    "kind":"telegram",
                    "binding_id":"telegram-personal-42",
                    "account":"personal",
                    "chat_id":"telegram:chat:42",
                    "self_user_id":"7",
                    "api_id":12345,
                    "api_hash":"0123456789abcdef0123456789abcdef"
                },
                {
                    "kind":"kakao_local",
                    "binding_id":"kakao-local-friends",
                    "account":"stable:personal",
                    "chat_id":"stable:friends",
                    "measurement":null,
                    "max_measurement_age":300,
                    "transport_account_id":"transport-account",
                    "transport_chat_id":"transport-chat"
                },
                {
                    "kind":"kakao_official",
                    "binding_id":"kakao-official-recipient",
                    "account":"official",
                    "destination_id":"recipient-uuid",
                    "template_ids":["template-1"],
                    "talk_message_consent":"granted",
                    "friends_message_permission":"granted",
                    "observed_at":1726650000,
                    "auth_observation":{
                        "source":"kakao_access_token_info",
                        "state":"authenticated",
                        "observed_at":1726650000
                    },
                    "auth_max_age_seconds":300,
                    "access_token":"kakao-synthetic-token"
                }
            ]
        })
    }

    fn write_config(directory: &Path, value: &Value) -> std::path::PathBuf {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("config.json");
        fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }

    async fn request(
        stream: &mut BufReader<UnixStream>,
        id: &str,
        method: &str,
        params: Value,
    ) -> Value {
        let frame = json!({"type":"request","id":id,"method":method,"params":params});
        stream
            .get_mut()
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .unwrap();
        let mut line = String::new();
        stream.read_line(&mut line).await.unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["ok"], true, "{response}");
        response["result"].clone()
    }

    #[tokio::test]
    async fn owner_only_config_registers_exact_claims_for_the_four_typed_provider_kinds() {
        let directory = trusted_tempdir();
        let config = provider_config(directory.path());
        let path = write_config(directory.path(), &config);

        let mut loaded = load(&path).expect("four typed production providers should load");
        assert_eq!(loaded.providers.len(), 4);
        let bindings = loaded
            .take_provider_bindings()
            .expect("typed provider bindings should validate");
        let daemon = launch(
            DaemonConfig::new(
                &loaded.state_dir,
                &loaded.database_path,
                &loaded.socket_path,
                [0x31; 32],
            )
            .with_bindings(bindings),
        )
        .await
        .expect("generated bindings should form one exact registry");
        let mut client = BufReader::new(UnixStream::connect(daemon.socket_path()).await.unwrap());
        request(
            &mut client,
            "hello",
            "system.hello",
            json!({"role":"reader"}),
        )
        .await;
        let listed = request(&mut client, "list", "capability.list", json!({})).await;
        let resources = listed["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 4);
        assert_eq!(
            resources[0]["resource"],
            json!({
                "v":1,"kind":"chat","platform":"kakao",
                "account":"stable:personal","chat_id":"stable:friends"
            })
        );
        assert_eq!(resources[0]["read"]["mode"], "measured_local");
        assert_eq!(resources[0]["write"]["mode"], "none");
        assert_eq!(
            resources[1]["resource"],
            json!({
                "v":1,"kind":"destination","platform":"kakao",
                "account":"official","destination_id":"recipient-uuid"
            })
        );
        assert_eq!(resources[1]["write"]["content_mode"], "approved_template");
        assert_eq!(resources[1]["receipt"]["level"], "ack_only");
        assert_eq!(resources[2]["resource"]["platform"], "slack");
        assert_eq!(resources[2]["receipt"]["level"], "independent_readback");
        assert_eq!(resources[3]["resource"]["platform"], "telegram");
        assert!(resources.iter().all(|entry| {
            entry["auth"]["state"] == "unknown" && entry["auth"]["reason"] == "unobserved"
        }));
        drop(client);
        daemon.shutdown().await.unwrap();
    }

    #[test]
    fn telegram_binding_creates_only_the_lowercase_sha256_owner_only_state_tree() {
        const HASH: &str = "5c92011f80e9af65ad7bfd672846d3179737f09269c8904a6996186ff7c9c4e3";
        let directory = trusted_tempdir();
        let state = directory.path().join("daemon-state");
        let mut config = provider_config(&state);
        config["providers"] = json!([config["providers"][1].clone()]);
        config["providers"][0]["binding_id"] = json!("../raw/binding-id");
        let path = write_config(directory.path(), &config);
        let mut loaded = load(&path).expect("normalized absolute state path should load");

        loaded
            .take_provider_bindings()
            .expect("valid Telegram binding should prepare private state");

        let binding = state.join("telegram").join(HASH);
        let children = fs::read_dir(state.join("telegram"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(children, [std::ffi::OsString::from(HASH)]);
        for path in [
            state.clone(),
            state.join("telegram"),
            binding.clone(),
            binding.join("database"),
            binding.join("files"),
        ] {
            let metadata = fs::symlink_metadata(path).unwrap();
            assert!(metadata.is_dir());
            assert_eq!(metadata.permissions().mode() & 0o7777, 0o700);
            assert_eq!(metadata.uid(), rustix::process::geteuid().as_raw());
        }
    }

    #[test]
    fn provider_config_rejects_unknown_fields_and_executable_paths() {
        let directory = trusted_tempdir();
        let mut config = provider_config(directory.path());
        config["providers"][0]["executable"] = json!("/tmp/untrusted-worker");
        let path = write_config(directory.path(), &config);

        assert!(load(&path).is_err());
    }

    #[test]
    fn provider_config_rejects_values_that_are_bounded_only_by_the_outer_file() {
        let directory = trusted_tempdir();
        let mut config = provider_config(directory.path());
        config["providers"][0]["bot_token"] = json!("x".repeat(9_000));
        let path = write_config(directory.path(), &config);

        let mut loaded = load(&path).expect("outer config byte bound should still accept fixture");
        assert!(loaded.take_provider_bindings().is_err());
    }

    #[test]
    fn telegram_provider_rejects_uppercase_api_hash_before_worker_launch() {
        let directory = trusted_tempdir();
        let mut config = provider_config(directory.path());
        config["providers"] = json!([config["providers"][1].clone()]);
        config["providers"][0]["api_hash"] = json!("0123456789ABCDEF0123456789ABCDEF");
        let path = write_config(directory.path(), &config);

        let mut loaded = load(&path).expect("outer config shape should still parse");
        assert!(
            loaded.take_provider_bindings().is_err(),
            "the Rust producer must reject API hashes the Telegram worker rejects"
        );
    }

    fn assert_provider_binding_invalid(mutator: impl FnOnce(&mut Value)) {
        let directory = trusted_tempdir();
        let mut config = provider_config(directory.path());
        mutator(&mut config);
        let path = write_config(directory.path(), &config);
        if let Ok(mut loaded) = load(&path) {
            assert!(
                loaded.take_provider_bindings().is_err(),
                "invalid provider configuration reached the registry"
            );
        }
    }

    #[test]
    fn provider_config_rejects_unknown_provider_kinds() {
        let directory = trusted_tempdir();
        let mut config = provider_config(directory.path());
        config["providers"][0]["kind"] = json!("caller_selected");
        let path = write_config(directory.path(), &config);

        assert!(load(&path).is_err());
    }

    #[test]
    fn provider_config_rejects_values_incompatible_with_fixed_worker_contracts() {
        assert_provider_binding_invalid(|config| {
            config["providers"][1]["chat_id"] = json!("telegram:chat:0");
        });
        assert_provider_binding_invalid(|config| {
            config["providers"][1]["api_id"] = json!(2_147_483_648_u64);
        });
        assert_provider_binding_invalid(|config| {
            config["providers"][1]["api_hash"] = json!("not-a-32-byte-hex-value");
        });
        assert_provider_binding_invalid(|config| {
            config["providers"][2]["measurement"] = json!({
                "schema_version":"wrong",
                "kind":"wrong",
                "status":"wrong",
                "observation":"wrong",
                "source":"wrong",
                "observed_at":1726650000,
                "send":false,
                "supported_read_fields":[
                    "account_id","chat_id","message_id","author_id","ts","body","revision"
                ]
            });
        });
        assert_provider_binding_invalid(|config| {
            config["providers"][3]["auth_observation"]["source"] = json!("untrusted");
        });
        assert_provider_binding_invalid(|config| {
            config["providers"][3]["auth_max_age_seconds"] = json!(3_601);
        });
        assert_provider_binding_invalid(|config| {
            config["providers"][3]["template_ids"] = json!(["template-1", "template-1"]);
        });
    }

    #[test]
    fn telegram_provider_rejects_non_nfc_account_and_binding_before_worker_launch() {
        assert_provider_binding_invalid(|config| {
            config["providers"][1]["account"] = json!("person-e\u{301}");
        });
        assert_provider_binding_invalid(|config| {
            config["providers"][1]["binding_id"] = json!("telegram-e\u{301}-42");
        });
    }

    #[test]
    fn config_rejects_textually_noncanonical_absolute_state_paths() {
        let directory = trusted_tempdir();
        let repeated = format!("{}//state", directory.path().display());
        let mut config = provider_config(Path::new(&repeated));
        config["state_dir"] = json!(repeated);
        let path = write_config(directory.path(), &config);

        assert!(
            load(&path).is_err(),
            "the Rust producer must not return a path spelling the worker rejects"
        );
    }

    #[test]
    fn provider_config_rejects_more_than_the_bounded_number_of_bindings() {
        let directory = trusted_tempdir();
        let mut config = provider_config(directory.path());
        let provider = config["providers"][0].clone();
        config["providers"] = Value::Array(vec![provider; 129]);
        let path = write_config(directory.path(), &config);

        let mut loaded = load(&path).expect("fixture remains within the outer file byte bound");
        assert!(loaded.take_provider_bindings().is_err());
    }
}
