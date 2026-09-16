import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createInitialState, reduce, renderScreen, screens, type Row, type Screen, type TuiState } from "../src/index.ts";

const rows: Record<Screen, Row[]> = {
  inbox: [
    { id: "slack:work:ops", author: "운영", ts: "09:41", body: "한국어 상태 업데이트", edited: true },
    { id: "slack:work:dev", author: "개발", ts: "09:38", body: "다음 점검 항목" },
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

const outputDirectory = join(import.meta.dir, "..", "rendered");
await mkdir(outputDirectory, { recursive: true });
for (const screen of screens) {
  for (const size of [{ width: 80, height: 24 }, { width: 120, height: 40 }]) {
    const output = renderScreen(evidenceState(screen), size)
      .split("\n")
      .map((line) => `${line.slice(0, -1)}│`)
      .join("\n");
    await Bun.write(join(outputDirectory, `${screen}-${size.width}x${size.height}.txt`), output);
  }
  const detail = renderScreen(activatedDetailState(screen), { width: 80, height: 24 })
    .split("\n")
    .map((line) => `${line.slice(0, -1)}│`)
    .join("\n");
  await Bun.write(join(outputDirectory, `${screen}-detail-80x24.txt`), detail);
}
