import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createInitialState, createTuiController, mountInteractiveTui, reduce, renderScreen, screens, type ChatRef, type Row, type Screen, type TuiController, type TuiState } from "../src/index.ts";
import type { ResourceCapabilityV1, ResourceRefV1 } from "../../protocol/src/schema.ts";
import type { MockInput } from "@opentui/core/testing";

const slackResource = { v: 1, kind: "chat", platform: "slack", account: "work", chat_id: "ops" } as const;
const telegramResource = { v: 1, kind: "chat", platform: "telegram", account: "personal", chat_id: "-100123" } as const;
const kakaoLocalResource = { v: 1, kind: "chat", platform: "kakao", account: "local", chat_id: "room-7" } as const;
const kakaoOfficialResource = { v: 1, kind: "destination", platform: "kakao", account: "official-app", destination_id: "friend-uuid" } as const;

const capabilities: ResourceCapabilityV1[] = [
  {
    v: 1,
    resource: slackResource,
    read: { mode: "bounded_history", limits: { max_page_size: 100, max_pages: 1, cursor: "opaque" } },
    write: { mode: "send", content_mode: "text", reply: true },
    receipt: { level: "independent_readback" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_000 },
  },
  {
    v: 1,
    resource: telegramResource,
    read: { mode: "bounded_history", limits: { max_page_size: 50, max_pages: 2, cursor: "opaque" } },
    write: { mode: "send", content_mode: "text", reply: true },
    receipt: { level: "independent_readback" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_001 },
  },
  {
    v: 1,
    resource: kakaoLocalResource,
    read: { mode: "measured_local", limits: { max_page_size: 100, max_pages: 1, cursor: "none" } },
    write: { mode: "none", content_mode: "none", reply: false },
    receipt: { level: "none" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_002 },
  },
  {
    v: 1,
    resource: kakaoOfficialResource,
    read: { mode: "none", limits: null },
    write: { mode: "send", content_mode: "approved_template", reply: false },
    receipt: { level: "ack_only" },
    auth: { state: "authenticated", reason: null, observed_at: 1_726_650_003 },
  },
];

function chat(resource: Extract<ResourceRefV1, { kind: "chat" }>): ChatRef {
  return { platform: resource.platform, account: resource.account, chat_id: resource.chat_id };
}

const rows: Record<Screen, Row[]> = {
  inbox: [
    {
      id: "slack:work:ops",
      resource: slackResource,
      chat: chat(slackResource),
      author: "운영",
      ts: "09:41",
      body: "한국어/CJK 경계 텍스트 가나다라마바사아자차카타파하漢字かなカナ — whole grapheme clipping evidence",
      edited: true,
      unread: "Unread: ? (unknown)",
      evidenceLines: ["Unread reason: unobserved", "Coverage: partial · 3 chats / 1 gaps / 1 limits", "Self: ? (unknown)"],
    },
    { id: "telegram:personal:-100123", resource: telegramResource, chat: chat(telegramResource), author: "민수", ts: "09:39", body: "Telegram text/reply capability" },
    { id: "kakao:local:room-7", resource: kakaoLocalResource, chat: chat(kakaoLocalResource), author: "카카오 로컬", ts: "09:38", body: "read-only measured local history" },
  ],
  search: [{ id: "m-search", resource: slackResource, chat: chat(slackResource), author: "민수", ts: "09:41", body: "검색 결과와 증거 범위" }],
  chat: [
    { id: "m-chat-1", resource: slackResource, chat: chat(slackResource), author: "민수", ts: "09:41", body: "재현 가능한 대화 내용" },
    { id: "m-chat-2", resource: slackResource, chat: chat(slackResource), author: "Ari", ts: "09:42", body: "수정됨", edited: true },
  ],
  approvals: [
    { id: "intent-1", resource: slackResource, chat: chat(slackResource), state: "Proposed", destination: "slack:work:ops", expires: "10m", body: "과거 승인 요청" },
    { id: "intent-2", resource: kakaoOfficialResource, state: "Uncertain", destination: "kakao:official-app:friend-uuid", expires: "expired", body: "공식 템플릿 자동 재전송 금지" },
  ],
  doctor: [
    { id: "encryption", state: "SQLCipher ready=true", evidenceLines: ["Cipher: fixture-version", "Schema: 2"] },
    { id: "authentication", state: "slack=unknown" },
    { id: "sync", state: "slack=degraded" },
    { id: "isolation", state: "grade=b protected=false", evidenceLines: ["same-user access is outside isolation"] },
  ],
};

const sizes = [{ width: 80, height: 24 }, { width: 120, height: 40 }] as const;
const outputDirectory = join(import.meta.dir, "..", "rendered");

function evidenceState(screen: Screen): TuiState {
  let state = createInitialState({ screen, period: "24h" });
  state = reduce(state, { type: "connected", generation: 1 });
  state = reduce(state, { type: "subscribed", generation: 1 });
  state = reduce(state, { type: "capabilitySucceeded", generation: 1, data: capabilities });
  for (const name of screens) {
    state = reduce(state, {
      type: "querySucceeded",
      generation: 1,
      screen: name,
      data: rows[name],
      coverage: { chats: 3, gaps: 1, limits: 1, freshness: "partial" },
    });
  }
  return { ...reduce(state, { type: "switchScreen", screen }), activeChat: chat(slackResource), activeResource: slackResource };
}

function activatedDetailState(screen: Screen): TuiState {
  return reduce(evidenceState(screen), { type: "key", key: "d" });
}

function focusBeforeSelectionState(): TuiState {
  return reduce(evidenceState("inbox"), { type: "key", key: "j" });
}

function unknownCoverageState(): TuiState {
  return reduce(evidenceState("search"), { type: "querySucceeded", generation: 1, screen: "search", data: rows.search, coverage: { freshness: "unknown" } });
}

function disconnectedApprovalsState(degraded: boolean): TuiState {
  return reduce(evidenceState("approvals"), { type: "disconnected", generation: 1, degraded });
}

function scopeLimitState(): TuiState {
  let state = evidenceState("inbox");
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "inbox", data: [] });
  return reduce(state, { type: "queryFailed", generation: 1, screen: "inbox", error: "Partial: 100-chat limit exceeded; no query", coverage: { freshness: "partial", chats: 0 } });
}

function emptyChatState(): TuiState {
  return reduce(evidenceState("chat"), { type: "querySucceeded", generation: 1, screen: "chat", data: [] });
}

function readOnlyChatState(): TuiState {
  let state = evidenceState("chat");
  state = reduce(state, {
    type: "capabilitySucceeded",
    generation: 1,
    data: capabilities.map(capability => capability.resource === slackResource ? {
      ...capability,
      write: { mode: "none", content_mode: "none", reply: false },
      receipt: { level: "none" },
    } : capability),
  });
  return reduce(state, { type: "key", key: "c" });
}

function completionLostState(): TuiState {
  let state = evidenceState("approvals");
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "approvals", data: [{
    id: "in-flight", resource: slackResource, chat: chat(slackResource), state: "Uncertain", destination: "slack:work:ops",
    evidenceLines: ["session observation", "outcome unknown; do not resend"],
  }] });
  return reduce(state, { type: "disconnected", generation: 1 });
}

function staleDoctorState(): TuiState {
  return reduce(evidenceState("doctor"), { type: "disconnected", generation: 1 });
}

async function settleNativeInput(): Promise<void> {
  for (let turn = 0; turn < 40; turn++) await Promise.resolve();
}

async function openNativeResource(input: MockInput, index: number): Promise<void> {
  await input.typeText("3");
  for (let position = 0; position < index; position++) input.pressArrow("down");
  input.pressEnter();
  await settleNativeInput();
}

async function nativeJourneyFrame(
  size: { width: number; height: number },
  capabilityResponses: readonly ResourceCapabilityV1[][],
  drive: (input: MockInput, controller: TuiController) => Promise<void>,
): Promise<string> {
  const { createTestRenderer } = await import("@opentui/core/testing");
  let capabilityRequest = 0;
  const controller = createTuiController({ client: {
    start: async () => {},
    stop: () => {},
    request: async (method) => {
      if (method === "capability.list") {
        const response = capabilityResponses[Math.min(capabilityRequest, capabilityResponses.length - 1)] ?? [];
        capabilityRequest++;
        return { v: 1, resources: response };
      }
      if (method === "chat.list") return { chats: [] };
      if (method === "message.inbox") return { messages: [{ msg_id: "native-parent", body: "Native reply parent" }] };
      if (method === "safety.intent.listPending") return { intents: [] };
      if (method === "message.send") return { state: "Sent" };
      return {};
    },
  } });
  const harness = await createTestRenderer(size);
  const mounted = await mountInteractiveTui(harness.renderer, controller);
  try {
    await controller.start();
    await drive(harness.mockInput, controller);
    await settleNativeInput();
    await harness.flush();
    return renderScreen(controller.state, size);
  } finally {
    mounted.destroy();
    controller.stop();
    harness.renderer.destroy();
  }
}

async function captureNativeJourneys(size: { width: number; height: number }): Promise<void> {
  const writeFrame = async (name: string, frame: Promise<string>): Promise<void> => {
    await Bun.write(join(outputDirectory, `${name}-${size.width}x${size.height}.txt`), await frame);
  };

  await writeFrame("native-destination-compose", nativeJourneyFrame(size, [capabilities], async (input) => {
    await openNativeResource(input, 3);
    await input.typeText("cnotice-7");
    input.pressEnter();
    await settleNativeInput();
    await input.typeText('{"amount":1000}');
    input.pressEnter();
    await settleNativeInput();
    await input.typeText("승인 ");
    input.pressKey("👩‍💻");
  }));

  for (const [name, index] of [["slack", 0], ["telegram", 1]] as const) {
    await writeFrame(`native-${name}-reply-success`, nativeJourneyFrame(size, [capabilities], async (input) => {
      await openNativeResource(input, index);
      await input.typeText(`r${name} native reply`);
      input.pressEnter();
    }));
  }

  await writeFrame("native-kakao-local-read-only", nativeJourneyFrame(size, [capabilities], async (input) => {
    await openNativeResource(input, 2);
    await input.typeText("c");
  }));

  const deniedCapabilities = capabilities.map((capability, index) => index === 0 ? {
    ...capability,
    auth: { state: "unauthenticated" as const, reason: "access_denied", observed_at: 1_726_650_100 },
  } : capability);
  await writeFrame("native-auth-denied", nativeJourneyFrame(size, [deniedCapabilities], async (input) => {
    await openNativeResource(input, 0);
    await input.typeText("c");
  }));

  await writeFrame("native-capability-revoked", nativeJourneyFrame(size, [capabilities, []], async (input, controller) => {
    await openNativeResource(input, 0);
    await controller.receiveEvent("capability.changed");
    await input.typeText("c");
  }));
}

async function capture(name: string, state: TuiState, size: { width: number; height: number }): Promise<void> {
  await Bun.write(join(outputDirectory, `${name}-${size.width}x${size.height}.txt`), renderScreen(state, size));
}

await mkdir(outputDirectory, { recursive: true });
await Promise.all(readdirSync(outputDirectory)
  .filter(name => name.endsWith(".txt"))
  .map(name => rm(join(outputDirectory, name))));
for (const screen of screens) {
  for (const size of sizes) await capture(screen, evidenceState(screen), size);
  for (const size of sizes) await capture(`${screen}-detail`, activatedDetailState(screen), size);
}
for (const size of sizes) {
  await capture("inbox-focus-before-selection", focusBeforeSelectionState(), size);
  await capture("unknown-coverage", unknownCoverageState(), size);
  await capture("approvals-disconnected", disconnectedApprovalsState(false), size);
  await capture("approvals-degraded", disconnectedApprovalsState(true), size);
  await capture("doctor-stale", staleDoctorState(), size);
  await capture("inbox-scope-limit", scopeLimitState(), size);
  await capture("approvals-completion-lost", completionLostState(), size);
  let compose = activatedDetailState("chat");
  for (const key of ["c", ..."검토 후 배포할까요? 👩‍💻"]) compose = reduce(compose, { type: "key", key });
  // Fixture content is deterministic; interactive control behavior has native input tests.
  compose = { ...compose, draft: "검토 후 배포할까요? 👩‍💻" };
  await capture("chat-active-compose", compose, size);
  for (const outcome of ["Sent", "Verified", "Uncertain"]) {
    for (const screen of ["chat", "approvals"] as const) {
      const state = reduce(evidenceState(screen), { type: "querySucceeded", generation: 1, screen: "approvals", data: [{
        id: `outcome-${outcome}`, chat: { platform: "slack", account: "work", chat_id: "ops" }, state: outcome, destination: "slack:work:ops", body: "Historical send record",
      }] });
      await capture(`${screen}-${outcome.toLowerCase()}`, state, size);
    }
  }
  await capture("inbox-empty", reduce(evidenceState("inbox"), { type: "querySucceeded", generation: 1, screen: "inbox", data: [] }), size);
  await capture("chat-empty", emptyChatState(), size);
  let long = reduce(evidenceState("inbox"), { type: "querySucceeded", generation: 1, screen: "inbox", data: [{ id: "long", author: "민수", body: "한글 👩‍💻 é message ".repeat(200) + "\nEND-OF-MESSAGE" }] });
  long = reduce(long, { type: "key", key: "d" });
  await capture("inbox-long-detail", long, size);
  for (let i = 0; i < 40; i++) long = reduce(long, { type: "key", key: "PageDown" });
  await capture("inbox-long-detail-scrolled", long, size);
  await capture("chat-read-only", readOnlyChatState(), size);
  await captureNativeJourneys(size);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const repository = resolve(import.meta.dir, "../../..");
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

const targetOverride = process.env.INBOXD_TUI_TARGET_REVISION;
if (targetOverride !== undefined && targetOverride.trim().length === 0) {
  throw new Error("INBOXD_TUI_TARGET_REVISION must name a commit when provided");
}
const workingTreeBase = git("rev-parse", "--verify", `${targetOverride ?? "HEAD"}^{commit}`);
const runtimeBase = git("merge-base", workingTreeBase, "origin/main");
const captures = Object.fromEntries(readdirSync(outputDirectory).filter(name => name.endsWith(".txt")).sort().map(name => [name, sha256(readFileSync(join(outputDirectory, name)))]));
const rendererPath = join(repository, "packages/tui/src/index.ts");
const runtimePath = join(repository, "packages/tui/src/runtime.ts");
const generatorPath = join(repository, "packages/tui/scripts/render-evidence.ts");
await Bun.write(join(outputDirectory, "manifest.json"), `${JSON.stringify({
  schema: "inboxd.tui.capture-manifest.v1",
  repository,
  base: runtimeBase,
  working_tree_base: workingTreeBase,
  runtime: Bun.version,
  source_hashes: {
    workspace: sha256(readFileSync(join(repository, "packages/tui/src/workspace.ts"))),
    model: sha256(readFileSync(join(repository, "packages/tui/src/workspace-model.ts"))),
    theme: sha256(readFileSync(join(repository, "packages/tui/src/theme.ts"))),
    text: sha256(readFileSync(join(repository, "packages/tui/src/text.ts"))),
    renderer: sha256(readFileSync(rendererPath)),
    runtime: sha256(readFileSync(runtimePath)),
    generator: sha256(readFileSync(generatorPath)),
  },
  viewports: sizes,
  captures,
}, null, 2)}\n`);
