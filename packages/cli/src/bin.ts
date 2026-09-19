import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { restartPackagedDaemon } from "../../host/src/restart.ts";
import { runTui } from "../../tui/src/main.ts";
import { runInboxdApplication } from "./application.ts";
import { launchPackagedDaemon } from "./daemon-launcher.ts";
import { createUdsCliHandlers, runCli, type CliHandlers } from "./index.ts";
import { ensureInstalledConfiguration, connectInstalledAccounts } from "./setup-runtime.ts";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log("usage: inboxd\n       inboxd connect [telegram|slack|kakao]\n       inboxd [--approver] <daemon|chat|message|sync|auth|send|doctor|safety> <action> [json]");
  process.exit(0);
}
const approverIndex = argv.indexOf("--approver");
const role = approverIndex >= 0 ? "approver" as const : "agent" as const;
if (approverIndex >= 0) argv.splice(approverIndex, 1);

let handlers: CliHandlers | undefined;
try {
  const root = join(homedir(), ".inboxd");
  const state = join(root, "state");
  const config = join(root, "config.json");
  const socket = join(state, "sock");
  const executableDirectory = dirname(process.execPath);
  const productDirectory = basename(process.execPath) === "inboxd"
    ? executableDirectory
    : resolve(import.meta.dir, "../../../target/inboxd-product/release");
  const daemonBinary = join(productDirectory, "inboxd-daemon");
  await runInboxdApplication(argv, {
    ensureConfigured: () => ensureInstalledConfiguration({
      root,
      state,
      config,
      database: join(state, "inboxd.db"),
      socket,
    }, productDirectory),
    launchDaemon: () => launchPackagedDaemon({ daemonBinary, configPath: config, socketPath: socket }).then(() => {}),
    runTui: async () => {
      while (await runTui({ socketPath: socket, role: "approver" }) === "connect") {
        const changed = await connectInstalledAccounts({ root, state, config, database: join(state, "inboxd.db"), socket }, productDirectory);
        if (changed) await restartPackagedDaemon({ daemonBinary, configPath: config, socketPath: socket });
      }
    },
    runCli: async (command) => {
      if (command[0] === "connect") {
        await ensureInstalledConfiguration({ root, state, config, database: join(state, "inboxd.db"), socket }, productDirectory, false);
        const changed = await connectInstalledAccounts({ root, state, config, database: join(state, "inboxd.db"), socket }, productDirectory, command[1]);
        if (changed) await restartPackagedDaemon({ daemonBinary, configPath: config, socketPath: socket });
        return;
      }
      handlers = createUdsCliHandlers({ role, daemonBinary, configPath: config, socketPath: socket });
      await runCli(command, { handlers });
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "command failed");
  process.exitCode = 1;
} finally {
  handlers?.stop();
}
