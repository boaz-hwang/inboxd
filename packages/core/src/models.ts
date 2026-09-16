export type Timestamp = number;

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

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function timestamp(value: unknown, field: string): Timestamp {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite timestamp`);
  }
  return value;
}

function object(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

export function chatKey(value: unknown): ChatKey {
  const input = object(value, "chat key");
  return {
    platform: nonEmptyString(input.platform, "platform"),
    account: nonEmptyString(input.account, "account"),
    chat_id: nonEmptyString(input.chat_id, "chat_id"),
  };
}

export function messageKey(value: unknown): MessageKey {
  const input = object(value, "message key");
  return {
    ...chatKey(input),
    msg_id: nonEmptyString(input.msg_id, "msg_id"),
  };
}

export function adapterRevision(value: unknown): AdapterRevision {
  const input = object(value, "adapter revision");
  if (input.source !== "adapter" && input.source !== "observation") {
    throw new TypeError("adapter revision source must be 'adapter' or 'observation'");
  }
  if (input.source === "observation" && input.value !== "unversioned") {
    throw new TypeError("observation revision value must be 'unversioned'");
  }
  if (
    (typeof input.value !== "string" || input.value.trim().length === 0)
    && (typeof input.value !== "number" || !Number.isFinite(input.value))
  ) {
    throw new TypeError("adapter revision value must be a non-empty string or finite number");
  }
  return { source: input.source, value: input.value } as AdapterRevision;
}

function attachment(value: unknown): AttachmentMeta {
  const input = object(value, "attachment");
  const size = input.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    throw new TypeError("attachment size must be a non-negative finite number");
  }
  return {
    filename: nonEmptyString(input.filename, "attachment filename"),
    mime: nonEmptyString(input.mime, "attachment mime"),
    size,
  };
}

function normalizedMessage(value: unknown, revision: AdapterRevision): UnifiedMessage {
  const input = object(value, "message");
  if (!Array.isArray(input.attachments)) throw new TypeError("message attachments must be an array");
  return {
    key: messageKey(input.key),
    author_id: nonEmptyString(input.author_id, "author_id"),
    ts: timestamp(input.ts, "message ts"),
    body: nonEmptyString(input.body, "message body"),
    attachments: input.attachments.map(attachment),
    adapter_revision: revision,
    ...(input.parent_id === undefined ? {} : { parent_id: messageKey(input.parent_id) }),
    ...(input.edited_at === undefined ? {} : { edited_at: timestamp(input.edited_at, "edited_at") }),
    ...(input.deleted_at === undefined ? {} : { deleted_at: timestamp(input.deleted_at, "deleted_at") }),
  };
}

function tombstone(value: unknown): MessageTombstone {
  const input = object(value, "tombstone");
  if (input.body !== null) throw new TypeError("tombstone body must be null");
  return {
    key: messageKey(input.key),
    body: null,
    deleted_at: timestamp(input.deleted_at, "deleted_at"),
  };
}

/** Validates platform-normalized events before they enter the store boundary. */
export function normalizeMessageEvent(value: unknown): NormalizedMessageEvent {
  const input = object(value, "message event");
  const revision = adapterRevision(input.revision);

  switch (input.kind) {
    case "create":
      return { kind: "create", message: normalizedMessage(input.message, revision), revision };
    case "edit":
      return {
        kind: "edit",
        key: messageKey(input.key),
        body: nonEmptyString(input.body, "edit body"),
        edited_at: timestamp(input.edited_at, "edited_at"),
        revision,
      };
    case "delete":
      return { kind: "delete", tombstone: tombstone(input.tombstone), revision };
    default:
      throw new TypeError("message event kind must be create, edit, or delete");
  }
}
