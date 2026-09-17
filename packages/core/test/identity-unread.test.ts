import { expect, test } from "bun:test";
import { coreCall } from "../../native/src/index.ts";

test("unread evidence distinguishes platform zero, local estimate, and unknown", () => {
  const chat = { platform: "slack", account: "work", chat_id: "general" };
  const platform = { chat, status: "known", source: "platform", count: 0, observed_at: 100 };
  expect(coreCall<unknown>("domain.unreadState", platform)).toEqual(platform);
  const local = { ...platform, source: "local_estimate", count: 2, basis: { read_cursor: "opaque", interval: { from_ts: 10, to_ts: 100 } } };
  expect(coreCall<unknown>("domain.unreadState", local)).toEqual(local);
  const unknown = { chat, status: "unknown", source: "unknown", count: null, reason: "unsupported", observed_at: 100 };
  expect(coreCall<unknown>("domain.unreadState", unknown)).toEqual(unknown);
  for (const bad of [{ ...unknown, count: 0 }, { ...platform, source: "guess" }, { ...platform, count: -1 }, { ...platform, count: 0.5 }, { ...platform, count: NaN }, { ...local, basis: undefined }]) {
    expect(() => coreCall<unknown>("domain.unreadState", bad)).toThrow();
  }
});

const account = { platform: "slack", account: "work" };
test("self binding accepts only authenticated adapter identity, never display-name inference", () => {
  const binding = { ...account, status: "known", self_id: "U123", source: "authenticated_adapter", observed_at: 100 };
  expect(coreCall<unknown>("domain.accountIdentity", binding)).toEqual(binding);
  for (const bad of [{ source: "display_name" }, { self_id: " " }, { observed_at: NaN }, { status: "unknown", reason: "unsupported" }]) {
    expect(() => coreCall<unknown>("domain.accountIdentity", { ...binding, ...bad })).toThrow();
  }
  const unknown = { ...account, status: "unknown", source: "unknown", reason: "unsupported", observed_at: 100 };
  expect(coreCall<unknown>("domain.accountIdentity", unknown)).toEqual(unknown);
});
