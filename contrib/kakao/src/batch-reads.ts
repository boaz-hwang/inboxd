import type { KakaoTalkClient } from "agent-messenger/kakaotalk";

type Session = Awaited<ReturnType<KakaoTalkClient["acquireSession"]>>;
type Response = Awaited<ReturnType<Session["getChatLogs"]>>;
type Id = Parameters<Session["getChatLogs"]>[0][number];

/** Coalesce independent SDK history reads into the protocol's native multi-chat request.
 * SDK getMessagePage still validates and formats each room's response independently.
 */
export function batchHistoryReads(session: Pick<Session, "getChatLogs">): () => void {
  const original = session.getChatLogs.bind(session);
  type Read = { id: Id; since: Id; resolve(value: Response): void; reject(error: unknown): void };
  let queue: Read[] = [];
  let stopped = false;
  async function flush() {
    const batch = queue.splice(0, 8);
    if (!batch.length) return;
    try {
      const response = await original(batch.map(r => r.id), batch.map(r => r.since));
      const logs = response.body.chatLogs;
      if (response.statusCode !== 0 || (response.body.status !== undefined && response.body.status !== 0) || !Array.isArray(logs)) throw new Error("Kakao batch history unavailable");
      const ids = new Set(batch.map(r => String(r.id)));
      if (logs.some(log => !ids.has(String((log as Record<string, unknown>).chatId)))) throw new Error("Kakao batch history scope mismatch");
      for (const read of batch) read.resolve({ ...response, body: { ...response.body, chatLogs: logs.filter(log => String((log as Record<string, unknown>).chatId) === String(read.id)) } });
    } catch (error) { for (const read of batch) read.reject(error); }
  }
  session.getChatLogs = (ids, sinces) => {
    if (stopped || ids.length !== 1 || sinces.length !== 1 || queue.some(r => String(r.id) === String(ids[0]))) return original(ids, sinces);
    return new Promise((resolve, reject) => {
      queue.push({ id: ids[0]!, since: sinces[0]!, resolve, reject });
      if (queue.length === 1) queueMicrotask(() => { void flush(); });
      if (queue.length === 8) void flush();
    });
  };
  return () => { stopped = true; session.getChatLogs = original; for (const read of queue.splice(0)) read.reject(new Error("Kakao session closed")); };
}
