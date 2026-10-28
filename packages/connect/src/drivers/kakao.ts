import { join } from "node:path";
import { homedir } from "node:os";
import { readPrivateJson } from "../private-config.ts";
import type { ConnectionUI, ProviderConfiguration } from "../contracts.ts";
import { personalSession, parsePersonalCredentials } from "../../../../contrib/kakao/src/personal-session.ts";

type ConnectionClient = Pick<Awaited<ReturnType<typeof personalSession>>, "getChats" | "getMessagePage" | "getCredentials">;

/** The self chat is only a legacy binding/read probe; account discovery loads every chat. */
export async function verifyKakaoConnection(client: ConnectionClient, id: string, ui: Pick<ConnectionUI, "report">): Promise<ProviderConfiguration> {
  const chats = await client.getChats({ all: true, resolveTitles: false });
  const self = chats.filter(c => c.type === "MemoChat");
  if (self.length !== 1) throw new Error("KakaoTalk의 나와의 채팅을 정확히 확인하지 못했습니다.");
  const chatId = self[0]!.chat_id;
  await client.getMessagePage(chatId, { count: 1 });
  ui.report("KakaoTalk 연결을 확인했습니다. 전체 대화 목록을 불러옵니다.");
  return { kind: "kakao_personal", binding_id: `kakao-personal-${id}-${chatId}`, account: `kakao:self:${id}`, chat_id: chatId, credentials: JSON.stringify(client.getCredentials()) };
}

export async function connectKakaoAccount(ui: ConnectionUI, login: () => Promise<void>, reauthenticated = false): Promise<ProviderConfiguration> {
  const path = join(homedir(), ".config", "agent-messenger", "kakaotalk-credentials.json");
  let config: Record<string, any>;
  try { config = readPrivateJson(path); } catch { await login(); config = readPrivateJson(path); }
  let accounts = Object.values(config.accounts ?? {}) as Record<string, any>[];
  if (!accounts.length) { await login(); config = readPrivateJson(path); accounts = Object.values(config.accounts ?? {}); }
  if (!accounts.length) throw new Error("KakaoTalk 로그인을 완료하지 못했습니다.");
  const id = accounts.length === 1 ? accounts[0]!.account_id : await ui.choose("KakaoTalk 계정", accounts.map((a, i) => ({ id: a.account_id, label: `계정 ${i + 1} (${a.device_type})` })));
  const account = accounts.find(a => a.account_id === id);
  if (!account) throw new Error("계정 선택을 취소했습니다.");
  const credentials = parsePersonalCredentials({ oauthToken: account.oauth_token, userId: account.user_id, deviceUuid: account.device_uuid, deviceType: account.device_type });
  const client = await personalSession(credentials);
  try {
    return await verifyKakaoConnection(client, id, ui);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "invalid_access_token" || error.code === "kakao_auth_recovering") && !reauthenticated) {
      client.close();
      ui.report("KakaoTalk 세션이 만료되어 휴대폰 인증을 시작합니다.");
      await login();
      return connectKakaoAccount(ui, login, true);
    }
    throw new Error("KakaoTalk 연결 확인 실패. 휴대폰 인증 후 다시 연결하세요.");
  } finally { client.close(); }
}
