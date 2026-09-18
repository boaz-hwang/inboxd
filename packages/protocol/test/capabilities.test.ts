import { describe, expect, test } from "bun:test";
import {
  parseChatRef,
  parseDestinationRef,
  parseResourceCapabilities,
  parseResourceCapability,
} from "../src/index.ts";

const fixture = await Bun.file(new URL("../../../test/fixtures/protocol/capabilities-v1.json", import.meta.url)).json();

describe("exact-resource capabilities v1", () => {
  test("keeps chat and write-only destination references structurally distinct", () => {
    const chat = { v: 1, kind: "chat", platform: "kakao", account: "local", chat_id: "room-7" } as const;
    const destination = { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" } as const;

    expect(parseChatRef(chat)).toEqual(chat);
    expect(parseDestinationRef(destination)).toEqual(destination);
    expect(() => parseChatRef(destination)).toThrow(/chat/i);
    expect(() => parseDestinationRef(chat)).toThrow(/destination/i);
    expect(() => parseChatRef({ ...chat, destination_id: "must-not-alias" })).toThrow(/unknown field/i);
  });

  test("accepts the four frozen provider resource shapes", () => {
    const parsed = parseResourceCapabilities(fixture);
    expect(parsed.resources).toHaveLength(4);
    expect(parsed.resources.map((entry) => [entry.resource.kind, entry.read.mode, entry.write.content_mode, entry.receipt.level])).toEqual([
      ["chat", "bounded_history", "text", "independent_readback"],
      ["chat", "bounded_history", "text", "independent_readback"],
      ["chat", "measured_local", "none", "none"],
      ["destination", "none", "approved_template", "ack_only"],
    ]);
  });

  test("rejects capability combinations that overclaim a resource", () => {
    const [slack, , kakaoLocal, kakaoOfficial] = fixture.resources;
    for (const value of [
      { ...slack, read: { mode: "none", limits: slack.read.limits } },
      { ...kakaoLocal, read: { ...kakaoLocal.read, limits: { ...kakaoLocal.read.limits, max_pages: 2 } } },
      { ...kakaoLocal, write: { mode: "none", content_mode: "text", reply: false } },
      { ...kakaoOfficial, resource: { ...kakaoOfficial.resource, kind: "chat", chat_id: "room-7" } },
      { ...kakaoOfficial, read: slack.read },
      { ...kakaoOfficial, write: { ...kakaoOfficial.write, reply: true } },
      { ...kakaoOfficial, receipt: { level: "independent_readback" } },
      { ...slack, auth: { ...slack.auth, reason: "must-be-null" } },
      { ...kakaoOfficial, auth: { ...kakaoOfficial.auth, reason: null } },
      { ...slack, display_name: "not-an-identity" },
    ]) expect(() => parseResourceCapability(value)).toThrow();
  });

  test("rejects duplicate structural resources without display-string keys", () => {
    expect(() => parseResourceCapabilities({ v: 1, resources: [fixture.resources[0], fixture.resources[0]] })).toThrow(/duplicate/i);
  });

  test("exhaustively permits chat text sends and destination template sends only", () => {
    const kinds = ["chat", "destination"] as const;
    const writeModes = ["none", "send"] as const;
    const contentModes = ["none", "text", "approved_template"] as const;
    const replies = [false, true] as const;
    let combinations = 0;
    for (const kind of kinds) {
      for (const mode of writeModes) {
        for (const content_mode of contentModes) {
          for (const reply of replies) {
            combinations += 1;
            const base = kind === "chat" ? fixture.resources[0] : fixture.resources[3];
            const candidate = {
              ...base,
              read: kind === "chat" ? fixture.resources[0].read : { mode: "none", limits: null },
              write: { mode, content_mode, reply },
              receipt: { level: "none" },
            };
            const valid = mode === "none"
              ? content_mode === "none" && !reply
              : kind === "chat"
                ? content_mode === "text"
                : content_mode === "approved_template" && !reply;
            if (valid) expect(parseResourceCapability(candidate).write).toEqual(candidate.write);
            else expect(() => parseResourceCapability(candidate)).toThrow(/write|content|text|template|reply/i);
          }
        }
      }
    }
    expect(combinations).toBe(24);
  });
});
