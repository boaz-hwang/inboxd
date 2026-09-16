import { createA2Manifest } from "./manifest.ts";

export const A2_HELP = `Usage: bun spikes/A2/run.ts [--help|--fixture|--live --approved-account <id> --approved-chat <id> --auth-input <name>]

Slack wrapper A2 is fixture-only by default. It never sends and has no live runner.
A --live request must name explicit approved account/chat IDs and an auth input;
even then it emits only a redacted not_observed manifest.`;

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  const value = index < 0 ? undefined : arguments_[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export function a2Cli(arguments_: readonly string[]): { readonly exitCode: number; readonly output: string } {
  if (arguments_.includes("--help") || arguments_.includes("-h")) return { exitCode: 0, output: A2_HELP };
  if (!arguments_.includes("--live")) return { exitCode: 0, output: JSON.stringify(createA2Manifest("fixture-only"), null, 2) };

  const approvedAccount = optionValue(arguments_, "--approved-account");
  const approvedChat = optionValue(arguments_, "--approved-chat");
  const authInput = optionValue(arguments_, "--auth-input");
  if (!approvedAccount || !approvedChat || !authInput) {
    return { exitCode: 2, output: "A2 live request requires --approved-account, --approved-chat, and --auth-input" };
  }
  return { exitCode: 0, output: JSON.stringify(createA2Manifest("live-requested"), null, 2) };
}

if (import.meta.main) {
  const result = a2Cli(Bun.argv.slice(2));
  console.log(result.output);
  process.exitCode = result.exitCode;
}
