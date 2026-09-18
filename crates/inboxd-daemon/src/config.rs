use rustix::process::geteuid;
use serde::Deserialize;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Component, Path, PathBuf},
};

const MAX_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_KEYCHAIN_LABEL_BYTES: usize = 256;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigFile {
    version: u8,
    state_dir: PathBuf,
    database_path: PathBuf,
    socket_path: PathBuf,
    keychain: KeychainConfig,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct KeychainConfig {
    pub(crate) service: String,
    pub(crate) account: String,
}

pub(crate) struct LoadedConfig {
    pub(crate) state_dir: PathBuf,
    pub(crate) database_path: PathBuf,
    pub(crate) socket_path: PathBuf,
    pub(crate) keychain: KeychainConfig,
}

pub(crate) fn load(path: &Path) -> Result<LoadedConfig, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "unable to inspect daemon config".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("daemon config must be an owner-only regular file".into());
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("daemon config must be owner-only".into());
    }
    if metadata.uid() != geteuid().as_raw() {
        return Err("daemon config must be owned by the current user".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_CONFIG_BYTES {
        return Err("daemon config size is invalid".into());
    }

    let absolute =
        std::path::absolute(path).map_err(|_| "unable to resolve daemon config path".to_owned())?;
    let canonical =
        fs::canonicalize(path).map_err(|_| "unable to resolve daemon config path".to_owned())?;
    if canonical != absolute {
        return Err("daemon config must not traverse a symlink".into());
    }

    let contents = fs::read_to_string(path)
        .map_err(|_| "daemon config must contain valid UTF-8 JSON".to_owned())?;
    let parsed: ConfigFile = serde_json::from_str(&contents)
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
    })
}

fn validate_absolute_path(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute()
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
