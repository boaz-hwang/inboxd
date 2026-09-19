import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, expect, test } from "bun:test";

import { runTelegramBootstrap, type TelegramBootstrapDependencies } from "../src/bootstrap.ts";

const fixtureRoot = mkdtempSync(join(process.env.HOME!, ".inboxd-bootstrap-tests-"));
chmodSync(fixtureRoot, 0o700);
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function privateTree(): {
  home: string;
  environment: Record<string, string>;
  qr: string;
  result: string;
} {
  const home = join(fixtureRoot, crypto.randomUUID());
  const root = join(home, ".inboxd");
  const database = join(root, "state", "telegram", "binding-hash", "database");
  const files = join(root, "state", "telegram", "binding-hash", "files");
  for (const path of [home, root, join(root, "state"), join(root, "state", "telegram"), join(root, "state", "telegram", "binding-hash"), database, files]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const qr = join(root, "telegram-login.html");
  const result = join(root, "telegram-bootstrap-result.json");
  return {
    home,
    qr,
    result,
    environment: {
      HOME: home,
      INBOXD_TELEGRAM_API_ID: "12345",
      INBOXD_TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
      INBOXD_TELEGRAM_DATABASE_DIRECTORY: database,
      INBOXD_TELEGRAM_FILES_DIRECTORY: files,
      INBOXD_TELEGRAM_QR_HTML: qr,
      INBOXD_TELEGRAM_BOOTSTRAP_RESULT: result,
    },
  };
}

class FakeClient extends EventEmitter {
  readonly calls: string[] = [];
  constructor(private readonly terminal: "ready" | "closed") { super(); }

  async invoke(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const operation = String(request._);
    this.calls.push(operation);
    if (operation === "getAuthorizationState") return { _: "authorizationStateWaitPhoneNumber" };
    if (operation === "requestQrCodeAuthentication") {
      queueMicrotask(() => {
        this.emit("update", { _: "updateAuthorizationState", authorization_state: { _: "authorizationStateWaitOtherDeviceConfirmation", link: "tg://login?token=rotating-secret" } });
        queueMicrotask(() => {
          this.emit("update", { _: "updateAuthorizationState", authorization_state: { _: "authorizationStateWaitOtherDeviceConfirmation", link: "tg://login?token=rotated-secret" } });
          queueMicrotask(() => this.emit("update", { _: "updateAuthorizationState", authorization_state: { _: this.terminal === "ready" ? "authorizationStateReady" : "authorizationStateClosed" } }));
        });
      });
      return { _: "ok" };
    }
    if (operation === "getMe") return { id: 7, first_name: "Self", last_name: "" };
    if (operation === "createPrivateChat") return { id: 7, title: "Self", unread_count: 0 };
    if (operation === "getChatHistory") return { messages: [] };
    throw new Error(`unexpected operation ${operation}`);
  }

  async close(): Promise<void> {}
}

function dependencies(client: FakeClient, created: { count: number }): TelegramBootstrapDependencies {
  return {
    packagedRuntime: () => ({ tdjsonPath: "/trusted/libtdjson.dylib" }),
    configureTdlib: () => {},
    createClient: () => { created.count++; return client; },
    toDataUrl: async () => "data:image/png;base64,fixture",
    prompt: () => { throw new Error("prompt not expected"); },
    writeStatus: () => {},
  };
}

test("removes stale outputs before TDLib and deletes the rotating QR after successful authentication", async () => {
  const fixture = privateTree();
  writeFileSync(fixture.qr, "stale-token", { mode: 0o600 });
  writeFileSync(fixture.result, "stale-result", { mode: 0o600 });
  const created = { count: 0 };
  const statuses: string[] = [];
  await runTelegramBootstrap(fixture.environment, {
    ...dependencies(new FakeClient("ready"), created),
    writeStatus: status => statuses.push(status),
  });
  expect(created.count).toBe(1);
  expect(existsSync(fixture.qr)).toBe(false);
  expect(statuses).toEqual(["QR_READY\n", "QR_READY\n", "AUTH_READY\n"]);
  expect(JSON.parse(await Bun.file(fixture.result).text())).toEqual(expect.objectContaining({
    schema_version: "inboxd-telegram-bootstrap/v1",
    self_user_id: "7",
    self_chat_id: "7",
  }));
});

test("deletes a newly rotated QR and leaves no result after terminal authentication failure", async () => {
  const fixture = privateTree();
  const created = { count: 0 };
  await expect(runTelegramBootstrap(fixture.environment, dependencies(new FakeClient("closed"), created))).rejects.toThrow();
  expect(created.count).toBe(1);
  expect(existsSync(fixture.qr)).toBe(false);
  expect(existsSync(fixture.result)).toBe(false);
});

test.skipIf(process.platform !== "darwin")("rejects a confidentiality ACL before TDLib runtime or output creation", async () => {
  const fixture = privateTree();
  const database = fixture.environment.INBOXD_TELEGRAM_DATABASE_DIRECTORY!;
  const added = Bun.spawnSync(["/bin/chmod", "+a", "group:everyone allow read,write,delete", database]);
  expect(added.exitCode).toBe(0);
  const created = { count: 0 };
  let runtimeChecks = 0;
  try {
    const deps = dependencies(new FakeClient("ready"), created);
    await expect(runTelegramBootstrap(fixture.environment, {
      ...deps,
      packagedRuntime: () => { runtimeChecks++; return { tdjsonPath: "/trusted/libtdjson.dylib" }; },
    })).rejects.toThrow();
    expect(runtimeChecks).toBe(0);
    expect(created.count).toBe(0);
    expect(existsSync(fixture.qr)).toBe(false);
    expect(existsSync(fixture.result)).toBe(false);
  } finally {
    const removed = Bun.spawnSync(["/bin/chmod", "-a#", "0", database]);
    expect(removed.exitCode).toBe(0);
  }
});

test("rejects a group-writable HOME ancestor before TDLib runtime or output creation", async () => {
  const fixture = privateTree();
  chmodSync(fixture.home, 0o770);
  const created = { count: 0 };
  let runtimeChecks = 0;
  try {
    const deps = dependencies(new FakeClient("ready"), created);
    await expect(runTelegramBootstrap(fixture.environment, {
      ...deps,
      packagedRuntime: () => { runtimeChecks++; return { tdjsonPath: "/trusted/libtdjson.dylib" }; },
    })).rejects.toThrow();
    expect(runtimeChecks).toBe(0);
    expect(created.count).toBe(0);
    expect(existsSync(fixture.result)).toBe(false);
  } finally {
    chmodSync(fixture.home, 0o700);
  }
});

test("rejects a symlink HOME ancestor before TDLib runtime or output creation", async () => {
  const fixture = privateTree();
  const linkedHome = join(fixtureRoot, `linked-${crypto.randomUUID()}`);
  symlinkSync(fixture.home, linkedHome, "dir");
  const environment = Object.fromEntries(Object.entries(fixture.environment).map(([key, value]) => [
    key,
    value === fixture.home || value.startsWith(`${fixture.home}/`)
      ? `${linkedHome}${value.slice(fixture.home.length)}`
      : value,
  ]));
  const created = { count: 0 };
  let runtimeChecks = 0;
  try {
    const deps = dependencies(new FakeClient("ready"), created);
    await expect(runTelegramBootstrap(environment, {
      ...deps,
      packagedRuntime: () => { runtimeChecks++; return { tdjsonPath: "/trusted/libtdjson.dylib" }; },
    })).rejects.toThrow();
    expect(runtimeChecks).toBe(0);
    expect(created.count).toBe(0);
    expect(existsSync(fixture.result)).toBe(false);
  } finally {
    rmSync(linkedHome);
  }
});

test.skipIf(process.platform !== "darwin")("rejects an allow ACL on HOME before TDLib runtime or output creation", async () => {
  const fixture = privateTree();
  const added = Bun.spawnSync(["/bin/chmod", "+a", "group:everyone allow read,write,delete", fixture.home]);
  expect(added.exitCode).toBe(0);
  const created = { count: 0 };
  let runtimeChecks = 0;
  try {
    const deps = dependencies(new FakeClient("ready"), created);
    await expect(runTelegramBootstrap(fixture.environment, {
      ...deps,
      packagedRuntime: () => { runtimeChecks++; return { tdjsonPath: "/trusted/libtdjson.dylib" }; },
    })).rejects.toThrow();
    expect(runtimeChecks).toBe(0);
    expect(created.count).toBe(0);
    expect(existsSync(fixture.result)).toBe(false);
  } finally {
    const removed = Bun.spawnSync(["/bin/chmod", "-a#", "0", fixture.home]);
    expect(removed.exitCode).toBe(0);
  }
});
