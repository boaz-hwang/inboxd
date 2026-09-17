export type Timestamp = number;

import { coreCall } from "../../native/src/index.ts";

export interface AccountKey {
  readonly platform: string;
  readonly account: string;
}

/** Identity is never inferred from message authors or display names. */
export type AccountIdentity = AccountKey & (
  | { readonly status: "known"; readonly source: "authenticated_adapter"; readonly self_id: string; readonly observed_at: Timestamp }
  | { readonly status: "unknown"; readonly source: "unknown"; readonly reason: "unsupported" | "unavailable" | "unobserved"; readonly observed_at: Timestamp | null }
);

/** A local estimate is not a platform-reported count; unknown is never zero. */
export type UnreadState = { readonly chat: ChatKey } & (
  | { readonly status: "known"; readonly source: "platform"; readonly count: number; readonly observed_at: Timestamp }
  | { readonly status: "known"; readonly source: "local_estimate"; readonly count: number; readonly observed_at: Timestamp;
      readonly basis: { readonly read_cursor: string; readonly interval: { readonly from_ts: Timestamp; readonly to_ts: Timestamp } } }
  | { readonly status: "unknown"; readonly source: "unknown"; readonly count: null; readonly reason: "unsupported" | "unavailable" | "unobserved"; readonly observed_at: Timestamp | null }
);

/** Validates adapter evidence; unobserved defaults are produced by retrieval, not ingestion. */
export function accountIdentity(value: unknown): AccountIdentity {
  return coreCall("domain.accountIdentity", value);
}
export function unreadState(value: unknown): UnreadState {
  return coreCall("domain.unreadState", value);
}

export interface ChatKey {
  readonly platform: string;
  readonly account: string;
  readonly chat_id: string;
}

/** A message id has no meaning without its platform, account, and chat scope. */
export interface MessageKey extends ChatKey {
  readonly msg_id: string;
}

export interface AttachmentMeta {
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
}

export interface AdapterRevision {
  /** Observation means the platform exposes no trustworthy mutation ordering token. */
  readonly source: "adapter" | "observation";
  /** Opaque platform token, or the fixed marker for an unversioned observation. */
  readonly value: string | number;
}

export interface UnifiedMessage {
  readonly key: MessageKey;
  readonly author_id: string;
  readonly ts: Timestamp;
  readonly body: string;
  readonly parent_id?: MessageKey;
  readonly edited_at?: Timestamp;
  readonly deleted_at?: Timestamp;
  readonly attachments: readonly AttachmentMeta[];
  readonly adapter_revision: AdapterRevision;
}

/** A deletion retains identity and deletion time but deliberately contains no body. */
export interface MessageTombstone {
  readonly key: MessageKey;
  readonly body: null;
  readonly deleted_at: Timestamp;
}

export interface CreateMessageEvent {
  readonly kind: "create";
  readonly message: Omit<UnifiedMessage, "adapter_revision">;
  readonly revision: AdapterRevision;
}

export interface EditMessageEvent {
  readonly kind: "edit";
  readonly key: MessageKey;
  readonly body: string;
  readonly edited_at: Timestamp;
  readonly revision: AdapterRevision;
}

export interface DeleteMessageEvent {
  readonly kind: "delete";
  readonly tombstone: MessageTombstone;
  readonly revision: AdapterRevision;
}

export type NormalizedMessageEvent =
  | (CreateMessageEvent & { readonly message: UnifiedMessage })
  | EditMessageEvent
  | DeleteMessageEvent;

export function chatKey(value: unknown): ChatKey {
  return coreCall("domain.chatKey", value);
}

export function messageKey(value: unknown): MessageKey {
  return coreCall("domain.messageKey", value);
}

export function adapterRevision(value: unknown): AdapterRevision {
  return coreCall("domain.adapterRevision", value);
}

/** Validates platform-normalized events before they enter the store boundary. */
export function normalizeMessageEvent(value: unknown): NormalizedMessageEvent {
  return coreCall("domain.normalizeMessageEvent", value);
}
