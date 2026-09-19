import { parseWorkerRequest, parseWorkerResponse, type WorkerRequestV1, type WorkerResponseV1 } from "../../../packages/protocol/src/index.ts";

export interface PersonalMessage { log_id: string; author_id: number; message: string; sent_at: number; type?: number }
export interface PersonalClient {
  getChats(): Promise<readonly { chat_id: string; unread_count: number }[]>;
  getMessagePage(chat: string, options: { count: number; from?: string }): Promise<{ messages: readonly PersonalMessage[]; next_cursor: string | null; complete: boolean }>;
  sendMessage(chat: string, text: string): Promise<{ success: boolean; status_code: number; chat_id: string; log_id: string }>;
  close(): void;
}
export interface PersonalBinding { bindingId: string; account: string; chatId: string; selfId: string }
export function createPersonalWorker(binding: PersonalBinding, client: PersonalClient, now = () => Date.now() / 1000) {
  const chat = { v: 1, kind: "chat", platform: "kakao", account: binding.account, chat_id: binding.chatId } as const;
  const key = { platform: "kakao", account: binding.account, chat_id: binding.chatId };
  const matches = (c: { platform: string; account: string; chat_id?: string }) => c.platform === "kakao" && c.account === binding.account && c.chat_id === binding.chatId;
  function ok(request: WorkerRequestV1, result: unknown): WorkerResponseV1 {
    return parseWorkerResponse({ v: 1, type: "worker_response", request_id: request.request_id, generation: request.generation, operation: request.operation.op, ok: true, result }, request);
  }
  function fail(request: WorkerRequestV1, code: string, mayHaveSent = false): WorkerResponseV1 {
    return parseWorkerResponse({ v: 1, type: "worker_response", request_id: request.request_id, generation: request.generation, operation: request.operation.op, ok: false, error: { code, message: "KakaoTalk operation unavailable", retryable: false, may_have_sent: mayHaveSent } }, request);
  }
  return {
    async handle(value: unknown): Promise<WorkerResponseV1> {
      const request = parseWorkerRequest(value);
      if (request.binding_id !== binding.bindingId) return fail(request, "binding_mismatch");
      const op = request.operation;
      if (op.op !== "health") {
        const destination = op.op === "read_page" ? op.chat : op.op === "send" ? op.envelope.destination : op.destination;
        if (!matches(destination)) return fail(request, "scope_denied");
      }
      let rooms;
      try { rooms = await client.getChats(); } catch { return fail(request, "authentication_unavailable"); }
      const room = rooms.find(r => r.chat_id === binding.chatId);
      if (!room) return fail(request, "scope_unavailable");
      const observedAt = now();
      if (op.op === "health") return ok(request, { state: "ready", auth: { state: "authenticated", reason: null, observed_at: observedAt } });
      if (op.op === "send") {
        if (op.envelope.content.mode !== "text" || op.envelope.reply) return fail(request, "unsupported_content");
        try {
          // Patched pinned SDK: this call NEVER reconnects and replays a send.
          const result = await client.sendMessage(binding.chatId, op.envelope.content.body);
          if (!result.success || result.chat_id !== binding.chatId || !/^[1-9]\d*$/.test(result.log_id)) return fail(request, "send_uncertain", true);
          return ok(request, { outcome: "sent", receipt_id: result.log_id });
        } catch { return fail(request, "send_uncertain", true); }
      }
      if (op.op === "read_receipt") {
        if (op.expected.content.mode !== "text" || op.expected.reply) return ok(request, { outcome: "unavailable", reason: "unsupported_content" });
        try {
          const page = await client.getMessagePage(binding.chatId, { count: 100 });
          const exact = page.messages.find(m => m.log_id === op.receipt_id && String(m.author_id) === binding.selfId && m.message === op.expected.content.body);
          return exact ? ok(request, { outcome: "verified", evidence: { destination: op.destination, receipt_id: op.receipt_id, content: op.expected.content } }) : ok(request, { outcome: "not_found" });
        } catch { return ok(request, { outcome: "unavailable", reason: "readback_unavailable" }); }
      }
      if (op.cursor !== null) return fail(request, "cursor_unsupported");
      try {
        const page = await client.getMessagePage(binding.chatId, { count: Math.min(100, op.limit) });
        const messages = page.messages.filter(m => Number.isSafeInteger(m.sent_at) && m.sent_at >= op.interval.from_ts && m.sent_at < op.interval.to_ts)
          .map(m => ({ kind: "create", revision: { source: "observation", value: "unversioned" }, message: { key: { ...key, msg_id: m.log_id }, author_id: String(m.author_id), ts: m.sent_at, body: m.message, attachments: [] } }));
        const normalized = { v: 1, mode: "bounded_history", chat, interval: op.interval, messages, tombstones: [],
          identity: { chat: key, status: "known", source: "authenticated_adapter", self_id: binding.selfId, observed_at: observedAt },
          unread: { chat: key, status: "unknown", source: "unknown", count: null, reason: "unavailable", observed_at: observedAt },
          coverage: [], limits: [{ chat: key, interval: op.interval, reason: "unsupported", observed_at: observedAt }], next_cursor: null, authoritative: false, observed_at: observedAt };
        return ok(request, { items: [normalized], next_cursor: null, authoritative: false });
      } catch { return fail(request, "read_unavailable"); }
    },
  };
}
