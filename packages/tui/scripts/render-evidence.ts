import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createInitialState, createTuiController, displayWidth, reduce, renderScreen, screens, truncateCells, type Row, type Screen, type TuiState } from "../src/index.ts";

const rows: Record<Screen, Row[]> = {
  inbox: [
    {
      id: "slack:work:ops",
      chat: { platform: "slack", account: "work", chat_id: "ops" },
      author: "운영",
      ts: "09:41",
      body: "한국어/CJK 경계 텍스트 가나다라마바사아자차카타파하漢字かなカナ — whole grapheme clipping evidence",
      edited: true,
      unread: "Unread: ? (unknown)",
      evidenceLines: ["Unread reason: unobserved", "Coverage: partial · 1 chats / 1 gaps / 1 limits", "Self: ? (unknown)"],
    },
    { id: "slack:work:dev", chat: { platform: "slack", account: "work", chat_id: "dev" }, author: "개발", ts: "09:38", body: "다음 점검 항목" },
  ],
  search: [{ id: "m-search", author: "민수", ts: "09:41", body: "검색 결과와 증거 범위" }],
  chat: [
    { id: "m-chat-1", author: "민수", ts: "09:41", body: "재현 가능한 대화 내용" },
    { id: "m-chat-2", author: "Ari", ts: "09:42", body: "수정됨", edited: true },
  ],
  approvals: [
    { id: "intent-1", state: "Proposed", destination: "slack:work:ops", expires: "10m", body: "승인 대기 제안", codeRequired: true },
    { id: "intent-2", state: "Uncertain", destination: "slack:work:ops", expires: "expired", body: "자동 재전송 금지", codeRequired: false },
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
  let state = createInitialState({ screen, platform: "slack", period: "24h" });
  state = reduce(state, { type: "connected", generation: 1 });
  state = reduce(state, { type: "subscribed", generation: 1 });
  for (const name of screens) {
    state = reduce(state, {
      type: "querySucceeded",
      generation: 1,
      screen: name,
      data: rows[name],
      coverage: { chats: 1, gaps: 1, limits: 1, freshness: "partial" },
    });
  }
  return { ...reduce(state, { type: "switchScreen", screen }), activeChat: { platform: "slack", account: "work", chat_id: "ops" }, sendCapable: true };
}

function activatedDetailState(screen: Screen): TuiState {
  return reduce(evidenceState(screen), { type: "key", key: "Enter" });
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

function completionLostState(): TuiState {
  let state = evidenceState("approvals");
  state = reduce(state, { type: "querySucceeded", generation: 1, screen: "approvals", data: [{
    id: "in-flight", state: "Uncertain", destination: "slack:work:ops", codeRequired: false,
    evidenceLines: ["session observation", "outcome unknown; do not resend"],
  }] });
  return reduce(state, { type: "disconnected", generation: 1 });
}

function staleDoctorState(): TuiState {
  return reduce(evidenceState("doctor"), { type: "disconnected", generation: 1 });
}

function unavailableApprovalState(state: TuiState, notice: string): TuiState {
  return {
    ...reduce(state, {
      type: "querySucceeded",
      generation: state.connection.generation,
      screen: "approvals",
      data: rows.approvals.map((row, index) => index === 0 ? { ...row, state: "Code unavailable", codeRequired: false } : row),
    }),
    notice,
  };
}

async function rejectedApprovalState(): Promise<TuiState> {
  const controller = createTuiController({ client: {
    start: async () => {},
    stop: () => {},
    request: async (method) => {
      if (method === "safety.intent.listPending") return { intents: [{ intent_id: "intent-1", actor: "operator", scope: { platform: "slack", account: "work", chat_id: "ops" }, state: "Proposed", body: "승인 대기 제안", expires_at: "10m" }] };
      if (method === "safety.intent.claimApprovalCode") return { code: "654321" };
      if (method === "safety.intent.approve") throw new Error("invalid approval code");
      return {};
    },
  } });
  await controller.start();
  await controller.dispatchKey("4");
  await controller.dispatchKey("a");
  for (const key of "000000") await controller.dispatchKey(key);
  await controller.dispatchKey("Enter");
  const state = controller.state;
  controller.stop();
  return state;
}

/** Reserve one cell for a visible capture border without breaking CJK clipping. */
function bordered(render: string, width: number): string {
  return render.split("\n").map((line) => {
    const content = line.trimEnd();
    const bounded = displayWidth(content) >= width ? truncateCells(content, width - 2) : content;
    return `${bounded}${" ".repeat(width - 1 - displayWidth(bounded))}│`;
  }).join("\n");
}

async function capture(name: string, state: TuiState, size: { width: number; height: number }): Promise<void> {
  await Bun.write(join(outputDirectory, `${name}-${size.width}x${size.height}.txt`), renderScreen(state, size));
}

await mkdir(outputDirectory, { recursive: true });
const rejectedApproval = await rejectedApprovalState();
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
  let prompt = activatedDetailState("approvals");
  for (const key of ["a", "1", "2", "3", "4"]) prompt = reduce(prompt, { type: "key", key });
  await capture("approvals-active-prompt", prompt, size);
  let compose = activatedDetailState("chat");
  for (const key of ["c", ..."검토 후 배포할까요? 👩‍💻"]) compose = reduce(compose, { type: "key", key });
  // Fixture content is deterministic; interactive control behavior has native input tests.
  compose = { ...compose, draft: "검토 후 배포할까요? 👩‍💻" };
  await capture("chat-active-compose", compose, size);
  for (const outcome of ["Sent", "Verified", "Uncertain"]) {
    for (const screen of ["chat", "approvals"] as const) {
      const state = reduce(evidenceState(screen), { type: "querySucceeded", generation: 1, screen: "approvals", data: [{
        id: `outcome-${outcome}`, chat: { platform: "slack", account: "work", chat_id: "ops" }, state: outcome, destination: "slack:work:ops", body: "Operator-reviewed proposal", codeRequired: false,
      }] });
      await capture(`${screen}-${outcome.toLowerCase()}`, state, size);
    }
  }
  await capture("inbox-empty", reduce(evidenceState("inbox"), { type: "querySucceeded", generation: 1, screen: "inbox", data: [] }), size);
  let long = reduce(evidenceState("inbox"), { type: "querySucceeded", generation: 1, screen: "inbox", data: [{ id: "long", author: "민수", body: "한글 👩‍💻 é message ".repeat(200) + "\nEND-OF-MESSAGE" }] });
  long = reduce(long, { type: "key", key: "Enter" });
  await capture("inbox-long-detail", long, size);
  for (let i = 0; i < 40; i++) long = reduce(long, { type: "key", key: "PageDown" });
  await capture("inbox-long-detail-scrolled", long, size);
  await capture("approvals-rejected", rejectedApproval, size);
  await capture("chat-read-only", { ...evidenceState("chat"), sendCapable: false, notice: "compose disabled — send capability unavailable (read-only)" }, size);
  let reconnected = disconnectedApprovalsState(false);
  reconnected = reduce(reconnected, { type: "connected", generation: 2 });
  reconnected = reduce(reconnected, { type: "subscribed", generation: 2 });
  for (const screen of screens) reconnected = reduce(reconnected, { type: "querySucceeded", generation: 2, screen, data: rows[screen] });
  await capture("approvals-reconnected", unavailableApprovalState(reconnected, "approval code unavailable after reconnect — re-proposal required"), size);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const repository = resolve(import.meta.dir, "../../..");
const captures = Object.fromEntries(readdirSync(outputDirectory).filter(name => name.endsWith(".txt")).sort().map(name => [name, sha256(readFileSync(join(outputDirectory, name)))]));
const rendererPath = join(repository, "packages/tui/src/index.ts");
const generatorPath = join(repository, "packages/tui/scripts/render-evidence.ts");
await Bun.write(join(outputDirectory, "manifest.json"), `${JSON.stringify({
  schema: "inboxd.tui.capture-manifest.v1",
  repository,
  base: "30f80c966076eddea0ffc185b1f7e22be0df74bb",
  working_tree_base: "3eef18fc2ae8eb129ac41abe5a17cc4c647143a0",
  runtime: Bun.version,
  source_hashes: {
    renderer: sha256(readFileSync(rendererPath)),
    generator: sha256(readFileSync(generatorPath)),
  },
  viewports: sizes,
  captures,
}, null, 2)}\n`);
