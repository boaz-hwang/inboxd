import { boundedAccountPages } from "./pagination.ts";
import { readBounded } from "./io.ts";
import { createSlackAccount } from "../../../platforms/slack/src/account.ts";
import { createTelegramAccount } from "../../../platforms/telegram/src/account.ts";
import { createKakaoAccount } from "../../../contrib/kakao/src/account.ts";
import type { AccountAdapter, AccountRequest } from "./contracts.ts";

if (!process.env.INBOXD_ACCOUNT_CONFIG) {
  process.stderr.write("Account worker: configuration required\n");
  process.exit(2);
}
let adapter: AccountAdapter | undefined;
const raw = process.env.INBOXD_ACCOUNT_CONFIG!;
const streaming = process.env.INBOXD_ACCOUNT_STREAM === "1";
delete process.env.INBOXD_ACCOUNT_CONFIG;
delete process.env.INBOXD_ACCOUNT_STREAM;
const config = JSON.parse(raw);
async function execute(text: string): Promise<string> {
  try {
    const req = JSON.parse(text) as AccountRequest;
    if (!["chats", "messages", "search", "send"].includes(req.op)) throw new Error("unsupported request");
    if (!adapter) {
    const created = config.kind === "slack" ? createSlackAccount(config)
      : config.kind === "telegram" ? await createTelegramAccount(config)
      : config.kind === "kakao_personal" ? await createKakaoAccount(JSON.parse(config.credentials)) : undefined;
    if (!created) throw new Error("unsupported account");
    adapter = boundedAccountPages(created);
    }
    const result = await adapter.run(req);
    const output = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(output) > 12_000_000) throw new Error("response limit");
    return output;
  } catch {
    await adapter?.close(); adapter = undefined;
    return JSON.stringify({ ok: false, error: "메신저 요청 실패. 연결 상태나 요청 제한을 확인하세요." });
  }
}
try {
  if (!streaming) process.stdout.write(await execute(await readBounded(Bun.stdin.stream(), 65536)));
  else {
    let pending = Buffer.alloc(0);
    for await (const chunk of Bun.stdin.stream()) {
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf(10)) >= 0) {
        if (end > 65536) throw new Error("request limit");
        const request = pending.subarray(0, end).toString(); pending = pending.subarray(end + 1);
        process.stdout.write((await execute(request)) + "\n");
      }
      if (pending.length > 65536) throw new Error("request limit");
    }
  }
} finally { await adapter?.close(); }
