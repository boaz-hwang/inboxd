import { expect, test } from "bun:test";
import {
  MAX_TELEGRAM_PAGE_SIZE,
  normalizeTelegramMessage,
  normalizeTelegramPage,
} from "../src/normalization.ts";

const tdTextMessage = (overrides: Record<string, unknown> = {}) => ({
  "@type": "message",
  id: "9007199254740000",
  chat_id: "-1001234567890",
  sender_id: { "@type": "messageSenderUser", user_id: "777000" },
  date: 1_700_000_000,
  is_outgoing: true,
  content: {
    "@type": "messageText",
    text: { "@type": "formattedText", text: "hello from TDLib", entities: [] },
  },
  ...overrides,
});

test("normalizes one TDLib text message without inferred account or read state", () => {
  expect(normalizeTelegramMessage(tdTextMessage())).toEqual({
    chat_id: "telegram:chat:-1001234567890",
    message_id: "telegram:message:-1001234567890:9007199254740000",
    sender: { kind: "user", id: "telegram:user:777000" },
    body: "hello from TDLib",
    timestamp: 1_700_000_000,
    reply_to: null,
  });
});

test("preserves TDLib chat senders as structural sender identities", () => {
  const raw = tdTextMessage({
    sender_id: { "@type": "messageSenderChat", chat_id: "-1002223334445" },
  });

  expect(normalizeTelegramMessage(raw).sender).toEqual({
    kind: "chat",
    id: "telegram:chat:-1002223334445",
  });
});

test("normalizes TDLib message reply targets in their own chat scope", () => {
  const raw = tdTextMessage({
    reply_to: {
      "@type": "messageReplyToMessage",
      chat_id: "-1009876543210",
      message_id: "456789",
    },
  });

  expect(normalizeTelegramMessage(raw).reply_to).toEqual({
    chat_id: "telegram:chat:-1009876543210",
    message_id: "telegram:message:-1009876543210:456789",
  });
});

test("rejects unsupported TDLib message content explicitly", () => {
  expect(() => normalizeTelegramMessage(tdTextMessage({
    content: { "@type": "messagePhoto", caption: { text: "not normalized as text" } },
  }))).toThrow(expect.objectContaining({
    name: "TelegramNormalizationError",
    code: "UNSUPPORTED_CONTENT",
  }));
});

test("rejects malformed TDLib messages without partial normalization", () => {
  const malformed = [
    null,
    tdTextMessage({ id: Number.MAX_SAFE_INTEGER + 1 }),
    tdTextMessage({ chat_id: "-01" }),
    tdTextMessage({ sender_id: { "@type": "messageSenderUser", user_id: "01" } }),
    tdTextMessage({ date: 1.5 }),
    tdTextMessage({
      content: { "@type": "messageText", text: { "@type": "formattedText", text: "", entities: [] } },
    }),
    tdTextMessage({
      reply_to: { "@type": "messageReplyToMessage", chat_id: 0, message_id: 0 },
    }),
  ];

  for (const raw of malformed) {
    expect(() => normalizeTelegramMessage(raw)).toThrow(expect.objectContaining({
      name: "TelegramNormalizationError",
      code: "MALFORMED_MESSAGE",
    }));
  }
});

test("normalizes a TDLib messages page without identity or readback claims", () => {
  const second = tdTextMessage({
    id: "9007199254740001",
    content: {
      "@type": "messageText",
      text: { "@type": "formattedText", text: "second", entities: [] },
    },
  });
  const normalized = normalizeTelegramPage({
    "@type": "messages",
    total_count: 2,
    messages: [tdTextMessage(), second],
    self_id: "untrusted-self",
    read_inbox_max_message_id: "9007199254740001",
  }, { limit: 2, continuation: null });

  expect(normalized).toEqual({
    messages: [
      normalizeTelegramMessage(tdTextMessage()),
      normalizeTelegramMessage(second),
    ],
    continuation: null,
  });
});

test("rejects a TDLib page above its requested item bound", () => {
  expect(() => normalizeTelegramPage({
    "@type": "messages",
    messages: [tdTextMessage(), tdTextMessage({ id: "2" })],
  }, { limit: 1, continuation: null })).toThrow(expect.objectContaining({
    name: "TelegramNormalizationError",
    code: "PAGE_BOUND_EXCEEDED",
  }));
});

test("enforces a fixed 1..100 Telegram page limit", () => {
  expect(MAX_TELEGRAM_PAGE_SIZE).toBe(100);
  for (const limit of [0, 101, 1.5, Number.NaN]) {
    expect(() => normalizeTelegramPage({
      "@type": "messages",
      messages: [],
    }, { limit, continuation: null })).toThrow(expect.objectContaining({
      name: "TelegramNormalizationError",
      code: "INVALID_PAGE_LIMIT",
    }));
  }
});

test("preserves an opaque Telegram continuation byte-for-byte", () => {
  const continuation = "tdlib:v1/한🙂?raw=%2B%2F";
  const normalized = normalizeTelegramPage({
    "@type": "messages",
    messages: [],
  }, { limit: 1, continuation });

  expect(normalized.continuation).toBe(continuation);
});
