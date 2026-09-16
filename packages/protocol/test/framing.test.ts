import { describe, expect, test } from "bun:test";
import { JsonLinesDecoder, encodeJsonLine } from "../src/index.ts";

describe("JSON-lines framing", () => {
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
