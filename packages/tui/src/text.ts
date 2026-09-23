export const CURSOR_MARK = "\u2060";

export function displayWidth(value: string): number {
  return Bun.stringWidth(value.replaceAll(CURSOR_MARK, ""));
}

/** Clips by terminal cells and emits an ellipsis without splitting a grapheme. */
export function truncateCells(value: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  if (width === 1) return "…";
  const target = width - 1;
  let result = "";
  let used = 0;
  const clusters = typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), (part) => part.segment)
    : Array.from(value);
  for (const character of clusters) {
    const characterWidth = displayWidth(character);
    if (used + characterWidth > target) break;
    result += character;
    used += characterWidth;
  }
  return `${result}…`;
}

/** Hard wrap on grapheme boundaries; preserve newlines and every message cell. */
export function wrapCells(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(paragraph)) {
      if (line && displayWidth(line) + displayWidth(segment) > width) { const caret = line.endsWith(CURSOR_MARK); lines.push(caret ? line.slice(0, -1) : line); line = caret ? CURSOR_MARK : ""; }
      line += segment;
    }
    lines.push(line);
  }
  return lines;
}

export function fit(line: string, width: number): string {
  const clipped = truncateCells(line, width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

/** Kakao hidden-message control feeds are transport metadata, not a chat message to render. */
export function messageDisplayBody(platform: string | undefined, body: string | undefined): string | undefined | null {
  if (platform !== "kakao" || !body?.trimStart().startsWith("{")) return body;
  let value: unknown;
  try { value = JSON.parse(body); } catch { return body; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return body;
  const feed = value as Record<string, unknown>;
  if (!Number.isInteger(feed.feedType)
    || !(typeof feed.logId === "string" || typeof feed.logId === "number") || typeof feed.hidden !== "boolean") return body;
  // Do not interpret the target ID, infer deletion, or stringify nested metadata.
  for (const key of ["message", "text", "body"]) {
    const text = feed[key];
    if (typeof text === "string" && text.trim()) return text;
  }
  return null;
}
