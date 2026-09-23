import { expect, test } from "bun:test";
import { parseMessageSendParams, parseRequest, REQUEST_METHODS } from "../src/index.ts";

test("local recommendations and trajectories require the authenticated owner role", () => {
  for (const method of REQUEST_METHODS.filter(m => m.startsWith("response.") || m.startsWith("trajectory."))) {
    const frame = { type: "request", id: "1", method, params: {} };
    for (const role of ["reader", "agent", "mcp"] as const) expect(() => parseRequest(frame, role)).toThrow("authenticated");
    expect(parseRequest(frame, "sender").method).toBe(method);
    expect(parseRequest(frame, "approver").method).toBe(method);
  }
});

test("send metadata preserves the response session without changing the send envelope", () => {
  const input = { request_id: "request-id-at-least-sixteen", response_session_id: "session-1",
    chat: { platform: "kakao", account: "personal", chat_id: "room" }, body: "검토한 답장" };
  expect(parseMessageSendParams(input)).toEqual(input);
  expect(() => parseMessageSendParams({ ...input, response_session_id: "" })).toThrow();
});
