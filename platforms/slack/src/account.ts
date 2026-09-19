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
}, fetcher: typeof fetch = fetch): AccountAdapter {
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
    close() {},
    async run(req) {
      const method = req.op.startsWith("slack.") ? req.op.slice(6) : "";
      if (!methods.has(method)) throw new Error("지원하지 않는 Slack 작업");
      return { data: await call(method, req.params ?? {}) };
    },
  };
}
