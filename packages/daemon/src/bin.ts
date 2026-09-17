import { runDaemonMain } from "./launcher.ts";

try {
  if (process.argv.includes("--help")) {
    console.log("usage: inboxd-daemon --config <owner-only-config.json>");
  } else {
    await runDaemonMain();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "daemon startup failed");
  process.exitCode = 1;
}
