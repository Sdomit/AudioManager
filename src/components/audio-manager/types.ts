/**
 * Public types for AudioManager UI components.
 *
 * These are UI-side types. They mirror — but are not identical to — the
 * shapes returned by your Rust backend. Adapt in tauriCommands.ts when wiring.
 */

import type {
  DspConfig,
  EqConfig,
  LimiterConfig,
  LoudnessSnapshot,
} from "../../types/engine";

export type {
  DspConfig,
  EqConfig,
  LimiterConfig,
  LoudnessSnapshot,
  LoudnessVerdict,
} from "../../types/engine";

export type BusId = "A1" | "A2" | "B1" | "B2";

export type BusRole = "monitor" | "speakers" | "stream" | "record";

export type BusState =
  | "idle"           // user-disabled, no audio
  | "running"        // enabled, audio flowing
  | "silent"         // enabled, no inputs routed to it
  | "clipping"       // enabled + recent clip (latched ~3s)
  | "error"          // device problem
  | "unconfigured";  // no output device chosen

export interface Bus {
  id: BusId;
  role: BusRole;
  label: string;       // human label, e.g. "Monitor"
  device: string | null;
  state: BusState;
  enabled: boolean;
  muted: boolean;
  /** -inf .. 0 dB on a UI scale of 0..1 */
  volume: number;
  /** Current peak level, 0..1.2 (>1 = clip) */
  level: number;
  /** Latched clip indicator until clipUntil ms */
  clipUntil: number | null;
  /** Error message if state === "error" */
  error: string | null;
  /** Output callback buffer size in frames. null = driver default (#35). */
  bufferSizeFrames: number | null;
  /** Named latency mode for bufferSizeFrames, or null for a custom value (#35).
   *  Optional: absent in mock/pre-load buses; the adapter always sets it from
   *  live status. */
  latencyMode?: string | null;
  /** Dropout sample counts since the last poll (#35/#36 telemetry). */
  underruns: number;
  overruns: number;
  /** Per-bus parametric EQ (post-sum). */
  eq: EqConfig;
  /** Per-bus final limiter (#32). */
  limiter: LimiterConfig;
  /** Streaming loudness meters (#38). null until the engine reports. */
  loudness: LoudnessSnapshot | null;
}

export type InputSourceKind =
  | "microphone"
  | "system"
  | "app"
  | "loopback"
  | "virtual"
  | "phone";

export interface AudioInput {
  id: string;
  name: string;
  kind: InputSourceKind;
  device: string;
  /** UI scale 0..1 */
  gain: number;
  muted: boolean;
  /** Current input meter level 0..1.2 (max of L/R; aria + mono fallback). */
  level: number;
  /** Post-stereo per-channel meter levels 0..1.2 (#feature10). Absent until the
   *  first meter poll; components fall back to `level` when undefined. */
  levelL?: number;
  levelR?: number;
  /** Source channel count (1 = mono → single meter bar). Absent → treat as stereo. */
  channels?: number;
  /** Monitor preview on (#feature1) — heard on the monitor bus (A1) for
   *  headphone listening without enabling the speaker send. Absent → off. */
  monitor?: boolean;
  /** Per-input effect chain HPF→Gate→EQ→Comp→Limiter (#32). */
  dsp: DspConfig;
}

/** Per-input meter sample from the fast meter poll (#feature10). */
export interface InputMeterLevel {
  /** max(L, R, capture) — aria label + mono fallback. */
  level: number;
  /** Post-stereo per-channel levels 0..1.2 (follow pan / mono / width). */
  levelL: number;
  levelR: number;
  /** Source channel count (1 = mono → single meter bar). */
  channels: number;
}

export interface Send {
  inputId: string;
  busId: BusId;
  enabled: boolean;
  /** UI scale 0..1, where 0.75 ≈ 0 dB unity */
  gain: number;
  muted: boolean;
}

export type PresetVersion = 1 | 2;

export interface Preset {
  id: string;
  name: string;
  version: PresetVersion;
  createdAt: number;
  updatedAt: number;
}

/* ── Recording ──────────────────────────────────────────────────────────── */

export type TapSpec =
  | { kind: "input_pre"; device_id: string }
  | { kind: "input_post"; device_id: string; bus_id: BusId }
  | { kind: "bus_out"; bus_id: BusId };

/**
 * Live recording — mirrors backend `RecordingInfo` 1:1 (snake_case).
 * Polled at ~1 Hz to update size/dropped counters in the panel.
 */
export interface ActiveRecording {
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

/** WAV file in the recordings dir. */
export interface RecordingFile {
  name: string;
  file_path: string;
  size_bytes: number;
  modified_unix_ms: number;
}

export type RoutingView = "matrix" | "flow" | "nodes";
export type Density = "comfortable" | "compact";

export type DetailSelection =
  | { kind: "none" }
  | { kind: "input"; inputId: string }
  | { kind: "bus"; busId: BusId };

export type StreamSetupStepStatus = "ok" | "pending" | "warning" | "error";

export interface StreamSetupStep {
  id: string;
  title: string;
  status: StreamSetupStepStatus;
  detail: string;
  actionLabel?: string;
  helpLink?: string;
}

/* ── Action surface returned by useAudioManager() ───────────────────────── */
export interface AudioManagerActions {
  setBusEnabled: (id: BusId, enabled: boolean) => void;
  setBusMuted: (id: BusId, muted: boolean) => void;
  setBusVolume: (id: BusId, volume: number) => void;
  setBusDevice: (id: BusId, device: string | null) => void;
  /** Rename a bus (label only — id stays A1/A2/B1/B2). */
  renameBus: (id: BusId, name: string) => void;
  /**
   * Set the bus output buffer size in frames (#35). null = driver default.
   * Triggers an engine rebuild, so it is not throttled.
   */
  setBusBufferSize: (id: BusId, frames: number | null) => void;
  /** Set the bus latency mode (#35) — a preset over the raw buffer size.
   *  "stable" | "low" | "ultra-low". Triggers an engine rebuild. */
  setBusLatencyMode: (id: BusId, mode: string) => void;
  /** Update the per-bus final limiter (#32). Live, no restart. */
  setBusLimiter: (id: BusId, limiter: LimiterConfig) => void;
  setBusEq: (id: BusId, eq: EqConfig) => void;
  /**
   * Override the bus visual role (icon + accent color). Stored
   * client-side in localStorage, not in the backend or preset.
   * Pass null to revert to the default role for the bus id.
   */
  setBusRoleOverride: (id: BusId, role: BusRole | null) => void;

  setInputGain: (id: string, gain: number) => void;
  setInputMuted: (id: string, muted: boolean) => void;
  /** Toggle monitor preview (#feature1): hear the input on the monitor bus (A1)
   *  without enabling its speaker send. */
  setInputMonitor: (id: string, enabled: boolean) => void;
  /** Update the per-input DSP chain (#32). Live, no restart. */
  setInputDsp: (id: string, dsp: DspConfig) => void;
  /**
   * Apply the Stream Voice profile to an input and arm B1 protection (final
   * -1 dBFS limiter on the B1 bus). Config-only — never starts audio (#33).
   */
  applyStreamVoice: (id: string) => void;
  removeInput: (id: string) => void;
  /**
   * Add an input. AudioManager opens the input device picker and calls
   * this with the chosen device ID on confirm. Implementations that
   * source devices another way may invoke this directly.
   */
  addInput: (deviceId: string) => void;
  /** Swap an input's device, preserving gain/sends/dsp/monitor/label
   *  (#feature7). A failed swap leaves the original input untouched. */
  replaceInput: (oldDeviceId: string, newDeviceId: string) => void;
  /** Set or clear an input's display label (#feature8). null reverts to the
   *  device-derived name. */
  renameInput: (deviceId: string, label: string | null) => void;

  toggleSend: (inputId: string, busId: BusId) => void;
  setSendGain: (inputId: string, busId: BusId, gain: number) => void;
  setSendMuted: (inputId: string, busId: BusId, muted: boolean) => void;

  loadPreset: (id: string) => void;
  savePreset: (name: string) => void;
  /**
   * Rename a preset by saving under a new name then deleting the old
   * one (backend has no rename command). Both calls happen serially;
   * on save failure nothing is touched.
   */
  renamePreset: (oldId: string, newName: string) => void;
  deletePreset: (id: string) => void;
  /**
   * Persist a user-pinned default preset to localStorage. On next app
   * boot the default is auto-loaded via the safe-load path (sets
   * routes/sends/gains; never auto-enables buses). Pass null to clear.
   */
  setDefaultPreset: (id: string | null) => void;
  dismissPresetBanner: () => void;

  setRoutingView: (v: RoutingView) => void;
  setDensity: (d: Density) => void;
  setSelection: (sel: DetailSelection) => void;

  openStreamSetup: () => void;
  closeStreamSetup: () => void;

  /** Undo the last undoable mutation (state + IPC reconciliation). */
  undo: () => void;
  /** Redo the last undone mutation. */
  redo: () => void;

  /* Recording */
  startRecording: (spec: TapSpec) => Promise<ActiveRecording | null>;
  startMasterRecording: () => Promise<ActiveRecording[]>;
  stopRecording: (id: string) => Promise<void>;
  stopAllRecordings: () => Promise<void>;
  refreshRecordingFiles: () => Promise<void>;
  setRecordingsDir: (path: string) => Promise<void>;
  openRecordingsFolder: () => Promise<void>;
  deleteRecordingFile: (path: string) => Promise<void>;
  openRecordingsPanel: () => void;
  closeRecordingsPanel: () => void;
}

export interface AudioManagerState {
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
  presets: Preset[];
  loadedPresetId: string | null;
  /** ID of the preset pinned as the user's default. Persisted to localStorage. */
  defaultPresetId: string | null;
  presetBannerVisible: boolean;
  streamSetupOpen: boolean;
  streamSetupSteps: StreamSetupStep[];
  routingView: RoutingView;
  density: Density;
  selection: DetailSelection;
  /** Whether an undo / redo step is available right now. */
  canUndo: boolean;
  canRedo: boolean;

  /* Recording */
  activeRecordings: ActiveRecording[];
  recordingFiles: RecordingFile[];
  recordingsDir: string | null;
  recordingsPanelOpen: boolean;
}

export interface UseAudioManager extends AudioManagerActions {
  state: AudioManagerState;
}
