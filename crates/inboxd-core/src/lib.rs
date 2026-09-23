#[cfg(unix)]
mod descriptor;
mod domain;
mod host;
mod message_body;
pub use message_body::message_body;
mod safety;
mod store;

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use serde::Serialize;
use serde_json::{Value, json};

#[cfg(unix)]
pub use descriptor::{DescriptorIdentity, descriptor_identity};
pub use host::{
    CallbackHost, Host, HostCallback, SqlHost, wire_cmp, wire_code_unit_len, wire_from_utf16_units,
    wire_utf16_units,
};
pub use store::{OWNER_SEND_SCHEMA, RESPONSE_SCHEMA};

pub type CoreResult<T> = Result<T, CoreError>;
pub const ABI_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
pub struct CoreError {
    pub name: String,
    pub message: String,
}

impl CoreError {
    pub fn new(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self::new("CoreError", error.to_string())
    }
}

/// Safe synchronous in-process entry point. All strings (including object keys)
/// use the UTF-16 wire encoding; native callers must encode ordinary Rust text
/// with `wire_from_utf16_units`. Returned strings use that same representation.
/// The host is borrowed only for this call and must not re-enter the dispatcher.
/// Panics are contained; transaction helpers roll back before propagation.
pub fn call(op: &str, input: &Value, host: &dyn Host) -> CoreResult<Value> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| dispatch(op, input, host)))
        .unwrap_or_else(|_| Err(CoreError::new("CorePanic", "native core panicked")))
}

fn dispatch(op: &str, input: &Value, host: &dyn Host) -> CoreResult<Value> {
    if let Some(result) = domain::dispatch(op, input) {
        return result;
    }
    if let Some(result) = store::dispatch(op, input, host) {
        return result;
    }
    if op.starts_with("safety.") {
        return safety::dispatch(op, input, host);
    }
    match op {
        "ping" => Ok(json!({ "pong": true, "input": input })),
        "host.roundtrip" => {
            let object = input.as_object().ok_or_else(|| {
                CoreError::new("TypeError", "host.roundtrip input must be an object")
            })?;
            let method = object
                .get("method")
                .and_then(Value::as_str)
                .filter(|method| !method.is_empty())
                .ok_or_else(|| {
                    CoreError::new(
                        "TypeError",
                        "host.roundtrip.method must be a non-empty string",
                    )
                })?;
            host.call(method, object.get("args").cloned().unwrap_or(Value::Null))
        }
        _ => Err(CoreError::new(
            "RangeError",
            format!("unknown core operation: {op}"),
        )),
    }
}

fn envelope(result: CoreResult<Value>) -> String {
    match result {
        Ok(value) => json!({ "ok": true, "value": value }).to_string(),
        Err(error) => json!({ "ok": false, "error": error }).to_string(),
    }
}

/// Stable, synchronous C boundary for Bun. Inputs and the callback are used
/// only for this call; all returned memory belongs to Rust and is released by
/// `inboxd_core_free`.
///
/// # Safety
///
/// `op` and `input` must each point to a valid NUL-terminated byte sequence
/// that remains alive for this call. `callback` must remain callable for the
/// duration of this call and must return a valid NUL-terminated response that
/// remains alive until the callback returns. The returned pointer must be
/// released exactly once with `inboxd_core_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn inboxd_core_call(
    op: *const c_char,
    input: *const c_char,
    callback: Option<HostCallback>,
) -> *mut c_char {
    let result = std::panic::catch_unwind(|| {
        if op.is_null() || input.is_null() {
            return Err(CoreError::new(
                "TypeError",
                "operation and input pointers are required",
            ));
        }
        let op = unsafe { CStr::from_ptr(op) }
            .to_str()
            .map_err(|_| CoreError::new("TypeError", "operation must be UTF-8"))?;
        let input = unsafe { CStr::from_ptr(input) }
            .to_str()
            .map_err(|_| CoreError::new("TypeError", "input must be UTF-8"))?;
        let input = serde_json::from_str(input)
            .map_err(|_| CoreError::new("TypeError", "input must be valid JSON"))?;
        let callback =
            callback.ok_or_else(|| CoreError::new("HostError", "host callback is required"))?;
        dispatch(op, &input, &CallbackHost::new(callback))
    });
    let encoded = match result {
        Ok(value) => envelope(value),
        Err(_) => envelope(Err(CoreError::new("CorePanic", "native core panicked"))),
    };
    CString::new(encoded)
        .expect("JSON envelope has no NUL")
        .into_raw()
}

#[unsafe(no_mangle)]
pub extern "C" fn inboxd_core_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
/// Releases a result allocated by `inboxd_core_call`.
///
/// # Safety
///
/// `value` must be null or a pointer returned by `inboxd_core_call` that has
/// not already been released. No other pointer is valid.
pub unsafe extern "C" fn inboxd_core_free(value: *mut c_char) {
    if !value.is_null() {
        unsafe {
            drop(CString::from_raw(value));
        }
    }
}

#[cfg(all(test, unix))]
mod descriptor_tests {
    use std::{
        fs::{self, OpenOptions},
        io::{Seek, SeekFrom, Write},
        os::unix::{fs::MetadataExt, io::AsRawFd},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::descriptor_identity;

    #[test]
    fn borrowed_descriptor_identity_reports_target_dev_and_ino_without_moving_offset() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "inboxd-core-descriptor-{}-{nonce}",
            std::process::id()
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        file.write_all(b"descriptor proof").unwrap();
        file.seek(SeekFrom::Start(4)).unwrap();
        let metadata = file.metadata().unwrap();

        let identity = descriptor_identity(file.as_raw_fd()).unwrap();

        assert_eq!(identity.device, metadata.dev());
        assert_eq!(identity.inode, metadata.ino());
        assert!(identity.is_regular);
        assert_eq!(file.stream_position().unwrap(), 4);
        file.write_all(b" still borrowed").unwrap();
        drop(file);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn descriptor_identity_rejects_invalid_descriptors() {
        assert_eq!(
            descriptor_identity(-1).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert_eq!(
            descriptor_identity(i32::MAX).unwrap_err().raw_os_error(),
            Some(libc::EBADF)
        );
    }
}
