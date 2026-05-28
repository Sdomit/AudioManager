/**
 * Public types for AudioManager UI components.
 *
 * These are UI-side types. They mirror — but are not identical to — the
 * shapes returned by your Rust backend. Adapt in tauriCommands.ts when wiring.
 */

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
}

export type InputSourceKind =
  | "microphone"
  | "system"
  | "app"
  | "loopback"
  | "virtual";

export interface AudioInput {
  id: string;
  name: string;
  kind: InputSourceKind;
  device: string;
  /** UI scale 0..1 */
  gain: number;
  muted: boolean;
  /** Current input meter level 0..1.2 */
  level: number;
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

  setInputGain: (id: string, gain: number) => void;
  setInputMuted: (id: string, muted: boolean) => void;
  removeInput: (id: string) => void;
  /**
   * Add an input. AudioManager opens the input device picker and calls
   * this with the chosen device ID on confirm. Implementations that
   * source devices another way may invoke this directly.
   */
  addInput: (deviceId: string) => void;

  toggleSend: (inputId: string, busId: BusId) => void;
  setSendGain: (inputId: string, busId: BusId, gain: number) => void;
  setSendMuted: (inputId: string, busId: BusId, muted: boolean) => void;

  loadPreset: (id: string) => void;
  savePreset: (name: string) => void;
  deletePreset: (id: string) => void;
  dismissPresetBanner: () => void;

  setRoutingView: (v: RoutingView) => void;
  setDensity: (d: Density) => void;
  setSelection: (sel: DetailSelection) => void;

  openStreamSetup: () => void;
  closeStreamSetup: () => void;
}

export interface AudioManagerState {
  buses: Bus[];
  inputs: AudioInput[];
  sends: Send[];
  presets: Preset[];
  loadedPresetId: string | null;
  presetBannerVisible: boolean;
  streamSetupOpen: boolean;
  streamSetupSteps: StreamSetupStep[];
  routingView: RoutingView;
  density: Density;
  selection: DetailSelection;
}

export interface UseAudioManager extends AudioManagerActions {
  state: AudioManagerState;
}
