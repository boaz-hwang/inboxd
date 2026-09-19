import { spawnSync } from "node:child_process";

const SAFE_ENV_KEYS = ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL"] as const;
export function safeEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

export function hiddenPrompt(message: string): string {
  const script = `text returned of (display dialog ${JSON.stringify(message)} default answer "" with hidden answer buttons {"Cancel", "Continue"} default button "Continue")`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, shell: false,
  });
  if (result.status !== 0 || result.error !== undefined) throw new Error("인증 입력을 취소했습니다.");
  const value = result.stdout.trim();
  if (value.length === 0 || value.includes("\0")) throw new Error("인증 입력이 비어 있습니다.");
  return value;
}
