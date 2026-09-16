import {
  createHandshake,
  parseEvent,
  parseRequest,
  parseResponse,
  type ClientRole,
  type JsonObject,
  type ProtocolEvent,
  type ProtocolEventMethod,
  type ProtocolMessage,
  type ProtocolMethod,
  type ProtocolRequest,
} from "./schema.ts";
import { SubscriptionQueue, subscriptionParams } from "./subscriptions.ts";

export interface ProtocolTransport {
  send(message: ProtocolMessage): void;
  onMessage(listener: (message: ProtocolMessage) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface ReconnectingProtocolClientOptions {
  connect: () => Promise<ProtocolTransport>;
  role: ClientRole;
  isTTY?: () => boolean;
  maxQueuedEvents?: number;
  onEvent?: (event: ProtocolEvent) => void;
}

interface PendingRequest {
  generation: number;
  method: ProtocolMethod;
  resolve: (result: JsonObject) => void;
  reject: (error: Error) => void;
}

/** A generation-safe client for the daemon's request/response/event stream. */
export class ReconnectingProtocolClient {
  private readonly connectTransport: () => Promise<ProtocolTransport>;
  private readonly role: ClientRole;
  private readonly isTTY: () => boolean;
  private readonly maxQueuedEvents: number | undefined;
  private readonly onEvent: (event: ProtocolEvent) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private topics: ProtocolEventMethod[] = [];
  private transport: ProtocolTransport | undefined;
  private subscriptions: SubscriptionQueue | undefined;
  private generation = 0;
  private activeGeneration = 0;
  private nextId = 0;
  private stopped = false;
  private starting: Promise<void> | undefined;

  ready = false;
  requeryRequired = false;

  constructor(options: ReconnectingProtocolClientOptions) {
    this.connectTransport = options.connect;
    this.role = options.role;
    this.isTTY = options.isTTY ?? defaultTTYProbe;
    this.maxQueuedEvents = options.maxQueuedEvents;
    this.onEvent = options.onEvent ?? (() => {});
  }

  start(topics: readonly ProtocolEventMethod[]): Promise<void> {
    this.stopped = false;
    this.topics = [...new Set(topics)];
    return this.ensureConnected();
  }

  stop(): void {
    const activeGeneration = this.activeGeneration;
    this.stopped = true;
    this.ready = false;
    this.activeGeneration = ++this.generation;
    this.transport?.close();
    this.transport = undefined;
    this.subscriptions = undefined;
    this.starting = undefined;
    this.rejectGeneration(activeGeneration, new Error("protocol client stopped"));
  }

  async request(method: ProtocolMethod, params: JsonObject): Promise<JsonObject> {
    if (!this.ready || this.transport === undefined) {
      throw new Error("protocol client is not ready");
    }
    return this.sendRequest(method, params, this.activeGeneration);
  }

  private async establish(): Promise<void> {
    this.ready = false;
    const generation = ++this.generation;
    this.activeGeneration = generation;
    const transport = await this.connectTransport();
    if (this.stopped || generation !== this.activeGeneration) {
      transport.close();
      return;
    }
    this.transport = transport;
    this.subscriptions = this.createSubscriptions();
    transport.onMessage((message) => this.handleMessage(message, generation));
    transport.onClose(() => this.handleClose(generation));

    await this.sendRequest("system.hello", createHandshake(this.role, this.isTTY), generation);
    if (generation !== this.activeGeneration || this.stopped) return;
    await this.sendRequest("subscribe", subscriptionParams(this.topics), generation);
    if (generation !== this.activeGeneration || this.stopped) return;
    this.ready = true;
  }

  private ensureConnected(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting !== undefined) return this.starting;
    const starting = this.establish();
    this.starting = starting;
    void starting.then(
      () => { if (this.starting === starting) this.starting = undefined; },
      () => { if (this.starting === starting) this.starting = undefined; },
    );
    return starting;
  }

  private sendRequest(method: ProtocolMethod, params: JsonObject, generation: number): Promise<JsonObject> {
    const transport = this.transport;
    if (transport === undefined || generation !== this.activeGeneration) {
      return Promise.reject(new Error("protocol connection is unavailable"));
    }
    const id = `g${generation}-${++this.nextId}`;
    const request: ProtocolRequest = { type: "request", id, method, params };
    return new Promise<JsonObject>((resolve, reject) => {
      let validated: ProtocolRequest;
      try {
        validated = parseRequest(request, this.role);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("protocol transport send failed"));
        return;
      }
      this.pending.set(id, { generation, method, resolve, reject });
      try {
        transport.send(validated);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("protocol transport send failed"));
      }
    });
  }

  private handleMessage(message: ProtocolMessage, generation: number): void {
    if (generation !== this.activeGeneration) return;
    if (message.type === "event") {
      const event = parseEvent(message);
      this.requeryRequired = true;
      this.subscriptions?.enqueue(event);
      return;
    }
    if (message.type !== "response") return;
    const response = parseResponse(message, this.role);
    const pending = this.pending.get(response.id);
    if (pending === undefined || pending.generation !== generation) return;
    this.pending.delete(response.id);
    if (pending.method !== response.method) {
      pending.reject(new Error("protocol response method did not match request"));
    } else if (response.ok) {
      pending.resolve(response.result!);
    } else {
      pending.reject(new Error(response.error!.message));
    }
  }

  private handleClose(generation: number): void {
    if (generation !== this.activeGeneration || this.stopped) return;
    this.ready = false;
    this.transport = undefined;
    this.requeryRequired = true;
    this.rejectGeneration(generation, new Error("protocol connection closed"));
    this.subscriptions = undefined;
    void this.ensureConnected().catch(() => {});
  }

  private rejectGeneration(generation: number, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation === generation) {
        this.pending.delete(id);
        pending.reject(error);
      }
    }
  }

  private createSubscriptions(): SubscriptionQueue {
    return new SubscriptionQueue({
      maxQueuedEvents: this.maxQueuedEvents,
      onEvent: this.onEvent,
      onOverflow: () => {
        this.requeryRequired = true;
        this.transport?.close();
      },
    });
  }
}

function defaultTTYProbe(): boolean {
  const processLike = (globalThis as { process?: { stdout?: { isTTY?: boolean } } }).process;
  return Boolean(processLike?.stdout?.isTTY);
}
