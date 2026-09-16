import { composeDaemon, type DaemonController, type DaemonOptions } from "./composition.ts";
import { defaultDatabasePath, defaultSocketPath } from "./lifecycle.ts";
import type { LocalKakaoBackfillConfig } from "./local-kakao.ts";
import type { LocalSlackBackfillConfig } from "./local-slack.ts";

export type { DaemonController, DaemonOptions } from "./composition.ts";
export { defaultDatabasePath, defaultSocketPath } from "./lifecycle.ts";
export { defaultApproverTokenPath, readLocalApproverToken } from "./approver-token.ts";
export type { LocalSlackBackfillConfig } from "./local-slack.ts";
export type { LocalKakaoBackfillConfig } from "./local-kakao.ts";

/** Starts the single production owner; clients must use its UDS protocol rather than a database path. */
export function createDaemon(options: Partial<DaemonOptions> & Pick<DaemonOptions, "keyProvider">): Promise<DaemonController> {
  return composeDaemon({ ...options, socketPath: options.socketPath ?? defaultSocketPath, databasePath: options.databasePath ?? defaultDatabasePath });
}

export interface LocalSlackDaemonOptions extends Omit<DaemonOptions, "localSlack"> {
  readonly slack: LocalSlackBackfillConfig;
}

/** Explicit, non-test local Slack read composition. No runner/allowlist means no backfill route. */
export function createLocalSlackDaemon(options: LocalSlackDaemonOptions): Promise<DaemonController> {
  return composeDaemon({ ...options, localSlack: options.slack });
}

export interface LocalKakaoDaemonOptions extends Omit<DaemonOptions, "localKakao"> {
  readonly kakao: LocalKakaoBackfillConfig;
}

/** Explicit measured local Kakao read composition. No evidence/reader/allowlist means no backfill route. */
export function createLocalKakaoDaemon(options: LocalKakaoDaemonOptions): Promise<DaemonController> {
  return composeDaemon({ ...options, localKakao: options.kakao });
}
