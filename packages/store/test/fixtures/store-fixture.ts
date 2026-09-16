import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateDatabase } from "../../src/migrations.ts";
import { openSqlCipherDatabase, type SqlCipherKeyProvider } from "../../src/sqlcipher.ts";

export interface StoreFixture {
  readonly database: ReturnType<typeof openSqlCipherDatabase>;
  readonly chat: { platform: string; account: string; chat_id: string };
  dispose(): void;
}

export function createStoreFixture(): StoreFixture {
  const directory = mkdtempSync(join(tmpdir(), "inboxd-store-"));
  const key = crypto.getRandomValues(new Uint8Array(32));
  const keyProvider: SqlCipherKeyProvider = { getKey: () => key.slice() };
  const database = openSqlCipherDatabase({ filename: join(directory, "store.db"), keyProvider });
  migrateDatabase(database);
  return {
    database,
    chat: { platform: "test-platform", account: "account-1", chat_id: "chat-1" },
    dispose: () => {
      database.close();
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

export function event(
  chat: { platform: string; account: string; chat_id: string },
  kind: "create" | "edit" | "delete",
  revision: number,
  messageId = "message-1",
  body = "anonymous body",
) {
  const key = { ...chat, msg_id: messageId };
  if (kind === "create") {
    return {
      kind,
      message: { key, author_id: "person-1", ts: 100, body, attachments: [] },
      revision: { source: "adapter" as const, value: revision },
    };
  }
  if (kind === "edit") {
    return {
      kind,
      key,
      body,
      edited_at: 101,
      revision: { source: "adapter" as const, value: revision },
    };
  }
  return {
    kind,
    tombstone: { key, body: null, deleted_at: 102 },
    revision: { source: "adapter" as const, value: revision },
  };
}
