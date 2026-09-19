import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ProviderConfiguration } from "./setup.ts";

interface TelegramCredentials {
  readonly apiId: string;
  readonly apiHash: string;
}

function readOwnerOnlyFile(path: string, maximumBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (uid === undefined || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`unsafe packaged file: ${path}`);
    }
    if (stat.size < 1 || stat.size > maximumBytes) throw new Error(`invalid packaged file size: ${path}`);
    const bytes = readFileSync(descriptor);
    if (bytes.length !== stat.size) throw new Error(`packaged file changed while reading: ${path}`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function readPackagedTelegramApplication(productDirectory: string): TelegramCredentials {
  const directory = lstatSync(productDirectory);
  const uid = process.getuid?.();
  if (uid === undefined || directory.isSymbolicLink() || !directory.isDirectory()
    || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
    throw new Error("unsafe Inboxd product directory");
  }
  const manifest = JSON.parse(
    readOwnerOnlyFile(join(productDirectory, "manifest.json"), 64 * 1024).toString("utf8"),
  ) as { schema_version?: unknown; files?: unknown };
  if (manifest.schema_version !== "inboxd-product/v1" || !Array.isArray(manifest.files)) {
    throw new Error("invalid Inboxd product manifest");
  }
  const entries = manifest.files.filter((value): value is Record<string, unknown> => (
    typeof value === "object" && value !== null && value.name === "telegram-app.json"
  ));
  if (entries.length !== 1) throw new Error("packaged Telegram application credential is missing or duplicated");
  const entry = entries[0]!;
  if (entry.kind !== "application-credential"
    || entry.source_entrypoint !== "installer:telegram-app-credentials"
    || entry.mode !== "0600"
    || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new Error("invalid packaged Telegram application credential manifest entry");
  }
  const credentialBytes = readOwnerOnlyFile(join(productDirectory, "telegram-app.json"), 256);
  if (createHash("sha256").update(credentialBytes).digest("hex") !== entry.sha256) {
    throw new Error("packaged Telegram application credential hash mismatch");
  }
  const credential = JSON.parse(credentialBytes.toString("utf8")) as Record<string, unknown>;
  const apiId = credential.api_id;
  const apiHash = credential.api_hash;
  if (Object.keys(credential).sort().join(",") !== "api_hash,api_id"
    || typeof apiId !== "string" || !/^[1-9]\d{0,9}$/.test(apiId)
    || typeof apiHash !== "string" || !/^[0-9a-f]{32}$/.test(apiHash)) {
    throw new Error("invalid packaged Telegram application credential");
  }
  return { apiId, apiHash };
}

interface SlackSetupInput {
  readonly token: string;
  readonly channelId: string;
}

export type SlackSetupMethod = "auth.test" | "conversations.info";
export type SlackSetupCall = (
  method: SlackSetupMethod,
  token: string,
  body: Readonly<Record<string, string>>,
) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("provider returned malformed data");
  return value as Record<string, unknown>;
}

export function telegramProviderFromBootstrap(
  value: unknown,
  credentials: TelegramCredentials,
): ProviderConfiguration {
  const result = record(value);
  if (result.schema_version !== "inboxd-telegram-bootstrap/v1") throw new Error("Telegram bootstrap result is invalid");
  const selfUserId = result.self_user_id;
  const selfChatId = result.self_chat_id;
  if (typeof selfUserId !== "string" || !/^[1-9]\d*$/.test(selfUserId)
    || typeof selfChatId !== "string" || !/^-?[1-9]\d*$/.test(selfChatId)
    || !/^[1-9]\d*$/.test(credentials.apiId)
    || BigInt(credentials.apiId) > 2_147_483_647n
    || !/^[0-9a-f]{32}$/.test(credentials.apiHash)) {
    throw new Error("Telegram bootstrap result is invalid");
  }
  return {
    kind: "telegram",
    binding_id: "telegram-personal",
    account: `telegram:self:${selfUserId}`,
    chat_id: `telegram:chat:${selfChatId}`,
    self_user_id: selfUserId,
    api_id: Number(credentials.apiId),
    api_hash: credentials.apiHash,
  };
}

export async function verifySlackProvider(
  input: SlackSetupInput,
  call: SlackSetupCall,
): Promise<ProviderConfiguration> {
  if (input.token.length < 8 || input.token.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(input.token)) {
    throw new Error("Slack token is invalid");
  }
  if (!/^[A-Z0-9]{2,128}$/.test(input.channelId)) throw new Error("Slack channel ID is invalid");
  const auth = record(await call("auth.test", input.token, {}));
  const teamId = auth.team_id;
  if (auth.ok !== true || typeof teamId !== "string" || !/^[A-Z0-9]{2,128}$/.test(teamId)
    || typeof auth.user_id !== "string") {
    throw new Error("Slack authentication failed");
  }
  const info = record(await call("conversations.info", input.token, { channel: input.channelId }));
  const channel = record(info.channel);
  if (info.ok !== true || channel.id !== input.channelId) throw new Error("Slack channel verification failed");
  return {
    kind: "slack",
    binding_id: `slack-${teamId}-${input.channelId}`,
    account: `slack:team:${teamId}`,
    chat_id: input.channelId,
    team_id: teamId,
    bot_token: input.token,
  };
}
