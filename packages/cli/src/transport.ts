import { createConnection, type Socket } from "node:net";

import { JsonLinesDecoder, encodeJsonLine, parseMessage, type ProtocolMessage, type ProtocolTransport } from "../../protocol/src/index.ts";

export type UdsTransportErrorCode = "CONNECT_FAILED" | "FRAME_ERROR" | "TRANSPORT_CLOSED" | "TRANSPORT_WRITE_FAILED";

/** Typed UDS failure; it never exposes storage details. */
export class UdsTransportError extends Error {
  readonly code: UdsTransportErrorCode;

  constructor(code: UdsTransportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UdsTransportError";
    this.code = code;
  }
}

class JsonLinesUdsTransport implements ProtocolTransport {
  private messageListener: ((message: ProtocolMessage) => void) | undefined;
  private closeListener: (() => void) | undefined;
  private closed = false;
  private readonly decoder = new JsonLinesDecoder();

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", () => this.finish());
    socket.on("close", () => this.finish());
  }

  send(message: ProtocolMessage): void {
    if (this.closed || this.socket.destroyed) {
      throw new UdsTransportError("TRANSPORT_CLOSED", "daemon transport is closed");
    }
    try {
      this.socket.write(encodeJsonLine(message));
    } catch (error) {
      throw new UdsTransportError("TRANSPORT_WRITE_FAILED", "failed to write daemon request", { cause: error });
    }
  }

  onMessage(listener: (message: ProtocolMessage) => void): () => void {
    this.messageListener = listener;
    return () => { if (this.messageListener === listener) this.messageListener = undefined; };
  }

  onClose(listener: () => void): () => void {
    this.closeListener = listener;
    return () => { if (this.closeListener === listener) this.closeListener = undefined; };
  }

  close(): void {
    if (!this.closed) this.socket.destroy();
  }

  private handleData(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) this.messageListener?.(parseMessage(frame));
    } catch {
      this.socket.destroy();
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeListener?.();
  }
}

/** Connects the CLI to the daemon's JSON-lines Unix-domain socket. */
export function connectUdsTransport(socketPath: string): Promise<ProtocolTransport> {
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    return Promise.reject(new UdsTransportError("CONNECT_FAILED", "socket endpoint must be a non-empty string"));
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let connected = false;
    const fail = (error: Error) => {
      if (!connected) reject(new UdsTransportError("CONNECT_FAILED", "unable to connect to daemon socket", { cause: error }));
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      connected = true;
      socket.removeListener("error", fail);
      resolve(new JsonLinesUdsTransport(socket));
    });
  });
}
