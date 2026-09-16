import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createBlockedManifest, validateManifest } from "../probe.ts";

const schema = JSON.parse(readFileSync(new URL("../manifest.schema.json", import.meta.url), "utf8")) as {
  required: string[];
  properties: Record<string, { const?: unknown }>;
};

describe("measurement manifest", () => {
  test("schema requires privacy-critical manifest fields and forbids send", () => {
    expect(schema.required).toEqual([
      "schemaVersion",
      "kind",
      "status",
      "observation",
      "send",
      "scope",
      "redaction",
      "measurements",
    ]);
    expect(schema.properties.send.const).toBe(false);
    expect(schema.properties.status.const).toBe("BLOCKED");
  });

  test("creates a blocked manifest with every required privacy boundary", () => {
    const manifest = createBlockedManifest("probe");

    expect(manifest.status).toBe("BLOCKED");
    expect(manifest.observation).toBe("not_observed");
    expect(manifest.send).toBe(false);
    expect(manifest.scope.stableChatAllowlist).toEqual([]);
    expect(validateManifest(manifest)).toEqual([]);
  });

  test("rejects a raw body field even when nested in a manifest", () => {
    const manifest = createBlockedManifest("probe");
    const unsafe = { ...manifest, measurements: [{ ...manifest.measurements[0], messageBody: "private" }] };

    expect(validateManifest(unsafe)).toContain("manifest contains a forbidden secret, body, or path field");
  });

  test("rejects a raw secret field even when nested in a manifest", () => {
    const manifest = createBlockedManifest("db");
    const unsafe = { ...manifest, measurements: [{ ...manifest.measurements[0], databasePassword: "private" }] };

    expect(validateManifest(unsafe)).toContain("manifest contains a forbidden secret, body, or path field");
  });

  test("rejects raw data hidden under the redaction policy", () => {
    const manifest = createBlockedManifest("probe");
    const unsafe = { ...manifest, redaction: { ...manifest.redaction, rawBody: "private" } };

    expect(validateManifest(unsafe)).toContain("manifest contains a forbidden secret, body, or path field");
  });

  test("rejects manifests missing a required field or enabling send", () => {
    const manifest = createBlockedManifest("probe");
    const withoutStatus = { ...manifest, status: undefined };
    const withSend = { ...manifest, send: true };

    expect(validateManifest(withoutStatus)).toContain("status is required");
    expect(validateManifest(withSend)).toContain("send must be false");
  });
});
