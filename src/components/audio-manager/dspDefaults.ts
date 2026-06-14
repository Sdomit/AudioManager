/**
 * UI-side DSP defaults + slider bounds.
 *
 * Mirrors the Rust defaults and clamp ranges in
 * `src-tauri/src/audio/dsp/config.rs`. The backend re-clamps every value it
 * receives, so these bounds are for UI ergonomics (sensible slider travel),
 * not validation — a value outside a UI range is still accepted and clamped
 * by the backend to the true [lo, hi] from config.rs.
 */

import type {
  BandKind,
  CompressorConfig,
  DenoiseConfig,
  DspConfig,
  DspStage,
  EqBand,
  EqConfig,
  GateConfig,
  HpfConfig,
  LimiterConfig,
  StereoConfig,
} from "../../types/engine";

export const MAX_EQ_BANDS = 4;

/** Selectable EQ band shapes, in menu order. */
export const BAND_KINDS: ReadonlyArray<{ value: BandKind; label: string }> = [
  { value: "peaking", label: "Bell" },
  { value: "low_shelf", label: "Low shelf" },
  { value: "high_shelf", label: "High shelf" },
  { value: "low_pass", label: "Low pass" },
  { value: "high_pass", label: "High pass" },
  { value: "notch", label: "Notch" },
];

/** Whether a band shape uses the gain control (peaking + shelves). */
export function bandUsesGain(kind: BandKind): boolean {
  return kind === "peaking" || kind === "low_shelf" || kind === "high_shelf";
}

/** Whether a band shape uses the Q control (peaking + cuts + notch). */
export function bandUsesQ(kind: BandKind): boolean {
  return (
    kind === "peaking" ||
    kind === "low_pass" ||
    kind === "high_pass" ||
    kind === "notch"
  );
}

export function defaultDenoise(): DenoiseConfig {
  return { enabled: false, backend: "rnnoise" };
}

export function defaultHpf(): HpfConfig {
  return { enabled: false, freq_hz: 80 };
}

export function defaultGate(): GateConfig {
  return {
    enabled: false,
    threshold_db: -40,
    attack_ms: 10,
    release_ms: 150,
    hold_ms: 80,
  };
}

export function defaultEqBands(): EqBand[] {
  // Console-style layout: low shelf, two sweepable bells, high shelf.
  return [
    { enabled: false, kind: "low_shelf", freq_hz: 100, q: 0.9, gain_db: 0 },
    { enabled: false, kind: "peaking", freq_hz: 400, q: 1.0, gain_db: 0 },
    { enabled: false, kind: "peaking", freq_hz: 3000, q: 1.0, gain_db: 0 },
    { enabled: false, kind: "high_shelf", freq_hz: 8000, q: 0.9, gain_db: 0 },
  ];
}

export function defaultEq(): EqConfig {
  return { enabled: false, bands: defaultEqBands() };
}

export function defaultCompressor(): CompressorConfig {
  return {
    enabled: false,
    threshold_db: -18,
    ratio: 4,
    attack_ms: 5,
    release_ms: 80,
    makeup_db: 0,
  };
}

export function defaultLimiter(): LimiterConfig {
  return { enabled: false, threshold_db: -1, attack_ms: 0.5, release_ms: 100 };
}

export function defaultStereo(): StereoConfig {
  return {
    pan: 0,
    mono: false,
    swap: false,
    invert_left: false,
    invert_right: false,
    center_level: 1,
    width: 1,
  };
}

/** True when any stereo control departs from transparent identity (mirrors the
 *  Rust `StereoConfig::is_active`). */
export function isStereoActive(s: StereoConfig): boolean {
  return (
    s.pan !== 0 ||
    s.mono ||
    s.swap ||
    s.invert_left ||
    s.invert_right ||
    s.center_level !== 1 ||
    s.width !== 1
  );
}

/** Canonical stage order (matches the Rust default). */
export const DEFAULT_DSP_ORDER: DspStage[] = [
  "denoise",
  "hpf",
  "gate",
  "eq",
  "comp",
  "limiter",
];

export function defaultDspConfig(): DspConfig {
  return {
    denoise: defaultDenoise(),
    hpf: defaultHpf(),
    gate: defaultGate(),
    eq: defaultEq(),
    compressor: defaultCompressor(),
    limiter: defaultLimiter(),
    order: [...DEFAULT_DSP_ORDER],
    stereo: defaultStereo(),
  };
}

/** Broadcast-ready voice profile (#33): HP → gate → EQ → comp, with the limiter
 *  left off (the bus-side B1 limiter owns final protection). Pre-clamped to legal
 *  ranges, so the backend clamp is a no-op. */
export function streamVoiceConfig(): DspConfig {
  return {
    denoise: defaultDenoise(),
    hpf: { enabled: true, freq_hz: 80 },
    gate: {
      enabled: true,
      threshold_db: -45,
      attack_ms: 2,
      release_ms: 150,
      hold_ms: 80,
    },
    eq: {
      enabled: true,
      bands: [
        // Low shelf: tame proximity boom.
        { enabled: true, kind: "low_shelf", freq_hz: 120, q: 0.7, gain_db: -1.5 },
        // Bell: presence lift for intelligibility.
        { enabled: true, kind: "peaking", freq_hz: 3000, q: 1.0, gain_db: 2.0 },
        // High shelf: air.
        { enabled: true, kind: "high_shelf", freq_hz: 10000, q: 0.7, gain_db: 1.5 },
        // 4th band unused by the profile.
        { enabled: false, kind: "high_shelf", freq_hz: 8000, q: 0.9, gain_db: 0 },
      ],
    },
    compressor: {
      enabled: true,
      threshold_db: -18,
      ratio: 3,
      attack_ms: 5,
      release_ms: 120,
      makeup_db: 4,
    },
    limiter: defaultLimiter(),
    order: [...DEFAULT_DSP_ORDER],
    stereo: defaultStereo(),
  };
}

/** B1 "protection" limiter (#33): a final brick-wall at -1 dBFS so the stream
 *  feed never clips. "Protected" == this limiter being enabled on the B1 bus. */
export function b1ProtectLimiter(): LimiterConfig {
  return { ...defaultLimiter(), enabled: true, threshold_db: -1, release_ms: 60 };
}

/** Slider bounds: [min, max, step]. UI travel only; backend re-clamps. */
export const DSP_RANGE = {
  hpfFreq: [20, 1000, 1] as const,
  gateThreshold: [-80, 0, 1] as const,
  gateAttack: [0, 50, 0.5] as const,
  gateRelease: [0, 500, 5] as const,
  gateHold: [0, 500, 5] as const,
  eqFreq: [20, 18000, 10] as const,
  eqQ: [0.1, 10, 0.1] as const,
  eqGain: [-24, 24, 0.5] as const,
  compThreshold: [-60, 0, 1] as const,
  compRatio: [1, 20, 0.5] as const,
  compAttack: [0, 100, 0.5] as const,
  compRelease: [0, 500, 5] as const,
  compMakeup: [-24, 24, 0.5] as const,
  limThreshold: [-12, 0, 0.5] as const,
  limAttack: [0, 10, 0.1] as const,
  limRelease: [0, 500, 5] as const,
  stereoPan: [-1, 1, 0.01] as const,
  stereoCenter: [0, 2, 0.01] as const,
  stereoWidth: [0, 2, 0.01] as const,
} as const;

/** Allowed fixed output buffer sizes (frames). `null` = driver default. */
export const BUFFER_SIZE_OPTIONS: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: "Auto", value: null },
  { label: "64", value: 64 },
  { label: "128", value: 128 },
  { label: "256", value: 256 },
  { label: "512", value: 512 },
  { label: "1024", value: 1024 },
];
