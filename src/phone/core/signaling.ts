/**
 * WebSocket signaling client with bounded-backoff reconnect.
 *
 * Framework-free (see protocol.ts). The owner decides what to send and how
 * to react; this class only manages the socket lifecycle: connect, parse
 * inbound frames, reconnect with 1s→15s backoff after recoverable drops,
 * stay closed after `close()`.
 */

import { parseServerMessage, type ClientMessage, type ServerMessage } from "./protocol";

export interface SignalingCallbacks {
  /** Socket is open — the owner must send `hello` now. */
  onOpen(): void;
  onMessage(msg: ServerMessage): void;
  /** Recoverable drop; a reconnect attempt is already scheduled. */
  onLost(): void;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15000;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private backoffMs = BACKOFF_START_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly callbacks: SignalingCallbacks,
  ) {}

  /** Build the signaling URL for the page we were served from. */
  static defaultUrl(): string {
    return `wss://${location.host}/ws`;
  }

  connect(): void {
    if (this.closed || this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = BACKOFF_START_MS;
      this.callbacks.onOpen();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (msg) this.callbacks.onMessage(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.closed) return;
      this.callbacks.onLost();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  send(msg: ClientMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Permanent close: no further reconnects. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }
}
