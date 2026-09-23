import { KakaoTalkClient } from "agent-messenger/kakaotalk";
import { KakaoAuthStore, isAuthExpired } from "./auth-store.ts";
import { batchHistoryReads } from "./batch-reads.ts";
import { parsePersonalCredentials, type PersonalCredentials } from "./credentials.ts";
export { parsePersonalCredentials, type PersonalCredentials } from "./credentials.ts";

const reads = new Set<PropertyKey>(["acquireSession", "getChats", "getChat", "getChatTitle", "getMessagePage", "getMessages", "getMemberSnapshot", "getMembers", "getMembersByIds", "getProfile"]);
type Store = Pick<KakaoAuthStore, "current" | "recover"> & Partial<Pick<KakaoAuthStore, "reject">>;
type Options = { store?: Store; create?: (credentials: PersonalCredentials) => Promise<KakaoTalkClient>; batchHistory?: boolean };

/** Rebind listeners on recovery and replay only explicitly listed reads, once.
 * Mutations always invoke the SDK exactly once, even on authentication errors. */
export async function personalSession(input: PersonalCredentials, options: Options = {}): Promise<KakaoTalkClient> {
  const store = options.store ?? new KakaoAuthStore();
  const create = options.create ?? (credentials => new KakaoTalkClient().login(credentials));
  let credentials = store.current(parsePersonalCredentials(input));
  let client = await create(credentials);
  let closed = false;
  let recovery: Promise<void> | undefined;
  let unbatch: (() => void) | undefined;
  let batchedSession: unknown;
  const listeners = new Set<{ method: "onPush" | "onSessionEvent"; handler: any; off: () => void }>();

  async function recover(failedClient: KakaoTalkClient, failedCredentials: PersonalCredentials): Promise<void> {
    if (closed) throw new Error("Kakao session closed");
    if (client !== failedClient) return;
    if (!recovery) {
      recovery = (async () => {
        const nextCredentials = await store.recover(failedCredentials);
        if (closed) throw new Error("Kakao session closed");
        const next = await create(nextCredentials);
        if (closed) { next.close(); throw new Error("Kakao session closed"); }
        unbatch?.(); unbatch = undefined; batchedSession = undefined;
        for (const listener of listeners) { listener.off(); listener.off = next[listener.method](listener.handler); }
        client = next; credentials = nextCredentials;
        failedClient.close();
      })().finally(() => { recovery = undefined; });
    }
    await recovery;
  }
  async function invokeRead(method: PropertyKey, args: unknown[]): Promise<unknown> {
    if (closed) throw new Error("Kakao session closed");
    if (recovery) await recovery;
    const original = client, originalCredentials = credentials;
    async function invoke(target: KakaoTalkClient): Promise<unknown> {
      if (options.batchHistory && (method === "getMessagePage" || method === "getMessages")) {
        const session = await target.acquireSession();
        if (batchedSession !== session) { unbatch?.(); unbatch = batchHistoryReads(session); batchedSession = session; }
      }
      return (target[method as keyof KakaoTalkClient] as Function).apply(target, args);
    }
    try { return await invoke(original); }
    catch (error) {
      if (!isAuthExpired(error)) throw error;
      await recover(original, originalCredentials);
      try { return await invoke(client); }
      catch (retryError) {
        if (isAuthExpired(retryError)) await store.reject?.(credentials);
        throw retryError;
      }
    }
  }
  return new Proxy(client, {
    get(_target, property) {
      if (property === "close") return () => {
        closed = true; unbatch?.();
        for (const listener of listeners) listener.off();
        listeners.clear(); client.close();
      };
      if (property === "onPush" || property === "onSessionEvent") return (handler: any) => {
        const listener = { method: property as "onPush" | "onSessionEvent", handler, off: client[property](handler) };
        listeners.add(listener);
        return () => { listener.off(); listeners.delete(listener); };
      };
      if (reads.has(property)) return (...args: unknown[]) => invokeRead(property, args);
      const value = client[property as keyof KakaoTalkClient];
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}
