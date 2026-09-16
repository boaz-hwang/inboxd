import { describe, expect, test } from "bun:test";
import { redactRecord } from "../redaction.ts";

describe("privacy redaction", () => {
  test("redacts message bodies, secret values, and filesystem paths", () => {
    const result = redactRecord({
      body: "private message",
      password: "hunter2",
      dbPath: "/synthetic/fixture/chat.db",
      nested: { token: "abc123", content: "another private message" },
    });

    expect(result).toEqual({
      body: "[REDACTED:body]",
      password: "[REDACTED:secret]",
      dbPath: "[REDACTED:path]",
      nested: { token: "[REDACTED:secret]", content: "[REDACTED:body]" },
    });
  });
});
