import type { Database } from "bun:sqlite";

import { applySyncBatch, diagnoseStore, migrateDatabase, openSqlCipherDatabase, type ApplySyncBatchInput, type SqlCipherKeyProvider } from "../../store/src/index.ts";
import { createSafetyService, type SafetyOptions, type SendTransport } from "../../safety/src/index.ts";
import type { ProtocolEvent } from "../../protocol/src/schema.ts";
import { acquireSingleInstanceLock, type SingleInstanceLock } from "./lock.ts";
import { daemonStateDirectory, removeStaleSocket } from "./lifecycle.ts";
import { recoverInterruptedSends } from "./recovery.ts";
import { createDaemonServer, type DaemonServer, type DaemonServerOptions, type TrustedApproverSessionAuthorizer } from "./server.ts";
import { ensureLocalApproverToken, matchesLocalApproverToken } from "./approver-token.ts";
import { createLocalSlackBackfill, type LocalSlackBackfillConfig } from "./local-slack.ts";

export interface DaemonOptions {
  readonly socketPath: string;
  readonly databasePath: string;
  readonly keyProvider: SqlCipherKeyProvider;
  readonly maxQueuedEvents?: number;
  /** A transport must be explicitly injected; the daemon never constructs a live sender. */
  readonly sendTransport?: SendTransport;
  readonly approvalCode?: SafetyOptions["approvalCode"];
  readonly globalQuotaLimit?: SafetyOptions["globalQuotaLimit"];
  readonly quotaLimit?: SafetyOptions["quotaLimit"];
  readonly transportTimeoutMs?: SafetyOptions["transportTimeoutMs"];
  readonly allowSend?: SafetyOptions["allowSend"];
  /** Code-bearing operations are default-denied unless this local-session predicate approves them. */
  readonly isTrustedApproverSession?: TrustedApproverSessionAuthorizer;
  readonly backfill?: DaemonServerOptions["backfill"];
  /** Explicit non-live Slack read composition; a runner and exact stable allowlist are mandatory. */
  readonly localSlack?: LocalSlackBackfillConfig;
  readonly startSync?: () => void | Promise<void>;
  readonly startPlatform?: () => void | Promise<void>;
  readonly startCredentials?: () => void | Promise<void>;
  readonly startAudit?: () => void | Promise<void>;
  /** Present only to make accidental resend wiring observable; it is never invoked on recovery. */
  readonly resendPersistedSends?: () => void | Promise<void>;
}

export interface DaemonController {
  apply(input: ApplySyncBatchInput): void;
  publish(event: ProtocolEvent): void;
  stop(): Promise<void>;
}

function openOwnedStore(options: DaemonOptions): Database {
  const database = openSqlCipherDatabase({ filename: options.databasePath, keyProvider: options.keyProvider });
  try {
    migrateDatabase(database);
    const diagnosis = diagnoseStore(database);
    if (!diagnosis.ready) throw new Error("encrypted store doctor did not report ready");
    recoverInterruptedSends(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function assertConfiguredSendQuotas(options: DaemonOptions): void {
  if (options.sendTransport?.capabilities.send !== true) return;
  for (const [name, value] of [["per-scope", options.quotaLimit], ["global", options.globalQuotaLimit]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new TypeError(`send-capable daemon requires an explicitly configured finite positive ${name} quota`);
    }
  }
}

/** The only composition root that opens the encrypted store and starts external owners. */
export async function composeDaemon(options: DaemonOptions): Promise<DaemonController> {
  assertConfiguredSendQuotas(options);
  let lock: SingleInstanceLock | undefined;
  let database: Database | undefined;
  let server: DaemonServer | undefined;
  try {
    if (options.backfill !== undefined && options.localSlack !== undefined) throw new TypeError("configure either backfill or localSlack, not both");
    lock = acquireSingleInstanceLock(daemonStateDirectory(options.socketPath));
    const localApproverToken = ensureLocalApproverToken(options.socketPath);
    database = openOwnedStore(options);
    if (await removeStaleSocket(options.socketPath)) { /* stale endpoint removed under the exclusive lock */ }
    const safety = createSafetyService(database, {
      transport: options.sendTransport,
      approvalCode: options.approvalCode,
      globalQuotaLimit: options.globalQuotaLimit,
      quotaLimit: options.quotaLimit,
      transportTimeoutMs: options.transportTimeoutMs,
      allowSend: options.allowSend,
    });
    const backfill = options.backfill ?? (options.localSlack === undefined ? undefined : createLocalSlackBackfill(database, options.localSlack));
    const authorizeApprover = options.isTrustedApproverSession ?? ((session) => matchesLocalApproverToken(localApproverToken, session.approverToken));
    server = createDaemonServer(database, options.maxQueuedEvents, { safety, isTrustedApproverSession: authorizeApprover, backfill });
    await server.listen(options.socketPath);
    // No sync/platform/credential/audit work begins until SQLCipher, schema, recovery, and UDS are ready.
    await options.startCredentials?.();
    await options.startAudit?.();
    await options.startPlatform?.();
    await options.startSync?.();
    const ownedDatabase = database;
    const ownedServer = server;
    let stopped = false;
    return {
      apply(input) {
        applySyncBatch(ownedDatabase, input);
        for (const event of input.events ?? []) {
          const raw = event as { kind?: unknown };
          ownedServer.publish({ type: "event", method: "message.upserted", params: { kind: typeof raw.kind === "string" ? raw.kind : "unknown" } });
        }
        if ((input.coverage?.length ?? 0) > 0) ownedServer.publish({ type: "event", method: "coverage.changed", params: {} });
      },
      publish: (event) => ownedServer.publish(event),
      async stop() {
        if (stopped) return;
        stopped = true;
        await ownedServer.close();
        ownedDatabase.close();
        lock?.release();
      },
    };
  } catch (error) {
    try { await server?.close(); } catch { /* best-effort cleanup after failed startup */ }
    database?.close();
    lock?.release();
    throw error;
  }
}
