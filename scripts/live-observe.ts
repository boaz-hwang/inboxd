/** Read-only live observation. Never writes provider payloads, identities, or error text. */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ReconnectingProtocolClient } from "../packages/protocol/src/index.ts";
import { connectUdsTransport } from "../packages/cli/src/transport.ts";

const root = join(homedir(), ".inboxd");
const output = process.argv[2];
const hours = Number(process.argv[3] ?? 25);
const interval = Number(process.argv[4] ?? 30);
if (!output || !Number.isFinite(hours) || hours <= 0 || hours > 168 || !Number.isFinite(interval) || interval < 1) {
  throw new Error("usage: bun scripts/live-observe.ts <private-output-directory> [hours=25] [interval-seconds=30]");
}
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);
const started = Date.now();
const deadline = started + hours * 3_600_000;
const binaryHash = createHash("sha256").update(readFileSync(join(root, "product/release/inboxd-daemon"))).digest("hex");
const write = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const append = (value: unknown) => appendFileSync(join(output, "samples.jsonl"), JSON.stringify(value) + "\n", { mode: 0o600 });
const states = new Set(["connected", "disconnected", "unsupported", "degraded", "idle", "live", "running", "failed"]);
const safeState = (v: unknown) => typeof v === "string" && states.has(v) ? v : "unknown";
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
let events: Record<string, number> = {};
let samples = 0, failures = 0, gaps = 0, restarts = 0, previousPid = 0, last = started;
let peakRssKiB = 0;
let continuousSince = started;
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
const client = new ReconnectingProtocolClient({
  connect: () => connectUdsTransport(join(root, "state/sock")), role: "agent",
  onEvent: event => {
    if (["account.changed", "message.upserted"].includes(event.method)) events[event.method] = (events[event.method] ?? 0) + 1;
  },
});
write("run.json", { schema: 1, started_at: new Date(started).toISOString(), scheduled_end: new Date(deadline).toISOString(), binary_sha256: binaryHash, interval_seconds: interval, scope: "status and invalidation observation only; not message delivery proof" });
try {
  while (!stopping && Date.now() < deadline) {
    const now = Date.now();
    const gap = now - last;
    if (gap > interval * 2000 + 15000) { gaps++; continuousSince = now; }
    last = now;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([
        (async () => { await client.start(["account.changed", "message.upserted"]); return await client.request("sync.status", {}); })(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("timeout")), 15000); }),
      ]);
      const accounts = Array.isArray(status.accounts) ? status.accounts : [];
      let rssKiB: number | null = null;
      let pid = 0;
      try {
        const lock = JSON.parse(readFileSync(join(root, "state/inboxd.lock"), "utf8"));
        if (Number.isSafeInteger(lock.pid) && lock.pid > 0) {
          pid = lock.pid;
          rssKiB = Number(execFileSync("/bin/ps", ["-p", String(pid), "-o", "rss="], { encoding: "utf8", timeout: 1000 }).trim());
          if (!Number.isFinite(rssKiB)) rssKiB = null;
        }
      } catch { /* missing resource sample is not zero usage */ }
      if (pid && previousPid && pid !== previousPid) { restarts++; continuousSince = now; }
      if (!pid) continuousSince = now;
      if (pid) previousPid = pid;
      peakRssKiB = Math.max(peakRssKiB, rssKiB ?? 0);
      append({ at: new Date(now).toISOString(), elapsed_ms: now - started, gap_ms: gap, ok: true,
        state: safeState(status.state), receiving_state: safeState(status.receiving_state), rss_kib: rssKiB,
        accounts: accounts.map((value, index) => {
          const a = value as Record<string, unknown>;
          return { slot: index, platform: ["slack", "telegram", "kakao"].includes(String(a.platform)) ? a.platform : "unknown", state: safeState(a.state), revision: number(a.revision), snapshot_age_seconds: number(a.snapshot_age_seconds), refreshing: a.refreshing === true };
        }), events });
    } catch {
      failures++;
      continuousSince = now;
      client.stop();
      append({ at: new Date(now).toISOString(), elapsed_ms: now - started, gap_ms: gap, ok: false, error: "status_unavailable", events });
    } finally { if (timeout) clearTimeout(timeout); }
    events = {};
    samples++;
    write("summary.json", { started_at: new Date(started).toISOString(), updated_at: new Date().toISOString(), elapsed_hours: (Date.now() - started) / 3_600_000, continuous_observed_daemon_hours: (Date.now() - continuousSince) / 3_600_000, samples, failures, observation_gaps: gaps, observed_daemon_restarts: restarts, peak_daemon_rss_kib: peakRssKiB, complete: false, message_scenarios: "not assessed by this observer" });
    await Bun.sleep(Math.min(interval * 1000, Math.max(0, deadline - Date.now())));
  }
} finally {
  client.stop();
  write("finished.json", { at: new Date().toISOString(), reached_deadline: Date.now() >= deadline, interrupted: stopping, samples, failures, observation_gaps: gaps, observed_daemon_restarts: restarts, elapsed_hours: (Date.now() - started) / 3_600_000, continuous_observed_daemon_hours: (Date.now() - continuousSince) / 3_600_000, delivery_verified: false });
}
