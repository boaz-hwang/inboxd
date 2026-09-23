import { StyledText, RGBA, type TextChunk } from "@opentui/core";

import type { TuiState } from "./index.ts";
import { selectionFrame } from "./workspace.ts";
import { displayWidth } from "./text.ts";

const colors = { base: "#D6DEE8", muted: "#8795A9", accent: "#91BAF5", slack: "#CFA5EB", telegram: "#78CBE8", kakao: "#F3D36A" };
/** Paint semantic chrome and provider marks, without embedding ANSI in message content. */
export function styleWorkspace(content: string, state: TuiState, size: { width: number; height: number }): StyledText {
  const chunks: TextChunk[] = [];
  const frame = selectionFrame(state, size.width, size.height);
  const platform = state.activeResource?.platform;
  const borderColor = platform === "slack" ? colors.slack : platform === "telegram" ? colors.telegram : platform === "kakao" ? colors.kakao : colors.accent;
  const lines = content.split("\n");
  const ghostStart = lines.findIndex(line => line.includes("메시지 · 추천"));
  const ghostEnd = ghostStart < 0 ? -1 : lines.findIndex((line, index) => index > ghostStart && line.includes("Tab 추천 수락"));
  lines.forEach((line, index) => {
    const selected = line.startsWith("›") || line.startsWith("●");
    const base = index === 0 ? colors.accent : index === 1 || index === lines.length - 1 || !frame && /^[─│╭╰]/.test(line) ? colors.muted : colors.base;
    const pieces = line.split(/(\[(?:SL|TG|KK)\]|Slack|Telegram|KakaoTalk|[╭╮╰╯│─])/g);
    let column = 0;
    for (const piece of pieces) {
      const row = index - 3;
      const roomTop = frame?.roomTop;
      const border = frame && row >= 0 && row < frame.height && (
        column >= frame.left && (row === 0 || row === frame.height - 1 || column === size.width - 1 || column === frame.left && !(roomTop !== undefined && row > roomTop && row < roomTop + 3)) ||
        roomTop !== undefined && column < frame.left && (row === roomTop || row === roomTop + 3 || column === 0 && row > roomTop && row < roomTop + 3)
      );
      const color = ghostStart >= 0 && index > ghostStart && index < ghostEnd && column > (frame?.left ?? 0) ? colors.muted : border ? borderColor : piece === "[SL]" || piece === "Slack" ? colors.slack : piece === "[TG]" || piece === "Telegram" ? colors.telegram : piece === "[KK]" || piece === "KakaoTalk" ? colors.kakao : base;
      chunks.push({ __isChunk: true, text: piece, fg: RGBA.fromHex(color), ...(selected ? { bg: RGBA.fromHex("#243348") } : {}), ...(index === 0 ? { attributes: 1 } : {}) });
      column += displayWidth(piece);
    }
    if (index < lines.length - 1) chunks.push({ __isChunk: true, text: "\n" });
  });
  return new StyledText(chunks);
}
