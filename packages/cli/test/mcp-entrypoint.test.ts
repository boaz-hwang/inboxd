import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("inboxd mcp serves stdio and delegates only through the daemon handshake", async () => {
  const root = mkdtempSync(join(tmpdir(), "imcp-"));
  const state = join(root, ".inboxd", "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const token = "test-owner-credential-".repeat(3);
  writeFileSync(join(state, "approver.token"), token, { mode: 0o600 });
  chmodSync(join(state, "approver.token"), 0o600);
  const calls: Record<string, any>[] = [];
  const sockets = new Set<any>();
  const server = Bun.listen<{ pending: string }>({
    unix: join(state, "sock"),
    socket: {
      open(socket) { socket.data = { pending: "" }; sockets.add(socket); },
      close(socket) { sockets.delete(socket); },
      data(socket, data) {
        socket.data.pending += data.toString();
        let newline: number;
        while ((newline = socket.data.pending.indexOf("\n")) >= 0) {
          const request = JSON.parse(socket.data.pending.slice(0, newline));
          socket.data.pending = socket.data.pending.slice(newline + 1);
          calls.push(request);
          const result = request.method === "message.send" ? { request_id: request.params.request_id, state: "Uncertain" } : {};
          socket.write(JSON.stringify({ type: "response", id: request.id, method: request.method, ok: true, result }) + "\n");
        }
      },
    },
  });
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/bin.ts"), "mcp"], {
    env: { ...process.env, HOME: root }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let output = "";
  const replies = new Map<number, any>();
  const waitFor = async (id: number) => {
    while (!replies.has(id)) {
      const part = await reader.read();
      if (part.done) throw new Error("MCP exited before response");
      output += new TextDecoder().decode(part.value);
      let newline: number;
      while ((newline = output.indexOf("\n")) >= 0) {
        const message = JSON.parse(output.slice(0, newline));
        output = output.slice(newline + 1);
        if (message.id !== undefined) replies.set(message.id, message);
      }
    }
    return replies.get(id);
  };
  const send = (message: object) => { child.stdin.write(JSON.stringify(message) + "\n"); child.stdin.flush(); };
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect((await waitFor(1)).result.serverInfo.name).toBe("inboxd");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = (await waitFor(2)).result.tools.map((tool: any) => tool.name);
    expect(names).toContain("message_send");
    expect(names).not.toContain("send_propose");
    const params = { request_id: "stable-entrypoint", chat: { platform: "slack", account: "a", chat_id: "c" }, body: "hello" };
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "message_send", arguments: params } });
    const response = await waitFor(3);
    expect(JSON.parse(response.result.content[0].text)).toEqual({ request_id: "stable-entrypoint", state: "Uncertain" });
    expect(calls[0]).toMatchObject({ method: "system.hello", params: { role: "sender", sender_token: token } });
    expect(calls.at(-1)).toMatchObject({ method: "message.send", params });
    expect(JSON.stringify(response)).not.toContain(token);
    child.stdin.end();
    expect(await child.exited).toBe(0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
    await child.exited;
    for (const socket of sockets) socket.end();
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
