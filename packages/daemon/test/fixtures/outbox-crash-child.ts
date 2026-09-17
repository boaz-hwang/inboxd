import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";

import { createDaemon } from "../../src/main.ts";

// Standalone test process only: synthetic SQLCipher key and an injected fake
// transport. Never import a platform connector or retrieve Keychain credentials.
if (process.env.NODE_ENV !== "test") throw new Error("outbox crash fixture requires NODE_ENV=test");
const [socketPath, databasePath, journalPath, stage = "transport-entered"] = process.argv.slice(2);
const encodedKey = process.env.INBOXD_CRASH_TEST_KEY;
if (!socketPath || !databasePath || !journalPath || !encodedKey || !/^[a-f0-9]{64}$/.test(encodedKey)) {
  throw new Error("outbox crash fixture requires temporary paths and a synthetic 32-byte key");
}
const key = Buffer.from(encodedKey, "hex");
delete process.env.INBOXD_CRASH_TEST_KEY;

function record(event: Record<string, unknown>) {
  const descriptor = openSync(journalPath!, "a", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(event)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

const daemon = await createDaemon({
  socketPath,
  databasePath,
  keyProvider: { getKey: () => key.slice() },
  quotaLimit: 1,
  globalQuotaLimit: 1,
  transportTimeoutMs: 60_000,
  allowSend: (proposal) => proposal.actor === "agent:crash-regression"
    && proposal.scope.platform === "slack"
    && proposal.scope.account === "crash-account"
    && ["crash-chat", "other-chat"].includes(proposal.scope.chat_id),
  sendTransport: {
    capabilities: { send: true },
    send(request) {
      const event = { event: "transport-entered", pid: process.pid, idempotency_key: request.idempotency_key };
      // Persist the invocation before notifying the parent. This journal spans
      // process lifetimes and detects accidental transport calls after restart.
      record(event);
      console.log(JSON.stringify(event));
      if (stage === "remote-succeeded") {
        // The fake destination durably accepts the exact message, then returns a
        // successful transport result. Gate its receipt consumption before the
        // local finalize transaction, without any production fault-injection hook.
        const accepted = { event: "remote-succeeded", pid: process.pid, idempotency_key: request.idempotency_key,
          receipt: "fake-remote-message", scope: request.scope, body: request.body };
        record(accepted);
        return Promise.resolve({ state: "sent" as const, get receipt(): string {
          console.log(JSON.stringify(accepted));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
          throw new Error("parent failed to SIGKILL before receipt consumption");
        } });
      }
      return new Promise(() => {});
    },
  },
  resendPersistedSends: () => { record({ event: "unexpected-resend-hook", pid: process.pid }); },
});
process.once("SIGTERM", () => {
  void daemon.stop().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
});
console.log(JSON.stringify({ event: "ready", pid: process.pid }));
