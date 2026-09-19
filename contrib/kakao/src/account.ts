import { readSelectedAttachment } from "../../../packages/host/src/attachments.ts";
import { batchHistoryReads } from "./batch-reads.ts";
import { personalSession, type PersonalCredentials } from "./personal-session.ts";
import type { AccountAdapter } from "../../../packages/accounts/src/contracts.ts";
type AccountClient = Pick<Awaited<ReturnType<typeof personalSession>>,
  "getChats" | "getMessagePage" | "getMembersByIds" | "getMembers" | "sendMessage" | "close"
> & Partial<Pick<Awaited<ReturnType<typeof personalSession>>, "getChatTitle" | "getChat" | "sendFile" | "onPush" | "onSessionEvent" | "isConnected">>;

/** Session-owned SDK operations. Traversal, caching and display policy live in Rust. */
export async function createKakaoAccount(credentials: PersonalCredentials, session?: AccountClient): Promise<AccountAdapter> {
  const client = session ?? await personalSession(credentials);
  const unbatch = !session ? batchHistoryReads(await (client as Awaited<ReturnType<typeof personalSession>>).acquireSession()) : () => {};
  return {
    close() { unbatch(); client.close(); },
    async listen(emit) {
      if (!client.onPush || !client.onSessionEvent) { emit({ event: "state", state: "unsupported" }); return () => {}; }
      const offPush = client.onPush(packet => {
        if (!["PING", "PONG", "NOTIREAD"].includes(packet.method)) emit({ event: "changed" });
      });
      const offState = client.onSessionEvent(event => emit({ event: "state", state: event.type === "connected" ? "connected" : "disconnected" }));
      emit({ event: "state", state: client.isConnected?.() ? "connected" : "disconnected" });
      return () => { offPush(); offState(); };
    },
    async run(req) {
      switch (req.op) {
        case "kakao_metadata": return { own_id: credentials.userId, has_details: !!client.getChat };
        case "kakao_rooms": return { data: await client.getChats({ all: true, resolveTitles: req.params?.resolve_titles === true }) };
        case "kakao_detail": {
          const detail = await client.getChat!(req.chat_id!);
          if (detail.chat_id !== req.chat_id) throw new Error("Kakao chat mismatch");
          return { data: detail };
        }
        case "kakao_page": {
          const page = await client.getMessagePage(req.chat_id!, { count: req.limit ?? 100, ...(req.cursor ? { from: req.cursor } : {}) });
          return { messages: page.messages.map(m => ({ id: m.log_id, chat_id: req.chat_id!, author_id: String(m.author_id), author_name: m.author_name ?? "", ts: m.sent_at, body: m.message })), complete: page.complete, ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}) };
        }
        case "kakao_members": return { data: await client.getMembersByIds(req.chat_id!, req.ids!) };
        case "kakao_self_members": return { data: await client.getMembers(req.chat_id!) };
        case "kakao_send_file": {
          if (!client.sendFile) return { state: "Failed", reason: "파일 전송을 지원하지 않는 세션입니다" };
          let bytes: Buffer;
          try { bytes = await readSelectedAttachment(req.file); }
          catch { return { state: "Failed", reason: "파일을 읽을 수 없거나 선택 이후 변경되었습니다" }; }
          const sent = await client.sendFile(req.chat_id, bytes, req.file.name);
          if (!sent.success) throw new Error("KakaoTalk 파일 전송 확인 실패");
          return { state: "Sent", receipt: sent.log_id };
        }
        case "kakao_send": {
          const sent = await client.sendMessage(req.chat_id!, req.body!);
          if (!sent.success) throw new Error("KakaoTalk 전송 거부");
          return { state: "Sent", receipt: sent.log_id };
        }
        default: throw new Error(`Unsupported Kakao primitive: ${req.op}`);
      }
    },
  };
}
