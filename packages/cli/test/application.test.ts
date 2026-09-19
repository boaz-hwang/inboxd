import { expect, test } from "bun:test";

import { runInboxdApplication, type InboxdApplicationDependencies } from "../src/application.ts";

function dependencies(calls: string[]): InboxdApplicationDependencies {
  return {
    ensureConfigured: async () => { calls.push("configure"); },
    launchDaemon: async () => { calls.push("daemon"); },
    runTui: async () => { calls.push("tui"); },
    runCli: async (argv) => { calls.push(`cli:${argv.join(" ")}`); },
  };
}

test("bare inboxd configures, launches the daemon, then opens the TUI", async () => {
  const calls: string[] = [];
  await runInboxdApplication([], dependencies(calls));
  expect(calls).toEqual(["configure", "daemon", "tui"]);
});

test("inboxd subcommands preserve the non-interactive CLI path", async () => {
  const calls: string[] = [];
  await runInboxdApplication(["chat", "list"], dependencies(calls));
  expect(calls).toEqual(["cli:chat list"]);
});
