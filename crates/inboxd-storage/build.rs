#![forbid(unsafe_code)]

use sha2::{Digest, Sha256};
use std::{
    env,
    fs::File,
    io::{BufReader, Read},
    path::Path,
    process::Command,
};

const TARGET: &str = "aarch64-apple-darwin";
const SQLCIPHER_PACKAGE: &str = "homebrew:sqlcipher@4.19.0";
const SQLCIPHER_VERSION: &str = "4.19.0";
const SQLITE_VERSION: &str = "3.53.4";
const CIPHER_VERSION: &str = "4.19.0 community";
const SQLCIPHER_LIB_DIR: &str = "/opt/homebrew/Cellar/sqlcipher/4.19.0/lib";
const SQLCIPHER_INCLUDE_DIR: &str = "/opt/homebrew/Cellar/sqlcipher/4.19.0/include/sqlcipher";
const SQLCIPHER_ARCHIVE: &str = "/opt/homebrew/Cellar/sqlcipher/4.19.0/lib/libsqlcipher.a";
const SQLCIPHER_ARCHIVE_SHA256: &str =
    "8887e6f3d4c567a00622649fac5ea5ca97fbcb99dc1d76036cb1d627e5cd46cc";
const SQLCIPHER_HEADER: &str = "/opt/homebrew/Cellar/sqlcipher/4.19.0/include/sqlcipher/sqlite3.h";
const SQLCIPHER_HEADER_SHA256: &str =
    "8a9d1bff44d75174ca6dea3ea9bac50a6104d86facb566647b8bb839375b7b3a";
const SQLCIPHER_PC: &str = "/opt/homebrew/Cellar/sqlcipher/4.19.0/lib/pkgconfig/sqlcipher.pc";
const SQLCIPHER_PC_SHA256: &str =
    "0eaf1615549fbdac55b2ac156bcd6a36d2fbbdc89ed7def1f5b69792bcd2637d";
const OPENSSL_LIB_DIR: &str = "/opt/homebrew/Cellar/openssl@4/4.0.2/lib";
const OPENSSL_ARCHIVE: &str = "/opt/homebrew/Cellar/openssl@4/4.0.2/lib/libcrypto.a";
const OPENSSL_ARCHIVE_SHA256: &str =
    "c9f628a0c6538771c0451cf9fe09dc24a5a92f01158212c3e343592b7e19b1ea";

fn sha256(path: &Path) -> Result<String, String> {
    let file =
        File::open(path).map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn require_hash(path: &str, expected: &str) {
    let actual = sha256(Path::new(path))
        .unwrap_or_else(|error| panic!("inboxd production SQLCipher pack is unavailable: {error}"));
    assert_eq!(
        actual, expected,
        "inboxd production SQLCipher pack rejected {path}: SHA-256 mismatch"
    );
}

fn require_env(name: &str, expected: &str) {
    let actual = env::var(name).unwrap_or_else(|_| {
        panic!("inboxd production SQLCipher pack requires Cargo env {name}={expected}")
    });
    assert_eq!(
        actual, expected,
        "inboxd production SQLCipher pack rejected Cargo env {name}"
    );
}

fn require_arm64_archive(path: &str) {
    let output = Command::new("/usr/bin/lipo")
        .args(["-archs", path])
        .output()
        .unwrap_or_else(|error| {
            panic!("inboxd production SQLCipher pack cannot inspect {path}: {error}")
        });
    assert!(
        output.status.success(),
        "inboxd production SQLCipher pack cannot inspect {path}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    let architectures = String::from_utf8(output.stdout)
        .unwrap_or_else(|_| panic!("inboxd production SQLCipher pack got non-UTF-8 lipo output"));
    assert_eq!(
        architectures.trim(),
        "arm64",
        "inboxd production SQLCipher pack rejected {path}: expected only arm64"
    );
}

fn main() {
    println!("cargo:rerun-if-changed=../../.cargo/config.toml");
    for path in [
        SQLCIPHER_ARCHIVE,
        SQLCIPHER_HEADER,
        SQLCIPHER_PC,
        OPENSSL_ARCHIVE,
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    for variable in [
        "SQLCIPHER_STATIC",
        "SQLCIPHER_LIB_DIR",
        "SQLCIPHER_INCLUDE_DIR",
        "CARGO_CFG_TARGET_OS",
        "CARGO_CFG_TARGET_ARCH",
        "TARGET",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }

    require_env("CARGO_CFG_TARGET_OS", "macos");
    require_env("CARGO_CFG_TARGET_ARCH", "aarch64");
    require_env("TARGET", TARGET);
    require_env("SQLCIPHER_STATIC", "1");
    require_env("SQLCIPHER_LIB_DIR", SQLCIPHER_LIB_DIR);
    require_env("SQLCIPHER_INCLUDE_DIR", SQLCIPHER_INCLUDE_DIR);

    require_hash(SQLCIPHER_ARCHIVE, SQLCIPHER_ARCHIVE_SHA256);
    require_hash(SQLCIPHER_HEADER, SQLCIPHER_HEADER_SHA256);
    require_hash(SQLCIPHER_PC, SQLCIPHER_PC_SHA256);
    require_hash(OPENSSL_ARCHIVE, OPENSSL_ARCHIVE_SHA256);
    require_arm64_archive(SQLCIPHER_ARCHIVE);
    require_arm64_archive(OPENSSL_ARCHIVE);

    println!("cargo:rustc-link-search=native={OPENSSL_LIB_DIR}");
    println!("cargo:rustc-link-lib=static=crypto");

    for (name, value) in [
        ("INBOXD_SQLCIPHER_PACKAGE", SQLCIPHER_PACKAGE),
        ("INBOXD_SQLCIPHER_PACKAGE_VERSION", SQLCIPHER_VERSION),
        ("INBOXD_SQLCIPHER_ARCHIVE", SQLCIPHER_ARCHIVE),
        ("INBOXD_SQLCIPHER_ARCHIVE_SHA256", SQLCIPHER_ARCHIVE_SHA256),
        ("INBOXD_SQLCIPHER_HEADER", SQLCIPHER_HEADER),
        ("INBOXD_SQLCIPHER_HEADER_SHA256", SQLCIPHER_HEADER_SHA256),
        ("INBOXD_SQLCIPHER_PC", SQLCIPHER_PC),
        ("INBOXD_SQLCIPHER_PC_SHA256", SQLCIPHER_PC_SHA256),
        ("INBOXD_SQLCIPHER_CIPHER_VERSION", CIPHER_VERSION),
        ("INBOXD_SQLCIPHER_SQLITE_VERSION", SQLITE_VERSION),
        ("INBOXD_SQLCIPHER_TARGET", TARGET),
        ("INBOXD_SQLCIPHER_LINKAGE", "static-archive"),
        ("INBOXD_SQLCIPHER_CRYPTO_LINKAGE", "static-archive"),
        ("INBOXD_SQLCIPHER_CRYPTO_ARCHIVE", OPENSSL_ARCHIVE),
        (
            "INBOXD_SQLCIPHER_CRYPTO_ARCHIVE_SHA256",
            OPENSSL_ARCHIVE_SHA256,
        ),
    ] {
        println!("cargo:rustc-env={name}={value}");
    }
}
