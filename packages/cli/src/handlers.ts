import {
  ReconnectingProtocolClient,
  type ClientRole,
  type JsonObject,
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
  get(message: ChatKey & { readonly msg_id: string }): Promise<JsonObject>;
  search(input: SearchInput): Promise<JsonObject>;
  syncStatus(): Promise<JsonObject>;
  backfill(input: ChatKey & { readonly from_ts: number; readonly to_ts: number }): Promise<JsonObject>;
  authStatus(): Promise<JsonObject>;
  sendStatus(id: string): Promise<JsonObject>;
  doctor(): Promise<JsonObject>;
  propose(intent: JsonObject): Promise<JsonObject>;
  listPending(): Promise<JsonObject>;
  approve(input: {
    readonly intent_id: string;
    readonly code: string;
    readonly actor: string;
    readonly scope: ChatKey;
  }): Promise<JsonObject>;
  reject(input: { readonly intent_id: string; readonly reason: string }): Promise<JsonObject>;
}

export interface AgentHandlers {
  connect(): Promise<void>;
  stop(): void;
  propose(intent: JsonObject): Promise<JsonObject>;
}

function defaultStdinTTY(): boolean {
  return Boolean((globalThis as { process?: { stdin?: { isTTY?: boolean } } }).process?.stdin?.isTTY);
}

function approvalCodePresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(approvalCodePresent);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as JsonObject).some(([key, nested]) =>
    key === "code" || key === "approval_code" || key === "approvalCode" || approvalCodePresent(nested),
  );
}

/** JSON output that preserves every protocol result field, including empty coverage evidence. */
export function formatCliResult(result: JsonObject, role: CliRole = "reader"): string {
  if (role !== "approver" && approvalCodePresent(result)) {
    throw new Error("approval code cannot be printed by this role");
  }
  return JSON.stringify(result);
}

export function createCliHandlers(options: CliHandlerOptions): CliHandlers {
  const role = options.role ?? "reader";
  const isTTY = options.isTTY ?? defaultStdinTTY;
  const client = new ReconnectingProtocolClient({ connect: options.connect, role, isTTY });
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
    if (role !== "approver" || !isTTY()) throw new ApproverTTYRequiredError();
  };

  const approverCall = (method: "safety.intent.listPending" | "safety.intent.approve" | "safety.intent.reject", params: JsonObject): Promise<JsonObject> => {
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
    get: (message) => call("message.get", { ...message }),
    search: (input) => call("message.search", { chat: input.chat, interval: input.interval, query: input.query }),
    syncStatus: () => call("sync.status", {}),
    backfill: (input) => call("sync.backfill", { ...input }),
    authStatus: () => call("auth.status", {}),
    sendStatus: (id) => call("send.status", { id }),
    doctor: () => call("system.status", {}),
    propose: (intent) => call("safety.intent.create", intent),
    listPending: () => approverCall("safety.intent.listPending", {}),
    approve: (input) => approverCall("safety.intent.approve", input),
    reject: (input) => approverCall("safety.intent.reject", input),
  };
}

/** Agent clients intentionally expose propose only, never approval enumeration or codes. */
export function createAgentHandlers(options: Omit<CliHandlerOptions, "role">): AgentHandlers {
  const handlers = createCliHandlers({ ...options, role: "agent" });
  return { connect: handlers.connect, stop: handlers.stop, propose: handlers.propose };
}
