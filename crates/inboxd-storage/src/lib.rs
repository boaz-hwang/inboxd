//! Development-only native SQLCipher ownership. Not a production library pack.
#![forbid(unsafe_code)]

mod serialization;

use inboxd_core::{CoreError, CoreResult, Host, wire_from_utf16_units, wire_utf16_units};
use rusqlite::{
    Connection,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Map, Value, json};
use std::{fs::File, io::Read, path::Path};

fn sql_error(_: rusqlite::Error) -> CoreError {
    CoreError::new("SQLiteError", "native SQL operation failed")
}
fn bootstrap(message: &str) -> CoreError {
    CoreError::new("SqlCipherBootstrapError", message)
}
fn text(value: &Value) -> CoreResult<&str> {
    value
        .as_str()
        .ok_or_else(|| CoreError::new("TypeError", "expected string"))
}
fn wire(text: &str) -> String {
    wire_from_utf16_units(&text.encode_utf16().collect::<Vec<_>>())
}
fn native(text: &str) -> CoreResult<String> {
    Ok(String::from_utf16_lossy(&wire_utf16_units(text)?))
}

/// Converts standard JSON text to core wire values, preserving lone surrogates.
pub fn decode_json(text: &str) -> CoreResult<Value> {
    serialization::parse(&wire(text))
}
/// Converts core wire values to ECMAScript-compatible standard JSON text.
pub fn encode_json(value: &Value) -> CoreResult<String> {
    serialization::stringify(value, false)
}

/// Single owner, synchronous connection; no shared ownership or background work.
/// SQLCipher's safe rusqlite wrapper performs all native calls. No key is retained.
pub struct NativeHost {
    connection: Connection,
    hooks: NativeHooks,
}
/// Trusted in-process capabilities; closures must be synchronous and must not
/// re-enter this host. They are owned, never sent to another process or thread.
/// Approval codes stay transient; the core persists only their hashes.
pub type SendPolicy = Box<dyn Fn(&Value) -> bool>;
#[derive(Default)]
pub struct NativeHooks {
    pub approval_code: Option<Box<dyn Fn() -> String>>,
    pub allow_send: Option<SendPolicy>,
}
impl NativeHost {
    /// Explicit development/compatibility opt-in. Dynamically linked SQLCipher
    /// is checked at runtime; production provenance is NOT implemented here.
    pub fn open_development(path: &Path, key: &[u8]) -> CoreResult<Self> {
        if key.is_empty() {
            return Err(bootstrap("A non-empty SQLCipher key is required"));
        }
        match File::open(path) {
            Ok(mut file) => {
                let mut header = [0; 16];
                let count = file
                    .read(&mut header)
                    .map_err(|_| bootstrap("Unable to inspect database header"))?;
                if count == 16 && &header == b"SQLite format 3\0" {
                    return Err(bootstrap("Refusing plaintext SQLite database header"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(bootstrap("Unable to inspect database header")),
        }
        let connection =
            Connection::open(path).map_err(|_| bootstrap("Unable to open encrypted database"))?;
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let hex: String = key
            .iter()
            .flat_map(|b| {
                [
                    char::from(HEX[(b >> 4) as usize]),
                    char::from(HEX[(b & 15) as usize]),
                ]
            })
            .collect();
        connection
            .pragma_update(None, "key", format!("x'{hex}'"))
            .map_err(|_| bootstrap("Unable to apply encryption key"))?;
        let cipher: String = connection
            .query_row("PRAGMA cipher_version", [], |r| r.get(0))
            .map_err(|_| bootstrap("SQLCipher is required"))?;
        if cipher.is_empty() {
            return Err(bootstrap("SQLCipher is required"));
        }
        connection
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|_| bootstrap("Unable to verify encrypted schema"))?;
        let journal: String = connection
            .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
            .map_err(|_| bootstrap("WAL is required"))?;
        if journal != "wal" {
            return Err(bootstrap("WAL is required"));
        }
        Ok(Self {
            connection,
            hooks: NativeHooks::default(),
        })
    }

    pub fn set_hooks(&mut self, hooks: NativeHooks) {
        self.hooks = hooks;
    }

    /// Input and output are core wire values, not unencoded Rust strings.
    pub fn execute(&self, op: &str, input: &Value) -> CoreResult<Value> {
        if op == "safety.claim" {
            let mut guarded = input.as_object().cloned().ok_or_else(|| {
                CoreError::new("TypeError", "safety.claim input must be an object")
            })?;
            guarded.insert("use_allow_send".into(), Value::Bool(true));
            return inboxd_core::call(op, &Value::Object(guarded), self);
        }
        inboxd_core::call(op, input, self)
    }

    fn sql(&self, method: &str, args: Value) -> CoreResult<Value> {
        if let Some(sql) = match method {
            "sql.transaction.begin" => Some("BEGIN IMMEDIATE"),
            "sql.transaction.commit" => Some("COMMIT"),
            "sql.transaction.rollback" => Some("ROLLBACK"),
            _ => None,
        } {
            self.connection.execute_batch(sql).map_err(sql_error)?;
            return Ok(Value::Null);
        }
        let sql = native(text(&args["sql"])?)?;
        if sql.is_empty() {
            return Err(CoreError::new("TypeError", "SQL must not be empty"));
        }
        if method == "sql.exec" {
            self.connection.execute_batch(&sql).map_err(sql_error)?;
            return Ok(Value::Null);
        }
        let empty = Vec::new();
        let params = match args.get("params") {
            None => &empty,
            Some(Value::Array(items)) => items,
            _ => return Err(CoreError::new("TypeError", "SQL params must be an array")),
        };
        let params = params
            .iter()
            .map(|value| {
                Ok(match value {
                    Value::Null => SqlValue::Null,
                    Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
                    Value::Number(n) => {
                        let value = n
                            .as_f64()
                            .filter(|value| value.is_finite())
                            .ok_or_else(|| CoreError::new("TypeError", "invalid number"))?;
                        // Bun/JSC binds signed Int52 values as INTEGER and other numbers as REAL.
                        if let Some(i) = n
                            .as_i64()
                            .filter(|i| (-(1_i64 << 51)..(1_i64 << 51)).contains(i))
                        {
                            SqlValue::Integer(i)
                        } else {
                            SqlValue::Real(value)
                        }
                    }
                    Value::String(s) => SqlValue::Text(native(s)?),
                    _ => return Err(CoreError::new("TypeError", "unsupported SQL binding")),
                })
            })
            .collect::<CoreResult<Vec<_>>>()?;
        let mut statement = self.connection.prepare_cached(&sql).map_err(sql_error)?;
        if method == "sql.run" {
            // PRAGMA assignments may produce rows; Bun run ignores them.
            let mut rows = statement
                .query(rusqlite::params_from_iter(&params))
                .map_err(sql_error)?;
            while rows.next().map_err(sql_error)?.is_some() {}
            return Ok(json!({"changes": self.connection.changes()}));
        }
        let names = statement
            .column_names()
            .iter()
            .map(|s| wire(s))
            .collect::<Vec<_>>();
        let mut rows = statement
            .query(rusqlite::params_from_iter(&params))
            .map_err(sql_error)?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().map_err(sql_error)? {
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index).map_err(sql_error)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(i) => json!(i),
                    ValueRef::Real(f) => json!(f),
                    ValueRef::Text(bytes) => json!(wire(&String::from_utf8_lossy(bytes))),
                    ValueRef::Blob(_) => {
                        return Err(CoreError::new(
                            "TypeError",
                            "BLOB is outside the JSON SQL host contract",
                        ));
                    }
                };
                object.insert(name.clone(), value);
            }
            result.push(Value::Object(object));
            if method == "sql.get" {
                break;
            }
        }
        if method == "sql.get" {
            Ok(result.into_iter().next().unwrap_or(Value::Null))
        } else {
            Ok(Value::Array(result))
        }
    }
}
impl Host for NativeHost {
    fn call(&self, method: &str, args: Value) -> CoreResult<Value> {
        match method {
            "sql.run"
            | "sql.get"
            | "sql.all"
            | "sql.exec"
            | "sql.transaction.begin"
            | "sql.transaction.commit"
            | "sql.transaction.rollback" => self.sql(method, args),
            "host.allowSend" => Ok(json!(
                self.hooks
                    .allow_send
                    .as_ref()
                    .is_some_and(|policy| policy(&args))
            )),
            "host.approvalCode" => Ok(self
                .hooks
                .approval_code
                .as_ref()
                .map_or(Value::Null, |generate| json!(wire(&generate())))),
            "host.now" => Ok(json!(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| CoreError::new("HostError", "clock precedes epoch"))?
                    .as_millis() as u64
            )),
            "host.id" => Ok(json!(uuid::Uuid::new_v4().to_string())),
            "host.sha256Text" | "host.canonicalSha256" => {
                use sha2::{Digest, Sha256};
                let content = if method == "host.sha256Text" {
                    native(text(&args)?)?
                } else {
                    serialization::stringify(&args, true)?
                };
                Ok(json!(format!("{:x}", Sha256::digest(content.as_bytes()))))
            }
            "host.base64urlEncode" => {
                use base64::Engine;
                Ok(json!(
                    base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .encode(native(text(&args)?)?.as_bytes())
                ))
            }
            "host.base64urlDecode" => {
                use base64::{
                    Engine,
                    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
                };
                let encoded = text(&args)?;
                if !encoded
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    return Err(CoreError::new("TypeError", "expected base64url text"));
                }
                // Node accepts nonzero unused trailing bits and discards a lone sextet.
                let encoded = if encoded.len() % 4 == 1 {
                    &encoded[..encoded.len() - 1]
                } else {
                    encoded
                };
                let engine = GeneralPurpose::new(
                    &base64::alphabet::URL_SAFE,
                    GeneralPurposeConfig::new()
                        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
                        .with_decode_allow_trailing_bits(true),
                );
                let bytes = engine
                    .decode(encoded)
                    .map_err(|_| CoreError::new("TypeError", "invalid base64url"))?;
                Ok(json!(wire(&String::from_utf8_lossy(&bytes))))
            }
            "host.jsonStringify" | "host.canonicalJson" => Ok(json!(wire(
                &serialization::stringify(&args, method == "host.canonicalJson")?
            ))),
            "host.jsonParse" => serialization::parse(text(&args)?),
            "host.numberToString" => Ok(json!(serialization::number(&args)?)),
            "host.utf16Compare" => Ok(json!(match inboxd_core::wire_cmp(
                text(&args["left"])?,
                text(&args["right"])?
            )? {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            })),
            "host.codePointLength" => Ok(json!(
                char::decode_utf16(wire_utf16_units(text(&args)?)?).count()
            )),
            _ => Err(CoreError::new(
                "RangeError",
                format!("unknown host method: {method}"),
            )),
        }
    }
}
