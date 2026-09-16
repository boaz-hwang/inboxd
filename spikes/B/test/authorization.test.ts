import { describe, expect, test } from "bun:test";
import { requireStablePreIoAllowlist } from "../db-measure.ts";

describe("pre-I/O authorization guard", () => {
  test("refuses before an I/O callback when the stable allowlist is absent", async () => {
    let reads = 0;
    const outcome = await requireStablePreIoAllowlist(
      { explicitAuthorization: true, stableChatAllowlist: [] },
      async () => {
        reads += 1;
        return "must not run";
      },
    );

    expect(outcome).toEqual({ allowed: false, reason: "stable pre-I/O allowlist is required" });
    expect(reads).toBe(0);
  });
});
