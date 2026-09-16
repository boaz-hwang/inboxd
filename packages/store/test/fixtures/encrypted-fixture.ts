import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqlCipherKeyProvider } from "../../src/sqlcipher";

export interface EncryptedFixture {
  directory: string;
  databasePath: string;
  key: Uint8Array;
  keyProvider: SqlCipherKeyProvider;
  dispose(): void;
}

export function createEncryptedFixture(): EncryptedFixture {
  const directory = mkdtempSync(join(tmpdir(), "inboxd-sqlcipher-"));
  const key = crypto.getRandomValues(new Uint8Array(32));

  return {
    directory,
    databasePath: join(directory, "messages.db"),
    key,
    keyProvider: {
      getKey: () => key.slice(),
    },
    dispose: () => rmSync(directory, { force: true, recursive: true }),
  };
}

export function keyProviderFor(key: Uint8Array): SqlCipherKeyProvider {
  return { getKey: () => key.slice() };
}
