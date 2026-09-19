import { KakaoTalkClient } from "agent-messenger/kakaotalk";

export interface PersonalCredentials { oauthToken: string; userId: string; deviceUuid: string; deviceType: "tablet" | "pc" }
export function parsePersonalCredentials(value: unknown): PersonalCredentials {
  if (!value || typeof value !== "object") throw new Error("invalid Kakao account session");
  const c = value as PersonalCredentials;
  if (typeof c.userId !== "string" || !/^[1-9]\d*$/.test(c.userId)
    || typeof c.oauthToken !== "string" || !c.oauthToken || c.oauthToken.length > 8192 || /[\x00-\x20\x7f]/.test(c.oauthToken)
    || typeof c.deviceUuid !== "string" || !c.deviceUuid || c.deviceUuid.length > 256
    || (c.deviceType !== "tablet" && c.deviceType !== "pc")) throw new Error("invalid Kakao account session");
  return { oauthToken: c.oauthToken, userId: c.userId, deviceUuid: c.deviceUuid, deviceType: c.deviceType };
}
export async function personalSession(credentials: PersonalCredentials): Promise<KakaoTalkClient> {
  return new KakaoTalkClient().login(parsePersonalCredentials(credentials));
}
