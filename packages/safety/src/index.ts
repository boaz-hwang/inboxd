import { randomInt } from "node:crypto";
import type { Database } from "bun:sqlite";
import { coreCall, type CoreHooks } from "../../native/src/index.ts";

export interface SendScope { readonly platform: string; readonly account: string; readonly chat_id: string; }
export interface SendProposal { readonly actor: string; readonly scope: SendScope; readonly body: string; readonly parent_id?: string; }
export interface SendTransportRequest extends SendProposal { readonly idempotency_key: string; }
export type TransportResult = { readonly state: "sent"; readonly receipt: string } | { readonly state: "failed"; readonly reason: string };
export interface SendTransport { readonly capabilities: { readonly send: boolean }; send(request: SendTransportRequest): Promise<TransportResult>; }
export type IntentState = "Proposed" | "Approved" | "Sending" | "Sent" | "Failed" | "Uncertain" | "Expired";
export interface IntentSummary { readonly intent_id: string; readonly state: IntentState; readonly actor: string; readonly scope: SendScope; readonly body: string; readonly parent_id?: string; readonly expires_at: number; readonly receipt?: string; }
export interface PendingIntent extends IntentSummary { readonly approval_code?: string; }
export interface ProposalResult { readonly intent_id: string; readonly expires_at: number; }
export interface ApprovalRequest { readonly intentId: string; readonly code: string; readonly actor: string; readonly scope: SendScope; }
export interface SafetyOptions {
  readonly now?: () => number;
  readonly approvalCode?: () => string;
  readonly id?: () => string;
  readonly approvalTtlMs?: number;
  /** Maximum sends reserved across every destination. Defaults to unlimited. */
  readonly globalQuotaLimit?: number;
  /** Maximum sends reserved for one destination scope. Defaults to unlimited. */
  readonly quotaLimit?: number;
  readonly transportTimeoutMs?: number;
  readonly transport?: SendTransport;
  /** Rechecked inside the Rust claim transaction against the freshly loaded proposal. */
  readonly allowSend?: (proposal: SendProposal) => boolean;
}
export class ApprovalRejectedError extends Error { constructor(message: string) { super(message); this.name = "ApprovalRejectedError"; } }
export class QuotaExceededError extends Error { constructor(message = "send quota exhausted") { super(message); this.name = "QuotaExceededError"; } }
export class IntentNotEligibleError extends Error { constructor(message: string) { super(message); this.name = "IntentNotEligibleError"; } }
export interface PendingIntentPageInput { readonly limit?: number; readonly cursor?: string; }
export interface PendingIntentPage { readonly intents: readonly PendingIntent[]; readonly next_cursor?: string; }
interface ClaimResult { readonly summary?: IntentSummary; readonly request?: SendTransportRequest; }

function compatibleError(error: unknown): never {
  if (error instanceof Error) {
    if (error.name === "ApprovalRejectedError") throw new ApprovalRejectedError(error.message);
    if (error.name === "QuotaExceededError") throw new QuotaExceededError(error.message);
    if (error.name === "IntentNotEligibleError") throw new IntentNotEligibleError(error.message);
  }
  throw error;
}

/** Rust owns all safety decisions and persistence; this facade owns only asynchronous transport I/O. */
export function createSafetyService(database: Database, options: SafetyOptions = {}) {
  const approvalTtlMs = options.approvalTtlMs ?? 15 * 60 * 1_000;
  const globalQuotaLimit = options.globalQuotaLimit ?? Number.MAX_SAFE_INTEGER;
  const quotaLimit = options.quotaLimit ?? Number.MAX_SAFE_INTEGER;
  const transportTimeoutMs = options.transportTimeoutMs ?? 30_000;
  if (!Number.isFinite(transportTimeoutMs) || transportTimeoutMs <= 0) throw new TypeError("transportTimeoutMs must be a positive finite number");
  const hooks: CoreHooks = { now: options.now, id: options.id, approvalCode: options.approvalCode ?? (() => String(randomInt(100_000, 1_000_000))), allowSend: options.allowSend };
  function call<T>(operation: string, input: unknown): T {
    try { return coreCall<T>(operation, input, database, hooks); } catch (error) { compatibleError(error); }
  }
  function sendWithTimeout(request: SendTransportRequest): Promise<TransportResult> {
    const transport = options.transport;
    if (transport === undefined) return Promise.reject(new IntentNotEligibleError("no injected send transport"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("send transport timed out after possible send")), transportTimeoutMs);
      void transport.send(request).then((result) => { clearTimeout(timer); resolve(result); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }
  return {
    hasTransport: () => options.transport !== undefined,
    propose(proposal: SendProposal): ProposalResult { return call("safety.propose", { proposal, approval_ttl_ms: approvalTtlMs }); },
    listPending(): readonly PendingIntent[] { return this.listPendingPage().intents; },
    listPendingPage(input: PendingIntentPageInput = {}): PendingIntentPage { return call("safety.listPendingPage", input); },
    getIntent(intentId: string): IntentSummary | undefined { return call<IntentSummary | null>("safety.getIntent", { intent_id: intentId }) ?? undefined; },
    async approve(request: ApprovalRequest): Promise<IntentSummary> { return call("safety.approve", { intent_id: request.intentId, code: request.code, actor: request.actor, scope: request.scope }); },
    reject(intentId: string): IntentSummary { return call("safety.reject", { intent_id: intentId }); },
    async execute(intentId: string): Promise<IntentSummary> {
      const claimed = call<ClaimResult>("safety.claim", {
        intent_id: intentId,
        transport_present: options.transport !== undefined,
        send_capable: options.transport?.capabilities.send ?? false,
        global_quota_limit: globalQuotaLimit,
        quota_limit: quotaLimit,
        use_allow_send: options.allowSend !== undefined,
      });
      if (claimed.summary !== undefined) return claimed.summary;
      const request = claimed.request;
      if (request === undefined) throw new Error("native safety claim omitted its transport request");
      try {
        const result = await sendWithTimeout(request);
        if (result.state === "sent") return call("safety.finalize", { intent_id: intentId, state: "Sent", transport_payload: { actor: request.actor, scope: request.scope, body: request.body, ...(request.parent_id === undefined ? {} : { parent_id: request.parent_id }), receipt: result.receipt } });
        return call("safety.finalize", { intent_id: intentId, state: "Failed", transport_payload: { actor: request.actor, scope: request.scope, body: request.body, ...(request.parent_id === undefined ? {} : { parent_id: request.parent_id }), reason: result.reason } });
      } catch {
        return call("safety.finalize", { intent_id: intentId, state: "Uncertain", transport_payload: { actor: request.actor, scope: request.scope, body: request.body, ...(request.parent_id === undefined ? {} : { parent_id: request.parent_id }), reason: "transport_threw_after_possible_send" } });
      }
    },
  };
}
export type SafetyService = ReturnType<typeof createSafetyService>;
