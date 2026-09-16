import { createHash, randomInt } from "node:crypto";

import type { Database } from "bun:sqlite";

export interface SendScope {
  readonly platform: string;
  readonly account: string;
  readonly chat_id: string;
}

export interface SendProposal {
  readonly actor: string;
  readonly scope: SendScope;
  readonly body: string;
  readonly parent_id?: string;
}

export interface SendTransportRequest extends SendProposal {
  readonly idempotency_key: string;
}

export type TransportResult =
  | { readonly state: "sent"; readonly receipt: string }
  | { readonly state: "failed"; readonly reason: string };

/** Transport is injected by the daemon; safety never selects or opens a remote transport. */
export interface SendTransport {
  readonly capabilities: { readonly send: boolean };
  send(request: SendTransportRequest): Promise<TransportResult>;
}

export type IntentState = "Proposed" | "Approved" | "Sending" | "Sent" | "Failed" | "Uncertain" | "Expired";

interface IntentPayload extends SendProposal {
  readonly state: IntentState;
  readonly expires_at: number;
  readonly payload_hash: string;
  readonly parent_id?: string;
  readonly failure_reason?: string;
  readonly receipt?: string;
}

interface ApprovalPayload {
  readonly code_hash: string;
  readonly code: string;
  readonly bound_hash: string;
  readonly actor: string;
  readonly scope: SendScope;
  readonly expires_at: number;
  readonly consumed_at?: number;
}

interface SendPayload extends SendProposal {
  readonly receipt?: string;
  readonly reason?: string;
}

export interface IntentSummary {
  readonly intent_id: string;
  readonly state: IntentState;
  readonly actor: string;
  readonly scope: SendScope;
  readonly body: string;
  readonly parent_id?: string;
  readonly expires_at: number;
  readonly receipt?: string;
}

export interface PendingIntent extends IntentSummary {
  readonly approval_code?: string;
}

export interface ProposalResult {
  readonly intent_id: string;
  readonly expires_at: number;
}

export interface ApprovalRequest {
  readonly intentId: string;
  readonly code: string;
  /** The displayed proposal actor must match the actor bound when the code was issued. */
  readonly actor: string;
  /** The displayed destination must match the scope bound when the code was issued. */
  readonly scope: SendScope;
}

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
  /** Rechecked at claim time so a policy change can stop a previously approved intent. */
  readonly allowSend?: (proposal: SendProposal) => boolean;
}

export class ApprovalRejectedError extends Error {
  constructor(message: string) { super(message); this.name = "ApprovalRejectedError"; }
}

export class QuotaExceededError extends Error {
  constructor(message = "send quota exhausted") { super(message); this.name = "QuotaExceededError"; }
}

export class IntentNotEligibleError extends Error {
  constructor(message: string) { super(message); this.name = "IntentNotEligibleError"; }
}

function assertNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) throw new TypeError(`${field} must be non-empty`);
  return value;
}

function validatedScope(scope: SendScope): SendScope {
  return {
    platform: assertNonEmpty(scope.platform, "scope.platform"),
    account: assertNonEmpty(scope.account, "scope.account"),
    chat_id: assertNonEmpty(scope.chat_id, "scope.chat_id"),
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function equalScopes(a: SendScope, b: SendScope): boolean {
  return a.platform === b.platform && a.account === b.account && a.chat_id === b.chat_id;
}

function decode<T>(json: string): T { return JSON.parse(json) as T; }

function metadata(intentId: string, payload: IntentPayload): Record<string, unknown> {
  return { intent_id: intentId, actor: payload.actor, scope: payload.scope, payload_hash: payload.payload_hash, expires_at: payload.expires_at };
}

const defaultPendingPageLimit = 50;
const maximumPendingPageLimit = 100;
const pendingCursorScope = "safety.intent.listPending:v1";
interface PendingCursor { readonly v: 1; readonly scope: string; readonly created_at: number; readonly id: string; }
export interface PendingIntentPageInput { readonly limit?: number; readonly cursor?: string; }
export interface PendingIntentPage { readonly intents: readonly PendingIntent[]; readonly next_cursor?: string; }

function pendingPageLimit(value: number | undefined): number {
  if (value === undefined) return defaultPendingPageLimit;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumPendingPageLimit) {
    throw new Error(`limit must be an integer from 1 to ${maximumPendingPageLimit}`);
  }
  return value;
}

function encodePendingCursor(row: { readonly created_at: number; readonly id: string }): string {
  return Buffer.from(JSON.stringify({ v: 1, scope: pendingCursorScope, created_at: row.created_at, id: row.id } satisfies PendingCursor)).toString("base64url");
}

function decodePendingCursor(value: string | undefined): PendingCursor | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 4_096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("cursor is malformed");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("cursor is malformed"); }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("cursor is malformed");
  const cursor = decoded as Partial<PendingCursor>;
  const createdAt = cursor.created_at;
  const id = cursor.id;
  if (cursor.v !== 1 || cursor.scope !== pendingCursorScope || typeof createdAt !== "number" || !Number.isFinite(createdAt) || typeof id !== "string" || id.length === 0) {
    throw new Error("cursor does not match pending intents");
  }
  if (encodePendingCursor({ created_at: createdAt, id }) !== value) throw new Error("cursor is malformed");
  return { v: 1, scope: pendingCursorScope, created_at: createdAt, id };
}

/**
 * SQLCipher protects persistent proposal contents and approval codes. Audit records intentionally
 * retain only identifiers, scope, hashes, and timestamps: never a message body or raw code.
 */
export function createSafetyService(database: Database, options: SafetyOptions = {}) {
  const now = options.now ?? Date.now;
  const approvalTtlMs = options.approvalTtlMs ?? 15 * 60 * 1_000;
  const globalQuotaLimit = options.globalQuotaLimit ?? Number.MAX_SAFE_INTEGER;
  const quotaLimit = options.quotaLimit ?? Number.MAX_SAFE_INTEGER;
  const transportTimeoutMs = options.transportTimeoutMs ?? 30_000;
  if (!Number.isFinite(transportTimeoutMs) || transportTimeoutMs <= 0) {
    throw new TypeError("transportTimeoutMs must be a positive finite number");
  }
  const makeId = options.id ?? (() => crypto.randomUUID());
  const makeCode = options.approvalCode ?? (() => String(randomInt(100_000, 1_000_000)));

  function audit(action: string, subject: string, payload: Record<string, unknown>): void {
    database.run("INSERT INTO audit (action, subject, payload_json, created_at) VALUES (?, ?, ?, ?)", [action, subject, JSON.stringify(payload), now()]);
  }

  function transaction<T>(operation: () => T): T {
    database.run("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.run("COMMIT");
      return result;
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    }
  }

  function loadIntent(intentId: string): IntentPayload | undefined {
    const row = database.query("SELECT payload_json FROM intents WHERE id = ?").get(intentId) as { payload_json: string } | null;
    return row === null ? undefined : decode<IntentPayload>(row.payload_json);
  }

  function loadApproval(intentId: string): { id: string; approved_at: number | null; payload: ApprovalPayload } | undefined {
    const row = database.query("SELECT id, approved_at, payload_json FROM approvals WHERE intent_id = ?").get(intentId) as { id: string; approved_at: number | null; payload_json: string } | null;
    return row === null ? undefined : { id: row.id, approved_at: row.approved_at, payload: decode<ApprovalPayload>(row.payload_json) };
  }

  function boundHash(intentId: string, payload: IntentPayload): string {
    const actualPayloadHash = sha256({ actor: payload.actor, scope: payload.scope, body: payload.body, ...(payload.parent_id === undefined ? {} : { parent_id: payload.parent_id }) });
    return sha256({ intent_id: intentId, actor: payload.actor, scope: payload.scope, payload_hash: actualPayloadHash, expires_at: payload.expires_at });
  }

  function markIntent(intentId: string, payload: IntentPayload, state: IntentState, failureReason?: string): IntentPayload {
    const updated: IntentPayload = { ...payload, state, ...(failureReason === undefined ? {} : { failure_reason: failureReason }) };
    database.run("UPDATE intents SET payload_json = ? WHERE id = ?", [JSON.stringify(updated), intentId]);
    return updated;
  }

  function expireIfNecessary(intentId: string, payload: IntentPayload): IntentPayload {
    if ((payload.state === "Proposed" || payload.state === "Approved") && payload.expires_at <= now()) {
      const expired = markIntent(intentId, payload, "Expired", "ttl_elapsed");
      audit("intent.expired", intentId, metadata(intentId, expired));
      return expired;
    }
    return payload;
  }

  /** Persist expiry before an operation can reject, so a rejected attempt cannot roll it back. */
  function currentIntent(intentId: string): IntentPayload {
    const payload = loadIntent(intentId);
    if (payload === undefined) throw new IntentNotEligibleError("intent is missing");
    return expireIfNecessary(intentId, payload);
  }

  // Scope keys are canonical JSON objects, so this scalar sentinel cannot collide with a real scope.
  const globalQuotaScope = "__global__";

  function quotaScope(scope: SendScope): string { return canonical(scope); }

  function reserveQuotaKey(key: string, limit: number): void {
    const existing = database.query("SELECT used FROM quota WHERE scope = ?").get(key) as { used: number } | null;
    if ((existing?.used ?? 0) >= limit) throw new QuotaExceededError();
    if (existing === null) database.run("INSERT INTO quota (scope, used, updated_at) VALUES (?, ?, ?)", [key, 1, now()]);
    else database.run("UPDATE quota SET used = ?, updated_at = ? WHERE scope = ?", [existing.used + 1, now(), key]);
  }

  function releaseQuotaKey(key: string): void {
    const existing = database.query("SELECT used FROM quota WHERE scope = ?").get(key) as { used: number } | null;
    if (existing !== null) database.run("UPDATE quota SET used = ?, updated_at = ? WHERE scope = ?", [Math.max(0, existing.used - 1), now(), key]);
  }

  /** Called inside claim/finalize transactions so both counters change atomically. */
  function reserveQuota(scope: SendScope): void {
    reserveQuotaKey(globalQuotaScope, globalQuotaLimit);
    reserveQuotaKey(quotaScope(scope), quotaLimit);
  }

  function releaseQuota(scope: SendScope): void {
    releaseQuotaKey(quotaScope(scope));
    releaseQuotaKey(globalQuotaScope);
  }

  function sendWithTimeout(request: SendTransportRequest): Promise<TransportResult> {
    const transport = options.transport;
    if (transport === undefined) return Promise.reject(new IntentNotEligibleError("no injected send transport"));
    return new Promise<TransportResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("send transport timed out after possible send")),
        transportTimeoutMs,
      );
      void transport.send(request).then(
        (result) => { clearTimeout(timer); resolve(result); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  function proposedSummary(intentId: string, payload: IntentPayload): IntentSummary {
    return { intent_id: intentId, state: payload.state, actor: payload.actor, scope: payload.scope, body: payload.body, ...(payload.parent_id === undefined ? {} : { parent_id: payload.parent_id }), expires_at: payload.expires_at, ...(payload.receipt === undefined ? {} : { receipt: payload.receipt }) };
  }

  function finalize(intentId: string, state: "Sent" | "Failed" | "Uncertain", transportPayload: SendPayload): IntentSummary {
    return transaction(() => {
      const payload = loadIntent(intentId);
      if (payload === undefined) throw new IntentNotEligibleError("intent is missing");
      const statePayload: IntentPayload = { ...payload, ...(transportPayload.receipt === undefined ? {} : { receipt: transportPayload.receipt }) };
      const updated = markIntent(intentId, statePayload, state, transportPayload.reason);
      database.run("UPDATE sends SET state = ?, payload_json = ? WHERE intent_id = ? AND state = 'Sending'", [state, JSON.stringify(transportPayload), intentId]);
      if (state === "Failed") releaseQuota(payload.scope);
      // Transport receipt/reason are untrusted remote strings; neither belongs in audit metadata.
      audit(`send.${state.toLowerCase()}`, intentId, metadata(intentId, updated));
      return proposedSummary(intentId, updated);
    });
  }

  return {
    hasTransport: () => options.transport !== undefined,

    propose(input: SendProposal): ProposalResult {
      const actor = assertNonEmpty(input.actor, "actor");
      const proposal: SendProposal = { actor, scope: validatedScope(input.scope), body: assertNonEmpty(input.body, "body"), ...(input.parent_id === undefined ? {} : { parent_id: assertNonEmpty(input.parent_id, "parent_id") }) };
      const intentId = makeId();
      const expiresAt = now() + approvalTtlMs;
      const payloadHash = sha256({ actor: proposal.actor, scope: proposal.scope, body: proposal.body, ...(proposal.parent_id === undefined ? {} : { parent_id: proposal.parent_id }) });
      const payload: IntentPayload = { ...proposal, state: "Proposed", expires_at: expiresAt, payload_hash: payloadHash };
      const code = assertNonEmpty(makeCode(), "approval code");
      const approval: ApprovalPayload = { code, code_hash: sha256(code), bound_hash: boundHash(intentId, payload), actor: proposal.actor, scope: proposal.scope, expires_at: expiresAt };
      transaction(() => {
        database.run("INSERT INTO intents (id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)", [intentId, "send", JSON.stringify(payload), now()]);
        database.run("INSERT INTO approvals (id, intent_id, approved_at, payload_json) VALUES (?, ?, NULL, ?)", [makeId(), intentId, JSON.stringify(approval)]);
        audit("intent.proposed", intentId, metadata(intentId, payload));
      });
      return { intent_id: intentId, expires_at: expiresAt };
    },

    /** Legacy in-process convenience surface; protocol consumers use listPendingPage. */
    listPending(): readonly PendingIntent[] {
      return this.listPendingPage().intents;
    },

    /** A bounded stable page over the actionable/uncertain state set. */
    listPendingPage(input: PendingIntentPageInput = {}): PendingIntentPage {
      const limit = pendingPageLimit(input.limit);
      const cursor = decodePendingCursor(input.cursor);
      const cursorWhere = cursor === undefined ? "" : " AND (created_at > ? OR (created_at = ? AND id > ?))";
      const rows = database.query(`SELECT id, created_at, payload_json FROM intents
        WHERE json_extract(payload_json, '$.state') IN ('Proposed', 'Approved', 'Sending', 'Uncertain')${cursorWhere}
        ORDER BY created_at, id LIMIT ?`).all(...(cursor === undefined ? [] : [cursor.created_at, cursor.created_at, cursor.id]), limit + 1) as { id: string; created_at: number; payload_json: string }[];
      const page = rows.slice(0, limit).flatMap((row) => {
        const payload = expireIfNecessary(row.id, decode<IntentPayload>(row.payload_json));
        if (payload.state !== "Proposed" && payload.state !== "Approved" && payload.state !== "Sending" && payload.state !== "Uncertain") return [];
        const summary = proposedSummary(row.id, payload);
        if (payload.state === "Sending" || payload.state === "Uncertain") return [summary];
        const approval = loadApproval(row.id);
        return approval === undefined ? [] : [{ ...summary, approval_code: approval.payload.code }];
      });
      const cursorRow = rows.slice(0, limit).at(-1);
      return {
        intents: page,
        ...(rows.length > limit && cursorRow !== undefined ? { next_cursor: encodePendingCursor(cursorRow) } : {}),
      };
    },

    getIntent(intentId: string): IntentSummary | undefined {
      const payload = loadIntent(intentId);
      return payload === undefined ? undefined : proposedSummary(intentId, expireIfNecessary(intentId, payload));
    },

    async approve(request: ApprovalRequest): Promise<IntentSummary> {
      if (currentIntent(request.intentId).state === "Expired") throw new ApprovalRejectedError("approval has expired");
      return transaction(() => {
        const payload = loadIntent(request.intentId);
        const approval = loadApproval(request.intentId);
        if (payload === undefined || approval === undefined) throw new ApprovalRejectedError("approval intent is missing");
        const current = payload;
        if (current.state !== "Proposed" || approval.approved_at !== null || approval.payload.consumed_at !== undefined) throw new ApprovalRejectedError("approval is no longer available");
        if (approval.payload.expires_at <= now() || current.expires_at <= now()) throw new ApprovalRejectedError("approval has expired");
        if (sha256(request.code) !== approval.payload.code_hash) throw new ApprovalRejectedError("approval code is invalid");
        if (request.actor !== approval.payload.actor || request.actor !== current.actor || !equalScopes(request.scope, approval.payload.scope) || !equalScopes(request.scope, current.scope)) throw new ApprovalRejectedError("approval actor or scope does not match");
        if (approval.payload.bound_hash !== boundHash(request.intentId, current)) throw new ApprovalRejectedError("approval binding no longer matches intent");
        database.run("UPDATE approvals SET approved_at = ?, payload_json = ? WHERE id = ?", [now(), JSON.stringify({ ...approval.payload, consumed_at: now() }), approval.id]);
        const approved = markIntent(request.intentId, current, "Approved");
        audit("intent.approved", request.intentId, metadata(request.intentId, approved));
        return proposedSummary(request.intentId, approved);
      });
    },

    reject(intentId: string): IntentSummary {
      currentIntent(intentId);
      return transaction(() => {
        const payload = loadIntent(intentId);
        if (payload === undefined) throw new IntentNotEligibleError("intent is missing");
        const current = payload;
        if (current.state !== "Proposed" && current.state !== "Approved") throw new IntentNotEligibleError("intent is not rejectable");
        const rejected = markIntent(intentId, current, "Expired", "rejected");
        audit("intent.rejected", intentId, metadata(intentId, rejected));
        return proposedSummary(intentId, rejected);
      });
    },

    async execute(intentId: string): Promise<IntentSummary> {
      if (currentIntent(intentId).state === "Expired") throw new IntentNotEligibleError("intent has expired");
      if (options.transport === undefined) throw new IntentNotEligibleError("no injected send transport");
      if (!options.transport.capabilities.send) {
        return transaction(() => {
          const payload = loadIntent(intentId);
          if (payload === undefined) throw new IntentNotEligibleError("intent is missing");
          const current = payload;
          if (current.state !== "Approved") throw new IntentNotEligibleError(`intent is not eligible from ${current.state}`);
          const failed = markIntent(intentId, current, "Failed", "send_capability_disabled");
          audit("send.rejected", intentId, metadata(intentId, failed));
          return proposedSummary(intentId, failed);
        });
      }

      const claimed = transaction(() => {
        const payload = loadIntent(intentId);
        const approval = loadApproval(intentId);
        if (payload === undefined || approval === undefined) throw new IntentNotEligibleError("intent is missing approval data");
        const current = payload;
        if (current.state !== "Approved") throw new IntentNotEligibleError(`intent is not eligible from ${current.state}`);
        if (approval.approved_at === null || approval.payload.consumed_at === undefined || approval.payload.bound_hash !== boundHash(intentId, current) || approval.payload.expires_at <= now()) throw new IntentNotEligibleError("approval binding is no longer valid");
        if (options.allowSend !== undefined && !options.allowSend(current)) {
          const failed = markIntent(intentId, current, "Failed", "policy_denied");
          audit("send.rejected", intentId, metadata(intentId, failed));
          return undefined;
        }
        reserveQuota(current.scope);
        const idempotencyKey = sha256({ intent_id: intentId, scope: current.scope, payload_hash: current.payload_hash, expires_at: current.expires_at });
        const sending = markIntent(intentId, current, "Sending");
        database.run("INSERT INTO sends (id, intent_id, idempotency_key, state, payload_json, created_at) VALUES (?, ?, ?, 'Sending', ?, ?)", [makeId(), intentId, idempotencyKey, JSON.stringify(current), now()]);
        audit("send.claimed", intentId, metadata(intentId, sending));
        return { payload: current, idempotency_key: idempotencyKey };
      });
      if (claimed === undefined) {
        const payload = loadIntent(intentId);
        if (payload === undefined) throw new IntentNotEligibleError("intent is missing");
        return proposedSummary(intentId, payload);
      }

      try {
        const result = await sendWithTimeout({ actor: claimed.payload.actor, scope: claimed.payload.scope, body: claimed.payload.body, ...(claimed.payload.parent_id === undefined ? {} : { parent_id: claimed.payload.parent_id }), idempotency_key: claimed.idempotency_key });
        if (result.state === "sent") return finalize(intentId, "Sent", { actor: claimed.payload.actor, scope: claimed.payload.scope, body: claimed.payload.body, ...(claimed.payload.parent_id === undefined ? {} : { parent_id: claimed.payload.parent_id }), receipt: result.receipt });
        return finalize(intentId, "Failed", { actor: claimed.payload.actor, scope: claimed.payload.scope, body: claimed.payload.body, ...(claimed.payload.parent_id === undefined ? {} : { parent_id: claimed.payload.parent_id }), reason: result.reason });
      } catch {
        return finalize(intentId, "Uncertain", { actor: claimed.payload.actor, scope: claimed.payload.scope, body: claimed.payload.body, ...(claimed.payload.parent_id === undefined ? {} : { parent_id: claimed.payload.parent_id }), reason: "transport_threw_after_possible_send" });
      }
    },
  };
}

export type SafetyService = ReturnType<typeof createSafetyService>;
