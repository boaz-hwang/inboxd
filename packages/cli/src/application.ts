export interface InboxdApplicationDependencies {
  readonly ensureConfigured: () => Promise<void>;
  readonly launchDaemon: () => Promise<void>;
  readonly runTui: () => Promise<void>;
  readonly runCli: (argv: readonly string[]) => Promise<void>;
}

/** Routes bare execution to the interactive product and arguments to the CLI. */
export async function runInboxdApplication(
  argv: readonly string[],
  dependencies: InboxdApplicationDependencies,
): Promise<void> {
  if (argv.length > 0) {
    await dependencies.runCli(argv);
    return;
  }
  await dependencies.ensureConfigured();
  await dependencies.launchDaemon();
  await dependencies.runTui();
}
