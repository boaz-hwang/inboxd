export interface AccountChat {
  chat_id: string;
  title: string;
  latest_ts: number;
  preview: string;
  can_send: boolean;
  unread?: number;
}
export interface AccountMessage {
  id: string;
  chat_id: string;
  author_id: string;
  author_name: string;
  ts: number;
  body: string;
}
export interface AccountRequest {
  op: "chats" | "messages" | "search" | "send";
  chat_id?: string;
  cursor?: string;
  query?: string;
  body?: string;
  message_id?: string;
  request_id?: string;
  refresh?: boolean;
}
export interface AccountResult {
  chats?: AccountChat[];
  messages?: AccountMessage[];
  next_cursor?: string;
  complete?: boolean;
  note?: string;
  state?: string;
  receipt?: string;
}
export interface AccountAdapter {
  run(request: AccountRequest): Promise<AccountResult>;
  close(): Promise<void> | void;
}
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}
