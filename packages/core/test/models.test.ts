import { describe, expect, test } from "bun:test";
import {
  messageKey,
  normalizeMessageEvent,
  type AdapterRevision,
  type MessageTombstone,
} from "../src/index.ts";

const key = messageKey({
  platform: "slack",
  account: "workspace-a",
  chat_id: "C123",
  msg_id: "1710000000.000100",
});

const revision: AdapterRevision = { source: "adapter", value: "1710000001.000000" };

describe("message domain v2", () => {
  test("requires every component of a message's composite scope", () => {
    expect(() => messageKey({ msg_id: "unscoped" } as never)).toThrow(
      /platform|account|chat_id/i,
    );
    expect(() => messageKey({
      platform: "slack",
      account: "workspace-a",
      chat_id: "C123",
      msg_id: "",
    })).toThrow(/msg_id/i);
  });

  test("normalizes revisioned create and edit events", () => {
    const created = normalizeMessageEvent({
      kind: "create",
      message: {
        key,
        author_id: "U123",
        ts: 1_710_000_000_000,
        body: "first version",
        attachments: [],
      },
      revision,
    });
    const edited = normalizeMessageEvent({
      kind: "edit",
      key,
      body: "second version",
      edited_at: 1_710_000_001_000,
      revision: { source: "adapter", value: "1710000002.000000" },
    });

    expect(created.kind).toBe("create");
    expect(created.revision).toEqual(revision);
    expect(edited).toMatchObject({ kind: "edit", key, body: "second version" });
  });

  test("represents delete events as bodyless tombstones with an adapter revision", () => {
    const tombstone: MessageTombstone = {
      key,
      body: null,
      deleted_at: 1_710_000_002_000,
    };
    const deleted = normalizeMessageEvent({ kind: "delete", tombstone, revision });

    expect(deleted.kind).toBe("delete");
    if (deleted.kind !== "delete") throw new Error("expected delete event");
    expect(deleted.tombstone.body).toBeNull();
    expect(deleted.tombstone.key).toEqual(key);
    expect(deleted.revision).toEqual(revision);
  });

  test("rejects a delete without a bodyless tombstone", () => {
    expect(() => normalizeMessageEvent({
      kind: "delete",
      tombstone: { key, body: "resurrected", deleted_at: 1_710_000_002_000 },
      revision,
    } as never)).toThrow(/tombstone|body/i);
  });
});
