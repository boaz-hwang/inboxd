import { expect, test } from "bun:test";
import { accountErrorMessage, KAKAO_AUTH_EXPIRED } from "../src/errors.ts";
import { dispatch } from "../src/dispatch.ts";

test("expired auth is actionable without leaking provider error text", async () => {
  const error = Object.assign(new Error("private token detail"), { code: "invalid_access_token" });
  expect(accountErrorMessage(error)).toBe(KAKAO_AUTH_EXPIRED);
  expect(accountErrorMessage(new Error("private token detail"))).not.toContain("private");
  let caught: unknown;
  try {
    await dispatch({ close() {}, async run() { throw error; } }, { op: "batch", requests: [{ op: "kakao_page", chat_id: "room" }] });
  } catch (error) { caught = error; }
  expect(accountErrorMessage(caught)).toBe(KAKAO_AUTH_EXPIRED);
});

test("Slack and Telegram authentication errors survive batch IPC without secrets", async () => {
  for (const [code, command] of [["slack_auth_required", "connect slack"], ["telegram_auth_required", "connect telegram"]]) {
    let caught: unknown;
    try { await dispatch({ close() {}, async run() { throw Object.assign(new Error("private token detail"), { code }); } }, { op: "batch", requests: [{ op: "kakao_page", chat_id: "room" }] }); }
    catch (error) { caught = error; }
    expect(accountErrorMessage(caught)).toContain(command!);
    expect(accountErrorMessage(caught)).not.toContain("private");
  }
});
