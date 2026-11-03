// One-shot credential maintenance for the native worker; never a persistent service.
import { SlackAuthStore, type SlackCredentials } from "./auth-store.ts";
import { readBounded } from "../../../packages/accounts/src/io.ts";
try {
  const raw = await readBounded(Bun.stdin.stream(), 32768);
  if (!raw.trim()) process.exit(1);
  const input = JSON.parse(raw);
  const credentials = input.credentials as SlackCredentials;
  if (!credentials || typeof credentials.bot_token !== "string" || !credentials.bot_token) throw new Error();
  const store = new SlackAuthStore();
  let result: SlackCredentials | null = null;
  switch (input.op) {
    case "current": result = store.current(credentials); break;
    case "remember": await store.remember(credentials); break;
    case "recover": result = await store.recover(credentials); break;
    case "reject": await store.reject(credentials); break;
    default: throw new Error();
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
  process.exitCode = 1;
}
