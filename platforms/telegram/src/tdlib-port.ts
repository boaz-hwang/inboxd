export type { TdlibAuthorizationState } from "./auth.ts";
import type { TdlibAuthorizationState } from "./auth.ts";

export type TdlibInt53 = string | number;

export interface TdlibUser {
  readonly "@type": "user";
  readonly id: TdlibInt53;
}

export interface TdlibChat {
  readonly "@type": "chat";
  readonly id: TdlibInt53;
  readonly unread_count: number;
}

export interface TdlibMessage extends Record<string, unknown> {
  readonly "@type": "message";
  readonly id: TdlibInt53;
  readonly chat_id: TdlibInt53;
  readonly sender_id: unknown;
  readonly date: number;
  readonly content: unknown;
}

export interface TdlibHistoryRequest {
  readonly chat_id: string;
  readonly from_message_id: string;
  readonly offset: 0;
  readonly limit: number;
  readonly only_local: false;
}

export interface TdlibSendTextRequest {
  readonly chat_id: string;
  readonly text: string;
  readonly reply_to_message_id: string | null;
  readonly timeout_ms: number;
}

export type TdlibRuntimeAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * Typed user-session seam. Implementations must use TDLib user-client semantics;
 * a Telegram Bot API transport is not compatible with this port.
 */
export interface TdlibUserClientPort {
  readonly availability: TdlibRuntimeAvailability;
  getAuthorizationState(): Promise<TdlibAuthorizationState>;
  getMe(): Promise<TdlibUser>;
  getChat(chatId: string): Promise<TdlibChat>;
  getChatHistory(request: TdlibHistoryRequest): Promise<readonly TdlibMessage[]>;
  sendTextMessage(request: TdlibSendTextRequest): Promise<TdlibMessage>;
  getMessage(chatId: string, messageId: string): Promise<TdlibMessage>;
  /** Internal account-directory adapter seam; never exposed as a client RPC. */
  accountQuery?(query: Record<string, unknown>): Promise<Record<string, any>>;
  close?(): Promise<void>;
}

export class TdlibCallError extends Error {
  readonly name = "TdlibCallError";

  constructor(
    readonly code: number,
    message: string,
    readonly mayHaveSent = false,
  ) {
    super(message);
  }
}
