export function displayWidth(value: string): number {
  return Bun.stringWidth(value);
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
      if (line && displayWidth(line) + displayWidth(segment) > width) { lines.push(line); line = ""; }
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
