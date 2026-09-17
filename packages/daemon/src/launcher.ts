import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { SqlCipherKeyProvider } from "../../store/src/index.ts";
import { MacOSKeychainKeyProvider } from "../../store/src/index.ts";
import { createDaemon } from "./main.ts";
import type { CursorSlackReadAdapterOptions } from "../../../platforms/slack/src/index.ts";
import type { KakaoReadAdapterOptions } from "../../../contrib/kakao/src/index.ts";

export interface ReaderConfig {
  readonly binding: string;
  readonly allowed_chats: readonly { readonly account: string; readonly chat_id: string }[];
}
export interface DaemonReaderBindings {
  readonly slack?: Readonly<Record<string, () => Pick<CursorSlackReadAdapterOptions, "authenticatedRunner">>>;
  readonly kakao?: Readonly<Record<string, () => Pick<KakaoReadAdapterOptions, "reader" | "measurement">>>;
}
export interface LaunchDaemonOptions {
  readonly keyProvider?: SqlCipherKeyProvider;
  readonly readerBindings?: DaemonReaderBindings;
  readonly now?: () => number;
}

export interface DaemonConfig {
  readonly version: 1;
  readonly state_dir: string;
  readonly database_path: string;
  readonly socket_path: string;
  readonly keychain: { readonly service: string; readonly account: string };
  readonly readers?: {
    readonly slack?: ReaderConfig;
    readonly kakao?: ReaderConfig & { readonly max_measurement_age: number };
  };
}

export interface LaunchedDaemon {
  readonly socketPath: string;
  stop(): Promise<void>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function parseReaders(value: unknown): NonNullable<DaemonConfig["readers"]> {
  const readers = object(value, "readers");
  if (Object.keys(readers).length === 0 || Object.keys(readers).some((key) => key !== "slack" && key !== "kakao")) throw new Error("readers must name Slack or Kakao bindings only");
  const result: { slack?: ReaderConfig; kakao?: ReaderConfig & { max_measurement_age: number } } = {};
  for (const platform of ["slack", "kakao"] as const) {
    if (!(platform in readers)) continue;
    const reader = object(readers[platform], "reader");
    exactKeys(reader, ["binding", "allowed_chats", ...(platform === "kakao" ? ["max_measurement_age"] : [])], "reader");
    const binding = text(reader.binding, "reader binding");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(binding)) throw new Error("invalid reader binding identifier");
    if (!Array.isArray(reader.allowed_chats) || reader.allowed_chats.length < 1 || reader.allowed_chats.length > 100) throw new Error("reader allowlist must contain 1..100 chats");
    const allowed_chats = reader.allowed_chats.map((value) => {
      const chat = object(value, "allowed chat");
      exactKeys(chat, ["account", "chat_id"], "allowed chat");
      const account = text(chat.account, "account");
      const chat_id = text(chat.chat_id, "chat_id");
      if (![account, chat_id].every((id) => /^stable:[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error("reader requires stable account/chat identifiers");
      return { account, chat_id };
    });
    if (new Set(allowed_chats.map((chat) => JSON.stringify(chat))).size !== allowed_chats.length) throw new Error("reader allowlist contains duplicates");
    if (platform === "slack") result.slack = { binding, allowed_chats };
    else {
      if (typeof reader.max_measurement_age !== "number" || !Number.isFinite(reader.max_measurement_age) || reader.max_measurement_age < 0) throw new Error("invalid Kakao measurement age");
      result.kakao = { binding, allowed_chats, max_measurement_age: reader.max_measurement_age };
    }
  }
  return result;
}

export function parseDaemonConfig(value: unknown): DaemonConfig {
  const config = object(value, "daemon config");
  exactKeys(config, ["version", "state_dir", "database_path", "socket_path", "keychain", ...(config.readers === undefined ? [] : ["readers"])], "daemon config");
  if (config.version !== 1) throw new Error("daemon config version must be 1");
  const stateDir = text(config.state_dir, "state_dir");
  const databasePath = text(config.database_path, "database_path");
  const socketPath = text(config.socket_path, "socket_path");
  if (![stateDir, databasePath, socketPath].every(isAbsolute)) throw new Error("daemon paths must be absolute");
  const canonicalStateDir = resolve(stateDir);
  if (resolve(dirname(databasePath)) !== canonicalStateDir || resolve(dirname(socketPath)) !== canonicalStateDir) {
    throw new Error("database_path and socket_path must be direct children of state_dir");
  }
  const keychain = object(config.keychain, "keychain");
  exactKeys(keychain, ["service", "account"], "keychain");
  return {
    version: 1,
    ...(config.readers === undefined ? {} : { readers: parseReaders(config.readers) }),
    state_dir: canonicalStateDir,
    database_path: resolve(databasePath),
    socket_path: resolve(socketPath),
    keychain: { service: text(keychain.service, "keychain.service"), account: text(keychain.account, "keychain.account") },
  };
}

export function loadDaemonConfig(path: string): DaemonConfig {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("daemon config must be an owner-only regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("daemon config must be owner-only");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("daemon config must be owned by the current user");
  if (realpathSync(path) !== resolve(path)) throw new Error("daemon config must not traverse a symlink");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("daemon config must contain valid JSON"); }
  return parseDaemonConfig(parsed);
}

export async function launchDaemon(
  config: DaemonConfig,
  options: LaunchDaemonOptions = {},
): Promise<LaunchedDaemon> {
  const validated = parseDaemonConfig(config);
  const now = options.now ?? (() => Date.now() / 1_000);
  const slack = validated.readers?.slack;
  const kakao = validated.readers?.kakao;
  for (const [reader, registry] of [[slack, options.readerBindings?.slack], [kakao, options.readerBindings?.kakao]] as const) {
    if (reader && (!registry || !Object.hasOwn(registry, reader.binding) || typeof registry[reader.binding] !== "function")) throw new Error("configured reader binding is unavailable");
  }
  function binding<T>(registry: Readonly<Record<string, () => T>> | undefined, name: string): T {
    if (!registry || !Object.hasOwn(registry, name) || typeof registry[name] !== "function") throw new Error("configured reader binding is unavailable");
    try { return registry[name]!(); } catch { throw new Error("configured reader binding failed"); }
  }
  const slackTransport = slack ? binding(options.readerBindings?.slack, slack.binding) : undefined;
  const kakaoTransport = kakao ? binding(options.readerBindings?.kakao, kakao.binding) : undefined;
  if (slack && typeof slackTransport?.authenticatedRunner !== "function") throw new Error("invalid Slack reader binding");
  if (kakao && (typeof kakaoTransport?.reader !== "function" || !kakaoTransport.measurement)) throw new Error("invalid Kakao reader binding");
  const keyProvider = options.keyProvider ?? new MacOSKeychainKeyProvider(validated.keychain.service, validated.keychain.account);
  const daemon = await createDaemon({
    databasePath: validated.database_path,
    socketPath: validated.socket_path,
    keyProvider,
    ...(slack && slackTransport ? { localSlack: { allowedChats: slack.allowed_chats, now, authenticatedRunner: slackTransport.authenticatedRunner } } : {}),
    ...(kakao && kakaoTransport ? { localKakao: { allowedChats: kakao.allowed_chats, now, reader: kakaoTransport.reader, measurement: kakaoTransport.measurement, max_measurement_age: kakao.max_measurement_age } } : {}),
  });
  return { socketPath: validated.socket_path, stop: () => daemon.stop() };
}

export async function runDaemonMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  if (configPath === undefined) throw new Error("usage: inboxd-daemon --config <owner-only-config.json>");
  const launched = await launchDaemon(loadDaemonConfig(configPath));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await launched.stop();
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await new Promise<void>((resolvePromise) => {
    const timer = setInterval(() => { if (stopping) { clearInterval(timer); resolvePromise(); } }, 25);
  });
}
