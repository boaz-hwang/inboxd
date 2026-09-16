import { describe, expect, test } from "bun:test";
import { axMeasurementManifest, AX_MEASURE_HELP } from "../ax-measure.ts";

describe("AX measurement harness", () => {
  test("is synthetic-only and never emits a raw accessibility tree", () => {
    const manifest = axMeasurementManifest();

    expect(manifest.status).toBe("BLOCKED");
    expect(manifest.observation).toBe("not_observed");
    expect(manifest.send).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("AXNode");
    expect(AX_MEASURE_HELP).toContain("does not inspect accessibility trees");
  });
});
