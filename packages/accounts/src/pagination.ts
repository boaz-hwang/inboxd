import type { AccountAdapter, AccountRequest, AccountResult } from "./contracts.ts";

/** Keep provider batches in the account process; serve bounded RPC pages without refetching. */
export function boundedAccountPages(adapter: AccountAdapter): AccountAdapter {
  const pages = new Map<string, { at: number; scope: string; result: AccountResult }>();
  const scope = (request: AccountRequest) => JSON.stringify([request.op, request.chat_id, request.query]);
  function fit(result: AccountResult, request: AccountRequest): AccountResult {
    if (!result.messages?.length || request.op === "send") return result;
    let count = 0, bytes = 0;
    for (const message of result.messages) {
      const size = Buffer.byteLength(JSON.stringify(message)) + 1;
      if (count >= 80 || bytes + size > 45_000) break;
      bytes += size; count++;
    }
    if (!count) throw new Error("message exceeds page limit");
    if (count === result.messages.length) return result;
    for (const [key, page] of pages) if (Date.now() - page.at > 120_000) pages.delete(key);
    while (pages.size >= 32) pages.delete(pages.keys().next().value!);
    const cursor = `local:${crypto.randomUUID()}`;
    pages.set(cursor, { at: Date.now(), scope: scope(request), result: { ...result, messages: result.messages.slice(count) } });
    let cachedBytes = [...pages.values()].reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p.result)), 0);
    while (cachedBytes > 16_000_000) {
      const key = pages.keys().next().value!;
      cachedBytes -= Buffer.byteLength(JSON.stringify(pages.get(key)!.result)); pages.delete(key);
    }
    if (!pages.has(cursor)) throw new Error("provider batch exceeds cache limit");
    return { ...result, messages: result.messages.slice(0, count), complete: false, next_cursor: cursor };
  }
  return {
    close: () => { pages.clear(); return adapter.close(); },
    async run(request) {
      if (request.cursor?.startsWith("local:")) {
        const page = pages.get(request.cursor);
        if (!page || Date.now() - page.at > 120_000 || page.scope !== scope(request)) throw new Error("expired or mismatched page");
        return fit(page.result, request);
      }
      return fit(await adapter.run(request), request);
    },
  };
}
