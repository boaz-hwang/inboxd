//! Conservative native Kakao event classification, shared by storage/history.
//! Exact values: storycraft/node-kakao stable/src/chat/chat-type.ts.
//! Unknown service/feed types stay unknown; deletion offset is never masked.
pub(crate) fn native_content_kind(kind: Option<i64>) -> &'static str {
    match kind {
        Some(1 | 26) => "text",
        Some(t) if t >= 16384 => "deleted",
        Some(
            2 | 3 | 4 | 5 | 6 | 12 | 14 | 16 | 17 | 18 | 20 | 24 | 25 | 27 | 51 | 71 | 72 | 97,
        ) => "media",
        _ => "unknown",
    }
}

pub(crate) fn native_placeholder(kind: Option<i64>) -> Option<&'static str> {
    match kind {
        Some(1 | 26) => None,
        Some(2) => Some("[사진]"),
        Some(3) => Some("[동영상]"),
        Some(5) => Some("[음성]"),
        Some(18) => Some("[파일]"),
        Some(27) => Some("[사진 여러 장]"),
        t if native_content_kind(t) == "deleted" => Some("[삭제 상태 메시지: 원문 미확인]"),
        t if native_content_kind(t) == "media" => Some("[카카오 첨부/구조화 메시지: 내용 미수집]"),
        _ => Some("[카카오 메시지 형식 미확인]"),
    }
}

/// Only an explicit native quote reference; prevId is a page chain, not a reply.
pub(crate) fn explicit_parent(row: &serde_json::Value) -> Option<String> {
    fn positive(value: &serde_json::Value) -> Option<String> {
        if let Some(s) = value.as_str() {
            if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                return s
                    .parse::<u64>()
                    .ok()
                    .filter(|n| *n > 0)
                    .map(|n| n.to_string());
            }
        }
        value.as_u64().filter(|n| *n > 0).map(|n| n.to_string())
    }
    if let Some(parent) = positive(&row["parent_id"]) {
        return Some(parent);
    }
    let attachment = &row["archive_metadata"]["attachment"];
    let parsed = attachment
        .as_str()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    positive(&parsed.as_ref().unwrap_or(attachment)["src_logId"])
}

#[cfg(test)]
mod tests {
    #[test]
    fn explicit_parent_accepts_only_positive_integer_or_decimal_string_references() {
        use serde_json::json;
        for parent in [json!(123), json!("123")] {
            let raw =
                json!({"archive_metadata":{"attachment":json!({"src_logId":parent}).to_string()}});
            assert_eq!(super::explicit_parent(&raw), Some("123".into()));
        }
        for parent in [
            json!(true),
            json!(1.5),
            json!(1.0),
            json!(0),
            json!(-1),
            json!("1.0"),
            json!("-2"),
        ] {
            assert_eq!(super::explicit_parent(&json!({"parent_id":parent})), None);
        }
        assert_eq!(
            super::explicit_parent(&json!({"archive_metadata":{"prevId":123}})),
            None
        );
    }
    #[test]
    fn exact_known_structured_events_are_nontext_but_deleted_types_are_not_masked() {
        for kind in [4, 6, 12, 14, 16, 17, 20, 24, 25, 51, 71, 72, 97] {
            assert_eq!(super::native_content_kind(Some(kind)), "media");
            assert!(super::native_placeholder(Some(kind)).is_some());
            assert_eq!(super::native_content_kind(Some(kind + 16384)), "deleted");
        }
        for kind in [0, 100, 1999] {
            assert_eq!(super::native_content_kind(Some(kind)), "unknown");
        }
    }
}
