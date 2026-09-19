import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import QRCode from "qrcode";
import * as tdl from "tdl";

import { packagedTdlibRuntime } from "./worker-entrypoint.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type RecordValue = Record<string, unknown>;

interface BootstrapClient {
  on(event: "error" | "update", listener: (value: unknown) => void): unknown;
  invoke(request: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface TelegramBootstrapDependencies {
  readonly packagedRuntime: typeof packagedTdlibRuntime;
  readonly configureTdlib: (options: { tdjson: string; verbosityLevel: number }) => void;
  readonly createClient: (options: Record<string, unknown>) => BootstrapClient;
  readonly toDataUrl: (text: string) => Promise<string>;
  readonly prompt: (prompt: string, hidden: boolean) => string;
  readonly writeStatus: (status: string) => void;
}

const ENV = Object.freeze({
  apiId: "INBOXD_TELEGRAM_API_ID",
  apiHash: "INBOXD_TELEGRAM_API_HASH",
  databaseDirectory: "INBOXD_TELEGRAM_DATABASE_DIRECTORY",
  filesDirectory: "INBOXD_TELEGRAM_FILES_DIRECTORY",
  qrHtml: "INBOXD_TELEGRAM_QR_HTML",
  result: "INBOXD_TELEGRAM_BOOTSTRAP_RESULT",
});

function fail(message: string): never {
  throw new Error(`Telegram bootstrap failed: ${message}`);
}

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail("invalid configuration");
  return value;
}

function canonicalAbsolutePath(environment: Environment, name: string): string {
  const value = required(environment, name);
  if (!isAbsolute(value) || resolve(value) !== value) fail("invalid configuration");
  return value;
}

function hasUnsafeMacAcl(path: string): boolean {
  if (process.platform !== "darwin") return true;
  const inspected = spawnSync("/bin/ls", ["-lde", path], {
    encoding: "utf8",
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    shell: false,
  });
  if (inspected.status !== 0 || inspected.error !== undefined) return true;
  const entries = inspected.stdout.split("\n").slice(1).filter(line => /^\s*\d+:/.test(line));
  return entries.some(line => !/^\s*\d+:\s+.*\sdeny(?:\s|$)/.test(line));
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o700 || hasUnsafeMacAcl(path)) {
    fail("state directory is not owner-only");
  }
}

function assertTrustedAncestor(path: string): void {
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== uid)
    || (stat.mode & 0o022) !== 0 || hasUnsafeMacAcl(path)) {
    fail("bootstrap ancestor is not trusted");
  }
}

function assertTrustedHomeChain(home: string): void {
  const nodes: string[] = [];
  for (let current = home; ; current = dirname(current)) {
    nodes.push(current);
    if (dirname(current) === current) break;
  }
  for (const node of nodes.reverse()) assertTrustedAncestor(node);
}

function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o600 || hasUnsafeMacAcl(path)) {
    fail("bootstrap output is not owner-only");
  }
}

function assertPrivateDirectoryTree(root: string, leaf: string): void {
  const traversal = relative(root, leaf);
  if (traversal === "" || traversal.startsWith("..") || isAbsolute(traversal)) fail("state path is outside the private root");
  const nodes: string[] = [];
  for (let current = leaf; current !== root; current = dirname(current)) {
    if (dirname(current) === current) fail("state path is outside the private root");
    nodes.push(current);
  }
  nodes.push(root);
  for (const node of nodes.reverse()) assertPrivateDirectory(node);
}

function removePrivateOutput(path: string): void {
  if (!existsSync(path)) return;
  assertPrivateFile(path);
  rmSync(path);
}

function atomicPrivateWrite(path: string, contents: string): void {
  assertPrivateDirectory(dirname(path));
  if (existsSync(path)) assertPrivateFile(path);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function nativePrompt(prompt: string, hidden: boolean): string {
  const script = hidden
    ? `text returned of (display dialog ${JSON.stringify(prompt)} default answer "" with hidden answer buttons {"Cancel", "Continue"} default button "Continue")`
    : `text returned of (display dialog ${JSON.stringify(prompt)} default answer "" buttons {"Cancel", "Continue"} default button "Continue")`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    shell: false,
  });
  if (result.status !== 0 || result.error !== undefined) fail("authentication input was cancelled");
  const value = result.stdout.trim();
  if (value.length === 0 || value.includes("\0")) fail("authentication input was empty");
  return value;
}

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("TDLib returned malformed data");
  return value as RecordValue;
}

const defaultDependencies: TelegramBootstrapDependencies = {
  packagedRuntime: packagedTdlibRuntime,
  configureTdlib: options => tdl.configure(options),
  createClient: options => tdl.createClient(options as Parameters<typeof tdl.createClient>[0]) as unknown as BootstrapClient,
  toDataUrl: text => QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 3, width: 420 }),
  prompt: nativePrompt,
  writeStatus: status => process.stdout.write(status),
};

export async function runTelegramBootstrap(
  environment: Environment,
  dependencies: TelegramBootstrapDependencies = defaultDependencies,
): Promise<void> {
  const apiIdRaw = required(environment, ENV.apiId);
  const apiHash = required(environment, ENV.apiHash);
  if (!/^[1-9]\d*$/.test(apiIdRaw) || BigInt(apiIdRaw) > 2_147_483_647n || !/^[0-9a-f]{32}$/.test(apiHash)) {
    fail("invalid configuration");
  }
  const databaseDirectory = canonicalAbsolutePath(environment, ENV.databaseDirectory);
  const filesDirectory = canonicalAbsolutePath(environment, ENV.filesDirectory);
  const qrHtml = canonicalAbsolutePath(environment, ENV.qrHtml);
  const resultPath = canonicalAbsolutePath(environment, ENV.result);
  const home = canonicalAbsolutePath(environment, "HOME");
  const privateRoot = resolve(home, ".inboxd");
  assertTrustedHomeChain(home);
  if (dirname(qrHtml) !== privateRoot || dirname(resultPath) !== privateRoot || qrHtml === resultPath) {
    fail("bootstrap outputs must be distinct direct children of the private root");
  }
  if (basename(databaseDirectory) !== "database" || basename(filesDirectory) !== "files"
    || dirname(databaseDirectory) !== dirname(filesDirectory)) {
    fail("Telegram state paths are invalid");
  }
  assertPrivateDirectoryTree(privateRoot, databaseDirectory);
  assertPrivateDirectoryTree(privateRoot, filesDirectory);
  assertPrivateDirectory(privateRoot);
  removePrivateOutput(qrHtml);
  removePrivateOutput(resultPath);

  try {
  const runtime = dependencies.packagedRuntime();
  if (runtime === undefined) fail("packaged TDLib runtime validation failed");
  dependencies.configureTdlib({ tdjson: runtime.tdjsonPath, verbosityLevel: 1 });
  const client = dependencies.createClient({
    apiId: Number(apiIdRaw),
    apiHash,
    databaseDirectory,
    filesDirectory,
    tdlibParameters: {
      use_message_database: true,
      use_secret_chats: false,
      system_language_code: "ko",
      application_version: "1.0",
      device_model: "inboxd",
      system_version: process.platform,
    },
  });
  client.on("error", () => {});

  let settled = false;
  let chain = Promise.resolve();
  let previousAuthorizationState: unknown;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });

  const handleState = async (stateValue: unknown): Promise<void> => {
    if (settled) return;
    const state = record(stateValue);
    if (state._ === "authorizationStateWaitPhoneNumber"
      && previousAuthorizationState === "authorizationStateWaitPhoneNumber") return;
    previousAuthorizationState = state._;
    switch (state._) {
      case "authorizationStateReady":
        settled = true;
        resolveReady();
        return;
      case "authorizationStateWaitPhoneNumber":
        await client.invoke({ _: "requestQrCodeAuthentication", other_user_ids: [] });
        return;
      case "authorizationStateWaitOtherDeviceConfirmation": {
        if (typeof state.link !== "string" || !state.link.startsWith("tg://login?token=")) fail("invalid QR login link");
        const image = await dependencies.toDataUrl(state.link);
        atomicPrivateWrite(qrHtml, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>inboxd Telegram login</title><style>body{font-family:system-ui;text-align:center;padding:32px;background:#fff;color:#111}img{width:min(72vw,420px);height:auto}</style><h1>inboxd Telegram 연결</h1><p>Telegram 앱 → 설정 → 기기 → 데스크톱 기기 연결</p><img alt="Telegram login QR" src="${image}"><p>스캔 후 이 탭을 닫아도 됩니다.</p>`);
        dependencies.writeStatus("QR_READY\n");
        return;
      }
      case "authorizationStateWaitPassword":
        await client.invoke({ _: "checkAuthenticationPassword", password: dependencies.prompt("Telegram 2단계 인증 비밀번호를 입력하세요.", true) });
        return;
      case "authorizationStateWaitCode":
        await client.invoke({ _: "checkAuthenticationCode", code: dependencies.prompt("Telegram 로그인 코드를 입력하세요.", false) });
        return;
      case "authorizationStateWaitEmailAddress":
        await client.invoke({ _: "setAuthenticationEmailAddress", email_address: dependencies.prompt("Telegram 인증 이메일 주소를 입력하세요.", false) });
        return;
      case "authorizationStateWaitEmailCode":
        await client.invoke({ _: "checkAuthenticationEmailCode", code: { _: "emailAddressAuthenticationCode", code: dependencies.prompt("Telegram 이메일 인증 코드를 입력하세요.", false) } });
        return;
      case "authorizationStateWaitRegistration":
        fail("account registration is outside the approved scope");
      case "authorizationStateClosing":
      case "authorizationStateClosed":
        fail("TDLib closed before authentication completed");
    }
  };

  client.on("update", (update: unknown) => {
    const candidate = update as { _?: unknown; authorization_state?: unknown };
    if (candidate?._ !== "updateAuthorizationState") return;
    chain = chain.then(() => handleState(candidate.authorization_state)).catch((error) => {
      if (!settled) {
        settled = true;
        rejectReady(error);
      }
    });
  });

  try {
    await handleState(await client.invoke({ _: "getAuthorizationState" }));
    await ready;
    const me = record(await client.invoke({ _: "getMe" }));
    const id = typeof me.id === "number" && Number.isSafeInteger(me.id) ? String(me.id) : String(me.id ?? "");
    if (!/^[1-9]\d*$/.test(id)) fail("self identity is invalid");
    const chat = record(await client.invoke({ _: "createPrivateChat", user_id: Number(id), force: false }));
    const chatId = typeof chat.id === "number" && Number.isSafeInteger(chat.id) ? String(chat.id) : String(chat.id ?? "");
    if (!/^-?(?:0|[1-9]\d*)$/.test(chatId) || chatId === "0") fail("self chat identity is invalid");
    const history = record(await client.invoke({
      _: "getChatHistory",
      chat_id: Number(chatId),
      from_message_id: 0,
      offset: 0,
      limit: 1,
      only_local: false,
    }));
    const messages = Array.isArray(history.messages) ? history.messages : [];
    atomicPrivateWrite(resultPath, `${JSON.stringify({
      schema_version: "inboxd-telegram-bootstrap/v1",
      self_user_id: id,
      self_chat_id: chatId,
      first_name: typeof me.first_name === "string" ? me.first_name : "",
      last_name: typeof me.last_name === "string" ? me.last_name : "",
      chat_title: typeof chat.title === "string" ? chat.title : "",
      unread_count: Number.isInteger(chat.unread_count) ? chat.unread_count : 0,
      history_read_count: messages.length,
    }, null, 2)}\n`);
    dependencies.writeStatus("AUTH_READY\n");
  } finally {
    await client.close();
  }
  } finally {
    removePrivateOutput(qrHtml);
  }
}

export async function main(environment: Environment = process.env): Promise<number> {
  try {
    await runTelegramBootstrap(environment);
    return 0;
  } catch {
    process.stderr.write("Telegram bootstrap terminated: failure\n");
    return 74;
  }
}

if (import.meta.main) process.exitCode = await main();