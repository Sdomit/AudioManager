/**
 * EQ frequency-response math for the interactive graph.
 *
 * Ports the biquad coefficient formulas from
 * `src-tauri/src/audio/dsp/filter.rs` (Audio EQ Cookbook, R. Bristow-Johnson)
 * and evaluates the magnitude response |H(e^jw)| so the UI can draw the exact
 * curve the backend produces. This is display-only; the backend remains the
 * source of truth and re-clamps every value.
 *
 * The cascade magnitude is the product of per-band magnitudes, so in dB the
 * bands simply add — `sumResponseDb` is exact for the magnitude curve (phase is
 * irrelevant to it).
 */

import type { BandKind, EqBand } from "../../types/engine";

/** Nominal sample rate for drawing the curve when the engine rate is unknown. */
export const DEFAULT_EQ_SR = 48_000;

/** `[b0, b1, b2, a1, a2]`. */
export type Coeffs = [number, number, number, number, number];

const TAU = Math.PI * 2;

function nyquistClamp(freqHz: number, sr: number): number {
  return Math.min(Math.max(freqHz, 10), sr * 0.49);
}

/** Biquad coefficients for one band shape. Mirror of `filter.rs::Coeffs`. */
export function bandCoeffs(
  kind: BandKind,
  freqHz: number,
  q: number,
  gainDb: number,
  sr: number,
): Coeffs {
  const f = nyquistClamp(freqHz, sr);
  const w0 = (TAU * f) / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);

  switch (kind) {
    case "peaking": {
      const a = Math.pow(10, gainDb / 40);
      const alpha = sin / (2 * q);
      const a0 = 1 + alpha / a;
      return [
        (1 + alpha * a) / a0,
        (-2 * cos) / a0,
        (1 - alpha * a) / a0,
        (-2 * cos) / a0,
        (1 - alpha / a) / a0,
      ];
    }
    case "low_pass": {
      const alpha = sin / (2 * q);
      const a0 = 1 + alpha;
      return [
        ((1 - cos) / 2) / a0,
        (1 - cos) / a0,
        ((1 - cos) / 2) / a0,
        (-2 * cos) / a0,
        (1 - alpha) / a0,
      ];
    }
    case "high_pass": {
      const alpha = sin / (2 * q);
      const a0 = 1 + alpha;
      return [
        ((1 + cos) / 2) / a0,
        (-(1 + cos)) / a0,
        ((1 + cos) / 2) / a0,
        (-2 * cos) / a0,
        (1 - alpha) / a0,
      ];
    }
    case "notch": {
      const alpha = sin / (2 * q);
      const a0 = 1 + alpha;
      return [
        1 / a0,
        (-2 * cos) / a0,
        1 / a0,
        (-2 * cos) / a0,
        (1 - alpha) / a0,
      ];
    }
    case "low_shelf": {
      const a = Math.pow(10, gainDb / 40);
      const alpha = (sin / 2) * Math.SQRT2; // S = 1 slope
      const s = Math.sqrt(a);
      const a0 = a + 1 + (a - 1) * cos + 2 * s * alpha;
      return [
        (a * (a + 1 - (a - 1) * cos + 2 * s * alpha)) / a0,
        (2 * a * (a - 1 - (a + 1) * cos)) / a0,
        (a * (a + 1 - (a - 1) * cos - 2 * s * alpha)) / a0,
        (-2 * (a - 1 + (a + 1) * cos)) / a0,
        (a + 1 + (a - 1) * cos - 2 * s * alpha) / a0,
      ];
    }
    case "high_shelf": {
      const a = Math.pow(10, gainDb / 40);
      const alpha = (sin / 2) * Math.SQRT2;
      const s = Math.sqrt(a);
      const a0 = a + 1 - (a - 1) * cos + 2 * s * alpha;
      return [
        (a * (a + 1 + (a - 1) * cos + 2 * s * alpha)) / a0,
        (-2 * a * (a - 1 + (a + 1) * cos)) / a0,
        (a * (a + 1 + (a - 1) * cos - 2 * s * alpha)) / a0,
        (2 * (a - 1 - (a + 1) * cos)) / a0,
        (a + 1 - (a - 1) * cos - 2 * s * alpha) / a0,
      ];
    }
  }
}

/** Magnitude of `H(e^jw)` in dB at `freqHz` for a coefficient set. */
export function magnitudeDb(c: Coeffs, freqHz: number, sr: number): number {
  const [b0, b1, b2, a1, a2] = c;
  const w = (TAU * freqHz) / sr;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const numRe = b0 + b1 * cos1 + b2 * cos2;
  const numIm = -(b1 * sin1 + b2 * sin2);
  const denRe = 1 + a1 * cos1 + a2 * cos2;
  const denIm = -(a1 * sin1 + a2 * sin2);
  const den = Math.hypot(denRe, denIm);
  if (den === 0) return 0;
  return 20 * Math.log10(Math.hypot(numRe, numIm) / den);
}

/** dB contribution of one band at `freqHz`. Disabled bands contribute 0. */
export function bandMagnitudeDb(band: EqBand, freqHz: number, sr: number): number {
  if (!band.enabled) return 0;
  return magnitudeDb(
    bandCoeffs(band.kind, band.freq_hz, band.q, band.gain_db, sr),
    freqHz,
    sr,
  );
}

/** Summed dB response of all enabled bands across `freqPts`. */
export function sumResponseDb(
  bands: EqBand[],
  freqPts: number[],
  sr: number,
): number[] {
  return freqPts.map((f) => {
    let sum = 0;
    for (const b of bands) sum += bandMagnitudeDb(b, f, sr);
    return sum;
  });
}

/** `count` log-spaced frequencies over `[fMin, fMax]`. */
export function logFreqPoints(
  count: number,
  fMin = 20,
  fMax = 20_000,
): number[] {
  const logMin = Math.log10(fMin);
  const logMax = Math.log10(fMax);
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    out[i] = Math.pow(10, logMin + t * (logMax - logMin));
  }
  return out;
}
