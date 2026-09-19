import { batchHistoryReads } from "./batch-reads.ts";
import {
  personalSession,
  type PersonalCredentials,
} from "./personal-session.ts";
import { mapBounded } from "../../../packages/accounts/src/contracts.ts";
import type {
  AccountAdapter,
  AccountMessage,
} from "../../../packages/accounts/src/contracts.ts";
type AccountClient = Pick<
  Awaited<ReturnType<typeof personalSession>>,
  | "getChats"
  | "getMessagePage"
  | "getMembersByIds"
  | "getMembers"
  | "sendMessage"
  | "close"
> & Partial<Pick<Awaited<ReturnType<typeof personalSession>>, "getChatTitle" | "getChat">>;

export async function createKakaoAccount(
  credentials: PersonalCredentials,
  session?: AccountClient,
): Promise<AccountAdapter> {
  const client = session ?? (await personalSession(credentials));
  const unbatch = !session ? batchHistoryReads(await (client as Awaited<ReturnType<typeof personalSession>>).acquireSession()) : () => {};
  type SearchPlan = { at: number; query: string; chat?: string; queue: { id: string; from?: string }[] };
  const searches = new Map<string, SearchPlan>();
  const names = new Map<string, string>();
  let ownName: string | undefined;
  let directory: Awaited<ReturnType<AccountClient["getChats"]>> = [];
  let directoryTime = 0;
  let titleTime = 0;
  let pageBytes = 0;
  const pages = new Map<string, { bytes: number; at: number; value: Awaited<ReturnType<AccountClient["getMessagePage"]>> }>();
  const histories = new Map<string, { messages: Map<string, AccountMessage>; cursor?: string; complete: boolean; at: number }>();
  async function rooms(titles = false, force = false) {
    if (!force && directory.length && Date.now() - directoryTime < 30_000 && (!titles || Date.now() - titleTime < 300_000)) return directory;
    const resolve = titles && Date.now() - titleTime > 300_000;
    const useDetails = resolve && !!client.getChat;
    const fresh = await client.getChats({ all: true, resolveTitles: resolve && !useDetails });
    if (useDetails) await mapBounded(fresh, 8, async c => {
      // One CHATINFO resolves title AND seeds the SDK's member-name mapping.
      const detail = await client.getChat!(c.chat_id);
      if (detail.chat_id !== c.chat_id) throw new Error("Kakao chat mismatch");
      c.title = detail.title;
      if (c.type === "MemoChat") {
        if (detail.type !== "MemoChat") throw new Error("Kakao self chat mismatch");
        c.display_name = detail.display_name;
        if (detail.display_name) ownName = detail.display_name;
      }
    });
    const previous = new Map(directory.map(c => [c.chat_id, c]));
    for (const c of fresh) {
      const old = previous.get(c.chat_id);
      if (old && JSON.stringify(old.last_message) !== JSON.stringify(c.last_message)) {
        for (const [key, cached] of pages) if (JSON.parse(key)[0] === c.chat_id) { pageBytes -= cached.bytes; pages.delete(key); }
        const history = histories.get(c.chat_id);
        if (history) history.at = 0;
      }
    }
    if (!resolve) for (const c of fresh) {
      const old = previous.get(c.chat_id);
      c.title = old?.title ?? c.title;
      if (titles && !old && client.getChat) {
        const detail = await client.getChat(c.chat_id); c.title = detail.title;
        if (c.type === "MemoChat") c.display_name = detail.display_name;
      }
    }
    directory = fresh; directoryTime = Date.now(); if (resolve) titleTime = Date.now();
    return directory;
  }
  async function selfName(memoChat?: string): Promise<string> {
    if (ownName) return ownName;
    const memo =
      memoChat ??
      (await rooms()).find(
        (chat) => chat.type === "MemoChat",
      )?.chat_id;
    if (memo)
      ownName = (await client.getMembers(memo)).find(
        (member) => member.user_id === credentials.userId,
      )?.nickname;
    return ownName || "이름 없음";
  }

  async function page(chat: string, from?: string, query?: string) {
    const key = JSON.stringify([chat, from ?? "0"]);
    const cached = pages.get(key);
    const raw = cached && Date.now() - cached.at < 30_000 ? cached.value : await client.getMessagePage(chat, { count: 100, ...(from ? { from } : {}) });
    const bytes = Buffer.byteLength(JSON.stringify(raw));
    pageBytes += bytes - (cached?.bytes ?? 0);
    pages.set(key, { bytes, at: cached && raw === cached.value ? cached.at : Date.now(), value: raw });
    while (pageBytes > 16_000_000 || pages.size > 256) {
      const oldest = pages.keys().next().value!; pageBytes -= pages.get(oldest)!.bytes; pages.delete(oldest);
    }
    const result = { ...raw, messages: query === undefined ? raw.messages : raw.messages.filter(m => m.message.normalize("NFC").toLocaleLowerCase().includes(query.normalize("NFC").toLocaleLowerCase())) };
    // SDK names come from the same response/session's provider member records.
    // Do not re-request MEMBER for information that was already returned.
    for (const message of result.messages) if (message.author_name?.trim())
      names.set(`${chat}:${message.author_id}`, message.author_name);
    const missing = [
      ...new Set(result.messages.map((m) => String(m.author_id))),
    ].filter((id) => !names.has(`${chat}:${id}`));
    if (missing.length) {
      const members = await client.getMembersByIds(chat, missing);
      for (const member of members)
        names.set(`${chat}:${member.user_id}`, member.nickname);
      if (
        missing.includes(credentials.userId) &&
        !names.get(`${chat}:${credentials.userId}`)
      )
        names.set(`${chat}:${credentials.userId}`, await selfName());
    }
    const messages: AccountMessage[] = result.messages.map((m) => ({
      id: m.log_id,
      chat_id: chat,
      author_id: String(m.author_id),
      author_name:
        names.get(`${chat}:${m.author_id}`) ?? m.author_name ?? "이름 없음",
      ts: m.sent_at,
      body: m.message,
    }));
    return { ...result, messages };
  }
  return {
    close: () => { unbatch(); searches.clear(); client.close(); },
    async run(req) {
      if (req.op === "chats") {
        const chats = await rooms(true, req.refresh);
        const memo = chats.find((c) => c.type === "MemoChat");
        if (memo) await selfName(memo.chat_id);
        return {
          chats: chats.map((c) => ({
            chat_id: c.chat_id,
            title:
              c.title ||
              c.display_name ||
              (c.type === "MemoChat" ? ownName : undefined) ||
              "이름 없음",
            latest_ts: c.last_message?.sent_at ?? 0,
            preview: c.last_message?.message ?? "",
            can_send: true,
            unread: c.unread_count,
          })),
          complete: true,
        };
      }
      if (req.op === "send") {
        const r = await client.sendMessage(req.chat_id!, req.body!);
        if (!r.success) throw new Error("KakaoTalk 전송 거부");
        pages.clear(); pageBytes = 0; directoryTime = 0;
        const history = histories.get(req.chat_id!); if (history) history.at = 0;
        return { state: "Sent", receipt: r.log_id, messages: [{ id: r.log_id, chat_id: req.chat_id!, author_id: credentials.userId, author_name: await selfName(), ts: Date.now()/1000, body: req.body! }] };
      }
      if (req.op === "search") {
        let plan: SearchPlan;
        if (req.cursor) {
          const previous = searches.get(req.cursor);
          if (!previous || Date.now() - previous.at > 120_000 || previous.query !== req.query || previous.chat !== req.chat_id) throw new Error("Kakao search cursor expired");
          plan = { ...previous, queue: previous.queue.slice() };
        } else plan = { at: Date.now(), query: req.query!, chat: req.chat_id,
          queue: (req.chat_id ? [{ chat_id: req.chat_id }] : await rooms()).map(c => ({ id: c.chat_id })) };
        const found: AccountMessage[] = [];
        let scanned = 0;
        while (scanned < 8 && found.length < 30 && plan.queue.length) {
          const batch = plan.queue.splice(0, Math.min(8 - scanned, plan.queue.length));
          scanned += batch.length;
          const results = await Promise.all(batch.map(room => page(room.id, room.from, req.query)));
          results.forEach((result, i) => {
            found.push(...result.messages);
            if (!result.complete && result.next_cursor && result.next_cursor !== batch[i]!.from)
              plan.queue.push({ id: batch[i]!.id, from: result.next_cursor });
          });
        }
        let next: string | undefined;
        if (plan.queue.length) {
          while (searches.size >= 32) searches.delete(searches.keys().next().value!);
          next = crypto.randomUUID(); searches.set(next, { ...plan, at: Date.now() });
        }
        return { messages: found, next_cursor: next, complete: !next, note: next ? "카카오 기록 검색 중 · n으로 계속 검색" : undefined };
      }
      if (req.refresh) {
        histories.delete(req.chat_id!);
        for (const [key, cached] of pages) if (JSON.parse(key)[0] === req.chat_id) { pageBytes -= cached.bytes; pages.delete(key); }
      }
      if (req.cursor) {
        const p = await page(req.chat_id!, req.cursor);
        return {
          messages: p.messages,
          next_cursor: p.complete ? undefined : (p.next_cursor ?? undefined),
          complete: p.complete,
        };
      }
      const previous = histories.get(req.chat_id!);
      if (req.message_id && previous?.messages.has(req.message_id)) {
        const all = [...previous.messages.values()]; const index = all.findIndex(m => m.id === req.message_id);
        return { messages: all.slice(Math.max(0, index - 29), index + 1), complete: false };
      }
      if (!req.message_id && previous?.complete && Date.now() - previous.at < 30_000) return { messages: [...previous.messages.values()].slice(-30), complete: true };
      const stored = previous?.messages ?? new Map<string, AccountMessage>();
      let messages: AccountMessage[] = [...stored.values()].slice(-30);
      let cursor: string | undefined = req.message_id ? undefined : previous?.cursor;
      let complete = false;
      for (let n = 0; n < 100; n++) {
        const p = await page(req.chat_id!, cursor);
        for (const m of p.messages) stored.set(m.id, m);
        messages.push(...p.messages);
        if (req.message_id && messages.some((m) => m.id === req.message_id))
          return {
            messages: messages.slice(Math.max(0, messages.findIndex(m => m.id === req.message_id) - 29), messages.findIndex(m => m.id === req.message_id) + 31),
            next_cursor: p.complete ? undefined : (p.next_cursor ?? undefined),
            complete: p.complete,
          };
        messages = messages.slice(-30);
        if (p.complete || !p.next_cursor || p.next_cursor === cursor) {
          cursor = p.messages.at(-1)?.id ?? cursor;
          complete = p.complete;
          break;
        }
        cursor = p.next_cursor;
      }
      while (stored.size > 10000) stored.delete(stored.keys().next().value!);
      if (histories.size >= 100) histories.delete(histories.keys().next().value!);
      histories.set(req.chat_id!, { messages: stored, cursor, complete, at: Date.now() });
      let historyBytes = [...histories.values()].reduce((n, h) => n + Buffer.byteLength(JSON.stringify([...h.messages.values()])), 0);
      while (historyBytes > 16_000_000) {
        const key = histories.keys().next().value!;
        historyBytes -= Buffer.byteLength(JSON.stringify([...histories.get(key)!.messages.values()])); histories.delete(key);
      }
      return {
        messages,
        complete,
        note: complete ? undefined : "일부 기록만 조회했습니다",
        next_cursor: complete ? undefined : cursor,
      };
    },
  };
}
