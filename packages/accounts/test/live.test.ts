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
