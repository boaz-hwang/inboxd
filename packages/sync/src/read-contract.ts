export interface ReadContractCapabilities {
  readonly fetch_historical: boolean;
  readonly read_cursor_comparison: "message_id" | "timestamp" | "none";
}

export interface ReadContractRequest {
  readonly authoritative_history: boolean;
  readonly capabilities: ReadContractCapabilities;
}

export type ReadAdapterDecision =
  | { readonly decision: "degraded_adapter_allowed" }
  | { readonly decision: "direct_cursor_adapter_required" };

/**
 * Wrapper reads may seed explicitly incomplete data, but authoritative history
 * needs a direct adapter with observable pagination/cursor semantics.
 */
export function decideReadAdapterWidening(request: ReadContractRequest): ReadAdapterDecision {
  if (request.authoritative_history) return { decision: "direct_cursor_adapter_required" };
  return { decision: "degraded_adapter_allowed" };
}
