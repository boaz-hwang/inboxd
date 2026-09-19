import type { AccountLiveEvent } from "./contracts.ts";

/** A bounded, content-free side channel. stdout remains request/response only. */
export function liveEmitter(write: (line: string) => boolean, onDrain: (resume: () => void) => void) {
  let state: AccountLiveEvent | undefined;
  let dirty = false;
  let blocked = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (closed || blocked) return;
    const event = state ?? (dirty ? { event: "changed" as const } : undefined);
    if (!event) return;
    if (state) state = undefined; else dirty = false;
    if (!write(JSON.stringify(event) + "\n")) {
      blocked = true;
      onDrain(() => { blocked = false; flush(); });
    } else if (state || dirty) flush();
  };
  return {
    emit(event: AccountLiveEvent) {
      if (closed) return;
      if (event.event === "changed") dirty = true;
      else {
        state = event;
        // A fast disconnect/reconnect may collapse to the same final state.
        // Preserve the need to reconcile any messages missed in that gap.
        if (event.state === "connected") dirty = true;
      }
      if (!timer && !blocked) timer = setTimeout(flush, 100);
    },
    close() { closed = true; clearTimeout(timer); },
  };
}
