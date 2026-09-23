import {
  ReconnectingProtocolClient,
  type ClientRole,
  type MessageSendParams,
  type JsonObject,
  type RecentMessagesParams,
  type ProtocolMethod,
  type ProtocolTransport,
} from "../../protocol/src/index.ts";

export type CliRole = ClientRole;
export type TransportConnector = () => Promise<ProtocolTransport>;

export interface ChatKey {
  readonly platform: string;
  readonly account: string;
  readonly chat_id: string;
}

export interface SearchInput {
  readonly chat: ChatKey;
  readonly interval: { readonly from_ts: number; readonly to_ts: number };
  readonly query: string;
}

export class ApproverTTYRequiredError extends Error {
  constructor() {
    super("approval commands require process.stdin.isTTY");
    this.name = "ApproverTTYRequiredError";
  }
}

/** Failure at the protocol boundary, classified without leaking daemon internals. */
export class CliProtocolError extends Error {
  readonly code: string;
  readonly method: ProtocolMethod;

  constructor(method: ProtocolMethod, error: unknown) {
    const source = error instanceof Error ? error : new Error("daemon protocol failed");
    super(source.message, { cause: source });
    this.name = "CliProtocolError";
    this.method = method;
    this.code = typeof (error as { code?: unknown } | undefined)?.code === "string"
      ? (error as { code: string }).code
      : source.message.includes("connection") || source.message.includes("transport")
        ? "CONNECTION_CLOSED"
        : "DAEMON_ERROR";
  }
}

export interface CliHandlerOptions {
  readonly connect: TransportConnector;
  readonly role?: CliRole;
  readonly isTTY?: () => boolean;
  readonly approverToken?: string;
  readonly senderToken?: string;
  /** Process lifecycle is injected so protocol handlers never own a daemon implementation. */
  readonly launchDaemon?: () => Promise<void>;
}

export interface CliHandlers {
  readonly role: CliRole;
  readonly requeryRequired: boolean;
  connect(): Promise<void>;
  stop(): void;
  daemonStart(): Promise<JsonObject>;
  daemonStatus(): Promise<JsonObject>;
  chatList(): Promise<JsonObject>;
  inbox(chat: ChatKey): Promise<JsonObject>;
  recent(input: RecentMessagesParams): Promise<JsonObject>;
  evidence(input: RecentMessagesParams): Promise<JsonObject>;
  get(message: ChatKey & { readonly msg_id: string }): Promise<JsonObject>;
  search(input: SearchInput): Promise<JsonObject>;
  syncStatus(): Promise<JsonObject>;
  backfill(input: ChatKey & { readonly from_ts: number; readonly to_ts: number }): Promise<JsonObject>;
  authStatus(): Promise<JsonObject>;
  send(input: MessageSendParams): Promise<JsonObject>;
  sendStatus(id: string): Promise<JsonObject>;
  doctor(): Promise<JsonObject>;
  trajectory(action: "list" | "delete" | "settings", input: JsonObject): Promise<JsonObject>;
  listPending(): Promise<JsonObject>;
  reject(input: { readonly intent_id: string; readonly reason: string }): Promise<JsonObject>;
}

function defaultStdinTTY(): boolean {
  return Boolean((globalThis as { process?: { stdin?: { isTTY?: boolean } } }).process?.stdin?.isTTY);
}

export function createCliHandlers(options: CliHandlerOptions): CliHandlers {
  const role = options.role ?? "reader";
  const isTTY = options.isTTY ?? defaultStdinTTY;
  const client = new ReconnectingProtocolClient({ connect: options.connect, role, isTTY, approverToken: options.approverToken, senderToken: options.senderToken });
  const connect = (): Promise<void> => client.ready ? Promise.resolve() : client.start([]);

  const call = async (method: ProtocolMethod, params: JsonObject): Promise<JsonObject> => {
    try {
      await connect();
      return await client.request(method, params);
    } catch (error) {
      throw new CliProtocolError(method, error);
    }
  };

  const requireApproverTTY = (): void => {
    if (role !== "sender" && (role !== "approver" || !isTTY())) throw new ApproverTTYRequiredError();
  };

  const approverCall = (method: "safety.intent.listPending" | "safety.intent.reject", params: JsonObject): Promise<JsonObject> => {
    try {
      requireApproverTTY();
    } catch (error) {
      return Promise.reject(error);
    }
    return call(method, params);
  };

  return {
    role,
    get requeryRequired(): boolean { return client.requeryRequired; },
    connect,
    stop: () => client.stop(),
    daemonStart: async () => {
      if (options.launchDaemon !== undefined) await options.launchDaemon();
      return call("system.status", {});
    },
    daemonStatus: () => call("system.status", {}),
    chatList: () => call("chat.list", {}),
    inbox: (chat) => call("message.inbox", { chat }),
    recent: (input) => call("message.recent", { ...input }),
    evidence: (input) => call("message.evidence", { ...input }),
    get: ({ msg_id, ...chat }) => call("message.get", { chat, msg_id }),
    search: (input) => call("message.search", { chat: input.chat, interval: input.interval, query: input.query }),
    syncStatus: () => call("sync.status", {}),
    backfill: (input) => call("sync.backfill", { ...input }),
    authStatus: () => call("auth.status", {}),
    send: (input) => call("message.send", { ...input }),
    sendStatus: (id) => call("send.status", { id }),
    doctor: () => call("system.status", {}),
    trajectory: (action, input) => call(`trajectory.${action}`, input),
    listPending: () => approverCall("safety.intent.listPending", {}),
    reject: (input) => approverCall("safety.intent.reject", input),
  };
}
