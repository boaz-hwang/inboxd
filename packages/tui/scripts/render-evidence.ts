import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { createInitialState, displayWidth, reduce, renderScreen, screens, truncateCells, type Row, type Screen, type TuiState } from "../src/index.ts";

const rows: Record<Screen, Row[]> = {
  inbox: [
    {
      id: "slack:work:ops",
      chat: { platform: "slack", account: "work", chat_id: "ops" },
      author: "운영",
      ts: "09:41",
      body: "한국어/CJK 경계 텍스트 가나다라마바사아자차카타파하漢字かなカナ — whole grapheme clipping evidence",
      edited: true,
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
    { id: "intent-2", state: "Uncertain", destination: "slack:work:ops", expires: "expired", body: "자동 재전송 금지", codeRequired: true },
  ],
  doctor: [
    { id: "encryption", state: "SQLCipher healthy" },
    { id: "authentication", state: "configured" },
    { id: "sync", state: "degraded coverage" },
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
  return reduce(state, { type: "switchScreen", screen });
}

function activatedDetailState(screen: Screen): TuiState {
  return reduce(evidenceState(screen), { type: "key", key: "Enter" });
}

function focusBeforeSelectionState(): TuiState {
  return reduce(evidenceState("inbox"), { type: "key", key: "j" });
}

function unknownCoverageState(): TuiState {
  return reduce(evidenceState("search"), { type: "coverage", coverage: { freshness: "unknown" } });
}

function disconnectedApprovalsState(degraded: boolean): TuiState {
  return reduce(evidenceState("approvals"), { type: "disconnected", generation: 1, degraded });
}

function staleDoctorState(): TuiState {
  return reduce(evidenceState("doctor"), { type: "disconnected", generation: 1 });
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
  await Bun.write(join(outputDirectory, `${name}-${size.width}x${size.height}.txt`), bordered(renderScreen(state, size), size.width));
}

await mkdir(outputDirectory, { recursive: true });
for (const stale of await readdir(outputDirectory)) {
  if (stale.endsWith(".txt")) await Bun.write(join(outputDirectory, stale), "");
}
for (const screen of screens) {
  for (const size of sizes) await capture(screen, evidenceState(screen), size);
  await capture(`${screen}-detail`, activatedDetailState(screen), { width: 80, height: 24 });
}
for (const size of sizes) {
  await capture("inbox-focus-before-selection", focusBeforeSelectionState(), size);
  await capture("unknown-coverage", unknownCoverageState(), size);
  await capture("approvals-disconnected", disconnectedApprovalsState(false), size);
  await capture("approvals-degraded", disconnectedApprovalsState(true), size);
  await capture("doctor-stale", staleDoctorState(), size);
}
