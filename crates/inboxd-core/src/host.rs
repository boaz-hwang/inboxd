use std::ffi::{CStr, CString};
use std::os::raw::c_char;

use serde_json::{Value, json};

use crate::{CoreError, CoreResult};

const WIRE_SURROGATE_BASE: u32 = 0xF0000;
const WIRE_SURROGATE_END: u32 = 0xF07FF;
const WIRE_ESCAPE: char = '\u{F0800}';

/// Returns JavaScript UTF-16 code units for a transport-encoded string. Lone
/// surrogate units are represented by the private-use escape range only while
/// crossing the Rust boundary; valid PUA scalars are escaped losslessly.
pub fn wire_utf16_units(value: &str) -> CoreResult<Vec<u16>> {
    let mut units = Vec::new();
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character == WIRE_ESCAPE {
            let escaped = chars
                .next()
                .ok_or_else(|| CoreError::new("TypeError", "malformed native UTF-16 escape"))?;
            let mut buffer = [0; 2];
            units.extend_from_slice(escaped.encode_utf16(&mut buffer));
        } else if (WIRE_SURROGATE_BASE..=WIRE_SURROGATE_END).contains(&(character as u32)) {
            units.push(0xD800 + (character as u32 - WIRE_SURROGATE_BASE) as u16);
        } else {
            let mut buffer = [0; 2];
            units.extend_from_slice(character.encode_utf16(&mut buffer));
        }
    }
    Ok(units)
}

pub fn wire_cmp(left: &str, right: &str) -> CoreResult<std::cmp::Ordering> {
    Ok(wire_utf16_units(left)?.cmp(&wire_utf16_units(right)?))
}

pub fn wire_code_unit_len(value: &str) -> CoreResult<usize> {
    Ok(wire_utf16_units(value)?.len())
}

/// A synchronous, JSON-only capability boundary supplied by the Bun host.
pub trait Host {
    fn call(&self, method: &str, args: Value) -> CoreResult<Value>;
}

/// C ABI callback supplied by Bun's `JSCallback`. The returned pointer must
/// remain valid until this function returns; Bun owns its allocation.
pub type HostCallback = unsafe extern "C" fn(*const c_char, usize) -> *const c_char;

pub struct CallbackHost {
    callback: HostCallback,
}

impl CallbackHost {
    pub fn new(callback: HostCallback) -> Self {
        Self { callback }
    }
}

impl Host for CallbackHost {
    fn call(&self, method: &str, args: Value) -> CoreResult<Value> {
        let request = serde_json::to_string(&json!({ "method": method, "args": args }))
            .map_err(CoreError::internal)?;
        let request = CString::new(request)
            .map_err(|_| CoreError::new("TypeError", "host request contains an interior NUL"))?;
        // The callback is synchronously scoped by `inboxd_core_call`; it must
        // never be retained or invoked from another thread.
        let response = unsafe { (self.callback)(request.as_ptr(), request.as_bytes().len()) };
        if response.is_null() {
            return Err(CoreError::new(
                "HostError",
                "host callback returned no response",
            ));
        }
        let response = unsafe { CStr::from_ptr(response) }
            .to_str()
            .map_err(|_| CoreError::new("HostError", "host callback returned invalid UTF-8"))?;
        let envelope: Value = serde_json::from_str(response)
            .map_err(|_| CoreError::new("HostError", "host callback returned invalid JSON"))?;
        let object = envelope.as_object().ok_or_else(|| {
            CoreError::new("HostError", "host callback returned a non-object envelope")
        })?;
        match object.get("ok") {
            Some(Value::Bool(true)) => Ok(object.get("value").cloned().unwrap_or(Value::Null)),
            Some(Value::Bool(false)) => {
                let error = object.get("error").and_then(Value::as_object);
                Err(CoreError::new(
                    error
                        .and_then(|value| value.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("HostError"),
                    error
                        .and_then(|value| value.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("host callback failed"),
                ))
            }
            _ => Err(CoreError::new(
                "HostError",
                "host callback response omitted ok",
            )),
        }
    }
}

/// Typed SQL capability helpers. SQLCipher stays entirely in Bun; Rust only
/// requests these named operations through the host boundary.
pub struct SqlHost<'a> {
    host: &'a dyn Host,
}

impl<'a> SqlHost<'a> {
    pub fn new(host: &'a dyn Host) -> Self {
        Self { host }
    }

    pub fn run(&self, sql: &str, params: &[Value]) -> CoreResult<Value> {
        self.host
            .call("sql.run", json!({ "sql": sql, "params": params }))
    }

    pub fn get(&self, sql: &str, params: &[Value]) -> CoreResult<Value> {
        self.host
            .call("sql.get", json!({ "sql": sql, "params": params }))
    }

    pub fn all(&self, sql: &str, params: &[Value]) -> CoreResult<Vec<Value>> {
        let value = self
            .host
            .call("sql.all", json!({ "sql": sql, "params": params }))?;
        value
            .as_array()
            .cloned()
            .ok_or_else(|| CoreError::new("HostError", "sql.all must return an array"))
    }

    pub fn exec(&self, sql: &str) -> CoreResult<Value> {
        self.host.call("sql.exec", json!({ "sql": sql }))
    }

    /// Transaction control remains host-owned, but the callback closure is
    /// synchronous so a Rust operation can preserve begin/commit/rollback.
    pub fn transaction<T>(&self, operation: impl FnOnce(&Self) -> CoreResult<T>) -> CoreResult<T> {
        self.host.call("sql.transaction.begin", Value::Null)?;
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| operation(self)));
        match outcome {
            Ok(Ok(value)) => match self.host.call("sql.transaction.commit", Value::Null) {
                Ok(_) => Ok(value),
                Err(error) => {
                    let _ = self.host.call("sql.transaction.rollback", Value::Null);
                    Err(error)
                }
            },
            Ok(Err(error)) => {
                let _ = self.host.call("sql.transaction.rollback", Value::Null);
                Err(error)
            }
            Err(_) => {
                let _ = self.host.call("sql.transaction.rollback", Value::Null);
                Err(CoreError::new("CorePanic", "core transaction panicked"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct RecordingHost {
        calls: RefCell<Vec<String>>,
        fail_commit: bool,
    }

    impl Host for RecordingHost {
        fn call(&self, method: &str, _: Value) -> CoreResult<Value> {
            self.calls.borrow_mut().push(method.to_owned());
            if self.fail_commit && method == "sql.transaction.commit" {
                return Err(CoreError::new("HostError", "commit failed"));
            }
            Ok(Value::Null)
        }
    }

    #[test]
    fn rolls_back_a_panicking_transaction_closure() {
        let host = RecordingHost {
            calls: RefCell::new(vec![]),
            fail_commit: false,
        };
        let sql = SqlHost::new(&host);
        let result = sql.transaction::<()>(|_| panic!("injected"));
        assert_eq!(result.unwrap_err().name, "CorePanic");
        assert_eq!(
            *host.calls.borrow(),
            vec!["sql.transaction.begin", "sql.transaction.rollback"]
        );
    }

    #[test]
    fn rolls_back_when_commit_fails() {
        let host = RecordingHost {
            calls: RefCell::new(vec![]),
            fail_commit: true,
        };
        let sql = SqlHost::new(&host);
        let result = sql.transaction(|_| Ok(()));
        assert_eq!(result.unwrap_err().message, "commit failed");
        assert_eq!(
            *host.calls.borrow(),
            vec![
                "sql.transaction.begin",
                "sql.transaction.commit",
                "sql.transaction.rollback"
            ]
        );
    }
}
