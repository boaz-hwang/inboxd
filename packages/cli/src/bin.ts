import { createUdsCliHandlers, runCli, type CliHandlers } from "./index.ts";

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log("usage: inboxd [--approver] <daemon|chat|message|sync|auth|send|doctor|safety> <action> [json]");
  process.exit(0);
}
const approverIndex = argv.indexOf("--approver");
const role = approverIndex >= 0 ? "approver" as const : "agent" as const;
if (approverIndex >= 0) argv.splice(approverIndex, 1);

let handlers: CliHandlers | undefined;
try {
  handlers = createUdsCliHandlers({ role });
  await runCli(argv, { handlers });
} catch (error) {
  console.error(error instanceof Error ? error.message : "command failed");
  process.exitCode = 1;
} finally {
  handlers?.stop();
}
