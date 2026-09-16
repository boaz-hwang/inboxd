import { createConnection, type Socket } from "node:net";

import { JsonLinesDecoder, encodeJsonLine, parseMessage, type ProtocolMessage, type ProtocolTransport } from "../../protocol/src/index.ts";

/** Protocol transport used by the TUI; it owns only the UDS framing layer. */
class JsonLinesTuiTransport implements ProtocolTransport {
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
    if (this.closed || this.socket.destroyed) throw new Error("daemon transport is closed");
    this.socket.write(encodeJsonLine(message));
  }

  onMessage(listener: (message: ProtocolMessage) => void): () => void {
    this.messageListener = listener;
    return () => { if (this.messageListener === listener) this.messageListener = undefined; };
  }

  onClose(listener: () => void): () => void {
    this.closeListener = listener;
    return () => { if (this.closeListener === listener) this.closeListener = undefined; };
  }

  close(): void { if (!this.closed) this.socket.destroy(); }

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

export function connectTuiUdsTransport(socketPath: string): Promise<ProtocolTransport> {
  if (socketPath.trim().length === 0) return Promise.reject(new Error("socket endpoint must be a non-empty string"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let connected = false;
    const fail = () => { if (!connected) reject(new Error("unable to connect to daemon socket")); };
    socket.once("error", fail);
    socket.once("connect", () => {
      connected = true;
      socket.removeListener("error", fail);
      resolve(new JsonLinesTuiTransport(socket));
    });
  });
}
