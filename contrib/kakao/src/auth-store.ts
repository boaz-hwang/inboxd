import { readPrivate, savePrivate, acquireLock } from "../../../packages/host/src/credential-file.ts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { refreshKakaoOAuthToken } from "agent-messenger/kakaotalk";
import { parsePersonalCredentials, type PersonalCredentials } from "./credentials.ts";

type Account = Record<string, unknown>;
type Refresh = typeof refreshKakaoOAuthToken;
export function authExpired(): Error { return Object.assign(new Error("KakaoTalk authentication requires reconnection"), { code: "invalid_access_token" }); }
export function authRecovering(): Error { return Object.assign(new Error("KakaoTalk authentication recovery is waiting to retry"), { code: "kakao_auth_recovering" }); }
const failureCodes = new Set(["refresh_credentials_missing", "refresh_http_error", "refresh_malformed_response", "refresh_rejected", "refresh_request_failed", "refresh_timeout", "refreshed_token_rejected"]);
function recordFailure(account: Account, fingerprint: string, error: unknown, now: number): void {
  const e = error as { code?: string; httpStatus?: number; serverStatus?: number } | undefined;
  const previous = account.inboxd_refresh_failure as { fingerprint?: string; attempts?: number } | undefined;
  const attempts = previous?.fingerprint === fingerprint ? Math.min(10, (previous.attempts ?? 0) + 1) : 1;
  const code = e?.code && failureCodes.has(e.code) ? e.code : "refresh_request_failed";
  // Even provider rejections can be temporary. Persist a bounded cooldown rather
  // than permanently disabling recovery for these credentials.
  const base = code === "refresh_rejected" || code === "refreshed_token_rejected" ? 15 * 60_000 : 60_000;
  account.inboxd_refresh_failure = {
    fingerprint, attempts, code, failedAt: now,
    retryAt: now + Math.min(60 * 60_000, base * 2 ** (attempts - 1)),
    ...(Number.isInteger(e?.httpStatus) ? { httpStatus: e!.httpStatus } : {}),
    ...(Number.isInteger(e?.serverStatus) ? { serverStatus: e!.serverStatus } : {}),
  };
}
export function isAuthExpired(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "invalid_access_token";
}
function findAccount(document: Record<string, any>, identity: PersonalCredentials): Account | undefined {
  const matches = Object.values(document.accounts ?? {}).filter((a: any) => a && String(a.user_id) === identity.userId && a.device_uuid === identity.deviceUuid && a.device_type === identity.deviceType);
  if (matches.length > 1) throw new Error("Ambiguous Kakao credentials");
  return matches[0] as Account | undefined;
}
function credentials(account: Account, identity: PersonalCredentials): PersonalCredentials {
  return parsePersonalCredentials({ ...identity, oauthToken: account.oauth_token });
}

/** The SDK credential file is canonical. All inboxd workers use it, including
 * workers started with an older token from daemon configuration. */
export class KakaoAuthStore {
  constructor(readonly path = join(homedir(), ".config", "agent-messenger", "kakaotalk-credentials.json"), private refresh: Refresh = refreshKakaoOAuthToken, private now: () => number = Date.now) {}
  current(identity: PersonalCredentials): PersonalCredentials {
    try {
      const account = findAccount(readPrivate(this.path), identity);
      return account ? credentials(account, identity) : identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return identity;
      throw error;
    }
  }
  async reject(failed: PersonalCredentials): Promise<void> {
    const release = await acquireLock(`${this.path}.inboxd-refresh-lock`);
    try {
      const document = readPrivate(this.path), account = findAccount(document, failed);
      if (account?.oauth_token === failed.oauthToken && typeof account.refresh_token === "string") {
        recordFailure(account, createHash("sha256").update(`${failed.oauthToken}\0${account.refresh_token}`).digest("hex"), { code: "refreshed_token_rejected" }, this.now());
        savePrivate(this.path, document);
      }
    } finally { release(); }
  }
  async recover(failed: PersonalCredentials): Promise<PersonalCredentials> {
    // File-wide lock also prevents different accounts from overwriting each
    // other's rotated tokens. Re-read after acquiring it to coalesce processes.
    const lock = `${this.path}.inboxd-refresh-lock`;
    const release = await acquireLock(lock).catch(() => { throw authExpired(); });
    try {
      const document = readPrivate(this.path);
      const account = findAccount(document, failed);
      if (!account) throw authExpired();
      const latest = credentials(account, failed);
      if (latest.oauthToken !== failed.oauthToken) return latest;
      if (typeof account.refresh_token !== "string" || !account.refresh_token) throw authExpired();
      const fingerprint = createHash("sha256").update(`${latest.oauthToken}\0${account.refresh_token}`).digest("hex");
      const status = account.inboxd_refresh_failure as { fingerprint?: string; retryAt?: number } | undefined;
      // Old releases wrote permanent latches without retryAt. Allow one fresh
      // attempt to migrate those records into the bounded retry policy.
      if (status?.fingerprint === fingerprint && typeof status.retryAt === "number" && status.retryAt > this.now()) throw authRecovering();
      try {
        const result = await this.refresh({ accessToken: latest.oauthToken, refreshToken: account.refresh_token, deviceUuid: latest.deviceUuid });
        const next = parsePersonalCredentials({ ...latest, oauthToken: result.accessToken });
        account.oauth_token = next.oauthToken;
        account.refresh_token = result.refreshToken;
        delete account.inboxd_refresh_failure;
        // Persist rotation before exposing the token to any connection.
        savePrivate(this.path, document);
        return next;
      } catch (error) {
        recordFailure(account, fingerprint, error, this.now());
        savePrivate(this.path, document);
        throw authRecovering();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw authExpired();
      throw error;
    } finally { release(); }
  }
}

