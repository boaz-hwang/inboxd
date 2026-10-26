import { Console } from "node:console";
import { Writable } from "node:stream";

/** SDK diagnostics must not enter stdout RPC frames or the content-free event pipe. */
export function isolateWorkerConsole(): void {
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  Object.assign(globalThis.console, new Console({ stdout: sink, stderr: sink }));
}
