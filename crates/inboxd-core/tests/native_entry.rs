use inboxd_core::{CoreResult, Host, call};
use serde_json::{Value, json};

struct NoHost;
impl Host for NoHost {
    fn call(&self, _: &str, _: Value) -> CoreResult<Value> {
        panic!("pure dispatch must not call a host")
    }
}

#[test]
fn native_entry_reuses_core_dispatch_without_ffi() {
    assert_eq!(
        call("ping", &json!({"native": true}), &NoHost).unwrap(),
        json!({"pong": true, "input": {"native": true}})
    );
    assert_eq!(
        call("missing", &Value::Null, &NoHost).unwrap_err().name,
        "RangeError"
    );
}
