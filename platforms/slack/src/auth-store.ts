import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPrivate, savePrivate, acquireLock } from "../../../packages/host/src/credential-file.ts";
import { readBounded } from "../../../packages/accounts/src/io.ts";

export type SlackCredentials = { bot_token: string; session_cookie?: string; team_id?: string };
export const slackAuthRequired = () => Object.assign(new Error("Slack authentication requires reconnection"), { code: "slack_auth_required" });
export const slackAuthErrors = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "invalid_cookie"]);
const fingerprint = (c: SlackCredentials) => createHash("sha256").update(`${c.bot_token}\0${c.session_cookie ?? ""}`).digest("hex");

type Identity = { team: string; user: string; domain: string };
/** Web-session tokens use the existing d cookie, not Slack-app OAuth rotation. */
export class SlackAuthStore {
  constructor(private fetcher: typeof fetch = fetch, readonly path = join(homedir(), ".config", "agent-messenger", "slack-credentials.json")) {}
  private workspace(document: Record<string, any>, c: SlackCredentials): any {
    const matches = Object.values(document.workspaces ?? {}).filter((w: any) => c.team_id ? w.workspace_id === c.team_id : w.token === c.bot_token);
    if (matches.length !== 1) return undefined;
    return matches[0];
  }
  current(c: SlackCredentials): SlackCredentials {
    if (!c.session_cookie || !c.team_id) return c;
    try {
      const row = this.workspace(readPrivate(this.path), c);
      const next = { ...c, bot_token: row?.token, session_cookie: row?.cookie };
      return row?.inboxd_identity?.team === c.team_id && row.inboxd_identity.fingerprint === fingerprint(next) ? next : c;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return c; throw error; }
  }
  private async identity(c: SlackCredentials): Promise<Identity> {
    const response = await this.fetcher("https://slack.com/api/auth.test", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${c.bot_token}`, ...(c.session_cookie ? { cookie: `d=${c.session_cookie}` } : {}) } });
    if (!response.body) throw slackAuthRequired();
    const result = JSON.parse(await readBounded(response.body, 64_000));
    if (!response.ok || !result.ok || typeof result.team_id !== "string" || typeof result.user_id !== "string") throw slackAuthRequired();
    const url = new URL(result.url);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname) || url.port || url.username || url.password) throw slackAuthRequired();
    if (c.team_id && c.team_id !== result.team_id) throw slackAuthRequired();
    return { team: result.team_id, user: result.user_id, domain: url.hostname };
  }
  async remember(c: SlackCredentials): Promise<void> {
    // Called after a successful read. Failure to record optional recovery
    // metadata must not turn a healthy read into an error.
    if (!c.session_cookie) return;
    const document = readPrivate(this.path), workspace = this.workspace(document, c);
    if (!workspace || workspace.token !== c.bot_token || workspace.cookie !== c.session_cookie) return;
    if (workspace.inboxd_identity?.fingerprint === fingerprint(c)) return;
    const identity = await this.identity(c);
    const release = await acquireLock(`${this.path}.inboxd-refresh-lock`);
    try {
      const latest = readPrivate(this.path), row = this.workspace(latest, c);
      if (row?.token === c.bot_token && row.cookie === c.session_cookie) {
        row.inboxd_identity = { ...identity, fingerprint: fingerprint(c) };
        delete row.inboxd_refresh_failure; savePrivate(this.path, latest);
      }
    } finally { release(); }
  }
  async reject(c: SlackCredentials): Promise<void> {
    const release = await acquireLock(`${this.path}.inboxd-refresh-lock`);
    try {
      const document = readPrivate(this.path), row = this.workspace(document, c);
      if (row?.token === c.bot_token && row.cookie === c.session_cookie) {
        row.inboxd_refresh_failure = fingerprint(c); savePrivate(this.path, document);
      }
    } finally { release(); }
  }
  async recover(c: SlackCredentials): Promise<SlackCredentials> {
    if (!c.session_cookie) throw slackAuthRequired();
    const release = await acquireLock(`${this.path}.inboxd-refresh-lock`);
    try {
      const document = readPrivate(this.path), row = this.workspace(document, c);
      const identity = row?.inboxd_identity as Identity | undefined;
      if (!row || !identity || identity.team !== row.workspace_id || !/^[a-z0-9-]+\.slack\.com$/i.test(identity.domain)) throw slackAuthRequired();
      const next = { ...c, bot_token: row.token, session_cookie: row.cookie, team_id: identity.team };
      if (fingerprint(next) !== fingerprint(c)) {
        const checked = await this.identity(next);
        if (checked.team !== identity.team || checked.user !== identity.user) throw slackAuthRequired();
        return next;
      }
      if (row.inboxd_refresh_failure === fingerprint(c)) throw slackAuthRequired();
      try {
        // Follow only bounded HTTPS Slack redirects, never forward the cookie
        // to arbitrary URLs supplied by a page or Location header.
        let url = new URL(`https://${identity.domain}/ssb/redirect`);
        let token: string | undefined;
        for (let i = 0; i < 5; i++) {
          if (url.protocol !== "https:" || !(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) || url.port || url.username || url.password) throw slackAuthRequired();
          const response = await this.fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { cookie: `d=${c.session_cookie}` } });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel(); const location = response.headers.get("location");
            if (!location) throw slackAuthRequired(); url = new URL(location, url); continue;
          }
          if (!response.ok || !response.body) throw slackAuthRequired();
          const html = await readBounded(response.body, 4_000_000);
          token = html.match(/"api_token"\s*:\s*"(xoxc-[a-zA-Z0-9-]+)"/)?.[1]; break;
        }
        if (!token) throw slackAuthRequired();
        next.bot_token = token;
        const checked = await this.identity(next);
        if (checked.team !== identity.team || checked.user !== identity.user) throw slackAuthRequired();
        row.token = token; row.inboxd_identity = { ...checked, fingerprint: fingerprint(next) };
        delete row.inboxd_refresh_failure; savePrivate(this.path, document); return next;
      } catch {
        row.inboxd_refresh_failure = fingerprint(c); savePrivate(this.path, document); throw slackAuthRequired();
      }
    } catch { throw slackAuthRequired(); }
    finally { release(); }
  }
}
