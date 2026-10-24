import { homedir } from "node:os";
import { join } from "node:path";
import { readPrivateJson } from "../private-config.ts";
import type { ConnectionUI, ProviderConfiguration } from "../contracts.ts";
import { readConnectionResponse } from "../response.ts";

type Workspace = { workspace_id: string; workspace_name: string; token: string; cookie: string };

export class SlackSessionError extends Error {}

function workspaceLabel(workspace: Workspace): string {
  return workspace.workspace_name.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 160);
}

export async function slackAccountCall(workspace: Workspace, method: "auth.test" | "conversations.open" | "conversations.info", payload: Record<string, unknown> = {}): Promise<Record<string, any>> {
  if (!workspace.token || !workspace.cookie || /[\r\n;]/.test(workspace.cookie)) throw new SlackSessionError("Slack 세션이 올바르지 않습니다. Slack 앱에서 다시 로그인하세요.");
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${workspace.token}`, cookie: `d=${workspace.cookie}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)])),
  });
  const result = await readConnectionResponse(response);
  if (response.ok && ["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "session_expired"].includes(result.error)) {
    throw new SlackSessionError("Slack 로그인 세션이 만료되었거나 해제되었습니다.");
  }
  if (!response.ok || result.ok !== true) throw new Error("Slack 요청에 실패했습니다. 네트워크 상태 또는 접근 권한을 확인한 뒤 다시 시도하세요.");
  return result;
}

interface SlackConnectionDependencies {
  readConfig?: () => Record<string, unknown>;
  readProviders?: () => readonly ProviderConfiguration[];
  call?: typeof slackAccountCall;
}

export async function connectSlackAccount(ui: ConnectionUI, extract: () => Promise<void>, dependencies: SlackConnectionDependencies = {}): Promise<ProviderConfiguration> {
  const path = join(homedir(), ".config", "agent-messenger", "slack-credentials.json");
  const readConfig = dependencies.readConfig ?? (() => readPrivateJson(path));
  const call = dependencies.call ?? slackAccountCall;
  const saved = (dependencies.readProviders?.() ?? []).filter(p => p.kind === "slack");
  let target: ProviderConfiguration | undefined;
  let refresh = false;
  if (saved.length) {
    const selected = await ui.choose("Slack 계정 연결", [
      ...saved.map((p, i) => ({ id: `saved:${i}`, label: `${String(p.team_id)} · ${String(p.user_id ?? p.account)} (저장된 계정)` })),
      { id: "add", label: "다른 Slack 계정 추가" },
    ]);
    if (selected !== "add") {
      target = saved.find((_, i) => selected === `saved:${i}`);
      if (!target) throw new Error("계정 선택을 취소했습니다.");
      const action = await ui.choose("저장된 Slack 계정", [{ id: "use", label: "저장된 세션 확인" }, { id: "reauth", label: "같은 계정으로 다시 로그인" }]);
      if (action !== "use" && action !== "reauth") throw new Error("계정 선택을 취소했습니다.");
      refresh = action === "reauth";
    } else refresh = true;
  }
  let imported = false;
  const importSessions = async () => {
    ui.report("연결할 Slack 계정으로 로그인되어 있다면 바로 세션을 가져오세요.");
    ui.report("추출기는 Slack 데스크톱 세션을 우선 사용하며, 없으면 지원되는 브라우저 프로필을 확인합니다.");
    ui.report("가져오는 세션의 워크스페이스와 사용자가 연결하려는 계정과 일치해야 합니다.");
    const action = await ui.choose("Slack 세션 가져오기", [
      { id: "continue", label: "이미 로그인했습니다 — 세션 가져오기" },
      { id: "login", label: "Slack 로그인 창 열기" },
    ]);
    if (action === "login") {
      ui.open("https://slack.com/signin");
      if (await ui.choose("Slack 로그인 완료 후 계속", [{ id: "continue", label: "로그인을 마쳤습니다 — 세션 가져오기" }]) !== "continue") throw new Error("계정 연결을 취소했습니다.");
    } else if (action !== "continue") throw new Error("계정 연결을 취소했습니다.");
    await extract();
    imported = true;
  };
  // Determine the selected identity before replacing its credentials, including legacy records.
  let expectedUser = typeof target?.user_id === "string" ? target.user_id : undefined;
  if (target && !expectedUser) {
    const match = typeof target.account === "string" ? /:user:([^:]+)$/.exec(target.account) : null;
    expectedUser = match?.[1];
    if (!expectedUser) {
      try {
        const identity = await call({ workspace_id: String(target.team_id), workspace_name: String(target.team_id), token: String(target.bot_token ?? ""), cookie: String(target.session_cookie ?? "") }, "auth.test");
        if (identity.team_id === target.team_id && typeof identity.user_id === "string") expectedUser = identity.user_id;
        else throw new Error("기존 Slack 계정의 사용자를 확인하지 못했습니다.");
      } catch (error) { if (!(error instanceof SlackSessionError)) throw error; }
    }
  }

  let workspace: Workspace | undefined;
  let auth: Record<string, any> | undefined;
  if (target && !refresh) {
    workspace = { workspace_id: String(target.team_id), workspace_name: String(target.team_id), token: String(target.bot_token ?? ""), cookie: String(target.session_cookie ?? "") };
    try { auth = await call(workspace, "auth.test"); }
    catch (error) { if (!(error instanceof SlackSessionError)) throw error; refresh = true; }
  }
  if (!auth) {
    let config: Record<string, unknown> = {};
    if (!refresh) { try { config = readConfig(); } catch { refresh = true; } }
    if (refresh || !Object.values(config.workspaces ?? {}).length) {
      await importSessions();
      config = readConfig();
    }
    const available: { workspace: Workspace; auth: Record<string, any> }[] = [];
    for (;;) {
      const candidates = Object.values(config.workspaces ?? {}) as Workspace[];
      let expired = 0;
      for (const candidate of candidates) {
        if (target && candidate.workspace_id !== target.team_id) continue;
        try {
          const identity = await call(candidate, "auth.test");
          if (identity.team_id !== candidate.workspace_id || !/^[A-Z0-9]{2,128}$/.test(identity.team_id) || typeof identity.user_id !== "string" || !/^[A-Z0-9]{2,128}$/.test(identity.user_id)) continue;
          if (target && !expectedUser) {
            const self = await call(candidate, "conversations.info", { channel: target.chat_id });
            if (self.channel?.id !== target.chat_id || self.channel?.user !== identity.user_id) continue;
            expectedUser = identity.user_id;
          }
          if (target && identity.user_id !== expectedUser) continue;
          available.push({ workspace: candidate, auth: identity });
        } catch (error) { if (!(error instanceof SlackSessionError)) throw error; expired++; }
      }
      if (!available.length && !target && !imported && candidates.length > 0 && expired === candidates.length) {
        await importSessions();
        config = readConfig();
        continue;
      }
      break;
    }
    if (!available.length) throw new Error(target ? "선택한 Slack 계정과 일치하는 세션이 없습니다. 같은 워크스페이스와 사용자로 로그인하세요." : "연결 가능한 Slack 세션이 없습니다. Slack 앱 또는 지원되는 브라우저에서 로그인한 뒤 다시 시도하세요.");
    const selected = available.length === 1 ? "0" : await ui.choose("연결할 Slack 계정", available.map((item, i) => ({ id: String(i), label: `${workspaceLabel(item.workspace)} · ${item.auth.user_id}` })));
    const chosen = available.find((_, i) => String(i) === selected);
    if (!chosen) throw new Error("계정 선택을 취소했습니다.");
    workspace = chosen.workspace;
    auth = chosen.auth;
  }
  if (!workspace || auth.team_id !== workspace.workspace_id || typeof auth.user_id !== "string" || !/^[A-Z0-9]{2,128}$/.test(auth.user_id) || !/^[A-Z0-9]{2,128}$/.test(auth.team_id) || (target && (auth.team_id !== target.team_id || auth.user_id !== expectedUser))) throw new Error("Slack 계정이 일치하지 않습니다.");
  const response = await call(workspace, "conversations.open", { users: auth.user_id });
  const chatId = response.channel?.id;
  if (typeof chatId !== "string" || !/^[CDG][A-Z0-9]+$/.test(chatId)) throw new Error("Slack 대화방 확인 실패.");
  const info = await call(workspace, "conversations.info", { channel: chatId });
  if (info.channel?.id !== chatId || info.channel?.user !== auth.user_id) throw new Error("Slack 대화 대상이 일치하지 않습니다.");
  let existing = target ?? saved.find(p => p.team_id === auth.team_id && (p.user_id === auth.user_id || p.account === `slack:team:${auth.team_id}:user:${auth.user_id}`));
  if (!existing) {
    for (const legacy of saved.filter(p => p.team_id === auth.team_id && !p.user_id && p.account === `slack:team:${auth.team_id}`)) {
      try {
        const old = await call(workspace, "conversations.info", { channel: legacy.chat_id });
        if (old.channel?.id === legacy.chat_id && old.channel?.user === auth.user_id) { existing = legacy; break; }
      } catch { /* An unverified legacy identity cannot be reused. */ }
    }
  }
  if (!target && existing) ui.report("이미 저장된 같은 Slack 계정입니다. 해당 계정의 세션을 갱신합니다.");
  ui.report("Slack 연결을 확인했습니다. 전체 대화 목록을 불러옵니다.");
  return { kind: "slack", binding_id: existing?.binding_id ?? `slack-${auth.team_id}-${auth.user_id}-${chatId}`, account: existing?.account ?? `slack:team:${auth.team_id}:user:${auth.user_id}`, chat_id: chatId, team_id: auth.team_id, user_id: auth.user_id, bot_token: workspace.token, session_cookie: workspace.cookie };
}
