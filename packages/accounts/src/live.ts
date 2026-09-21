import type { AccountLiveEvent } from "./contracts.ts";

/** A bounded, content-free side channel. stdout remains request/response only. */
export function liveEmitter(write: (line: string) => boolean, onDrain: (resume: () => void) => void) {
  let state: AccountLiveEvent | undefined;
  let dirty = false;
  let gap = false;
  const pending = new Map<string, AccountLiveEvent>();
  let blocked = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (closed || blocked) return;
    const event = state ?? (gap ? { event: "gap" as const } : pending.values().next().value) ?? (dirty ? { event: "changed" as const } : undefined);
    if (!event) return;
    if (state) state = undefined;
    else if (gap) gap = false;
    else if (pending.size) pending.delete(pending.keys().next().value!);
    else dirty = false;
    if (!write(JSON.stringify(event) + "\n")) {
      blocked = true;
      onDrain(() => { blocked = false; flush(); });
    } else if (state || dirty || gap || pending.size) flush();
  };
  return {
    emit(event: AccountLiveEvent) {
      if (closed) return;
      if (event.event === "gap") { gap = true; dirty = true; }
      else if (event.event === "deleted" || (event.event === "changed" && event.chat_id)) {
        const key = JSON.stringify(event);
        if (Buffer.byteLength(key) > 1000) { gap = true; dirty = true; }
        else if (pending.size < 1024 || pending.has(key)) pending.set(key, event);
        else { gap = true; dirty = true; }
      } else if (event.event === "changed") dirty = true;
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
