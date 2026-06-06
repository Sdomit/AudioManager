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

// ── DSP chain config (mirrors src-tauri/src/audio/dsp/config.rs) ─────────────

/** Neural denoiser backend (mirrors Rust `DenoiseBackend`, snake_case wire). */
export type DenoiseBackend = "rnnoise" | "deep_filter_net";

/** Neural noise suppression, first in the chain. RNNoise = 48 kHz mono, ~10 ms
 *  latency (#37). `deep_filter_net` is reserved for a phase-2 upgrade. */
export interface DenoiseConfig {
  enabled: boolean;
  backend: DenoiseBackend;
}

/** High-pass filter. */
export interface HpfConfig {
  enabled: boolean;
  freq_hz: number;
}

/** Noise gate / downward expander. */
export interface GateConfig {
  enabled: boolean;
  threshold_db: number;
  attack_ms: number;
  release_ms: number;
  hold_ms: number;
}

/** Filter shape for one EQ band (mirrors Rust `BandKind`, snake_case wire form). */
export type BandKind =
  | "peaking"
  | "low_shelf"
  | "high_shelf"
  | "low_pass"
  | "high_pass"
  | "notch";

/** One parametric EQ band. `kind` selects the filter shape. */
export interface EqBand {
  enabled: boolean;
  kind: BandKind;
  freq_hz: number;
  q: number;
  gain_db: number;
}

/** Fixed-band parametric EQ (backend normalizes to MAX_EQ_BANDS = 4). */
export interface EqConfig {
  enabled: boolean;
  bands: EqBand[];
}

/** Feed-forward compressor. `makeup_db` is a ±24 dB trim. */
export interface CompressorConfig {
  enabled: boolean;
  threshold_db: number;
  ratio: number;
  attack_ms: number;
  release_ms: number;
  makeup_db: number;
}

/** Brick-wall peak limiter. */
export interface LimiterConfig {
  enabled: boolean;
  threshold_db: number;
  attack_ms: number;
  release_ms: number;
}

/** Per-input effect chain: Denoise -> HPF -> Gate -> EQ -> Compressor -> Limiter. */
export interface DspConfig {
  denoise: DenoiseConfig;
  hpf: HpfConfig;
  gate: GateConfig;
  eq: EqConfig;
  compressor: CompressorConfig;
  limiter: LimiterConfig;
}

/** Per-bus effect chain, processed post-sum/pre-clip: EQ -> Limiter. */
export interface BusDspConfig {
  eq: EqConfig;
  limiter: LimiterConfig;
}

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
  /** Per-bus DSP chain. Optional for back-compat with pre-#32 payloads. */
  dsp?: BusDspConfig;
  /** Dropout counters since last poll. 0 when no engine or no dropouts. */
  underruns?: number;
  overruns?: number;
  /** Output callback buffer size in frames. null = driver default (#35). */
  buffer_size_frames?: number | null;
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
  /** Per-input DSP chain. Optional for back-compat with pre-#32 payloads. */
  dsp?: DspConfig;
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
  /** `true` = device enabled (endpoints visible in Windows Sound), `false` = disabled, `undefined` = driver not present. */
  device_enabled?: boolean;
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
