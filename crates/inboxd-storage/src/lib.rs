//! Rust-owned SQLCipher storage using an exact Cargo-locked static bundle.
#![forbid(unsafe_code)]

mod actor;
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
    cell::{Cell, RefCell},
    collections::{HashMap, VecDeque},
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
const DEFAULT_PENDING_INTENT_CAPACITY: usize = 100;
const MAX_PENDING_INTENT_CAPACITY: usize = 4096;
static PRODUCTION_OPEN_GUARD: Mutex<()> = Mutex::new(());

struct ApprovalCodeEntry {
    code: Zeroizing<String>,
    expires_at: f64,
}

struct ApprovalCodeStore {
    entries: HashMap<String, ApprovalCodeEntry>,
    order: VecDeque<String>,
    capacity: usize,
}

impl ApprovalCodeStore {
    fn new(capacity: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(capacity),
            order: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    fn take(&mut self, intent_id: &str) -> Option<Zeroizing<String>> {
        self.order.retain(|candidate| candidate != intent_id);
        self.entries.remove(intent_id).map(|entry| entry.code)
    }

    fn oldest(&self) -> Option<String> {
        self.order.front().cloned()
    }

    fn expired(&self, now: f64) -> Vec<String> {
        self.order
            .iter()
            .filter(|intent_id| {
                self.entries
                    .get(*intent_id)
                    .is_some_and(|entry| entry.expires_at <= now)
            })
            .cloned()
            .collect()
    }

    fn insert(
        &mut self,
        intent_id: String,
        code: Zeroizing<String>,
        expires_at: f64,
    ) -> Option<String> {
        self.take(&intent_id);
        let evicted = (self.entries.len() >= self.capacity)
            .then(|| self.oldest())
            .flatten();
        if let Some(evicted) = &evicted {
            self.take(evicted);
        }
        self.order.push_back(intent_id.clone());
        self.entries
            .insert(intent_id, ApprovalCodeEntry { code, expires_at });
        evicted
    }
}

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

fn update_json_hex_escape(hasher: &mut Sha256, unit: u16) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    hasher.update([
        b'\\',
        b'u',
        HEX[((unit >> 12) & 0x0f) as usize],
        HEX[((unit >> 8) & 0x0f) as usize],
        HEX[((unit >> 4) & 0x0f) as usize],
        HEX[(unit & 0x0f) as usize],
    ]);
}

/// Hashes the canonical JSON string representation incrementally. This avoids
/// constructing any raw-code `serde_json::Value` or serialized JSON `String`.
fn native_approval_code_digest(code: &str) -> CoreResult<String> {
    let units = Zeroizing::new(wire_utf16_units(code)?);
    let mut hasher = Sha256::new();
    hasher.update(b"\"");
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Err(error) => update_json_hex_escape(&mut hasher, error.unpaired_surrogate()),
            Ok(character) => match character {
                '"' => hasher.update(b"\\\""),
                '\\' => hasher.update(b"\\\\"),
                '\u{8}' => hasher.update(b"\\b"),
                '\u{c}' => hasher.update(b"\\f"),
                '\n' => hasher.update(b"\\n"),
                '\r' => hasher.update(b"\\r"),
                '\t' => hasher.update(b"\\t"),
                character if character < '\u{20}' => {
                    update_json_hex_escape(&mut hasher, character as u16);
                }
                character => {
                    let mut encoded = [0_u8; 4];
                    hasher.update(character.encode_utf8(&mut encoded).as_bytes());
                }
            },
        }
    }
    hasher.update(b"\"");
    Ok(format!("{:x}", hasher.finalize()))
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
    provenance: Option<Value>,
    approval_codes: RefCell<ApprovalCodeStore>,
    pending_approval_code: RefCell<Option<Zeroizing<String>>>,
    approval_request_active: Cell<bool>,
    clock: Option<Box<dyn Fn() -> u64 + Send + Sync>>,
    #[cfg(test)]
    forbid_legacy_approval_digest_path: Cell<bool>,
}
impl std::fmt::Debug for NativeHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeHost")
            .field("production", &self.provenance.is_some())
            .finish_non_exhaustive()
    }
}
/// Trusted in-process capabilities; closures must be synchronous and must not
/// re-enter this host. They are owned and may move with the single storage
/// owner thread, but are never invoked concurrently or sent to another process.
/// Approval codes stay transient; the core persists only their hashes.
pub type SendPolicy = Box<dyn Fn(&Value) -> bool + Send + Sync>;
#[derive(Default)]
pub struct NativeHooks {
    pub approval_code: Option<Box<dyn Fn() -> String + Send + Sync>>,
    pub allow_send: Option<SendPolicy>,
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
            hooks: NativeHooks::default(),
            provenance,
            approval_codes: RefCell::new(ApprovalCodeStore::new(DEFAULT_PENDING_INTENT_CAPACITY)),
            pending_approval_code: RefCell::new(None),
            approval_request_active: Cell::new(false),
            clock: None,
            #[cfg(test)]
            forbid_legacy_approval_digest_path: Cell::new(false),
        })
    }

    pub(crate) fn opened_database_path(&self) -> CoreResult<std::path::PathBuf> {
        self.connection
            .path()
            .filter(|path| !path.is_empty())
            .map(std::path::PathBuf::from)
            .ok_or_else(|| bootstrap("SQLite did not report its opened database path"))
    }

    pub fn set_hooks(&mut self, hooks: NativeHooks) {
        self.hooks = hooks;
    }

    /// Overrides the host millisecond clock. Production callers leave the
    /// system clock in place; deterministic storage tests inject a fixed clock.
    pub fn set_clock(&mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) {
        self.clock = Some(Box::new(clock));
    }

    #[cfg(test)]
    fn forbid_legacy_approval_digest_path(&self) {
        self.forbid_legacy_approval_digest_path.set(true);
    }

    /// Bounds transient approval secrets by the same configured ceiling used
    /// for pending approval intents. It must be set before any code is retained.
    pub fn set_pending_intent_capacity(&mut self, capacity: usize) -> CoreResult<()> {
        if !(1..=MAX_PENDING_INTENT_CAPACITY).contains(&capacity) {
            return Err(CoreError::new(
                "ApprovalCodeConfigurationError",
                format!("pending intent capacity must be from 1 to {MAX_PENDING_INTENT_CAPACITY}"),
            ));
        }
        let codes = self.approval_codes.get_mut();
        if !codes.entries.is_empty() {
            return Err(CoreError::new(
                "ApprovalCodeConfigurationError",
                "pending intent capacity cannot change while approval codes are retained",
            ));
        }
        *codes = ApprovalCodeStore::new(capacity);
        Ok(())
    }

    fn generate_raw_approval_code(&self) -> CoreResult<Option<Zeroizing<String>>> {
        if let Some(generate) = &self.hooks.approval_code {
            return Ok(Some(Zeroizing::new(generate())));
        }
        if !self.approval_request_active.get() {
            return Ok(None);
        }
        let mut bytes = Zeroizing::new([0_u8; 4]);
        let sample = loop {
            getrandom::fill(bytes.as_mut()).map_err(|_| {
                CoreError::new("HostError", "secure approval code generation failed")
            })?;
            let sample = u32::from_le_bytes(*bytes);
            let ceiling = u32::MAX - (u32::MAX % 900_000);
            if sample < ceiling {
                break sample;
            }
        };
        Ok(Some(Zeroizing::new(format!(
            "{:06}",
            100_000 + sample % 900_000
        ))))
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

    fn expire_unavailable_code(&self, intent_id: &str) -> CoreResult<()> {
        let outcome = inboxd_core::call(
            "safety.claimApprovalCode",
            &json!({"intent_id":intent_id,"code_available":false}),
            self,
        )?;
        if outcome.get("available").and_then(Value::as_bool) == Some(true) {
            return Err(CoreError::new(
                "CoreError",
                "approval code eviction remained eligible",
            ));
        }
        Ok(())
    }

    fn purge_expired_approval_codes(&self) -> CoreResult<()> {
        let expired = self
            .approval_codes
            .borrow()
            .expired(self.now_millis()? as f64);
        for intent_id in expired {
            self.approval_codes.borrow_mut().take(&intent_id);
            self.expire_unavailable_code(&intent_id)?;
        }
        Ok(())
    }

    fn approval_operation(op: &str) -> bool {
        matches!(
            op,
            "safety.propose"
                | "safety.claimApprovalCode"
                | "safety.listPendingPage"
                | "safety.getIntent"
                | "safety.approve"
                | "safety.reject"
        )
    }

    /// Input and output are core wire values, not unencoded Rust strings.
    pub fn execute(&self, op: &str, input: &Value) -> CoreResult<Value> {
        if Self::approval_operation(op) {
            self.purge_expired_approval_codes()?;
        }
        if op == "safety.initialize" {
            self.approval_codes.borrow_mut().clear();
            self.pending_approval_code.borrow_mut().take();
        }
        if op == "safety.propose" {
            self.pending_approval_code.borrow_mut().take();
            self.approval_request_active.set(true);
            let result = inboxd_core::call(op, input, self);
            self.approval_request_active.set(false);
            let code = self.pending_approval_code.borrow_mut().take();
            let created = result?;
            let code = code.ok_or_else(|| {
                CoreError::new("CoreError", "proposal omitted its transient approval code")
            })?;
            let id = created
                .get("intent_id")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::new("CoreError", "proposal omitted intent_id"))?
                .to_owned();
            let expires_at = created
                .get("expires_at")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| CoreError::new("CoreError", "proposal omitted expires_at"))?;
            let evicted = self
                .approval_codes
                .borrow_mut()
                .insert(id.clone(), code, expires_at);
            if let Some(evicted) = evicted {
                if let Err(error) = self.expire_unavailable_code(&evicted) {
                    self.approval_codes.borrow_mut().take(&id);
                    let _ = self.expire_unavailable_code(&id);
                    return Err(error);
                }
            }
            self.purge_expired_approval_codes()?;
            return Ok(created);
        }
        if op == "safety.claimApprovalCode" {
            let id = input
                .get("intent_id")
                .and_then(Value::as_str)
                .ok_or_else(|| CoreError::new("TypeError", "intent_id must be a string"))?;
            let code = self.approval_codes.borrow_mut().take(id);
            let eligibility = inboxd_core::call(
                op,
                &json!({"intent_id": id, "code_available": code.is_some()}),
                self,
            )?;
            let result = if eligibility.get("available").and_then(Value::as_bool) == Some(true) {
                code.map(|code| json!({"code": wire(code.as_str())}))
                    .ok_or_else(|| {
                        CoreError::new("CoreError", "approval code eligibility was inconsistent")
                    })?
            } else {
                json!({"unavailable": true})
            };
            self.purge_expired_approval_codes()?;
            return Ok(result);
        }
        if op == "safety.claim" {
            let mut guarded = input.as_object().cloned().ok_or_else(|| {
                CoreError::new("TypeError", "safety.claim input must be an object")
            })?;
            guarded.insert("use_allow_send".into(), Value::Bool(true));
            return inboxd_core::call(op, &Value::Object(guarded), self);
        }
        if matches!(op, "safety.approve" | "safety.reject") {
            if let Some(id) = input.get("intent_id").and_then(Value::as_str) {
                self.approval_codes.borrow_mut().take(id);
            }
        }
        let mut result = inboxd_core::call(op, input, self)?;
        if Self::approval_operation(op) {
            self.purge_expired_approval_codes()?;
        }
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
    fn requires_send_policy(&self) -> bool {
        true
    }

    fn approval_code_digest(&self, code: &str) -> CoreResult<String> {
        native_approval_code_digest(code)
    }

    fn generate_approval_code_digest(&self) -> CoreResult<String> {
        let code = self.generate_raw_approval_code()?.ok_or_else(|| {
            CoreError::new("HostError", "approval code generation is unavailable")
        })?;
        let digest = native_approval_code_digest(code.as_str())?;
        self.pending_approval_code.borrow_mut().replace(code);
        Ok(digest)
    }

    fn call(&self, method: &str, args: Value) -> CoreResult<Value> {
        #[cfg(test)]
        if self.forbid_legacy_approval_digest_path.get()
            && self.approval_request_active.get()
            && (method == "host.approvalCode"
                || (method == "host.canonicalSha256" && args.is_string()))
        {
            panic!("production proposal used the legacy raw approval-code digest path");
        }
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
            "host.approvalCode" => {
                let Some(code) = self.generate_raw_approval_code()? else {
                    return Ok(Value::Null);
                };
                if self.approval_request_active.get() {
                    self.pending_approval_code
                        .borrow_mut()
                        .replace(code.clone());
                }
                Ok(json!(wire(code.as_str())))
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_proposal_uses_native_digest_without_legacy_raw_host_calls() {
        let directory = tempfile::tempdir().unwrap();
        let mut host =
            NativeHost::open_production(&directory.path().join("native-digest.db"), &[0x85; 32])
                .unwrap();
        host.set_hooks(NativeHooks {
            approval_code: Some(Box::new(|| "654321".into())),
            allow_send: None,
        });
        host.execute("store.migrate", &Value::Null).unwrap();
        host.execute("safety.initialize", &Value::Null).unwrap();
        host.forbid_legacy_approval_digest_path();

        let scope = json!({"platform":"slack","account":"work","chat_id":"C1"});
        let created = host
            .execute(
                "safety.propose",
                &json!({
                    "proposal":{"actor":"agent:native-digest","scope":scope,"body":"exact body"},
                    "approval_ttl_ms":60_000,
                }),
            )
            .unwrap();
        let code = host
            .execute(
                "safety.claimApprovalCode",
                &json!({"intent_id":created["intent_id"]}),
            )
            .unwrap()["code"]
            .clone();
        assert_eq!(code, "654321");
        assert_eq!(
            host.execute(
                "safety.approve",
                &json!({
                    "intent_id":created["intent_id"],"code":code,
                    "actor":"agent:native-digest","scope":scope,
                }),
            )
            .unwrap()["state"],
            "Approved"
        );
    }
}
