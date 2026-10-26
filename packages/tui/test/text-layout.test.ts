import { expect, test } from "bun:test";
import { CURSOR_MARK, displayWidth, truncateCells, wrapCells } from "../src/text.ts";

test("wrapping preserves Korean, joined emoji and combining graphemes", () => {
  expect(wrapCells("가나👩‍💻é🇰🇷", 4)).toEqual(["가나", "👩‍💻é", "🇰🇷"]);
  expect(truncateCells("가👩‍💻나다", 5)).toBe("가👩‍💻…");
  expect(wrapCells("가\n\n나", 4)).toEqual(["가", "", "나"]);
});

test("zero-width editor caret follows the character when wrapping", () => {
  expect(wrapCells(`가나${CURSOR_MARK}다`, 4)).toEqual(["가나", `${CURSOR_MARK}다`]);
  const body = "안녕 👩‍👩‍👧‍👦 é 🇰🇷 ❤️".repeat(30);
  for (const width of [2, 4, 17, 40, 80]) {
    const lines = wrapCells(body, width);
    expect(lines.join("")).toBe(body);
    expect(lines.every(line => displayWidth(line) <= width)).toBe(true);
  }
});
