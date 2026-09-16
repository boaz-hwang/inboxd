export class JsonLinesFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonLinesFrameError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface JsonLinesOptions {
  maxLineBytes?: number;
}

export class JsonLinesDecoder {
  private readonly maxLineBytes: number;
  private buffer = "";

  constructor(options: JsonLinesOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes <= 0) {
      throw new JsonLinesFrameError("maximum line size must be a positive integer");
    }
  }

  push(chunk: string | Uint8Array): unknown[] {
    this.buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (encoder.encode(this.buffer).byteLength > this.maxLineBytes && !this.buffer.includes("\n")) {
      throw new JsonLinesFrameError(`frame exceeds maximum line size of ${this.maxLineBytes} bytes`);
    }

    const frames: unknown[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (encoder.encode(line).byteLength > this.maxLineBytes) {
        throw new JsonLinesFrameError(`frame exceeds maximum line size of ${this.maxLineBytes} bytes`);
      }
      if (line.length === 0) throw new JsonLinesFrameError("empty JSON-lines frame");
      try {
        frames.push(JSON.parse(line));
      } catch {
        throw new JsonLinesFrameError("malformed JSON frame");
      }
    }
    if (encoder.encode(this.buffer).byteLength > this.maxLineBytes) {
      throw new JsonLinesFrameError(`frame exceeds maximum line size of ${this.maxLineBytes} bytes`);
    }
    return frames;
  }
}

export function encodeJsonLine(value: unknown, maxLineBytes = 64 * 1024): string {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new JsonLinesFrameError("maximum line size must be a positive integer");
  }
  const line = JSON.stringify(value);
  if (line === undefined) throw new JsonLinesFrameError("frame must be JSON serializable");
  if (line.includes("\n") || line.includes("\r")) throw new JsonLinesFrameError("frame may not contain literal newlines");
  if (encoder.encode(line).byteLength > maxLineBytes) {
    throw new JsonLinesFrameError(`frame exceeds maximum line size of ${maxLineBytes} bytes`);
  }
  return `${line}\n`;
}
