import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { describeAttachment } from "../packages/host/src/attachments.ts";
import { dispatch } from "../packages/accounts/src/dispatch.ts";
import { createSlackAccount } from "../platforms/slack/src/account.ts";
import { createKakaoAccount } from "../contrib/kakao/src/account.ts";
import { createTelegramAdapter } from "../platforms/telegram/src/account.ts";
import type { TdlibUserClientPort } from "../platforms/telegram/src/tdlib-port.ts";

test("all three providers upload selected bytes exactly once; edited files make zero remote calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "upload-test-"));
  try {
    const path = join(dir, "한글.bin"), bytes = Buffer.from([0, 1, 255, 42]);
    await writeFile(path, bytes); const file = await describeAttachment(path);
    const slackCalls: string[] = [];
    const slack = createSlackAccount({ bot_token: "secret", session_cookie: "cookie" }, (async (url: URL | string, options: RequestInit) => {
      slackCalls.push(String(url)); const headers = new Headers(options.headers);
      if (String(url).startsWith("https://files.slack.com/")) {
        expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
        expect(Buffer.from(options.body as Uint8Array)).toEqual(bytes); return new Response("");
      }
      expect(headers.get("authorization")).toBe("Bearer secret");
      const params = new URLSearchParams(String(options.body));
      if (String(url).endsWith("getUploadURLExternal")) {
        expect(params.get("filename")).toBe(file.name); expect(params.get("length")).toBe("4");
        return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/test", file_id: "F1" });
      }
      expect(params.get("channel_id")).toBe("1");
      expect(JSON.parse(params.get("files")!)).toEqual([{ id: "F1", title: file.name }]);
      return Response.json({ ok: true, files: [{ id: "F1" }] });
    }) as typeof fetch);
    let kakaoCalls = 0, telegramCalls = 0;
    const kakao = await createKakaoAccount({ userId: "self" } as never, {
      async sendFile(chat: string, data: Buffer, name: string) { kakaoCalls++; expect(chat).toBe("1"); expect(data).toEqual(bytes); expect(name).toBe(file.name); return { success: true, log_id: "K1" }; }, close() {},
    } as never);
    const telegram = createTelegramAdapter({ async sendDocumentMessage(request) {
      telegramCalls++; expect(request.chat_id).toBe("1"); expect(basename(request.path)).toBe(file.name);
      expect(request.path).not.toBe(file.path); expect(await readFile(request.path)).toEqual(bytes);
      return { id: 123 };
    } } as TdlibUserClientPort);
    expect(await dispatch(slack, { op: "slack_send_file", chat_id: "1", file })).toEqual({ state: "Sent", receipt: "F1" });
    expect(await dispatch(kakao, { op: "kakao_send_file", chat_id: "1", file })).toEqual({ state: "Sent", receipt: "K1" });
    expect(await dispatch(telegram, { op: "telegram_send_file", chat_id: "1", file })).toEqual({ state: "Sent", receipt: "123" });
    await writeFile(path, Buffer.from([9, 1, 255, 42]));
    for (const [adapter, op] of [[slack, "slack_send_file"], [kakao, "kakao_send_file"], [telegram, "telegram_send_file"]] as const) expect((await dispatch(adapter, { op, chat_id: "1", file })).state).toBe("Failed");
    expect(slackCalls).toHaveLength(3); expect(kakaoCalls).toBe(1); expect(telegramCalls).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
