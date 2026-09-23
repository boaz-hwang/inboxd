import { AUTH_ERROR_CODES } from "./errors.ts";
import type { AccountAdapter, AccountRequest, AccountResult, ResultFor } from "./contracts.ts";
import { parseRequest, parseResult } from "./validation.ts";

/** Typed callers get an operation-specific result; the worker uses dispatchWire for JSON. */
export async function dispatch<R extends AccountRequest>(adapter: AccountAdapter, request: R): Promise<ResultFor<R>> {
  return await dispatchWire(adapter,request) as ResultFor<R>;
}
/** Validate the entire request before any SDK call; validate each result before IPC. */
export async function dispatchWire(adapter: AccountAdapter, input: unknown): Promise<AccountResult> {
  const request = parseRequest(input);
  if (request.op !== "batch") return parseResult(request,await adapter.run(request));
  // Await every started read before returning failure or closing the SDK session.
  const settled = await Promise.allSettled(request.requests.map(async r => parseResult(r,await adapter.run(r))));
  const failure = settled.find(r => r.status === "rejected");
  if (failure?.status === "rejected") {
    const error = new Error("provider batch failed");
    if (AUTH_ERROR_CODES.has(failure.reason?.code)) Object.assign(error, { code: failure.reason.code });
    throw error;
  }
  return { results: settled.map(r => { if (r.status === "rejected") throw r.reason; return r.value; }) };
}
