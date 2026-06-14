/**
 * Phone client connection state machine (docs/phone/protocol-v1.md).
 *
 * ```text
 * idle ──connect──▶ connecting ──ws-open──▶ hello-sent ──hello-ack──▶ waiting-accept
 *                                                │ (acceptRequired=false)     │ accepted
 *                                                ▼                            ▼
 *                  reconnecting ◀──ws-lost── negotiating ──ice-connected──▶ live
 *                       │ ws-open → hello-sent (re-hello)
 * any ──fatal/stop──▶ ended (terminal)
 * ```
 *
 * Framework-free: no DOM, no React. The shell (browser page today, Capacitor
 * app later) subscribes and renders.
 */

export type PhoneState =
  | "idle"
  | "connecting"
  | "hello-sent"
  | "waiting-accept"
  | "negotiating"
  | "live"
  | "reconnecting"
  | "ended";

export type PhoneEvent =
  | { kind: "connect" }
  | { kind: "ws-open" }
  | { kind: "hello-ack"; acceptRequired: boolean }
  | { kind: "accepted" }
  | { kind: "ice-connected" }
  | { kind: "ws-lost" }
  | { kind: "fatal"; reason: string }
  | { kind: "stop" };

export type Listener = (state: PhoneState, reason: string | null) => void;

const RECOVERABLE: PhoneState[] = [
  "connecting",
  "hello-sent",
  "waiting-accept",
  "negotiating",
  "live",
];

export class PhoneMachine {
  private current: PhoneState = "idle";
  private endReason: string | null = null;
  private listeners = new Set<Listener>();

  get state(): PhoneState {
    return this.current;
  }

  /** Why the machine ended; null unless state is "ended". */
  get reason(): string | null {
    return this.endReason;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.current, this.endReason);
    return () => this.listeners.delete(listener);
  }

  /** Apply an event. Invalid (state, event) pairs are ignored. */
  dispatch(event: PhoneEvent): PhoneState {
    const next = this.next(event);
    if (next !== this.current) {
      this.current = next;
      for (const l of this.listeners) l(this.current, this.endReason);
    }
    return this.current;
  }

  private next(event: PhoneEvent): PhoneState {
    const s = this.current;
    if (s === "ended") return s;

    switch (event.kind) {
      case "connect":
        return s === "idle" ? "connecting" : s;
      case "ws-open":
        return s === "connecting" || s === "reconnecting" ? "hello-sent" : s;
      case "hello-ack":
        if (s !== "hello-sent") return s;
        return event.acceptRequired ? "waiting-accept" : "negotiating";
      case "accepted":
        return s === "waiting-accept" ? "negotiating" : s;
      case "ice-connected":
        return s === "negotiating" ? "live" : s;
      case "ws-lost":
        return RECOVERABLE.includes(s) ? "reconnecting" : s;
      case "fatal":
        this.endReason = event.reason;
        return "ended";
      case "stop":
        this.endReason = "user-stop";
        return "ended";
    }
  }
}
