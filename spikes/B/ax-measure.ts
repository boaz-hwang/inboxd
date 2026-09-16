import { createBlockedManifest } from "./probe.ts";

export const AX_MEASURE_HELP = `Usage: bun run spikes/B/ax-measure.ts [--help]

Privacy-safe Kakao original accessibility measurement harness.
Default mode emits a BLOCKED/not_observed synthetic manifest.
It does not inspect accessibility trees, take screenshots, read UI content, or send.`;

export function axMeasurementManifest() {
  return createBlockedManifest("ax");
}

if (import.meta.main) {
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log(AX_MEASURE_HELP);
  } else {
    console.log(JSON.stringify(axMeasurementManifest(), null, 2));
  }
}
