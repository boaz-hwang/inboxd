//! Rust-owned SQLCipher storage using an exact Cargo-locked static bundle.
#![forbid(unsafe_code)]

mod actor;
mod observations;
mod owner_sends;
mod responses;
mod serialization;

pub use actor::{StorageActor, StorageActorConfig, StorageOperation};

use inboxd_core::{CoreError, CoreResult, Host, wire_from_utf16_units, wire_utf16_units};
use rusqlite::{
    Connection,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::Path,
    sync::{Mutex, MutexGuard},
};
use zeroize::Zeroizing;

const PRODUCTION_PACKAGE: &str = env!("INBOXD_SQLCIPHER_PACKAGE");
const PRODUCTION_PACKAGE_VERSION: &str = env!("INBOXD_SQLCIPHER_PACKAGE_VERSION");
const PRODUCTION_ARCHIVE_PATH: &str = env!("INBOXD_SQLCIPHER_ARCHIVE");
const PRODUCTION_ARCHIVE_SHA256: &str = env!("INBOXD_SQLCIPHER_ARCHIVE_SHA256");
const PRODUCTION_HEADER_PATH: &str = env!("INBOXD_SQLCIPHER_HEADER");
const PRODUCTION_HEADER_SHA256: &str = env!("INBOXD_SQLCIPHER_HEADER_SHA256");
const PRODUCTION_PC_PATH: &str = env!("INBOXD_SQLCIPHER_PC");
const PRODUCTION_PC_SHA256: &str = env!("INBOXD_SQLCIPHER_PC_SHA256");
const PRODUCTION_CIPHER_VERSION: &str = env!("INBOXD_SQLCIPHER_CIPHER_VERSION");
const PRODUCTION_SQLITE_VERSION: &str = env!("INBOXD_SQLCIPHER_SQLITE_VERSION");
const PRODUCTION_TARGET: &str = env!("INBOXD_SQLCIPHER_TARGET");
const PRODUCTION_LINKAGE: &str = env!("INBOXD_SQLCIPHER_LINKAGE");
const PRODUCTION_CRYPTO_LINKAGE: &str = env!("INBOXD_SQLCIPHER_CRYPTO_LINKAGE");
const PRODUCTION_CRYPTO_ARCHIVE: &str = env!("INBOXD_SQLCIPHER_CRYPTO_ARCHIVE");
const PRODUCTION_CRYPTO_ARCHIVE_SHA256: &str = env!("INBOXD_SQLCIPHER_CRYPTO_ARCHIVE_SHA256");
const BINDING_PACKAGE: &str = "crates.io:libsqlite3-sys@0.38.2";
const BINDING_PACKAGE_CHECKSUM: &str =
    "f1d20bef17f513b9b3004532233187769cd072d790971f4e4da0e346eb6401e8";
static PRODUCTION_OPEN_GUARD: Mutex<()> = Mutex::new(());

fn sql_error(_: rusqlite::Error) -> CoreError {
    CoreError::new("SQLiteError", "native SQL operation failed")
}
fn bootstrap(message: &str) -> CoreError {
    CoreError::new("SqlCipherBootstrapError", message)
}

fn production_provenance() -> Value {
    json!({
        "enforced": true,
        "package": PRODUCTION_PACKAGE,
        "package_version": PRODUCTION_PACKAGE_VERSION,
        "archive_path": PRODUCTION_ARCHIVE_PATH,
        "archive_sha256": PRODUCTION_ARCHIVE_SHA256,
        "header_path": PRODUCTION_HEADER_PATH,
        "header_sha256": PRODUCTION_HEADER_SHA256,
        "pkg_config_path": PRODUCTION_PC_PATH,
        "pkg_config_sha256": PRODUCTION_PC_SHA256,
        "cipher_version": PRODUCTION_CIPHER_VERSION,
        "sqlite_version": PRODUCTION_SQLITE_VERSION,
        "target": PRODUCTION_TARGET,
        "linkage": PRODUCTION_LINKAGE,
        "crypto_linkage": PRODUCTION_CRYPTO_LINKAGE,
        "crypto_archive_path": PRODUCTION_CRYPTO_ARCHIVE,
        "crypto_archive_sha256": PRODUCTION_CRYPTO_ARCHIVE_SHA256,
        "binding_package": BINDING_PACKAGE,
        "binding_package_checksum": BINDING_PACKAGE_CHECKSUM,
    })
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
    provenance: Option<Value>,
    clock: Option<Box<dyn Fn() -> u64 + Send + Sync>>,
}
impl std::fmt::Debug for NativeHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeHost")
            .field("production", &self.provenance.is_some())
            .finish_non_exhaustive()
    }
}
impl NativeHost {
    /// Explicit development/compatibility opt-in. Uses the linked SQLCipher
    /// implementation but does not enforce the production runtime versions or
    /// attach build provenance to diagnostics.
    pub fn open_development(path: &Path, key: &[u8]) -> CoreResult<Self> {
        Self::open(path, key, None)
    }

    /// Opens with the exact build-time-verified static SQLCipher archive.
    /// Runtime SQLCipher/SQLite versions and required codec features are
    /// checked through the connection before encrypted data is accessed.
    pub fn open_production(path: &Path, key: &[u8]) -> CoreResult<Self> {
        let guard = Self::acquire_production_open_guard()?;
        Self::open_production_with_guard(path, key, &guard)
    }

    pub(crate) fn acquire_production_open_guard() -> CoreResult<MutexGuard<'static, ()>> {
        PRODUCTION_OPEN_GUARD
            .lock()
            .map_err(|_| bootstrap("Production database open guard is unavailable"))
    }

    pub(crate) fn open_production_with_guard(
        path: &Path,
        key: &[u8],
        _guard: &MutexGuard<'static, ()>,
    ) -> CoreResult<Self> {
        Self::open(path, key, Some(production_provenance()))
    }

    fn open(path: &Path, key: &[u8], provenance: Option<Value>) -> CoreResult<Self> {
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
        let mut pragma_key = Zeroizing::new(String::with_capacity(key.len() * 2 + 3));
        pragma_key.push_str("x'");
        for byte in key {
            pragma_key.push(char::from(HEX[(byte >> 4) as usize]));
            pragma_key.push(char::from(HEX[(byte & 15) as usize]));
        }
        pragma_key.push('\'');
        connection
            .pragma_update(None, "key", pragma_key.as_str())
            .map_err(|_| bootstrap("Unable to apply encryption key"))?;
        let cipher: String = connection
            .query_row("PRAGMA cipher_version", [], |r| r.get(0))
            .map_err(|_| bootstrap("SQLCipher is required"))?;
        if cipher.is_empty() {
            return Err(bootstrap("SQLCipher is required"));
        }
        if provenance.is_some() && cipher != PRODUCTION_CIPHER_VERSION {
            return Err(bootstrap(
                "Loaded SQLCipher version does not match the production pack",
            ));
        }
        let sqlite_version: String = connection
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .map_err(|_| bootstrap("Unable to identify the loaded SQLite runtime"))?;
        if provenance.is_some() && sqlite_version != PRODUCTION_SQLITE_VERSION {
            return Err(bootstrap(
                "Loaded SQLite version does not match the production pack",
            ));
        }
        let mut compile_options = connection
            .prepare("PRAGMA compile_options")
            .map_err(|_| bootstrap("Unable to inspect SQLCipher compile options"))?;
        let options = compile_options
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| bootstrap("Unable to inspect SQLCipher compile options"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| bootstrap("Unable to inspect SQLCipher compile options"))?;
        drop(compile_options);
        if !options.iter().any(|option| option == "HAS_CODEC")
            || !options.iter().any(|option| option == "ENABLE_FTS5")
            || !options.iter().any(|option| option == "THREADSAFE=1")
        {
            return Err(bootstrap(
                "Loaded SQLCipher lacks required codec, FTS5, or threading support",
            ));
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
            provenance,
            clock: None,
        })
    }

    pub(crate) fn opened_database_path(&self) -> CoreResult<std::path::PathBuf> {
        self.connection
            .path()
            .filter(|path| !path.is_empty())
            .map(std::path::PathBuf::from)
            .ok_or_else(|| bootstrap("SQLite did not report its opened database path"))
    }

    /// Overrides the host millisecond clock. Production callers leave the
    /// system clock in place; deterministic storage tests inject a fixed clock.
    pub fn set_clock(&mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) {
        self.clock = Some(Box::new(clock));
    }

    fn now_millis(&self) -> CoreResult<u64> {
        if let Some(clock) = &self.clock {
            return Ok(clock());
        }
        Ok(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| CoreError::new("HostError", "clock precedes epoch"))?
            .as_millis() as u64)
    }

    /// Input and output are core wire values, not unencoded Rust strings.
    pub fn execute(&self, op: &str, input: &Value) -> CoreResult<Value> {
        if op == "response.recover" {
            observations::repair_internal_feeds(&self.connection)?;
        }
        if op == "observations.delete" {
            return observations::delete(&self.connection, input);
        }
        if op == "observations.store" {
            return observations::observe(&self.connection, input);
        }
        if op == "observations.search" {
            return observations::search(&self.connection, input);
        }
        // These native daemon operations accept ordinary Unicode JSON, unlike
        // legacy UTF-16 core wire operations. Keep exact owner request identity.
        if op.starts_with("ownerSend.") {
            return owner_sends::execute(&self.connection, op, input);
        }
        if op.starts_with("response.") {
            return responses::execute(&self.connection, op, input);
        }
        let mut result = inboxd_core::call(op, input, self)?;
        if op == "store.diagnose" {
            if let Some(provenance) = &self.provenance {
                let diagnosis = result.as_object_mut().ok_or_else(|| {
                    CoreError::new("CoreError", "store diagnosis must be an object")
                })?;
                diagnosis.insert("provenance".into(), provenance.clone());
                let ready = diagnosis.get("ready").and_then(Value::as_bool) == Some(true);
                diagnosis.insert("ready".into(), Value::Bool(ready));
            }
        }
        Ok(result)
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
        let mut statement = self.connection.prepare(&sql).map_err(sql_error)?;
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
            "host.now" => Ok(json!(self.now_millis()?)),
            "host.id" => Ok(json!(uuid::Uuid::new_v4().to_string())),
            "host.sha256Text" | "host.canonicalSha256" => {
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
