/**
 * Signaling protocol v1 — phone-side types and helpers.
 *
 * Wire contract: docs/phone/protocol-v1.md (desktop mirror:
 * src-tauri/src/net/signaling.rs). This module is framework-free and must
 * stay importable from a future Capacitor shell unchanged: no React, no
 * Vite-specific imports, browser APIs only.
 */

export const PROTOCOL_VERSION = 1 as const;

export interface PairingParams {
  session: string;
  token: string;
}

/** Parse `#s=<session>&t=<token>` from the QR URL fragment. */
export function pairingFromHash(hash: string): PairingParams | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const session = params.get("s");
  const token = params.get("t");
  if (!session || !token) return null;
  return { session, token };
}

// ── Client → server ───────────────────────────────────────────────────────────

export type ClientKind = "browser" | "app";

export interface ClientHello {
  v: typeof PROTOCOL_VERSION;
  type: "hello";
  session: string;
  token: string;
  client: { kind: ClientKind; os: string; ua: string; ver: string };
  caps: { codecs: string[] };
  name?: string;
}

export interface ClientOffer {
  v: typeof PROTOCOL_VERSION;
  type: "offer";
  sdp: string;
}

export interface ClientCandidate {
  v: typeof PROTOCOL_VERSION;
  type: "candidate";
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export interface ClientStats {
  v: typeof PROTOCOL_VERSION;
  type: "stats";
  micLevel: number;
  visible: boolean;
  muted?: boolean;
  batterySaver?: boolean;
}

export interface ClientBye {
  v: typeof PROTOCOL_VERSION;
  type: "bye";
  reason: string;
}

/** OS endpoint the phone remote controls (MC-5). */
export type EndpointTarget = "speaker" | "mic";

export interface ClientSetEndpointVolume {
  v: typeof PROTOCOL_VERSION;
  type: "set-endpoint-volume";
  target: EndpointTarget;
  /** 0..1 scalar. */
  value: number;
}

export interface ClientSetEndpointMute {
  v: typeof PROTOCOL_VERSION;
  type: "set-endpoint-mute";
  target: EndpointTarget;
  muted: boolean;
}

export interface ClientRequestEndpointState {
  v: typeof PROTOCOL_VERSION;
  type: "request-endpoint-state";
}

export type ClientMessage =
  | ClientHello
  | ClientOffer
  | ClientCandidate
  | ClientStats
  | ClientBye
  | ClientSetEndpointVolume
  | ClientSetEndpointMute
  | ClientRequestEndpointState;

export function helloMessage(
  pairing: PairingParams,
  opts: { kind: ClientKind; name?: string; appVersion?: string },
): ClientHello {
  return {
    v: PROTOCOL_VERSION,
    type: "hello",
    session: pairing.session,
    token: pairing.token,
    client: {
      kind: opts.kind,
      os: detectOs(),
      ua: navigator.userAgent,
      ver: opts.appVersion ?? "0",
    },
    caps: { codecs: ["opus"] },
    ...(opts.name ? { name: opts.name } : {}),
  };
}

export function offerMessage(sdp: string): ClientOffer {
  return { v: PROTOCOL_VERSION, type: "offer", sdp };
}

export function candidateMessage(c: RTCIceCandidateInit): ClientCandidate {
  return {
    v: PROTOCOL_VERSION,
    type: "candidate",
    candidate: c.candidate ?? "",
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
  };
}

export function statsMessage(
  micLevel: number,
  visible: boolean,
  muted = false,
  batterySaver = false,
): ClientStats {
  const msg: ClientStats = { v: PROTOCOL_VERSION, type: "stats", micLevel, visible, muted };
  // Only include when set, so the common case stays minimal.
  if (batterySaver) msg.batterySaver = true;
  return msg;
}

export function byeMessage(reason: string): ClientBye {
  return { v: PROTOCOL_VERSION, type: "bye", reason };
}

export function setEndpointVolumeMessage(
  target: EndpointTarget,
  value: number,
): ClientSetEndpointVolume {
  return { v: PROTOCOL_VERSION, type: "set-endpoint-volume", target, value };
}

export function setEndpointMuteMessage(
  target: EndpointTarget,
  muted: boolean,
): ClientSetEndpointMute {
  return { v: PROTOCOL_VERSION, type: "set-endpoint-mute", target, muted };
}

export function requestEndpointStateMessage(): ClientRequestEndpointState {
  return { v: PROTOCOL_VERSION, type: "request-endpoint-state" };
}

// ── Server → client ───────────────────────────────────────────────────────────

export type ServerMessage =
  | {
      type: "hello-ack";
      state: string;
      acceptRequired: boolean;
      server: { name: string; appVer: string };
    }
  | { type: "accepted" }
  | { type: "rejected"; reason: string }
  | { type: "answer"; sdp: string }
  | {
      type: "candidate";
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    }
  | { type: "latency"; mode: "fastest" | "balanced" | "stable" }
  | { type: "endpoint-state"; endpoints: EndpointStateView[] }
  | { type: "error"; code: string; message: string; supported?: number[] }
  | { type: "bye"; reason: string };

/** One endpoint's live state pushed to the phone remote (MC-5). */
export interface EndpointStateView {
  target: EndpointTarget;
  name: string;
  volume: number;
  muted: boolean;
  available: boolean;
}

/**
 * Parse a server frame. Returns null for malformed frames or unknown
 * majors — both terminal for the caller. Unknown message types parse to
 * null too and should be ignored (forward compatibility).
 */
export function parseServerMessage(text: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.v !== PROTOCOL_VERSION) return null;
  if (typeof obj.type !== "string") return null;
  const known: ServerMessage["type"][] = [
    "hello-ack",
    "accepted",
    "rejected",
    "answer",
    "candidate",
    "latency",
    "endpoint-state",
    "error",
    "bye",
  ];
  if (!known.includes(obj.type as ServerMessage["type"])) return null;
  return obj as unknown as ServerMessage;
}

/** Error codes the desktop marks fatal (protocol-v1.md). */
export function isFatalErrorCode(code: string): boolean {
  return ["version", "bad-token", "unknown-session", "busy", "rejected", "malformed"].includes(
    code,
  );
}

function detectOs(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "unknown";
}

/** Default device label shown in the desktop pairing sheet. */
export function defaultDeviceName(): string {
  const os = detectOs();
  if (os === "iOS") return /iPad/i.test(navigator.userAgent) ? "iPad" : "iPhone";
  if (os === "Android") return "Android phone";
  return `${os} device`;
}
