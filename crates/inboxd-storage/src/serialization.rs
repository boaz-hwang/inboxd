//! ECMAScript JSON over core wire strings, never a serde_json text substitute.
use inboxd_core::{CoreError, CoreResult, wire_from_utf16_units, wire_utf16_units};
use serde_json::{Number, Value};

fn syntax() -> CoreError {
    CoreError::new("SyntaxError", "invalid JSON text")
}

fn normalize_numbers(value: &mut Value) -> CoreResult<()> {
    match value {
        Value::Number(number) => {
            let value = number
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(syntax)?;
            *number = if value == 0.0 && value.is_sign_negative() {
                Number::from_f64(value).ok_or_else(syntax)?
            } else {
                ryu_js::Buffer::new()
                    .format(value)
                    .parse()
                    .map_err(|_| syntax())?
            };
        }
        Value::Array(items) => {
            for item in items {
                normalize_numbers(item)?;
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                normalize_numbers(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn number(value: &Value) -> CoreResult<String> {
    let n = value
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| CoreError::new("TypeError", "expected finite number"))?;
    Ok(ryu_js::Buffer::new().format(n).to_owned())
}
fn quote(value: &str) -> CoreResult<String> {
    let mut result = String::from("\"");
    for decoded in char::decode_utf16(wire_utf16_units(value)?) {
        match decoded {
            Err(e) => result.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
            Ok(c) => match c {
                '"' => result.push_str("\\\""),
                '\\' => result.push_str("\\\\"),
                '\u{8}' => result.push_str("\\b"),
                '\u{c}' => result.push_str("\\f"),
                '\n' => result.push_str("\\n"),
                '\r' => result.push_str("\\r"),
                '\t' => result.push_str("\\t"),
                c if c < '\u{20}' => result.push_str(&format!("\\u{:04x}", c as u32)),
                c => result.push(c),
            },
        }
    }
    result.push('"');
    Ok(result)
}
fn index(key: &str) -> Option<u32> {
    let n = key.parse::<u32>().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}
/// Returns ordinary UTF-8 JSON text. Lone surrogates are escaped, real PUA is raw.
pub fn stringify(value: &Value, canonical: bool) -> CoreResult<String> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(_) => number(value)?,
        Value::String(s) => quote(s)?,
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|v| stringify(v, canonical))
                .collect::<CoreResult<Vec<_>>>()?
                .join(",")
        ),
        Value::Object(object) => {
            // Store decoded units once: comparator cannot swallow malformed wire.
            let mut entries = object
                .iter()
                .map(|(k, v)| Ok((k, v, wire_utf16_units(k)?)))
                .collect::<CoreResult<Vec<_>>>()?;
            if canonical {
                entries.sort_by(|a, b| a.2.cmp(&b.2));
            } else {
                entries.sort_by_key(|(k, _, _)| index(k).map_or((1, 0), |n| (0, n)));
            }
            format!(
                "{{{}}}",
                entries
                    .iter()
                    .map(|(k, v, _)| Ok(format!("{}:{}", quote(k)?, stringify(v, canonical)?)))
                    .collect::<CoreResult<Vec<_>>>()?
                    .join(",")
            )
        }
    })
}
/// Parses JS JSON text represented as a wire string. String tokens are decoded
/// to UTF-16 then wire-encoded BEFORE serde parses structure/numbers. This avoids
/// serde's rejection/loss of lone surrogate escapes and PUA double-encoding.
pub fn parse(text: &str) -> CoreResult<Value> {
    let units = wire_utf16_units(text)?;
    let mut output = String::new();
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        i += 1;
        if unit != 34 {
            if unit > 127 {
                return Err(syntax());
            }
            output.push(char::from(unit as u8));
            continue;
        }
        let mut token = Vec::new();
        let mut closed = false;
        while i < units.len() {
            let u = units[i];
            i += 1;
            if u == 34 {
                closed = true;
                break;
            }
            if u < 32 {
                return Err(syntax());
            }
            if u != 92 {
                token.push(u);
                continue;
            }
            let escape = *units.get(i).ok_or_else(syntax)?;
            i += 1;
            token.push(match escape {
                34 | 92 | 47 => escape,
                98 => 8,
                102 => 12,
                110 => 10,
                114 => 13,
                116 => 9,
                117 => {
                    let mut n = 0;
                    for _ in 0..4 {
                        let digit = *units.get(i).ok_or_else(syntax)?;
                        i += 1;
                        let d = char::from_u32(u32::from(digit))
                            .and_then(|c| c.to_digit(16))
                            .ok_or_else(syntax)?;
                        n = (n << 4) | d as u16;
                    }
                    n
                }
                _ => return Err(syntax()),
            });
        }
        if !closed {
            return Err(syntax());
        }
        output.push_str(
            &serde_json::to_string(&wire_from_utf16_units(&token)).map_err(|_| syntax())?,
        );
    }
    let mut value = serde_json::from_str(&output).map_err(|_| syntax())?;
    normalize_numbers(&mut value)?;
    Ok(value)
}
