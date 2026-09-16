mod domain;
mod host;
mod safety;
mod store;

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use serde::Serialize;
use serde_json::{Value, json};

pub use host::{
    CallbackHost, Host, HostCallback, SqlHost, wire_cmp, wire_code_unit_len, wire_utf16_units,
};

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
