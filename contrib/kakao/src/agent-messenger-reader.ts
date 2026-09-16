import type { KakaoReadReader, KakaoReaderRequest } from "./index.ts";

export interface AgentMessengerKakaoBinding {
  readonly account: string;
  readonly chat_id: string;
  readonly transport_account_id: string;
  readonly transport_chat_id: string;
}

export interface AgentMessengerKakaoMessage {
  readonly log_id: string;
  readonly author_id: number;
  readonly message: string;
  readonly sent_at: number;
}

export interface AgentMessengerKakaoClient {
  getMessagePage(
    chatId: string,
    options: { readonly count: number },
  ): Promise<{
    readonly messages: readonly AgentMessengerKakaoMessage[];
    readonly next_cursor: string | null;
    readonly complete: boolean;
  }>;
  close(): void;
}

export interface AgentMessengerKakaoReaderOptions {
  readonly bindings: readonly AgentMessengerKakaoBinding[];
  readonly page_size: number;
  readonly createClient: (transportAccountId: string) => Promise<AgentMessengerKakaoClient>;
}

function findBinding(
  request: KakaoReaderRequest,
  bindings: readonly AgentMessengerKakaoBinding[],
): AgentMessengerKakaoBinding {
  const binding = bindings.find((entry) => entry.account === request.account && entry.chat_id === request.chat_id);
  if (binding === undefined) throw new Error("Kakao reader denied: exact transport binding required");
  return binding;
}

export function createAgentMessengerKakaoReader(options: AgentMessengerKakaoReaderOptions): KakaoReadReader {
  if (!Number.isInteger(options.page_size) || options.page_size < 1 || options.page_size > 100) {
    throw new TypeError("Kakao reader page_size must be an integer between 1 and 100");
  }

  const bindings = options.bindings.map((binding) => ({ ...binding }));
  if (bindings.some((binding) => binding.transport_account_id.length === 0 || binding.transport_chat_id.length === 0)) {
    throw new TypeError("Kakao reader transport account/chat identifiers must be non-empty strings");
  }
  const stableKeys = bindings.map((binding) => `${binding.account}\0${binding.chat_id}`);
  if (new Set(stableKeys).size !== stableKeys.length) {
    throw new TypeError("Kakao reader bindings must be unique");
  }
  return async (request) => {
    const binding = findBinding(request, bindings);
    let client: AgentMessengerKakaoClient | undefined;
    try {
      client = await options.createClient(binding.transport_account_id);
      const page = await client.getMessagePage(binding.transport_chat_id, { count: options.page_size });
      return page.messages.map((message) => ({
        account_id: binding.account,
        chat_id: binding.chat_id,
        message_id: message.log_id,
        author_id: String(message.author_id),
        ts: message.sent_at,
        body: message.message,
        revision: message.log_id,
      }));
    } catch {
      throw new Error("Kakao transport read failed");
    } finally {
      if (client !== undefined) {
        try { client.close(); } catch { /* cleanup failure is not public protocol data */ }
      }
    }
  };
}
