import { expect, test } from "bun:test";
import { createPersonalWorker, type PersonalClient } from "../src/personal-worker.ts";
import type { WorkerRequestV1 } from "../../../packages/protocol/src/schema.ts";
const binding = { bindingId: "kakao-self", account: "self", chatId: "100", selfId: "1" };
const destination = { v: 1, kind: "chat", platform: "kakao", account: "self", chat_id: "100" } as const;
const envelope = { v: 2, destination, content: { mode: "text", body: "test" } } as const;
const request = (operation: WorkerRequestV1["operation"]): WorkerRequestV1 => ({ v: 1, type: "worker_request", request_id: "req", generation: 1, binding_id: "kakao-self", limits: { timeout_ms: 1000, max_response_bytes: 100000, max_queue_depth: 1 }, operation });
const client = (overrides: Partial<PersonalClient> = {}): PersonalClient => ({
  getChats: async () => [{ chat_id: "100", unread_count: 0 }],
  getMessagePage: async () => ({ messages: [{ log_id: "2", author_id: 1, message: "test", sent_at: 10 }], next_cursor: null, complete: true }),
  sendMessage: async () => ({ success: true, status_code: 0, chat_id: "100", log_id: "2" }), close() {}, ...overrides,
});
test("scope mismatch refuses before any provider I/O", async () => {
  let reads = 0;
  const worker = createPersonalWorker(binding, client({ getChats: async () => { reads++; return []; } }));
  expect(await worker.handle(request({ op: "send", envelope: { ...envelope, destination: { ...destination, chat_id: "999" } }, idempotency_key: "a".repeat(64) }))).toMatchObject({ ok: false, error: { code: "scope_denied", may_have_sent: false } });
  expect(reads).toBe(0);
});
test("ambiguous send calls transport once and preserves uncertainty", async () => {
  let sends = 0;
  const worker = createPersonalWorker(binding, client({ sendMessage: async () => { sends++; throw new Error("connection lost"); } }));
  expect(await worker.handle(request({ op: "send", envelope, idempotency_key: "a".repeat(64) }))).toMatchObject({ ok: false, error: { may_have_sent: true, retryable: false } });
  expect(sends).toBe(1);
});
test("bounded history has explicit limits and independent receipt requires exact body and author", async () => {
  const worker = createPersonalWorker(binding, client(), () => 20);
  expect(await worker.handle(request({ op: "read_page", chat: destination, interval: { from_ts: 0, to_ts: 20 }, cursor: null, limit: 10 }))).toMatchObject({ ok: true, result: { authoritative: false, items: [{ messages: [{ message: { body: "test" } }], limits: [{ reason: "unsupported" }] }] } });
  expect(await worker.handle(request({ op: "read_receipt", destination, receipt_id: "2", expected: envelope }))).toMatchObject({ ok: true, result: { outcome: "verified" } });
  expect(await worker.handle(request({ op: "read_receipt", destination, receipt_id: "2", expected: { ...envelope, content: { mode: "text", body: "different" } } }))).toMatchObject({ ok: true, result: { outcome: "not_found" } });
});
test("pinned SDK never replays send after session loss", async () => {
  const { KakaoTalkClient } = await import("agent-messenger/kakaotalk");
  const sdk = new KakaoTalkClient() as any;
  let sends = 0, connects = 0;
  sdk.ensureSession = async () => { connects++; return { session: { sendMessage: async () => { sends++; sdk.state = null; throw new Error("closed"); } } }; };
  await expect(sdk.sendMessage("100", "test")).rejects.toThrow();
  expect(sends).toBe(1); expect(connects).toBe(1);
});
test("pinned SDK never reconnects and replays a file upload after session loss", async () => {
  const { KakaoTalkClient } = await import("agent-messenger/kakaotalk");
  const sdk = new KakaoTalkClient() as any;
  sdk.ensureAuth = () => {};
  let uploads = 0, connects = 0;
  sdk.ensureSession = async () => { connects++; return { session: { shipMedia: async () => { uploads++; sdk.state = null; throw new Error("closed"); } } }; };
  await expect(sdk.sendFile("100", Buffer.from("file"), "test.txt")).rejects.toThrow();
  expect(uploads).toBe(1); expect(connects).toBe(1);
});
