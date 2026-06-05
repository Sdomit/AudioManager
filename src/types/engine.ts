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
 * ready `proc:<pid>` id to pass to `addInput` for per-app loopback capture.
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
