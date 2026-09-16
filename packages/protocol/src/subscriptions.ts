import type { ProtocolEvent, ProtocolEventMethod } from "./schema.ts";

export interface SubscriptionQueueOptions {
  maxQueuedEvents?: number;
  onEvent: (event: ProtocolEvent) => void;
  onOverflow: () => void;
}

/**
 * Batches event delivery into a microtask so producers cannot grow an
 * unbounded in-memory queue. An overflow is intentionally terminal: callers
 * close the stream and re-query their views after reconnecting.
 */
export class SubscriptionQueue {
  private readonly maxQueuedEvents: number;
  private readonly events: ProtocolEvent[] = [];
  private scheduled = false;
  private overflowed = false;

  constructor(private readonly options: SubscriptionQueueOptions) {
    this.maxQueuedEvents = options.maxQueuedEvents ?? 256;
    if (!Number.isSafeInteger(this.maxQueuedEvents) || this.maxQueuedEvents <= 0) {
      throw new Error("maxQueuedEvents must be a positive integer");
    }
  }

  enqueue(event: ProtocolEvent): boolean {
    if (this.overflowed) return false;
    if (this.events.length >= this.maxQueuedEvents) {
      this.overflowed = true;
      this.events.length = 0;
      this.options.onOverflow();
      return false;
    }
    this.events.push(event);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.drain());
    }
    return true;
  }

  get requiresRequery(): boolean {
    return this.overflowed;
  }

  private drain(): void {
    this.scheduled = false;
    while (this.events.length > 0 && !this.overflowed) {
      this.options.onEvent(this.events.shift()!);
    }
  }
}

export function subscriptionParams(topics: readonly ProtocolEventMethod[]): { topics: ProtocolEventMethod[] } {
  return { topics: [...new Set(topics)] };
}
