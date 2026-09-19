import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

import {
  readPackagedTelegramApplication,
  telegramProviderFromBootstrap,
  verifySlackProvider,
} from "../src/provider-setup.ts";

test("Telegram setup reads only a manifest-hashed owner-only packaged application credential", () => {
  const directory = mkdtempSync(join(process.env.HOME!, ".inboxd-telegram-app-test-"));
  try {
    chmodSync(directory, 0o700);
    const credential = `${JSON.stringify({ api_id: "12345", api_hash: "0123456789abcdef0123456789abcdef" })}\n`;
    writeFileSync(join(directory, "telegram-app.json"), credential, { mode: 0o600 });
    const hash = createHash("sha256").update(credential).digest("hex");
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      schema_version: "inboxd-product/v1",
      files: [{
        name: "telegram-app.json",
        kind: "application-credential",
        source_entrypoint: "installer:telegram-app-credentials",
        sha256: hash,
        mode: "0600",
      }],
    }), { mode: 0o600 });

    expect(readPackagedTelegramApplication(directory)).toEqual({
      apiId: "12345",
      apiHash: "0123456789abcdef0123456789abcdef",
    });
    writeFileSync(join(directory, "telegram-app.json"), credential.replace("12345", "54321"), { mode: 0o600 });
    expect(() => readPackagedTelegramApplication(directory)).toThrow("hash mismatch");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authenticated Telegram bootstrap result becomes one canonical self-chat binding", () => {
  expect(telegramProviderFromBootstrap({
    schema_version: "inboxd-telegram-bootstrap/v1",
    self_user_id: "777000",
    self_chat_id: "-100123",
    first_name: "Self",
    last_name: "",
    chat_title: "Saved Messages",
    unread_count: 0,
    history_read_count: 1,
  }, { apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef" })).toEqual({
    kind: "telegram",
    binding_id: "telegram-personal",
    account: "telegram:self:777000",
    chat_id: "telegram:chat:-100123",
    self_user_id: "777000",
    api_id: 12345,
    api_hash: "0123456789abcdef0123456789abcdef",
  });
});

test("Slack setup requires authenticated team and exact channel observations", async () => {
  const calls: string[] = [];
  const provider = await verifySlackProvider({ token: "xoxb-secret-token", channelId: "C123" }, async (method, token, body) => {
    calls.push(`${method}:${token}:${body.channel ?? ""}`);
    if (method === "auth.test") return { ok: true, team_id: "T123", user_id: "U123" };
    return { ok: true, channel: { id: "C123", name: "general" } };
  });
  expect(calls).toEqual([
    "auth.test:xoxb-secret-token:",
    "conversations.info:xoxb-secret-token:C123",
  ]);
  expect(provider).toEqual({
    kind: "slack",
    binding_id: "slack-T123-C123",
    account: "slack:team:T123",
    chat_id: "C123",
    team_id: "T123",
    bot_token: "xoxb-secret-token",
  });
});

test("Slack setup refuses a channel response outside the requested scope", async () => {
  let calls = 0;
  await expect(verifySlackProvider({ token: "xoxb-secret-token", channelId: "C123" }, async (method) => {
    calls++;
    return method === "auth.test"
      ? { ok: true, team_id: "T123", user_id: "U123" }
      : { ok: true, channel: { id: "C999" } };
  })).rejects.toThrow("channel verification failed");
  expect(calls).toBe(2);
});
