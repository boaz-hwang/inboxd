import { homedir } from "node:os";
import { join } from "node:path";
import { readPrivateJson } from "../private-config.ts";
import type { ConnectionUI, ProviderConfiguration } from "../contracts.ts";
import { readConnectionResponse } from "../response.ts";

type Workspace = { workspace_id: string; workspace_name: string; token: string; cookie: string };

export async function slackAccountCall(workspace: Workspace, method: "auth.test" | "conversations.list" | "conversations.open" | "conversations.info", payload: Record<string, unknown> = {}): Promise<Record<string, any>> {
  if (!workspace.token || !workspace.cookie || /[\r\n;]/.test(workspace.cookie)) throw new Error("Slack 세션이 올바르지 않습니다. Slack 앱에서 다시 로그인하세요.");
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${workspace.token}`, cookie: `d=${workspace.cookie}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)])),
  });
  const result = await readConnectionResponse(response);
  if (!response.ok || result?.ok !== true) throw new Error("Slack 세션 확인 실패. Slack 앱 로그인 후 다시 연결하세요.");
  return result;
}

export async function connectSlackAccount(ui: ConnectionUI, extract: () => Promise<void>): Promise<ProviderConfiguration> {
  const path = join(homedir(), ".config", "agent-messenger", "slack-credentials.json");
  let config: Record<string, unknown>;
  try { config = readPrivateJson(path); } catch { await extract(); config = readPrivateJson(path); }
  let workspaces = Object.values(config.workspaces ?? {}) as Workspace[];
  if (workspaces.length === 0) { await extract(); config = readPrivateJson(path); workspaces = Object.values(config.workspaces ?? {}) as Workspace[]; }
  if (workspaces.length === 0) throw new Error("Slack 앱에서 워크스페이스에 로그인한 뒤 다시 연결하세요.");
  const id = await ui.choose("연결할 Slack 워크스페이스", workspaces.map(w => ({ id: w.workspace_id, label: w.workspace_name })));
  let workspace = workspaces.find(w => w.workspace_id === id);
  if (!workspace) throw new Error("워크스페이스 선택을 취소했습니다.");
  let auth;
  try { auth = await slackAccountCall(workspace, "auth.test"); }
  catch {
    ui.report("Slack 앱의 현재 로그인 상태를 다시 확인합니다.");
    await extract();
    const refreshed = readPrivateJson(path).workspaces as Record<string, Workspace> | undefined;
    workspace = refreshed?.[id];
    if (!workspace) throw new Error("선택한 워크스페이스에 Slack 앱으로 로그인한 뒤 다시 연결하세요.");
    auth = await slackAccountCall(workspace, "auth.test");
  }
  if (auth.team_id !== id || typeof auth.user_id !== "string") throw new Error("Slack 계정이 일치하지 않습니다.");
  const target = await ui.choose("연결 범위", [{ id: "self", label: "나와의 대화 (개인 테스트)" }, { id: "channel", label: "대화방 목록에서 선택" }]);
  let chatId: string;
  if (target === "self") {
    const response = await slackAccountCall(workspace, "conversations.open", { users: auth.user_id });
    chatId = response.channel?.id;
  } else if (target === "channel") {
    const channels: { id: string; label: string }[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const response = await slackAccountCall(workspace, "conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 100, cursor });
      for (const channel of response.channels ?? []) if (channel.is_member && typeof channel.name === "string") channels.push({ id: channel.id, label: `#${channel.name}` });
      cursor = response.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    if (!channels.length) throw new Error("참여 중인 대화방을 찾지 못했습니다.");
    chatId = await ui.choose("연결할 대화방", channels);
    if (!channels.some(c => c.id === chatId)) throw new Error("대화방 선택을 취소했습니다.");
  } else throw new Error("연결을 취소했습니다.");
  if (typeof chatId !== "string" || !/^[CDG][A-Z0-9]+$/.test(chatId)) throw new Error("Slack 대화방 확인 실패.");
  const info = await slackAccountCall(workspace, "conversations.info", { channel: chatId });
  if (info.channel?.id !== chatId || (target === "self" && info.channel?.user !== auth.user_id)) throw new Error("Slack 대화 대상이 일치하지 않습니다.");
  ui.report("Slack 계정과 선택한 대화방을 확인했습니다.");
  return { kind: "slack", binding_id: `slack-${id}-${chatId}`, account: `slack:team:${id}`, chat_id: chatId, team_id: id, bot_token: workspace.token, session_cookie: workspace.cookie };
}
