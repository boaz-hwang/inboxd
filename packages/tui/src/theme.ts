import { StyledText, RGBA, type TextChunk } from "@opentui/core";

const colors = { base: "#D6DEE8", muted: "#8795A9", accent: "#91BAF5", slack: "#CFA5EB", telegram: "#78CBE8", kakao: "#F3D36A" };
/** Paint semantic chrome and provider marks, without embedding ANSI in message content. */
export function styleWorkspace(content: string): StyledText {
  const chunks: TextChunk[] = [];
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    const selected = line.startsWith("›") || line.startsWith("●");
    const base = index === 0 ? colors.accent : index === 1 || index === lines.length - 1 || /^[─│╭╰]/.test(line) ? colors.muted : colors.base;
    const pieces = line.split(/(\[(?:SL|TG|KK)\]|Slack|Telegram|KakaoTalk)/g);
    for (const piece of pieces) {
      const color = piece === "[SL]" || piece === "Slack" ? colors.slack : piece === "[TG]" || piece === "Telegram" ? colors.telegram : piece === "[KK]" || piece === "KakaoTalk" ? colors.kakao : base;
      chunks.push({ __isChunk: true, text: piece, fg: RGBA.fromHex(color), ...(selected ? { bg: RGBA.fromHex("#243348") } : {}), ...(index === 0 ? { attributes: 1 } : {}) });
    }
    if (index < lines.length - 1) chunks.push({ __isChunk: true, text: "\n" });
  });
  return new StyledText(chunks);
}
