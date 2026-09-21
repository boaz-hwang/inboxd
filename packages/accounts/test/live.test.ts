import { expect, test } from "bun:test";
import { liveEmitter } from "../src/live.ts";

test("push bursts use bounded state and resume after IPC backpressure", async () => {
  const lines: string[] = [];
  let resume: (() => void) | undefined;
  const emitter = liveEmitter(line => { lines.push(line); return lines.length !== 1; }, callback => { resume = callback; });
  for (let i = 0; i < 10000; i++) emitter.emit({ event: "changed" });
  emitter.emit({ event: "state", state: "connected" });
  await Bun.sleep(120);
  expect(lines.map(line => JSON.parse(line))).toEqual([{ event: "state", state: "connected" }]);
  for (let i = 0; i < 10000; i++) emitter.emit({ event: "changed" });
  emitter.emit({ event: "state", state: "disconnected" });
  expect(lines).toHaveLength(1);
  resume!();
  expect(lines.map(line => JSON.parse(line))).toEqual([{ event: "state", state: "connected" }, { event: "state", state: "disconnected" }, { event: "changed" }]);
  emitter.emit({ event: "changed" });
  emitter.close();
  await Bun.sleep(120);
  expect(lines).toHaveLength(3);
});

test("a reconnect coalesced to the same state still requests reconciliation", async () => {
  const events: unknown[] = [];
  const emitter = liveEmitter(line => { events.push(JSON.parse(line)); return true; }, () => {});
  emitter.emit({ event: "state", state: "connected" });
  await Bun.sleep(120);
  events.length = 0;
  emitter.emit({ event: "state", state: "disconnected" });
  emitter.emit({ event: "state", state: "connected" });
  await Bun.sleep(120);
  expect(events).toEqual([{ event: "state", state: "connected" }, { event: "changed" }]);
  emitter.close();
});

test("deletion identities survive coalescing and overflow reports an evidence gap", async () => {
  const lines: any[] = [];
  let resume: (() => void) | undefined;
  const emitter = liveEmitter(line => { lines.push(JSON.parse(line)); return lines.length !== 1; }, callback => { resume = callback; });
  emitter.emit({ event: "deleted", chat_id: "room", message_id: "original" });
  await Bun.sleep(120);
  for (let i = 0; i < 1100; i++) emitter.emit({ event: "deleted", chat_id: "room", message_id: String(i) });
  resume!();
  expect(lines[0]).toEqual({ event: "deleted", chat_id: "room", message_id: "original" });
  expect(lines.filter(v => v.event === "deleted")).toHaveLength(1025);
  expect(lines.some(v => v.event === "gap")).toBe(true);
  emitter.close();
});
