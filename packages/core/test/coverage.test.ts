import { describe, expect, test } from "bun:test";
import {
  buildCoverage,
  coverageSegment,
  halfOpenInterval,
  type ChatKey,
} from "../src/index.ts";

const chat: ChatKey = {
  platform: "slack",
  account: "workspace-a",
  chat_id: "C123",
};

const target = { chat, interval: halfOpenInterval(0, 100) };

describe("coverage contracts", () => {
  test("rejects empty, reversed, and non-finite half-open intervals", () => {
    expect(() => halfOpenInterval(10, 10)).toThrow(/half-open/i);
    expect(() => halfOpenInterval(11, 10)).toThrow(/half-open/i);
    expect(() => halfOpenInterval(Number.NaN, 10)).toThrow(/finite/i);
  });

  test("reports an explicit unknown gap for a target with no coverage", () => {
    const coverage = buildCoverage({ target, covered: [], limits: [] });

    expect(coverage.target).toEqual(target);
    expect(coverage.covered).toEqual([]);
    expect(coverage.gaps).toEqual([
      { interval: halfOpenInterval(0, 100), reason: "unknown" },
    ]);
    expect("complete" in coverage).toBe(false);
  });

  test("keeps middle gaps rather than replacing them with a complete boolean", () => {
    const coverage = buildCoverage({
      target,
      covered: [
        coverageSegment({
          chat,
          interval: halfOpenInterval(0, 25),
          kind: "backfill",
          collected_at: 101,
          mutations_verified_at: null,
        }),
        coverageSegment({
          chat,
          interval: halfOpenInterval(75, 100),
          kind: "watch",
          collected_at: 102,
          mutations_verified_at: 103,
        }),
      ],
      limits: [],
    });

    expect(coverage.gaps).toEqual([
      { interval: halfOpenInterval(25, 75), reason: "unknown" },
    ]);
    expect(coverage.freshness).toEqual([
      { interval: halfOpenInterval(0, 25), collected_at: 101, mutations_verified_at: null },
      { interval: halfOpenInterval(75, 100), collected_at: 102, mutations_verified_at: 103 },
    ]);
  });

  test("treats verified_empty as coverage, distinct from unknown", () => {
    const coverage = buildCoverage({
      target,
      covered: [coverageSegment({
        chat,
        interval: halfOpenInterval(0, 100),
        kind: "verified_empty",
        collected_at: 101,
        mutations_verified_at: null,
      })],
      limits: [],
    });

    expect(coverage.covered[0]?.kind).toBe("verified_empty");
    expect(coverage.gaps).toEqual([]);
  });
});
