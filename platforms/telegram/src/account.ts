import { packagedTdlibRuntime } from "./worker-entrypoint.ts";
import { createProductionTdlibPort } from "./production-tdlib.ts";
import {
  mapBounded,
  type AccountAdapter,
  type AccountMessage,
} from "../../../packages/accounts/src/contracts.ts";
export async function createTelegramAccount(config: {
  api_id: number;
  api_hash: string;
  database_directory: string;
  files_directory: string;
  tdjson_path: string;
}): Promise<AccountAdapter> {
  const port = await createProductionTdlibPort({
    apiId: config.api_id,
    apiHash: config.api_hash,
    databaseDirectory: config.database_directory,
    filesDirectory: config.files_directory,
    tdjsonPath: packagedTdlibRuntime()?.tdjsonPath ?? config.tdjson_path,
  });
  const query = async (q: Record<string, unknown>) => {
    if (!port.accountQuery) throw new Error("Telegram 세션 확인 필요");
    return port.accountQuery(q);
  };
  const deadline = Date.now() + 15000;
  while (true) {
    const state = await port.getAuthorizationState();
    if (state["@type"] === "authorizationStateReady") break;
    if (
      Date.now() > deadline ||
      ![
        "authorizationStateWaitTdlibParameters",
        "authorizationStateWaitEncryptionKey",
      ].includes(state["@type"])
    ) {
      await port.close?.();
      throw new Error("Telegram 세션 확인 필요");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const names = new Map<string, string>();
  async function message(m: any): Promise<AccountMessage> {
    const id = String(m.sender_id?.user_id ?? m.sender_id?.chat_id ?? "");
    let name = names.get(id);
    if (!name) {
      const sender = m.sender_id?.user_id
        ? await query({ _: "getUser", user_id: Number(id) })
        : await query({ _: "getChat", chat_id: Number(id) });
      name =
        sender.title ??
        [sender.first_name, sender.last_name].filter(Boolean).join(" ");
      names.set(id, name || "이름 없음");
    }
    return {
      id: String(m.id),
      chat_id: String(m.chat_id),
      author_id: id,
      author_name: name || "이름 없음",
      ts: m.date,
      body:
        m.content?.text?.text ??
        m.content?.caption?.text ??
        `[${String(m.content?.["@type"] ?? "미디어").replace(/^message/, "")}]`,
    };
  }
  return {
    close: () => port.close?.(),
    async run(req) {
      if (req.op === "chats") {
        const ids = new Set<number>();
        for (const type of ["chatListMain", "chatListArchive"]) {
          for (let i = 0; i < 100; i++) {
            try {
              await query({
                _: "loadChats",
                chat_list: { _: type },
                limit: 200,
              });
            } catch (error) {
              if ((error as { code?: number }).code === 404) break;
              throw error;
            }
            if (i === 99) throw new Error("Telegram 목록 로드 제한");
          }
          const page = await query({
            _: "getChats",
            chat_list: { _: type },
            limit: 20000,
          });
          for (const id of page.chat_ids ?? []) ids.add(id);
        }
        const chats = await mapBounded([...ids], 8, async (id) => {
          const c = await query({ _: "getChat", chat_id: id });
          return {
            chat_id: String(c.id),
            title: c.title,
            latest_ts: c.last_message?.date ?? 0,
            preview:
              c.last_message?.content?.text?.text ??
              c.last_message?.content?.caption?.text ??
              "",
            can_send:
              c.permissions?.can_send_basic_messages ??
              c.permissions?.can_send_messages ??
              true,
            unread: c.unread_count,
          };
        });
        return { chats, complete: true };
      }
      if (req.op === "send") {
        const result = await port.sendTextMessage({
          chat_id: req.chat_id!,
          text: req.body!,
          reply_to_message_id: null,
          timeout_ms: 20000,
        });
        return { state: "Sent", receipt: String(result.id), messages: [await message(result)] };
      }
      if (req.op === "search") {
        const result = req.chat_id
          ? await query({
              _: "searchChatMessages",
              chat_id: Number(req.chat_id),
              query: req.query,
              sender_id: null,
              from_message_id: Number(req.cursor ?? 0),
              offset: 0,
              limit: 100,
              filter: null,
              message_thread_id: 0,
              saved_messages_topic_id: 0,
            })
          : await query({
              _: "searchMessages",
              chat_list: null,
              query: req.query,
              offset: req.cursor ?? "",
              limit: 100,
              filter: null,
              chat_type_filter: null,
              min_date: 0,
              max_date: 0,
            });
        const items = result.messages ?? [];
        return {
          messages: await mapBounded(items, 4, message),
          next_cursor: req.chat_id
            ? items.length
              ? String(items.at(-1).id)
              : undefined
            : result.next_offset || undefined,
          complete: items.length === 0,
        };
      }
      const items = await port.getChatHistory({
        chat_id: req.chat_id!,
        from_message_id: req.message_id ?? req.cursor ?? "0",
        offset: 0,
        limit: 30,
        only_local: false,
      });
      return {
        messages: (await mapBounded(items, 4, message)).reverse(),
        next_cursor: items.length ? String(items.at(-1)!.id) : undefined,
        complete: items.length === 0,
      };
    },
  };
}
