import { composeDaemon, type DaemonController, type DaemonOptions } from "./composition.ts";
import { defaultDatabasePath, defaultSocketPath } from "./lifecycle.ts";

export type { DaemonController, DaemonOptions } from "./composition.ts";
export { defaultDatabasePath, defaultSocketPath } from "./lifecycle.ts";

/** Starts the single production owner; clients must use its UDS protocol rather than a database path. */
export function createDaemon(options: Partial<DaemonOptions> & Pick<DaemonOptions, "keyProvider">): Promise<DaemonController> {
  return composeDaemon({ ...options, socketPath: options.socketPath ?? defaultSocketPath, databasePath: options.databasePath ?? defaultDatabasePath });
}
