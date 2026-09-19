import { expect, test } from "bun:test";
import { dispatch, dispatchWire } from "../src/dispatch.ts";
import type { AccountAdapter } from "../src/contracts.ts";

test("Rust-selected reads execute together and retain request order", async () => {
  let active = 0, peak = 0;
  const adapter: AccountAdapter = { close() {}, async run(req) {
    if (req.op !== "kakao_page") throw new Error("unexpected request");
    peak = Math.max(peak, ++active);
    await new Promise(r => setTimeout(r, req.chat_id === "a" ? 8 : 1));
    active--;
    return { messages: [{id:req.chat_id,chat_id:req.chat_id,author_id:"7",author_name:"name",ts:1,body:"text"}], complete: true };
  } };
  const result = await dispatch(adapter, { op: "batch", requests: ["a", "b"].map(chat_id => ({op:"kakao_page", chat_id})) });
  expect(peak).toBe(2);
  expect(result.results.map(r => "messages" in r ? r.messages[0]?.chat_id : null)).toEqual(["a", "b"]);
});

test("invalid or write batches are rejected before any provider call", async () => {
  let calls = 0;
  const adapter: AccountAdapter = { close() {}, async run() { calls++; return {}; } };
  for (const op of ["kakao_send", "telegram_send", "slack.chat.postMessage", "batch", "untrusted"]) {
    await expect(dispatchWire(adapter, {op:"batch",requests:[{op:"kakao_page"},{op}]})).rejects.toThrow();
  }
  await expect(dispatch(adapter,{op:"batch",requests:[]})).rejects.toThrow();
  await expect(dispatchWire(adapter,{op:"batch",requests:Array.from({length:9},()=>({op:"kakao_page"}))})).rejects.toThrow();
  expect(calls).toBe(0);
});

test("batch failure waits for started reads and never retries", async () => {
  const finished: string[] = [];
  const adapter: AccountAdapter = { close() {}, async run(req) {
    if (req.op !== "kakao_page") throw new Error("unexpected request");
    if (req.chat_id === "bad") throw new Error("private provider detail");
    await new Promise(r => setTimeout(r, 5)); finished.push(req.chat_id); return {messages:[],complete:true};
  } };
  await expect(dispatch(adapter,{op:"batch",requests:["bad","good"].map(chat_id=>({op:"kakao_page",chat_id}))})).rejects.toThrow("provider batch failed");
  expect(finished).toEqual(["good"]);
});

test("a send passes through once even when its result is uncertain", async () => {
  let calls = 0;
  const adapter: AccountAdapter = { close() {}, async run() { calls++; throw new Error("connection lost"); } };
  await expect(dispatch(adapter,{op:"kakao_send",chat_id:"r",body:"fixture"})).rejects.toThrow();
  expect(calls).toBe(1);
});
