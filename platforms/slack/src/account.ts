import { SlackClient, SlackListener } from "agent-messenger/slack";
import { readSelectedAttachment } from "../../../packages/host/src/attachments.ts";
import { readBounded } from "../../../packages/accounts/src/io.ts";
import type { AccountAdapter } from "../../../packages/accounts/src/contracts.ts";

// One provider operation per request. All traversal and cache policy lives in Rust.
const methods = new Set([
  "users.list", "users.info", "client.counts", "conversations.list",
  "conversations.members", "conversations.history", "chat.postMessage", "search.messages",
]);
export function createSlackAccount(config: {
  bot_token: string;
  session_cookie?: string;
}, fetcher: typeof fetch = fetch, makeListener: (client: SlackClient) => Pick<SlackListener, "on" | "start" | "stop"> = client => new SlackListener(client)): AccountAdapter {
  let stopListening: (() => void) | undefined;
  async function call(
    method: string,
    body: Record<string, unknown> = {},
  ): Promise<any> {
    const response = await fetcher(`https://slack.com/api/${method}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${config.bot_token}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(config.session_cookie
          ? { cookie: `d=${config.session_cookie}` }
          : {}),
      },
      body: new URLSearchParams(
        Object.entries(body).map(([k, v]) => [
          k,
          typeof v === "object" ? JSON.stringify(v) : String(v),
        ]),
      ),
    });
    if (response.status === 429)
      throw new Error("Slack 요청 제한 — 잠시 후 다시 시도하세요");
    if (!response.body) throw new Error("Slack 응답 없음");
    const text = await readBounded(response.body, 4_000_000);
    const result = JSON.parse(text);
    if (!response.ok || !result.ok) throw new Error("Slack 조회 실패");
    return result;
  }
  return {
    close() { stopListening?.(); },
    async listen(emit) {
      if (!config.session_cookie) { emit({ event: "state", state: "unsupported" }); return () => {}; }
      const client = await new SlackClient().login({ token: config.bot_token, cookie: config.session_cookie });
      const listener = makeListener(client);
      listener.on("connected", () => emit({ event: "state", state: "connected" }));
      listener.on("disconnected", () => emit({ event: "state", state: "disconnected" }));
      listener.on("error", () => emit({ event: "state", state: "disconnected" }));
      listener.on("slack_event", event => {
        const value = event as unknown as Record<string, unknown>;
        if (value.type === "message" && value.subtype === "message_deleted"
          && typeof value.channel === "string" && typeof value.deleted_ts === "string") {
          emit({ event: "deleted", chat_id: value.channel, message_id: value.deleted_ts });
        } else if (!["user_typing", "presence_change", "pong"].includes(event.type)) {
          const message = value.message as Record<string, unknown> | undefined;
          const id = message?.ts ?? value.ts;
          emit({ event: "changed", ...(typeof value.channel === "string" ? { chat_id: value.channel, ...(typeof id === "string" ? { message_id: id } : {}) } : {}) });
        }
      });
      stopListening = () => listener.stop();
      // RTM setup cannot block reads/sends; the SDK owns socket heartbeats/reconnect.
      void listener.start().catch(() => emit({ event: "state", state: "disconnected" }));
      return stopListening;
    },
    async run(req) {
      if (req.op === "slack_send_file") {
        let bytes: Buffer;
        try { bytes = await readSelectedAttachment(req.file); }
        catch { return { state: "Failed", reason: "파일을 읽을 수 없거나 선택 이후 변경되었습니다" }; }
        const upload = await call("files.getUploadURLExternal", { filename: req.file.name, length: bytes.length });
        const url = new URL(upload.upload_url);
        if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.username || url.password || url.port) throw new Error("Slack upload URL rejected");
        if (typeof upload.file_id !== "string" || !upload.file_id) throw new Error("Slack file ID missing");
        const response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(50_000), headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) });
        await response.body?.cancel();
        if (!response.ok) throw new Error("Slack 파일 업로드 실패");
        const complete = await call("files.completeUploadExternal", { files: [{ id: upload.file_id, title: req.file.name }], channel_id: req.chat_id });
        if (!Array.isArray(complete.files) || !complete.files.some((file: { id?: string }) => file.id === upload.file_id)) throw new Error("Slack 파일 전송 확인 실패");
        return { state: "Sent", receipt: upload.file_id };
      }
      const method = req.op.startsWith("slack.") ? req.op.slice(6) : "";
      if (!methods.has(method)) throw new Error("지원하지 않는 Slack 작업");
      return { data: await call(method, "params" in req ? req.params : {}) };
    },
  };
}
