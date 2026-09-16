import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type ServeStdioOptions, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import {
  ReconnectingProtocolClient,
  type JsonObject,
  type ProtocolTransport,
} from "../../protocol/src/index.ts";

export const MCP_TOOL_NAMES = ["inbox_search", "inbox_list", "send_propose"] as const;

type DaemonMethod = "message.search" | "safety.intent.create";
type ToolName = (typeof MCP_TOOL_NAMES)[number];
type JsonRecord = Record<string, unknown>;

/** The only boundary this package uses to access inboxd state: daemon protocol RPC. */
export interface ProtocolRequester {
  request(method: DaemonMethod, params: JsonRecord): Promise<JsonRecord>;
}

/** Creates the only live daemon client used by this package; its handshake role is fixed to agent. */
export function createAgentProtocolRequester(connect: () => Promise<ProtocolTransport>): ProtocolRequester & { stop(): void } {
  const client = new ReconnectingProtocolClient({ connect, role: "agent" });
  return {
    async request(method, params) {
      await client.start([]);
      return client.request(method, params);
    },
    stop: () => client.stop(),
  };
}

export class McpInputError extends Error {
  constructor() {
    super("invalid MCP tool input");
    this.name = "McpInputError";
  }
}

/** A typed, method-labelled failure from the daemon protocol boundary. */
export class McpDaemonError extends Error {
  readonly code: string;
  readonly method: DaemonMethod;

  constructor(method: DaemonMethod, source: unknown) {
    super(`daemon request failed: ${method}`, { cause: source });
    this.name = "McpDaemonError";
    this.method = method;
    this.code = typeof (source as { code?: unknown } | undefined)?.code === "string"
      ? (source as { code: string }).code
      : "DAEMON_ERROR";
  }
}

/** The agent surface must fail closed rather than expose an approver secret. */
export class McpSecretResponseError extends Error {
  constructor() {
    super("daemon response contained a forbidden secret field");
    this.name = "McpSecretResponseError";
  }
}

const nonEmpty = z.string().refine((value) => value.trim().length > 0, "must be non-empty");
const chatSchema = z.object({
  platform: nonEmpty,
  account: nonEmpty,
  chat_id: nonEmpty,
}).strict();
const intervalSchema = z.object({
  from_ts: z.number().finite(),
  to_ts: z.number().finite(),
}).strict().refine((value) => value.from_ts <= value.to_ts, "interval must be ordered");
const inboxSearchSchema = z.object({
  chat: chatSchema,
  interval: intervalSchema,
  query: nonEmpty,
}).strict();
const inboxListSchema = z.object({
  chat: chatSchema,
  interval: intervalSchema,
}).strict();
const sendProposeSchema = z.object({
  actor: nonEmpty,
  scope: chatSchema,
  body: nonEmpty,
  parent_id: nonEmpty.optional(),
}).strict();

const forbiddenFieldNames = new Set([
  "code",
  "approval_code",
  "approvalcode",
  "secret",
  "password",
  "token",
  "access_token",
  "accesstoken",
]);

function containsForbiddenField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as JsonRecord).some(([key, nested]) =>
    forbiddenFieldNames.has(key.toLowerCase()) || containsForbiddenField(nested),
  );
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new McpInputError();
  return result.data;
}

async function daemonRequest(requester: ProtocolRequester, method: DaemonMethod, params: JsonRecord): Promise<JsonRecord> {
  try {
    const result = await requester.request(method, params);
    if (containsForbiddenField(result)) throw new McpSecretResponseError();
    return result;
  } catch (error) {
    if (error instanceof McpSecretResponseError) throw error;
    throw new McpDaemonError(method, error);
  }
}

function coverageResult(result: JsonRecord): JsonRecord {
  const coverage = result.coverage;
  if (!Array.isArray(result.messages) || coverage === null || typeof coverage !== "object" || Array.isArray(coverage)
    || !Array.isArray((coverage as JsonRecord).covered) || !Array.isArray((coverage as JsonRecord).gaps) || !Array.isArray((coverage as JsonRecord).limits)) {
    throw new McpDaemonError("message.search", new Error("daemon returned an invalid inbox result"));
  }
  return result;
}

function proposalReceipt(result: JsonRecord): JsonRecord {
  if (typeof result.intent_id !== "string" || result.intent_id.length === 0 || typeof result.expires_at !== "number" || !Number.isFinite(result.expires_at)) {
    throw new McpDaemonError("safety.intent.create", new Error("daemon returned an invalid proposal receipt"));
  }
  // Whitelist exactly the safe receipt fields. In particular, never reflect a proposed body.
  return { intent_id: result.intent_id, expires_at: result.expires_at };
}

export type ToolHandlers = Record<ToolName, (input: unknown) => Promise<JsonRecord>>;

/** Builds the three agent-safe tool callbacks without opening a daemon or platform connection. */
export function createToolHandlers(requester: ProtocolRequester): ToolHandlers {
  return {
    inbox_search: async (input) => {
      const parsed = parse(inboxSearchSchema, input);
      return coverageResult(await daemonRequest(requester, "message.search", parsed));
    },
    // Listing is a blank-query search so its result retains the daemon's complete coverage evidence.
    inbox_list: async (input) => {
      const parsed = parse(inboxListSchema, input);
      return coverageResult(await daemonRequest(requester, "message.search", { ...parsed, query: "" }));
    },
    send_propose: async (input) => {
      const parsed = parse(sendProposeSchema, input);
      return proposalReceipt(await daemonRequest(requester, "safety.intent.create", parsed));
    },
  };
}

function textResult(result: JsonObject) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

/** Creates an official MCP v2 server containing only the agent-safe inboxd tools. */
export function createMcpServer(requester: ProtocolRequester): McpServer {
  const tools = createToolHandlers(requester);
  const server = new McpServer({ name: "inboxd", version: "0.0.0" });
  server.registerTool("inbox_search", {
    title: "Search inbox",
    description: "Search one chat and return messages plus coverage, gaps, and limits.",
    inputSchema: inboxSearchSchema,
  }, async (input) => textResult(await tools.inbox_search(input)));
  server.registerTool("inbox_list", {
    title: "List inbox",
    description: "List one chat interval and return messages plus coverage, gaps, and limits.",
    inputSchema: inboxListSchema,
  }, async (input) => textResult(await tools.inbox_list(input)));
  server.registerTool("send_propose", {
    title: "Propose send",
    description: "Create an approval-gated send proposal and return a non-secret receipt.",
    inputSchema: sendProposeSchema,
  }, async (input) => textResult(await tools.send_propose(input)));
  return server;
}

/** Starts the official SDK stdio server; the caller owns the injected agent-role daemon requester. */
export function serveMcpStdio(requester: ProtocolRequester, options?: ServeStdioOptions): StdioServerHandle {
  return serveStdio(() => createMcpServer(requester), options);
}
