import { expect, test, spyOn } from "bun:test";
import { connectSlackAccount, SlackSessionError, slackAccountCall } from "../src/drivers/slack.ts";
import type { ConnectionUI } from "../src/contracts.ts";

function fixture(count = 1) {
  const workspaces = Object.fromEntries(Array.from({ length: count }, (_, i) => [`T${i}`, {
    workspace_id: `T${i}`, workspace_name: `Workspace ${i}`, token: "synthetic", cookie: "synthetic",
  }]));
  const prompts: string[] = [], reports: string[] = [], calls: string[] = [];
  const ui: ConnectionUI = {
    choose: async title => { prompts.push(title); return "T1"; },
    report: message => { reports.push(message); },
    secret: async () => { throw new Error("unexpected secret prompt"); }, open: () => {},
  };
  const call: typeof slackAccountCall = async (workspace, method, payload) => {
    calls.push(method);
    if (method === "auth.test") return { team_id: workspace.workspace_id, user_id: "U1" };
    if (method === "conversations.open") {
      expect(payload).toEqual({ users: "U1" });
      return { channel: { id: "D1" } };
    }
    return { channel: { id: "D1", user: "U1" } };
  };
  return { ui, prompts, reports, calls, workspaces, dependencies: { readConfig: () => ({ workspaces }), call } };
}
const noExtract = async () => { throw new Error("unexpected session import"); };

test("new identities include the workspace and user", async () => {
  const f = fixture();
  const result = await connectSlackAccount(f.ui, noExtract, f.dependencies);
  expect(result.account).toBe("slack:team:T0:user:U1");
  expect(result.user_id).toBe("U1");
});

test("two users in the same workspace use independent saved credentials", async () => {
  const f = fixture();
  const providers = ["U1", "U2"].map(user => ({ kind: "slack", team_id: "T0", user_id: user, account: `slack:team:T0:user:${user}`, binding_id: `binding-${user}`, bot_token: user, session_cookie: "synthetic" }));
  let selection = 0;
  f.ui.choose = async () => ++selection === 1 ? "saved:1" : "use";
  const result = await connectSlackAccount(f.ui, noExtract, { ...f.dependencies, readProviders: () => providers, call: async (workspace, method) => method === "auth.test" ? { team_id: "T0", user_id: workspace.token } : { channel: { id: "D2", user: "U2" } } });
  expect(result.account).toBe("slack:team:T0:user:U2");
  expect(result.binding_id).toBe("binding-U2");
  expect(result.bot_token).toBe("U2");
  expect(providers[0]!.bot_token).toBe("U1");
});

test("targeted reauthentication rejects another user in the same team", async () => {
  const f = fixture();
  const answers = ["saved:0", "reauth", "continue"];
  f.ui.choose = async () => answers.shift()!;
  await expect(connectSlackAccount(f.ui, async () => {}, { ...f.dependencies, readProviders: () => [{ kind: "slack", team_id: "T0", user_id: "U2", binding_id: "old", account: "slack:team:T0:user:U2" }] })).rejects.toThrow("일치하는 세션");
  expect(f.calls).toEqual(["auth.test"]);
});

test("cancel before extraction leaves saved credentials and conversations untouched", async () => {
  const f = fixture();
  const answers = ["add", "cancel"];
  f.ui.choose = async () => answers.shift()!;
  let extracts = 0;
  await expect(connectSlackAccount(f.ui, async () => { extracts++; }, { ...f.dependencies, readProviders: () => [{ kind: "slack", team_id: "T0", user_id: "U1" }] })).rejects.toThrow("취소");
  expect(extracts).toBe(0);
  expect(f.calls).toEqual([]);
});

test("verified legacy reauthentication preserves account and binding history", async () => {
  const f = fixture();
  const answers = ["saved:0", "reauth", "continue"];
  f.ui.choose = async () => answers.shift()!;
  const result = await connectSlackAccount(f.ui, async () => {}, { ...f.dependencies, readProviders: () => [{ kind: "slack", team_id: "T0", chat_id: "D1", account: "slack:team:T0", binding_id: "legacy", bot_token: "old", session_cookie: "old" }] });
  expect(result.account).toBe("slack:team:T0");
  expect(result.binding_id).toBe("legacy");
  expect(result.user_id).toBe("U1");
});

test("cancelling imported account selection never opens a conversation", async () => {
  const f = fixture(2);
  f.ui.choose = async () => "cancel";
  await expect(connectSlackAccount(f.ui, noExtract, f.dependencies)).rejects.toThrow("취소");
  expect(f.calls).toEqual(["auth.test", "auth.test"]);
});

test("network failures do not trigger extraction", async () => {
  const f = fixture();
  f.dependencies.call = async () => { throw new Error("network unavailable"); };
  await expect(connectSlackAccount(f.ui, noExtract, f.dependencies)).rejects.toThrow("network unavailable");
});

test("Slack API authentication and service failures are distinguished without leaking response data", async () => {
  const fetchMock = spyOn(globalThis, "fetch");
  const f = fixture();
  try {
    fetchMock.mockResolvedValue(Response.json({ ok: false, error: "invalid_auth", secret: "do-not-display" }));
    await expect(slackAccountCall(f.workspaces.T0!, "auth.test")).rejects.toBeInstanceOf(SlackSessionError);
    fetchMock.mockResolvedValue(Response.json({ ok: false, error: "ratelimited" }, { status: 429 }));
    try { await slackAccountCall(f.workspaces.T0!, "auth.test"); throw new Error("expected failure"); }
    catch (error) {
      expect(error).not.toBeInstanceOf(SlackSessionError);
      expect((error as Error).message).toContain("네트워크 상태 또는 접근 권한");
      expect((error as Error).message).not.toContain("do-not-display");
    }
  } finally { fetchMock.mockRestore(); }
});

test("adding an already saved identity preserves its aliases", async () => {
  const f = fixture();
  const answers = ["add", "continue"];
  f.ui.choose = async () => answers.shift()!;
  const result = await connectSlackAccount(f.ui, async () => {}, { ...f.dependencies, readProviders: () => [{ kind: "slack", team_id: "T0", user_id: "U1", binding_id: "legacy-binding", account: "slack:team:T0" }] });
  expect(result.account).toBe("slack:team:T0");
  expect(result.binding_id).toBe("legacy-binding");
  expect(f.reports.some(message => message.includes("이미 저장된"))).toBe(true);
});

test("a wrong saved user is rejected without opening a conversation", async () => {
  const f = fixture();
  const answers = ["saved:0", "use"];
  f.ui.choose = async () => answers.shift()!;
  await expect(connectSlackAccount(f.ui, noExtract, { ...f.dependencies, readProviders: () => [{ kind: "slack", team_id: "T0", user_id: "U2", bot_token: "synthetic", session_cookie: "synthetic" }] })).rejects.toThrow("계정이 일치하지 않습니다");
  expect(f.calls).toEqual(["auth.test"]);
});

test("Slack rejects a self chat belonging to another user", async () => {
  const f = fixture();
  const original = f.dependencies.call;
  f.dependencies.call = async (workspace, method, payload) => method === "conversations.info" ? { channel: { id: "D1", user: "U2" } } : original(workspace, method, payload);
  await expect(connectSlackAccount(f.ui, noExtract, f.dependencies)).rejects.toThrow("대화 대상이 일치하지 않습니다");
});

for (const correctUser of [true, false]) test(`expired legacy reauthentication ${correctUser ? "proves self-DM and preserves history" : "rejects another user's self-DM"}`, async () => {
  const f = fixture();
  const answers = ["saved:0", "reauth", "continue"];
  f.ui.choose = async () => answers.shift()!;
  const original = f.dependencies.call;
  const dependencies = { ...f.dependencies, readProviders: () => [{ kind: "slack", team_id: "T0", chat_id: "D1", account: "slack:team:T0", binding_id: "legacy", bot_token: "expired", session_cookie: "old" }], call: (async (workspace, method, payload) => {
    if (workspace.token === "expired") throw new SlackSessionError("expired");
    if (method === "conversations.info" && !correctUser) return { channel: { id: "D1", user: "U2" } };
    return original(workspace, method, payload);
  }) as typeof slackAccountCall };
  const connection = connectSlackAccount(f.ui, async () => {}, dependencies);
  if (correctUser) {
    const result = await connection;
    expect(result.account).toBe("slack:team:T0");
    expect(result.user_id).toBe("U1");
  } else {
    await expect(connection).rejects.toThrow("일치하는 세션");
    expect(f.calls).not.toContain("conversations.open");
  }
});

test("entirely expired import cache offers login once and retries extraction", async () => {
  const f = fixture();
  f.workspaces.T0!.token = "expired";
  f.ui.choose = async () => "continue";
  let extracts = 0;
  const original = f.dependencies.call;
  f.dependencies.call = async (workspace, method, payload) => {
    if (workspace.token === "expired") throw new SlackSessionError("expired");
    return original(workspace, method, payload);
  };
  const result = await connectSlackAccount(f.ui, async () => { extracts++; f.workspaces.T0!.token = "fresh"; }, f.dependencies);
  expect(extracts).toBe(1);
  expect(result.user_id).toBe("U1");
  f.workspaces.T0!.token = "expired";
  await expect(connectSlackAccount(f.ui, async () => { extracts++; }, f.dependencies)).rejects.toThrow("연결 가능한 Slack 세션이 없습니다");
  expect(extracts).toBe(2);
});

for (const action of ["continue", "cancel"]) test(`already logged-in import ${action} never opens a login window`, async () => {
  const f = fixture();
  const answers = ["add", action];
  f.ui.choose = async () => answers.shift()!;
  let opens = 0, extracts = 0;
  f.ui.open = () => { opens++; };
  const connection = connectSlackAccount(f.ui, async () => { extracts++; }, { ...f.dependencies, readProviders: () => [{ kind: "slack", team_id: "T1", user_id: "U2" }] });
  if (action === "continue") await connection;
  else await expect(connection).rejects.toThrow("취소");
  expect(opens).toBe(0);
  expect(extracts).toBe(action === "continue" ? 1 : 0);
});

test("opening a login window is explicit and extraction waits for continue", async () => {
  const f = fixture();
  const answers = ["add", "login", "cancel"];
  f.ui.choose = async () => answers.shift()!;
  let opens = 0, extracts = 0;
  f.ui.open = () => { opens++; };
  await expect(connectSlackAccount(f.ui, async () => { extracts++; }, { ...f.dependencies, readProviders: () => [{ kind: "slack", team_id: "T1", user_id: "U2" }] })).rejects.toThrow("취소");
  expect(opens).toBe(1);
  expect(extracts).toBe(0);
});
