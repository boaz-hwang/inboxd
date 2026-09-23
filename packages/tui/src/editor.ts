/** Terminal-style editing, using UTF-16 offsets at grapheme boundaries. */
export function editDraft(text: string, offset: number, key: string): { text: string; cursor: number } | undefined {
  const cursor = Math.max(0, Math.min(offset, text.length));
  const left = text.slice(0, cursor), right = text.slice(cursor);
  const segments = (value: string) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value));
  const previous = segments(left).at(-1)?.index ?? 0;
  const next = cursor + (segments(right)[0]?.segment.length ?? 0);
  const start = left.lastIndexOf("\n") + 1;
  const end = text.indexOf("\n", cursor) < 0 ? text.length : text.indexOf("\n", cursor);
  const wordLeft = left.replace(/[^\s]+\s*$/u, "").length;
  const wordRight = cursor + (right.match(/^\s*[^\s]+/u)?.[0].length ?? right.length);
  const move = (position: number) => ({ text, cursor: position });
  const remove = (from: number, to: number) => ({ text: text.slice(0, from) + text.slice(to), cursor: from });
  switch (key) {
    case "ArrowLeft": return move(previous);
    case "ArrowRight": return move(next);
    case "WordLeft": return move(wordLeft);
    case "WordRight": return move(wordRight);
    case "Home": return move(start);
    case "End": return move(end);
    case "BufferHome": return move(0);
    case "BufferEnd": return move(text.length);
    case "Backspace": return remove(previous, cursor);
    case "Delete": return remove(cursor, next);
    case "DeleteWordLeft": return remove(wordLeft, cursor);
    case "DeleteWordRight": return remove(cursor, wordRight);
    case "KillLineLeft": return remove(start === cursor ? previous : start, cursor);
    case "KillLineRight": return remove(cursor, end === cursor ? next : end);
    case "ArrowUp":
    case "ArrowDown": {
      const column = segments(text.slice(start, cursor)).length;
      const targetStart = key === "ArrowUp" ? text.lastIndexOf("\n", start - 2) + 1 : end + 1;
      if (key === "ArrowUp" && start === 0) return move(0);
      if (key === "ArrowDown" && end === text.length) return move(text.length);
      const targetEnd = text.indexOf("\n", targetStart);
      const line = text.slice(targetStart, targetEnd < 0 ? text.length : targetEnd);
      return move(targetStart + (segments(line)[column]?.index ?? line.length));
    }
  }
}
