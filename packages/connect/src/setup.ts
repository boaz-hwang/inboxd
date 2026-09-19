import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SetupProviderChoice = "telegram" | "slack" | "kakao" | "finish";
export type ProviderConfiguration = Readonly<Record<string, unknown>>;

export interface FirstRunPaths {
  readonly root: string;
  readonly state: string;
  readonly config: string;
  readonly database: string;
  readonly socket: string;
}

export interface FirstRunDependencies {
  readonly isInteractive: () => boolean;
  readonly initializeKeychain: () => Promise<void>;
  readonly selectProvider: () => Promise<SetupProviderChoice>;
  readonly connectTelegram: () => Promise<ProviderConfiguration>;
  readonly connectSlack: () => Promise<ProviderConfiguration>;
  readonly report: (message: string) => void;
}

function assertOwnerOnlyFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("existing inboxd config must be an owner-only regular file");
  }
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("inboxd setup directory must be owner-only");
  }
}

function atomicPrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export async function ensureFirstRunConfiguration(
  paths: FirstRunPaths,
  dependencies: FirstRunDependencies,
): Promise<void> {
  if (existsSync(paths.config)) {
    assertOwnerOnlyFile(paths.config);
    return;
  }
  if (!dependencies.isInteractive()) {
    throw new Error("first-run setup requires an interactive terminal");
  }
  privateDirectory(paths.root);
  privateDirectory(paths.state);
  if (dirname(paths.config) !== paths.root) throw new Error("config must be a direct child of the private inboxd root");

  await dependencies.initializeKeychain();
  const providers: ProviderConfiguration[] = [];
  const selected = new Set<Exclude<SetupProviderChoice, "finish">>();
  for (;;) {
    const choice = await dependencies.selectProvider();
    if (choice === "finish") break;
    if (choice === "kakao") {
      dependencies.report("KakaoTalk 연결은 local measurement evidence 또는 Kakao official consent/template 권한이 준비된 뒤 활성화할 수 있습니다.");
      continue;
    }
    if (selected.has(choice)) {
      dependencies.report(`${choice} 연결은 이미 추가되었습니다.`);
      continue;
    }
    providers.push(choice === "telegram"
      ? await dependencies.connectTelegram()
      : await dependencies.connectSlack());
    selected.add(choice);
  }

  atomicPrivateJson(paths.config, {
    version: 1,
    state_dir: paths.state,
    database_path: paths.database,
    socket_path: paths.socket,
    keychain: { service: "com.inboxd.database", account: "default" },
    providers,
  });
}
