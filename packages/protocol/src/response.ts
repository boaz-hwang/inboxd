/** Owner-only local response flow. IDs are opaque and never provider receipts. */
export interface ResponseChatKey {
  readonly platform: string;
  readonly account: string;
  readonly chat_id: string;
}

export interface ConversationUnread {
  readonly count: number | null;
  readonly source: "provider" | "observed" | "combined" | "unknown";
  readonly status: "known" | "at_least" | "unknown";
  readonly observed_at: number;
  readonly local_unseen_count: number | null;
}

/** Local optimistic state and provider synchronization are separate results. */
export interface ReadSynchronization {
  readonly operation_id?: string;
  readonly status: "pending" | "synced" | "failed" | "unsupported";
}

export interface ResponseSeenResult {
  readonly unread: ConversationUnread;
  readonly read_sync?: ReadSynchronization;
}

/** Payload for the existing account.changed event; contains no message text. */
export interface ReadSynchronizationEvent extends ResponseChatKey {
  readonly phase: "read_sync";
  readonly read_sync: ReadSynchronization;
  readonly unread: ConversationUnread;
}

export type ReplySuggestionStatus = "queued" | "generating" | "ready" | "abstained" | "failed" | "stale";
export interface ReplySuggestion {
  readonly id: string;
  readonly status: ReplySuggestionStatus;
  readonly text?: string | null;
  readonly model_version?: string | null;
  readonly prompt_version?: string;
  readonly error?: string | null;
}

export interface ResponseSession {
  readonly response_session_id: string;
  readonly chat: ResponseChatKey;
  readonly incoming_version: string;
  readonly source_message_ids: readonly string[];
  readonly status: ReplySuggestionStatus | "sent" | "closed" | "uncertain";
  readonly error?: string | null;
  readonly suggestion: ReplySuggestion | null;
}

export interface ResponseNext {
  readonly chat: ResponseChatKey | null;
  readonly status: "next" | "done" | "unknown";
  readonly remaining_unknown?: number;
}
