export interface DeviceInfo {
  id: string;
  name: string;
  default_sample_rate: number;
  channels: number;
  is_default: boolean;
}

export interface DeviceListError {
  message: string;
}

/**
 * A capturable application, returned by `list_audio_sessions`. `source_id` is a
 * ready id to pass to `addInput` for per-app loopback capture: `app:<image>` for
 * a named app (stable across restarts), or `proc:<pid>` only when the image name
 * couldn't be resolved. Pass it through opaquely — don't parse the prefix.
 */
export interface AudioSessionInfo {
  pid: number;
  name: string;
  source_id: string;
}

export interface PassthroughStatus {
  running: boolean;
  input_device: string | null;
  output_device: string | null;
}

// Rust field names are snake_case; serde serializes them as-is.
export interface Route {
  input_id: string;
  output_id: string;
  enabled: boolean;
  active: boolean;
  /** Per-route gain in [0.0, 2.0]. Default 1.0 (= 100%). */
  volume: number;
  /** True when this input is muted (contributes silence). */
  muted: boolean;
}

export interface EngineStatus {
  status: "stopped" | "running" | "error";
  output_device: string | null;
  active_inputs: string[];
  input_peaks: number[];
  output_peak: number;
  clipped_recently: boolean;
  last_error: string | null;
}

export interface PresetSummary {
  name: string;
  saved_at_utc: string;
  route_count: number;
  schema_version: number;
}

export interface PresetLoadWarning {
  code: string;
  message: string;
}

export interface PresetLoadResult {
  preset: PresetSummary;
  routes: Route[];
  warnings: PresetLoadWarning[];
}

// ── Phase 8A: output buses ────────────────────────────────────────────────────

/** Fixed bus identifier. Serialized as a plain string by the backend. */
export type BusId = "A1" | "A2" | "B1" | "B2";

export interface BusStatus {
  id: BusId;
  name: string;
  output_device: string | null;
  /** Per-bus gain in [0.0, 2.0]. Default 1.0. */
  volume: number;
  muted: boolean;
  enabled: boolean;
  running: boolean;
  output_peak: number;
  clipped_recently: boolean;
  last_error: string | null;
}

export interface SystemStatus {
  buses: BusStatus[];
  inputs: InputChannel[];
  input_peaks: InputPeakStatus[];
  last_error: string | null;
}

export interface InputSend {
  bus_id: BusId;
  enabled: boolean;
  volume: number;
  muted: boolean;
}

export interface InputChannel {
  device_id: string;
  gain: number;
  muted: boolean;
  sends: InputSend[];
}

export interface InputPeakStatus {
  device_id: string;
  peak: number;
}

// ── Recording ────────────────────────────────────────────────────────────────

/**
 * What the user asked to record. The `kind` discriminant matches the
 * `#[serde(tag = "kind", rename_all = "snake_case")]` attribute on the
 * Rust `TapSpec` enum.
 */
export type TapSpec =
  | { kind: "input_pre"; device_id: string }
  | { kind: "input_post"; device_id: string; bus_id: BusId }
  | { kind: "bus_out"; bus_id: BusId };

export interface RecordingInfo {
  id: string;
  spec: TapSpec;
  file_path: string;
  channels: number;
  sample_rate: number;
  started_at_unix_ms: number;
  samples_written: number;
  bytes_written: number;
  dropped_samples: number;
  engine_bus: BusId;
  error: string | null;
}

export interface RecordingFile {
  name: string;
  file_path: string;
  size_bytes: number;
  modified_unix_ms: number;
}

// ── AudioManager Virtual Cable helper (amvc-helper) ──────────────────────────

export type AmvcHealthStatus =
  | "not-installed"
  | "installed-healthy"
  | "installed-degraded"
  | "needs-repair"
  | "needs-reboot";

export interface AmvcStatus {
  status: AmvcHealthStatus;
  found: number;
  expected: number;
  driver_in_store: boolean;
  reboot_pending: boolean;
  names_aligned: boolean;
  detected: string[];
  missing: string[];
}

/**
 * Discriminated union returned by the `query_amvc_helper` Tauri command.
 *
 * `kind: "ok"` — helper ran and returned valid JSON (driver may still be absent).
 * `kind: "unavailable"` — helper binary not found or output could not be parsed.
 */
export type AmvcQueryResult =
  | ({ kind: "ok" } & AmvcStatus)
  | { kind: "unavailable"; reason: string };

// ── Phone Wireless Audio (#39-#45) ───────────────────────────────────────────

/** Mirror of `net::session::SessionState` (serde kebab-case). */
export type PhoneSessionState =
  | "created"
  | "pending-accept"
  | "accepted"
  | "reconnecting"
  | "disconnected"
  | "expired";

/** Mirror of `net::PhoneServerStatus`. */
export interface PhoneServerStatus {
  running: boolean;
  port: number | null;
  lanIps: string[];
  /** Server running but a LAN connect fails => a firewall is blocking the port. */
  reachable: boolean;
}

/** Mirror of `net::session::PhoneSessionStatus`. Never contains the token. */
export interface PhoneSessionStatus {
  id: string;
  label: string;
  state: PhoneSessionState;
  clientKind: string | null;
  clientOs: string | null;
  expiresInSecs: number | null;
  /** RTP packets received since connect (Phase 2); 0 until audio flows. */
  packets: number;
  /** Estimated lost packets from RTP sequence gaps. */
  lost: number;
  /** Decoded peak level 0..1 since the last poll — the "we hear you" meter. */
  level: number;
  /** Active latency mode (Phase 4). */
  latencyMode: "fastest" | "balanced" | "stable" | "adaptive";
  /** Current jitter-buffer depth in frames. */
  jitterDepth: number;
  /** Cumulative concealed (PLC) frames — rises on packet loss. */
  plc: number;
  /** Times this session resumed after a dropped connection (#44). */
  reconnectCount: number;
  /** Active audio codec once media flows, else null. */
  codec: string | null;
  /** Phone has muted itself (self-reported). */
  muted: boolean;
  /** Phone is in OS data-saver mode (self-reported). */
  batterySaver: boolean;
  /** Frames reconstructed via Opus FEC (Adaptive mode). */
  fecRecovered: number;
  /** Reordered (out-of-order, in-window) arrivals. */
  reorder: number;
  /** Live adaptive jitter window depth in frames. */
  adaptiveTarget: number;
  /** Ring-overflow drops on the mixer feed (weak-link indicator). */
  ringGlitches: number;
  /** Clock-drift trim currently applied, ppm (signed). */
  driftPpm: number;
}

/**
 * Returned by `phone_create_session`. `urls` carry the pairing token in the
 * fragment — render as QR, never log.
 */
export interface PhoneSessionCreated {
  id: string;
  label: string;
  port: number;
  urls: string[];
}

/**
 * Mirror of `net::paired::PairedDeviceStatus` — a persisted trusted device in
 * the "Paired devices" list. Never contains the token/digest.
 */
export interface PhonePairedDevice {
  id: string;
  label: string;
  clientKind: string | null;
  clientOs: string | null;
  /** Unix seconds when first accepted. */
  createdUtc: number;
  /** Unix seconds of the most recent successful connect. */
  lastSeenUtc: number;
}
