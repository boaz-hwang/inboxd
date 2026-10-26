import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

test("SDK diagnostics cannot corrupt response frames or leak into live events", async () => {
  const module = pathToFileURL(join(import.meta.dir, "../src/worker-console.ts")).href;
  const child = Bun.spawn([process.execPath, "-e", `
    import { isolateWorkerConsole } from ${JSON.stringify(module)};
    isolateWorkerConsole();
    console.info("[INFO] web-api:WebClient API Call failed due to rate limiting");
    console.warn("private provider detail");
    console.error("private credential");
    process.stdout.write(JSON.stringify({ok:true,result:{messages:[]}})+"\\n");
    process.stderr.write(JSON.stringify({event:"state",state:"disconnected"})+"\\n");
  `], { stdout: "pipe", stderr: "pipe" });
  expect(await new Response(child.stdout).text()).toBe('{"ok":true,"result":{"messages":[]}}\n');
  expect(await new Response(child.stderr).text()).toBe('{"event":"state","state":"disconnected"}\n');
  expect(await child.exited).toBe(0);
});
