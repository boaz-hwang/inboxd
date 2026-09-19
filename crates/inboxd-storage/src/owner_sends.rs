//! Owner-authenticated send ledger, independent of agent proposal/approval state.
//! A committed reservation is never automatically dispatched again. Pending
//! includes the crash window before dispatch, so recovery deliberately errs
//! toward uncertainty instead of guessing whether the provider was called.
use inboxd_core::{CoreError, CoreResult};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn canonical(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let sorted: std::collections::BTreeMap<_, _> = object
                .into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        other => other,
    }
}

fn audit(connection: &Connection, action: &str, input: &Value) -> CoreResult<()> {
    let subject = format!(
        "{:x}",
        Sha256::digest(input["request_id"].as_str().unwrap_or_default().as_bytes())
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| failure())?
        .as_secs_f64()
        * 1000.;
    // Only daemon-generated session metadata and state, never credential or body.
    let payload = json!({"authorization":input["authorization"],"state":input["outcome"]["state"]})
        .to_string();
    connection
        .execute(
            "INSERT INTO audit (action, subject, payload_json, created_at) VALUES (?, ?, ?, ?)",
            params![action, subject, payload, now],
        )
        .map_err(|_| failure())?;
    Ok(())
}

fn failure() -> CoreError {
    CoreError::new(
        "OwnerSendStorageError",
        "Unable to persist owner send state",
    )
}
struct Identity<'a> {
    id: &'a str,
    platform: &'a str,
    account: &'a str,
    chat: &'a str,
    body: &'a str,
    envelope: String,
}
impl<'a> Identity<'a> {
    fn parse(input: &'a Value) -> CoreResult<Self> {
        let field = |name: &str| {
            input[name]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    CoreError::new("OwnerSendInputError", "Incomplete owner send identity")
                })
        };
        let identity = Self {
            id: field("request_id")?,
            platform: field("platform")?,
            account: field("account")?,
            chat: field("chat_id")?,
            body: field("body")?,
            envelope: canonical(input.get("envelope").cloned().unwrap_or_else(|| {
                let mut envelope = json!({"v":2,"destination":{"v":1,"kind":"chat","platform":input["platform"],"account":input["account"],"chat_id":input["chat_id"]},"content":{"mode":"text","body":input["body"]}});
                if let Some(parent) = input.get("parent_id") { envelope["reply"] = json!({"parent_id":parent}); }
                envelope
            })).to_string(),
        };
        if !(16..=80).contains(&identity.id.len())
            || identity.body.len() > 65536
            || identity.body.trim().is_empty()
        {
            return Err(CoreError::new(
                "OwnerSendInputError",
                "Invalid owner send identity",
            ));
        }
        Ok(identity)
    }
    fn lookup(&self, connection: &Connection) -> CoreResult<Option<(String, Value)>> {
        let row = connection.query_row(
            "SELECT platform, account, chat_id, body, state, outcome_json, envelope_json FROM owner_sends WHERE request_id = ?",
            [self.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?)),
        ).optional().map_err(|_| failure())?;
        let Some((platform, account, chat, body, state, outcome, envelope)) = row else {
            return Ok(None);
        };
        if (
            platform.as_str(),
            account.as_str(),
            chat.as_str(),
            body.as_str(),
        ) != (self.platform, self.account, self.chat, self.body)
            || envelope != self.envelope
        {
            return Err(CoreError::new(
                "OwnerSendIdentityError",
                "Owner send request ID was reused with a different identity",
            ));
        }
        let outcome = serde_json::from_str(&outcome).map_err(|_| failure())?;
        Ok(Some((state, outcome)))
    }
}

pub(super) fn execute(connection: &Connection, op: &str, input: &Value) -> CoreResult<Value> {
    if op == "ownerSend.recover" {
        let changed = connection.execute("UPDATE owner_sends SET state = 'Uncertain', outcome_json = '{\"state\":\"Uncertain\"}' WHERE state = 'Pending'", []).map_err(|_| failure())?;
        return Ok(json!({"recovered":changed}));
    }
    if !matches!(
        op,
        "ownerSend.lookup" | "ownerSend.reserve" | "ownerSend.complete" | "ownerSend.status"
    ) {
        return Err(CoreError::new(
            "OwnerSendInputError",
            "Unknown owner send operation",
        ));
    }
    if op == "ownerSend.status" {
        let id = input["id"].as_str().ok_or_else(failure)?;
        let value: Option<String> = connection
            .query_row(
                "SELECT outcome_json FROM owner_sends WHERE request_id = ?",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| failure())?;
        return value
            .map(|value| serde_json::from_str(&value).map_err(|_| failure()))
            .unwrap_or(Ok(Value::Null));
    }
    let identity = Identity::parse(input)?;
    if op == "ownerSend.lookup" {
        return Ok(identity
            .lookup(connection)?
            .map_or(Value::Null, |(_, outcome)| outcome));
    }
    let transaction = connection.unchecked_transaction().map_err(|_| failure())?;
    let previous = identity.lookup(&transaction)?;
    let result = if op == "ownerSend.reserve" {
        if let Some((_, outcome)) = previous {
            json!({"reserved":false,"outcome":outcome})
        } else {
            transaction.execute("INSERT INTO owner_sends (request_id, platform, account, chat_id, body, envelope_json, state, outcome_json) VALUES (?, ?, ?, ?, ?, ?, 'Pending', '{\"state\":\"Uncertain\"}')",
                params![identity.id, identity.platform, identity.account, identity.chat, identity.body, identity.envelope]).map_err(|_| failure())?;
            audit(&transaction, "send.reserved", input)?;
            json!({"reserved":true})
        }
    } else {
        let outcome = &input["outcome"];
        let state = outcome["state"]
            .as_str()
            .filter(|s| matches!(*s, "Sent" | "Verified" | "Failed" | "Uncertain"))
            .ok_or_else(|| CoreError::new("OwnerSendInputError", "Invalid owner send outcome"))?;
        let Some((previous_state, previous_outcome)) = previous else {
            return Err(CoreError::new(
                "OwnerSendStateError",
                "Owner send has no reservation",
            ));
        };
        if previous_state == "Sent"
            && state == "Verified"
            && previous_outcome["receipt"] == outcome["receipt"]
            && outcome.get("evidence").is_some()
        {
            transaction.execute("UPDATE owner_sends SET state = ?, outcome_json = ? WHERE request_id = ? AND state = 'Sent'", params![state, outcome.to_string(), identity.id]).map_err(|_| failure())?;
        } else if previous_state != "Pending" {
            if previous_outcome != *outcome {
                return Err(CoreError::new(
                    "OwnerSendStateError",
                    "Owner send outcome is already final",
                ));
            }
        } else {
            transaction.execute("UPDATE owner_sends SET state = ?, outcome_json = ? WHERE request_id = ? AND state = 'Pending'",
                params![state, outcome.to_string(), identity.id]).map_err(|_| failure())?;
        }
        if previous_state == "Pending" || (previous_state == "Sent" && state == "Verified") {
            audit(&transaction, "send.outcome", input)?;
        }
        outcome.clone()
    };
    transaction.commit().map_err(|_| failure())?;
    Ok(result)
}
