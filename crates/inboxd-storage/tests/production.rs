use std::{fs, process::Command};

use inboxd_storage::NativeHost;
use serde_json::Value;

#[test]
fn production_open_uses_the_exact_verified_static_sqlcipher_archive() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("production.db");
    let host = NativeHost::open_production(&path, &[0x61; 32]).unwrap();
    host.execute("store.migrate", &Value::Null).unwrap();

    let diagnosis = host.execute("store.diagnose", &Value::Null).unwrap();
    assert_eq!(diagnosis["ready"], true);
    assert_eq!(diagnosis["cipher_version"], "4.19.0 community");
    assert_eq!(diagnosis["provenance"]["enforced"], true);
    assert_eq!(
        diagnosis["provenance"]["package"],
        "homebrew:sqlcipher@4.19.0"
    );
    assert_eq!(diagnosis["provenance"]["package_version"], "4.19.0");
    assert_eq!(diagnosis["provenance"]["linkage"], "static-archive");
    assert_eq!(diagnosis["provenance"]["sqlite_version"], "3.53.4");
    assert_eq!(
        diagnosis["provenance"]["archive_path"],
        "/opt/homebrew/Cellar/sqlcipher/4.19.0/lib/libsqlcipher.a"
    );
    assert_eq!(
        diagnosis["provenance"]["archive_sha256"],
        "8887e6f3d4c567a00622649fac5ea5ca97fbcb99dc1d76036cb1d627e5cd46cc"
    );
    assert_eq!(diagnosis["provenance"]["target"], "aarch64-apple-darwin");
    assert!(
        diagnosis["provenance"]
            .get("runtime_library_path")
            .is_none()
    );
    assert!(
        diagnosis["provenance"]
            .get("runtime_library_sha256")
            .is_none()
    );

    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe().unwrap();
        let output = Command::new("otool")
            .arg("-L")
            .arg(executable)
            .output()
            .unwrap();
        assert!(output.status.success());
        let linked_images = String::from_utf8(output.stdout).unwrap();
        assert!(
            !linked_images.contains("libsqlcipher"),
            "production test binary dynamically loads SQLCipher:\n{linked_images}"
        );
    }
}

#[test]
fn production_open_fails_closed_for_no_key_plaintext_and_wrong_key() {
    let directory = tempfile::tempdir().unwrap();

    let no_key = NativeHost::open_production(&directory.path().join("no-key.db"), &[]).unwrap_err();
    assert_eq!(no_key.name, "SqlCipherBootstrapError");

    let plaintext = directory.path().join("plain.db");
    fs::write(
        &plaintext,
        [b"SQLite format 3\0".as_slice(), &[0; 128]].concat(),
    )
    .unwrap();
    let plain = NativeHost::open_production(&plaintext, &[0x62; 32]).unwrap_err();
    assert_eq!(plain.name, "SqlCipherBootstrapError");

    let encrypted = directory.path().join("encrypted.db");
    {
        let host = NativeHost::open_production(&encrypted, &[0x63; 32]).unwrap();
        host.execute("store.migrate", &Value::Null).unwrap();
    }
    let wrong = NativeHost::open_production(&encrypted, &[0x64; 32]).unwrap_err();
    assert_eq!(wrong.name, "SqlCipherBootstrapError");
}
