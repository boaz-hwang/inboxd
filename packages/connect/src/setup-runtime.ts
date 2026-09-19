import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { validatePackagedDaemonBinary } from "../../host/src/daemon-launcher.ts";
import { ensureFirstRunConfiguration, type FirstRunPaths } from "./setup.ts";
import { readPackagedTelegramApplication, telegramProviderFromBootstrap } from "./provider-setup.ts";
import { ConnectionRegistry, type ConnectionUI } from "./contracts.ts";
import { hiddenPrompt, safeEnvironment } from "./host.ts";
import { saveConnection } from "./private-config.ts";
import { runTelegramBootstrap } from "./drivers/telegram.ts";
import { connectSlackAccount } from "./drivers/slack.ts";
import { connectKakaoAccount } from "./drivers/kakao.ts";

function runAccountLogin(platform: "slack" | "kakaotalk"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("agent-messenger", platform === "slack" ? ["slack", "auth", "extract"] : ["kakaotalk", "auth", "login"], {
      shell: false, stdio: "inherit", env: safeEnvironment({}),
    });
    child.once("error", () => reject(new Error("agent-messenger 실행 파일을 찾지 못했습니다.")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("계정 연결을 완료하지 못했습니다.")));
  });
}

export function createConnectionRuntime(paths: FirstRunPaths, productDirectory: string) {
  const ui: ConnectionUI = {
    async choose(title, choices) {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try {
        process.stdout.write(`\n${title}\n${choices.map((c, i) => `  ${i + 1}. ${String(c.label).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 160)}`).join("\n")}\n  0. 취소\n`);
        for (;;) {
          const answer = (await input.question("선택: ")).trim();
          if (answer === "0") return "cancel";
          const choice = choices[Number(answer) - 1];
          if (/^[1-9]\d*$/.test(answer) && choice) return choice.id;
          process.stdout.write("목록의 번호를 선택하세요.\n");
        }
      } finally { input.close(); }
    },
    secret: async title => hiddenPrompt(title),
    report: message => process.stdout.write(`${message}\n`),
    open: url => { spawnSync("/usr/bin/open", [url], { shell: false, stdio: "ignore" }); },
  };
  const registry = new ConnectionRegistry([
    { id: "telegram", label: "Telegram — QR 로그인", async connect() {
      const credentials = readPackagedTelegramApplication(productDirectory);
      ui.report("Telegram QR 창을 준비합니다. 휴대폰 Telegram → 설정 → 기기에서 연결하세요.");
      return telegramProviderFromBootstrap(await runTelegramBootstrap(paths, productDirectory, credentials.apiId, credentials.apiHash), credentials);
    } },
    { id: "slack", label: "Slack — 로그인된 앱 연결", connect: () => connectSlackAccount(ui, () => runAccountLogin("slack")) },
    { id: "kakao", label: "KakaoTalk — 계정 / 휴대폰 인증", connect: () => connectKakaoAccount(ui, () => runAccountLogin("kakaotalk")) },
  ]);
  return { ui, registry };
}

export async function connectInstalledAccounts(paths: FirstRunPaths, productDirectory: string, provider?: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("계정 연결에는 대화형 터미널이 필요합니다.");
  const { ui, registry } = createConnectionRuntime(paths, productDirectory);
  let changed = false;
  for (;;) {
    const id = provider ?? await ui.choose("메신저 연결", registry.choices());
    if (id === "cancel") return changed;
    try {
      const config = await registry.connect(id);
      saveConnection(paths.config, config);
      changed = true;
      ui.report("연결을 저장했습니다.");
    } catch (error) {
      ui.report(error instanceof Error ? error.message : "연결하지 못했습니다.");
      if (provider) throw new Error("계정 연결을 완료하지 못했습니다.");
    }
    if (provider) return changed;
  }
}

export async function ensureInstalledConfiguration(paths: FirstRunPaths, productDirectory: string, connectOnFirstRun = true): Promise<void> {
  const existed = existsSync(paths.config);
  await ensureFirstRunConfiguration(paths, {
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    initializeKeychain: async () => {
      const daemon = join(productDirectory, "inboxd-daemon");
      validatePackagedDaemonBinary(daemon);
      const result = spawnSync(daemon, ["--init-keychain", "com.inboxd.database", "default"], { env: safeEnvironment({}), shell: false, stdio: "ignore" });
      if (result.status !== 0) throw new Error("SQLCipher Keychain 초기화 실패.");
    },
    selectProvider: async () => "finish",
    connectTelegram: async () => { throw new Error("use connection registry"); },
    connectSlack: async () => { throw new Error("use connection registry"); },
    report: message => process.stdout.write(`${message}\n`),
  });
  if (!existed && connectOnFirstRun) await connectInstalledAccounts(paths, productDirectory);
}
