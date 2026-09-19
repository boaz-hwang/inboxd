//! Validated private wire boundary. Vendor additions are accepted in responses;
//! private requests reject unknown operations/fields before starting a process.
#[path = "contract_generated.rs"]
mod generated;
pub(crate) use generated::PrimitiveRequest;
use serde_json::Value;

fn schema() -> &'static Value {
    static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../packages/accounts/schema/primitives.json"
        ))
        .expect("checked wire schema")
    })
}
fn check(shape: &Value, value: &Value, strict: bool) -> bool {
    if let Some(kind) = shape.as_str() {
        if let Some(definition) = schema()["types"].get(kind) {
            return check(definition, value, strict);
        }
        return match kind {
            "nonempty" => value
                .as_str()
                .is_some_and(|s| !s.is_empty() && (!strict || s.len() <= 16000)),
            "string" => value.as_str().is_some_and(|s| !strict || s.len() <= 16000),
            "number" => value.as_f64().is_some_and(f64::is_finite),
            "file_size" => value.as_f64().is_some_and(|n| {
                n.is_finite() && n.fract() == 0.0 && (1.0..=104857600.0).contains(&n)
            }),
            "integer" => value.as_f64().is_some_and(|n| {
                n.is_finite()
                    && n.fract() == 0.0
                    && n >= if strict { 1.0 } else { 0.0 }
                    && n <= if strict {
                        20000.0
                    } else {
                        9_007_199_254_740_991.0
                    }
            }),
            "boolean" => value.is_boolean(),
            _ => false,
        };
    }
    if let Some(member) = shape.get("optional") {
        return value.is_null() || check(member, value, strict);
    }
    if let Some(members) = shape["enum"].as_array() {
        return members.contains(value);
    }
    if let Some(members) = shape["union"].as_array() {
        return members.iter().any(|m| check(m, value, strict));
    }
    if let Some(member) = shape.get("array") {
        return value.as_array().is_some_and(|items| {
            items.len() <= 20000 && items.iter().all(|v| check(member, v, strict))
        });
    }
    let Some(fields) = shape["fields"].as_object() else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    (!strict || object.keys().all(|k| fields.contains_key(k)))
        && fields
            .iter()
            .all(|(key, member)| check(member, object.get(key).unwrap_or(&Value::Null), strict))
}
fn valid_request(value: &Value, platform: &str, in_batch: bool) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let Some(op) = value["op"].as_str() else {
        return false;
    };
    if op == "batch" {
        return !in_batch
            && object.len() == 2
            && value["requests"].as_array().is_some_and(|items| {
                !items.is_empty()
                    && items.len() <= 8
                    && items.iter().all(|v| valid_request(v, platform, true))
            });
    }
    let same_platform = op
        .strip_prefix(platform)
        .is_some_and(|s| s.starts_with('.') || s.starts_with('_'));
    if !same_platform
        || (in_batch
            && matches!(
                op,
                "kakao_send"
                    | "telegram_send"
                    | "slack.chat.postMessage"
                    | "slack_send_file"
                    | "kakao_send_file"
                    | "telegram_send_file"
            ))
    {
        return false;
    }
    let mut fields = object.clone();
    fields.remove("op");
    check(
        &schema()["operations"][op]["request"],
        &Value::Object(fields),
        true,
    )
}
pub(crate) fn validate_request(value: Value, platform: &str) -> Result<PrimitiveRequest, String> {
    if !valid_request(&value, platform, false) {
        return Err("invalid provider primitive".into());
    }
    serde_json::from_value(value).map_err(|_| "invalid provider primitive".into())
}
pub(crate) fn validate_result(request: &PrimitiveRequest, value: &Value) -> Result<(), String> {
    fn valid(request: &Value, value: &Value) -> bool {
        if request["op"] == "batch" {
            let requests = request["requests"].as_array().unwrap();
            return value["results"].as_array().is_some_and(|results| {
                results.len() == requests.len()
                    && requests.iter().zip(results).all(|(r, v)| valid(r, v))
            });
        }
        check(
            &schema()["operations"][request["op"].as_str().unwrap()]["result"],
            value,
            false,
        )
    }
    // Shape checking also rejects array-as-struct representations accepted by serde.
    if !valid(
        &serde_json::to_value(request).map_err(|_| "invalid request")?,
        value,
    ) {
        return Err("invalid provider primitive result".into());
    }
    request
        .decode_result(value.clone())
        .map(|_| ())
        .map_err(|_| "invalid provider primitive result".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn integral_json_lexical_forms_match_typescript() {
        for integer in ["1", "1.0", "1e0"] {
            let value = serde_json::from_str(&format!(
                r#"{{"op":"telegram_history","chat_id":"1","limit":{integer}}}"#
            ))
            .unwrap();
            let request = validate_request(value, "telegram").unwrap();
            assert_eq!(serde_json::to_value(request).unwrap()["limit"], 1);
        }
    }
    #[test]
    fn shared_wire_parity_fixtures() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../packages/accounts/schema/parity-fixtures.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let request = validate_request(
                fixture["request"].clone(),
                fixture["platform"].as_str().unwrap(),
            );
            assert_eq!(
                request.is_ok(),
                fixture["request_valid"] == true,
                "request: {}: {:?}",
                fixture["name"],
                request
            );
            if let Ok(request) = request {
                assert_eq!(
                    validate_result(&request, &fixture["result"]).is_ok(),
                    fixture["result_valid"] == true,
                    "result: {}",
                    fixture["name"]
                );
            }
        }
    }
}
