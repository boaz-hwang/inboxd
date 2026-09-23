use serde_json::Value;

/// Normalize Kakao hidden-message control envelopes. Its target logId is metadata,
/// never the identity of a message to delete or mark read.
pub fn message_body(platform: &str, body: &str) -> Option<String> {
    if platform != "kakao" || !body.trim_start().starts_with('{') {
        return Some(body.into());
    }
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return Some(body.into());
    };
    // targetRevision belongs to revision feeds (25), not hidden feeds (14).
    // Identify the common control envelope rather than requiring subtype fields.
    if !(v["feedType"].is_i64()
        && (v["logId"].is_string() || v["logId"].is_number())
        && v["hidden"].is_boolean())
    {
        return Some(body.into());
    }
    ["message", "text", "body"].into_iter().find_map(|key| {
        v[key]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revision_feeds_are_not_messages() {
        let feed =
            r#"{"logId":3935507181535623170,"targetRevision":1,"hidden":true,"feedType":25}"#;
        assert_eq!(message_body("kakao", feed), None);
        assert_eq!(message_body("telegram", feed), Some(feed.into()));
        for body in ["hello", r#"{"logId":12,"text":"ordinary JSON"}"#, "{broken"] {
            assert_eq!(message_body("kakao", body), Some(body.into()));
        }
        assert_eq!(
            message_body(
                "kakao",
                &feed.replace(
                    "\"feedType\":25",
                    "\"feedType\":25,\"message\":\"real text\""
                )
            ),
            Some("real text".into())
        );
    }
    #[test]
    fn hidden_feed_without_revision_is_not_a_message() {
        let feed = r#"{"logId":3934384549540935683,"byHost":false,"hidden":true,"feedType":14}"#;
        assert_eq!(message_body("kakao", feed), None);
        assert_eq!(message_body("telegram", feed), Some(feed.into()));
        for body in [
            r#"{"logId":1,"hidden":true}"#,
            r#"{"feedType":14,"text":"ordinary JSON"}"#,
        ] {
            assert_eq!(message_body("kakao", body), Some(body.into()));
        }
    }
}
