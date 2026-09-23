import { SlackAuthStore, slackAuthErrors, type SlackCredentials } from "./auth-store.ts";
import { createSlackWebApiTransport } from "./transport.ts";
import type { SlackApiTransport } from "./worker.ts";

/** Preserve the base transport's single-send invariant; recovery wraps reads. */
export function createRecoveringSlackTransport(input: SlackCredentials, store = new SlackAuthStore(), makeTransport = (c: SlackCredentials) => createSlackWebApiTransport({ token: c.bot_token, cookie: c.session_cookie })): SlackApiTransport {
  let credentials = store.current(input);
  let transport = makeTransport(credentials);
  let recovery: Promise<void> | undefined;
  return {
    async call(call) {
      const read = call.method !== "chat.postMessage";
      if (read && recovery) await recovery;
      const failed = credentials;
      const result = await transport.call(call);
      const body = result.body as { ok?: boolean; error?: string } | null;
      const code = body?.ok === false ? body.error : undefined;
      if (!read || !code || !slackAuthErrors.has(code)) return result;
      if (credentials === failed && !recovery) recovery = (async () => {
        credentials = await store.recover(failed); transport = makeTransport(credentials);
      })().finally(() => { recovery = undefined; });
      await recovery;
      if (call.signal.aborted) throw new Error("Slack request aborted");
      const retried = await transport.call(call);
      const retryBody = retried.body as { ok?: boolean; error?: string } | null;
      const retryCode = retryBody?.ok === false ? retryBody.error : undefined;
      if (retryCode && slackAuthErrors.has(retryCode)) await store.reject(credentials);
      return retried;
    },
  };
}
