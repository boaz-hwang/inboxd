import { readSelectedAttachment } from "../../../packages/host/src/attachments.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { packagedTdlibRuntime } from "./worker-entrypoint.ts";
import { createProductionTdlibPort } from "./production-tdlib.ts";
import type { AccountAdapter } from "../../../packages/accounts/src/contracts.ts";
import type { TdlibUserClientPort } from "./tdlib-port.ts";
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
  return createTelegramAdapter(port);
}

/** Provider operations only; traversal, caching and result paging belong to Rust. */
export function createTelegramAdapter(port: TdlibUserClientPort): AccountAdapter {
  const query = async (q: Record<string, unknown>) => {
    if (!port.accountQuery) throw new Error("Telegram 세션 확인 필요");
    return port.accountQuery(q);
  };
  const message = (m: any) => ({
    id: String(m.id), chat_id: String(m.chat_id),
    author_id: String(m.sender_id?.user_id ?? m.sender_id?.chat_id ?? ""),
    author_kind: m.sender_id?.user_id != null ? "user" : "chat",
    author_name: "",
    ts: m.date,
    body: m.content?.text?.text ?? (m.content?.caption?.text || (m.content?.document?.file_name ? `[파일] ${m.content.document.file_name}` : undefined)) ??
      `[${String(m.content?.["@type"] ?? "미디어").replace(/^message/, "")}]`,
  });
  const run: AccountAdapter["run"] = async (req) => {
    const list = { _: "params" in req && "list" in req.params && req.params.list === "archive" ? "chatListArchive" : "chatListMain" };
    switch (req.op) {
      case "telegram_load_directory":
        try {
          await query({ _: "loadChats", chat_list: list, limit: req.limit });
          return { complete: false };
        } catch (error) {
          if ((error as { code?: number }).code === 404) return { complete: true };
          throw error;
        }
      case "telegram_list_directory": {
        const result = await query({ _: "getChats", chat_list: list, limit: req.limit });
        if (!Array.isArray(result.chat_ids)) throw new Error("Malformed Telegram directory");
        return { ids: result.chat_ids.map(String) };
      }
      case "telegram_chat": {
        const c = await query({ _: "getChat", chat_id: Number(req.chat_id) });
        return { chats: [{ chat_id: String(c.id), title: c.title,
          latest_ts: c.last_message?.date ?? 0,
          preview: c.last_message?.content?.text?.text ?? c.last_message?.content?.caption?.text ?? "",
          can_send: c.permissions?.can_send_basic_messages ?? c.permissions?.can_send_messages ?? true,
          unread: c.unread_count }] };
      }
      case "telegram_sender": {
        const sender = await query(req.params?.kind === "user"
          ? { _: "getUser", user_id: Number(req.params?.id) }
          : { _: "getChat", chat_id: Number(req.params?.id) });
        return { name: sender.title ?? [sender.first_name, sender.last_name].filter(Boolean).join(" ") };
      }
      case "telegram_history": {
        const items = await port.getChatHistory({ chat_id: req.chat_id!,
          from_message_id: req.message_id ?? "0", offset: 0,
          limit: req.limit!, only_local: false });
        return { messages: items.map(message) };
      }
      case "telegram_search": {
        const result = req.chat_id
          ? await query({ _: "searchChatMessages", chat_id: Number(req.chat_id),
              query: req.query, sender_id: null, from_message_id: Number(req.cursor ?? 0),
              offset: 0, limit: req.limit, filter: null, message_thread_id: 0, saved_messages_topic_id: 0 })
          : await query({ _: "searchMessages", chat_list: null, query: req.query,
              offset: req.cursor ?? "", limit: req.limit, filter: null,
              chat_type_filter: null, min_date: 0, max_date: 0 });
        if (!Array.isArray(result.messages)) throw new Error("Malformed Telegram search results");
        return { messages: result.messages.map(message), next_offset: result.next_offset };
      }
      case "telegram_send_file": {
        if (!port.sendDocumentMessage) return { state: "Failed", reason: "파일 전송을 지원하지 않는 세션입니다" };
        let bytes: Buffer;
        try { bytes = await readSelectedAttachment(req.file); }
        catch { return { state: "Failed", reason: "파일을 읽을 수 없거나 선택 이후 변경되었습니다" }; }
        const directory = await mkdtemp(join(tmpdir(), "inboxd-upload-"));
        try {
          const path = join(directory, req.file.name);
          await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
          const result = await port.sendDocumentMessage({ chat_id: req.chat_id, path, timeout_ms: 80_000 });
          return { state: "Sent", receipt: String(result.id) };
        } finally { void rm(directory, { recursive: true, force: true }).catch(() => {}); }
      }
      case "telegram_send": {
        const result = await port.sendTextMessage({ chat_id: req.chat_id!, text: req.body!,
          reply_to_message_id: null, timeout_ms: 20000 });
        return { state: "Sent", receipt: String(result.id), messages: [message(result)] };
      }
      default: throw new Error(`Unsupported Telegram provider operation: ${req.op}`);
    }
  };
  return {
    run, close: () => port.close?.(),
    async listen(emit) {
      if (!port.onAccountUpdate) { emit({ event: "state", state: "unsupported" }); return () => {}; }
      emit({ event: "state", state: "disconnected" });
      const unsubscribe = port.onAccountUpdate(update => {
        const type = update["@type"];
        if (type === "updateConnectionState") {
          const state = update.state as Record<string, unknown> | undefined;
          emit({ event: "state", state: state?.["@type"] === "connectionStateReady" ? "connected" : "disconnected" });
        } else if (type === "updateAuthorizationState") {
          const auth = update.authorization_state as Record<string, unknown> | undefined;
          if (auth?.["@type"] !== "authorizationStateReady") emit({ event: "state", state: "disconnected" });
        } else if (["updateNewMessage", "updateMessageContent", "updateDeleteMessages", "updateChatLastMessage", "updateChatTitle", "updateChatReadInbox", "updateChatPosition"].includes(String(type))) {
          if (type === "updateDeleteMessages" && update.is_permanent === true && update.from_cache === false
            && Array.isArray(update.message_ids) && update.chat_id !== undefined) {
            for (const id of update.message_ids) emit({ event: "deleted", chat_id: String(update.chat_id), message_id: String(id) });
          } else {
            const m = update.message as Record<string, unknown> | undefined;
            const chat = update.chat_id ?? m?.chat_id;
            const id = update.message_id ?? m?.id;
            emit({ event: "changed", ...(chat !== undefined ? { chat_id: String(chat), ...(id !== undefined ? { message_id: String(id) } : {}) } : {}) });
          }
        }
      });
      return unsubscribe;
    },
  };
}
