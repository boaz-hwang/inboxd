import type { Database } from "bun:sqlite";
import { coreCall } from "../../native/src/index.ts";

import { recentMessages, readSyncState, applySyncBatch, diagnoseStore, migrateDatabase, openSqlCipherDatabase, type ApplySyncBatchInput, type SqlCipherKeyProvider } from "../../store/src/index.ts";
import { createSafetyService, type SafetyOptions, type SendTransport } from "../../safety/src/index.ts";
import type { ProtocolEvent } from "../../protocol/src/schema.ts";
import { acquireSingleInstanceLock, type SingleInstanceLock } from "./lock.ts";
import { daemonStateDirectory, removeStaleSocket } from "./lifecycle.ts";
import { recoverInterruptedSends } from "./recovery.ts";
import { createDaemonServer, type DaemonServer, type DaemonServerOptions, type TrustedApproverSessionAuthorizer } from "./server.ts";
import { ensureLocalApproverToken, matchesLocalApproverToken } from "./approver-token.ts";
import { createLocalKakaoBackfill, type LocalKakaoBackfillConfig } from "./local-kakao.ts";
import { createLocalSlackBackfill, type LocalSlackBackfillConfig } from "./local-slack.ts";

export interface DaemonOptions {
  readonly socketPath: string;
  readonly databasePath: string;
  readonly keyProvider: SqlCipherKeyProvider;
  readonly maxQueuedEvents?: number;
  /** A transport must be explicitly injected; the daemon never constructs a live sender. */
  readonly sendTransport?: SendTransport;
  readonly receiptReader?: SafetyOptions["receiptReader"];
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
  /** Explicit measured Kakao read composition; evidence, reader, and exact stable allowlist are mandatory. */
  readonly localKakao?: LocalKakaoBackfillConfig;
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
  const send_capable = options.sendTransport?.capabilities.send === true;
  // Non-finite values must remain invalid for a sender, but are irrelevant for
  // a read-only daemon. Convert only these configuration fields so JSON never
  // silently turns Infinity/NaN into null before Rust validates the policy.
  coreCall("domain.validateSendConfiguration", {
    send_capable,
    quota_limit: send_capable && Number.isFinite(options.quotaLimit) ? options.quotaLimit : null,
    global_quota_limit: send_capable && Number.isFinite(options.globalQuotaLimit) ? options.globalQuotaLimit : null,
    has_allow_send: options.allowSend !== undefined,
  });
}

/** The only composition root that opens the encrypted store and starts external owners. */
export async function composeDaemon(options: DaemonOptions): Promise<DaemonController> {
  assertConfiguredSendQuotas(options);
  let lock: SingleInstanceLock | undefined;
  let database: Database | undefined;
  let server: DaemonServer | undefined;
  try {
    if (options.backfill !== undefined && (options.localSlack !== undefined || options.localKakao !== undefined)) {
      throw new TypeError("custom backfill cannot be combined with local Slack or Kakao readers");
    }
    lock = acquireSingleInstanceLock(daemonStateDirectory(options.socketPath));
    const localApproverToken = ensureLocalApproverToken(options.socketPath);
    database = openOwnedStore(options);
    if (await removeStaleSocket(options.socketPath)) { /* stale endpoint removed under the exclusive lock */ }
    const safety = createSafetyService(database, {
      transport: options.sendTransport,
      receiptReader: options.receiptReader,
      approvalCode: options.approvalCode,
      globalQuotaLimit: options.globalQuotaLimit,
      quotaLimit: options.quotaLimit,
      transportTimeoutMs: options.transportTimeoutMs,
      // The normal daemon has one canonical writable platform. Unknown values,
      // aliases, and noncanonical spellings fail closed before transport I/O.
      allowSend: (proposal) => proposal.scope.platform === "slack" && options.allowSend?.(proposal) === true,
    });
    const slackBackfill = options.localSlack === undefined ? undefined : createLocalSlackBackfill(database, options.localSlack);
    const kakaoBackfill = options.localKakao === undefined ? undefined : createLocalKakaoBackfill(database, options.localKakao);
    const performBackfill = options.backfill ?? (slackBackfill === undefined && kakaoBackfill === undefined
      ? undefined
      : async (request: Parameters<NonNullable<DaemonServerOptions["backfill"]>>[0]) => {
        if (request.chat.platform === "slack" && slackBackfill !== undefined) return slackBackfill(request);
        if (request.chat.platform === "kakao" && kakaoBackfill !== undefined) return kakaoBackfill(request);
        throw new Error("sync.backfill is unavailable because no configured adapter matches the requested scope");
      });
    // Configuration registers discoverable scopes, not message, identity,
    // unread or coverage evidence. INSERT OR IGNORE preserves observed data.
    for (const [platform, reader] of [["slack", options.localSlack], ["kakao", options.localKakao]] as const) {
      for (const chat of reader?.allowedChats ?? []) {
        database.query("INSERT OR IGNORE INTO chats (platform, account, chat_id) VALUES (?, ?, ?)").run(platform, chat.account, chat.chat_id);
      }
    }
    const configuredPlatforms = [options.localSlack === undefined ? undefined : "slack", options.localKakao === undefined ? undefined : "kakao"]
      .filter((platform): platform is "slack" | "kakao" => platform !== undefined);
    const diagnosis = diagnoseStore(database);
    const auth = Object.fromEntries(configuredPlatforms.map((platform) => [platform, "unknown"]));
    const accountAuth = new Map<string, boolean>();
    const jobs = new Map<string, { platform: string; active: number; state: string; retry_at?: number }>();
    // Restore only committed observations; configuration itself proves no auth.
    for (const chat of options.localSlack?.allowedChats ?? []) {
      const scope = { platform: "slack", ...chat };
      const evidence = recentMessages(database, { chats: [scope], interval: { from_ts: 0, to_ts: 1 }, limit: 1 }).identities[0];
      accountAuth.set(JSON.stringify([scope.platform, scope.account]), evidence?.status === "known" && evidence.source === "authenticated_adapter");
      const saved = readSyncState(database, scope);
      if (saved !== null) {
        let state = "failed";
        let retry_at: number | undefined;
        try {
          const checkpoint = JSON.parse(saved.cursor);
          if (checkpoint.version === 1 && checkpoint.chat?.platform === scope.platform && checkpoint.chat?.account === scope.account && checkpoint.chat?.chat_id === scope.chat_id && typeof checkpoint.exhausted === "boolean") {
            state = "success";
            if (typeof checkpoint.retry_at === "number" && Number.isFinite(checkpoint.retry_at)) { state = "cooldown"; retry_at = checkpoint.retry_at; }
          }
        } catch { /* Invalid durable evidence reports failure, never a fabricated success. */ }
        jobs.set(JSON.stringify(scope), { platform: "slack", active: 0, state, retry_at });
      }
    }
    if (options.localSlack) auth.slack = options.localSlack.allowedChats.every((chat) => accountAuth.get(JSON.stringify(["slack", chat.account])) === true) ? "authenticated" : "unknown";
    const syncStatus = () => Object.fromEntries(configuredPlatforms.map((platform) => {
      const states = [...jobs.values()].filter((job) => job.platform === platform);
      const now = (platform === "slack" ? options.localSlack : options.localKakao)!.now();
      const observedState = (job: typeof states[number]) => job.active > 0 ? "running" : job.state === "cooldown" && job.retry_at !== undefined && now >= job.retry_at ? "retry_due" : job.state;
      const state = ["running", "cooldown", "failed", "retry_due", "success"].find((state) => states.some((job) => observedState(job) === state)) ?? "idle";
      const retries = states.flatMap((job) => job.retry_at === undefined ? [] : [job.retry_at]);
      return [platform, { state, active_jobs: states.reduce((count, job) => count + job.active, 0), ...(state === "cooldown" && retries.length ? { retry_at: Math.max(...retries) } : {}) }];
    }));
    const backfill: DaemonServerOptions["backfill"] = performBackfill === undefined ? undefined : async (request) => {
      const { platform, account } = request.chat;
      const configuredReader = platform === "slack" ? options.localSlack : platform === "kakao" ? options.localKakao : undefined;
      if (configuredReader && !configuredReader.allowedChats.some((chat) => chat.account === account && chat.chat_id === request.chat.chat_id)) throw new Error("read denied: exact stable account/chat allowlist required");
      const key = JSON.stringify(request.chat);
      const job = jobs.get(key) ?? { platform, active: 0, state: "idle" };
      jobs.set(key, job);
      job.active++;
      const updateAuth = (authenticated: boolean) => {
        accountAuth.set(JSON.stringify([platform, account]), authenticated);
        const reader = platform === "slack" ? options.localSlack : platform === "kakao" ? options.localKakao : undefined;
        const accounts = [...new Set(reader?.allowedChats.map((chat) => chat.account) ?? [])];
        if (reader) auth[platform] = accounts.every((account) => accountAuth.get(JSON.stringify([platform, account])) === true) ? "authenticated" : "unknown";
      };
      try {
        const result = await performBackfill(request);
        job.state = result.page_status === "rate_limited" ? "cooldown" : "success";
        job.retry_at = typeof result.retry_at === "number" ? result.retry_at : undefined;
        if (result.authenticated === true && platform === "slack" && options.localSlack !== undefined) updateAuth(true);
        return result;
      } catch (error) {
        job.state = "failed";
        job.retry_at = undefined;
        updateAuth(false);
        throw error;
      } finally { job.active--; }
    };
    const diagnostics = () => ({
      ready: true,
      owner: "daemon",
      send_capable: options.sendTransport?.capabilities.send === true,
      configured_platforms: configuredPlatforms,
      encryption: diagnosis,
      endpoint: { kind: "uds", permissions: "owner-only" },
      auth: { ...auth },
      sync: syncStatus(),
      isolation: {
        grade: "b",
        protected: false,
        warning: "same-user processes with shell, file, or Keychain access are outside the daemon isolation boundary",
      },
    });
    const authorizeApprover = options.isTrustedApproverSession ?? ((session) => matchesLocalApproverToken(localApproverToken, session.approverToken));
    server = createDaemonServer(database, options.maxQueuedEvents, { safety, isTrustedApproverSession: authorizeApprover, backfill, diagnostics });
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
