import { describe, expect, test } from "bun:test";
import { JsonLinesDecoder, encodeJsonLine } from "../src/index.ts";

describe("JSON-lines framing", () => {
  test("isolates interleaved split multibyte streams per connection", () => {
    const first = new JsonLinesDecoder();
    const second = new JsonLinesDecoder();
    const a = new TextEncoder().encode('"한"\n');
    const b = new TextEncoder().encode('"🙂"\n');
    expect(first.push(a.slice(0, 2))).toEqual([]);
    expect(second.push(b.slice(0, 3))).toEqual([]);
    expect(first.push(a.slice(2))).toEqual(["한"]);
    expect(second.push(b.slice(3))).toEqual(["🙂"]);
  });
  test("decodes complete newline-delimited JSON frames across chunks", () => {
    const decoder = new JsonLinesDecoder({ maxLineBytes: 128 });
    expect(decoder.push('{"type":"event",')).toEqual([]);
    expect(decoder.push('"method":"message.upserted","params":{}}\n')).toEqual([
      { type: "event", method: "message.upserted", params: {} },
    ]);
  });

  test("rejects malformed frames and frames exceeding the configured bound", () => {
    const malformed = new JsonLinesDecoder({ maxLineBytes: 128 });
    expect(() => malformed.push("{not json}\n")).toThrow(/JSON/i);

    const oversized = new JsonLinesDecoder({ maxLineBytes: 8 });
    expect(() => oversized.push("123456789")).toThrow(/maximum/i);
    expect(() => encodeJsonLine({ payload: "123456789" }, 8)).toThrow(/maximum/i);
  });
});
