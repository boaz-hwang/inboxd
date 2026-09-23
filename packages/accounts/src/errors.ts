export const SLACK_AUTH_EXPIRED = "Slack 인증이 만료되었습니다. inboxd connect slack으로 다시 연결하세요.";
export const TELEGRAM_AUTH_EXPIRED = "Telegram 세션이 해제되었습니다. inboxd connect telegram으로 다시 연결하세요.";
export const AUTH_ERROR_CODES = new Set(["invalid_access_token", "slack_auth_required", "telegram_auth_required"]);

export const KAKAO_AUTH_EXPIRED = "KakaoTalk 인증이 만료되었습니다. inboxd connect kakao로 다시 연결하세요.";

/** Only known error codes cross IPC; provider messages may contain secrets. */
export function accountErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error && error.code === "invalid_access_token") return KAKAO_AUTH_EXPIRED;
  if (error !== null && typeof error === "object" && "code" in error) {
    if (error.code === "slack_auth_required") return SLACK_AUTH_EXPIRED;
    if (error.code === "telegram_auth_required") return TELEGRAM_AUTH_EXPIRED;
  }
  return "메신저 요청 실패. 연결 상태나 요청 제한을 확인하세요.";
}
