//! Provider workspace identities map to the existing shared message keys here,
//! before storage. Storage itself does not know SDK/provider ID formats.
use serde_json::{Value, json};

pub(crate) fn chat(platform: &str, id: &str) -> String {
    if platform == "telegram" && !id.starts_with("telegram:chat:") {
        format!("telegram:chat:{id}")
    } else {
        id.into()
    }
}
pub(crate) fn observations(platform: &str, rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            let mut row = row.clone();
            if platform == "telegram" {
                if let (Some(room), Some(id)) = (row["chat_id"].as_str(), row["id"].as_str()) {
                    let raw = room.strip_prefix("telegram:chat:").unwrap_or(room);
                    let id = if id.starts_with("telegram:message:") {
                        id.into()
                    } else {
                        format!("telegram:message:{raw}:{id}")
                    };
                    row["chat_id"] = json!(chat(platform, room));
                    row["id"] = json!(id);
                }
                if let Some(author) = row["author_id"]
                    .as_str()
                    .filter(|s| !s.starts_with("telegram:"))
                {
                    row["author_id"] = json!(format!(
                        "telegram:{}:{author}",
                        if row["author_kind"] == "chat" {
                            "chat"
                        } else {
                            "user"
                        }
                    ));
                }
            }
            row
        })
        .collect()
}
pub(crate) fn workspace_result(platform: &str, result: &mut Value) {
    if platform != "telegram" {
        return;
    }
    if let Some(rows) = result["messages"].as_array_mut() {
        for row in rows {
            if let (Some(room), Some(id)) = (row["chat_id"].as_str(), row["msg_id"].as_str()) {
                let raw = room
                    .strip_prefix("telegram:chat:")
                    .unwrap_or(room)
                    .to_owned();
                let id = id
                    .strip_prefix(&format!("telegram:message:{raw}:"))
                    .unwrap_or(id)
                    .to_owned();
                row["chat_id"] = json!(raw);
                row["msg_id"] = json!(id);
                row["id"] = row["msg_id"].clone();
            }
        }
    }
}
