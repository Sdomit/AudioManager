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
  CompressorConfig,
  DspConfig,
  EqBand,
  EqConfig,
  GateConfig,
  HpfConfig,
  LimiterConfig,
} from "../../types/engine";

export const MAX_EQ_BANDS = 4;

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
  return [
    { enabled: false, freq_hz: 100, q: 0.9, gain_db: 0 },
    { enabled: false, freq_hz: 400, q: 1.0, gain_db: 0 },
    { enabled: false, freq_hz: 3000, q: 1.0, gain_db: 0 },
    { enabled: false, freq_hz: 8000, q: 0.9, gain_db: 0 },
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

export function defaultDspConfig(): DspConfig {
  return {
    hpf: defaultHpf(),
    gate: defaultGate(),
    eq: defaultEq(),
    compressor: defaultCompressor(),
    limiter: defaultLimiter(),
  };
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
