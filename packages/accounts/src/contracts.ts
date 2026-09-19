export type * from "./generated.ts";
import type { PrimitiveRequest } from "./generated.ts";

/** SDK output is untrusted until dispatch validates its operation-specific schema. */
export interface AccountAdapter {
  run(request: PrimitiveRequest): Promise<unknown>;
  /** Content-free invalidations from the existing SDK session, never a second login. */
  listen?(emit: (event: AccountLiveEvent) => void): Promise<() => void>;
  close(): Promise<void> | void;
}

export type AccountLiveEvent =
  | { event: "changed" }
  | { event: "state"; state: "connected" | "disconnected" | "unsupported" };
