import { describe, expect, it } from "vitest";

import type { EqBand } from "../../types/engine";
import {
  bandCoeffs,
  bandMagnitudeDb,
  DEFAULT_EQ_SR,
  logFreqPoints,
  magnitudeDb,
  sumResponseDb,
} from "./eqResponse";

const SR = DEFAULT_EQ_SR;

function band(parts: Partial<EqBand>): EqBand {
  return {
    enabled: true,
    kind: "peaking",
    freq_hz: 1000,
    q: 1,
    gain_db: 0,
    ...parts,
  };
}

describe("eqResponse", () => {
  it("peaking band reads its gain at the center and ~0 dB far away", () => {
    const b = band({ kind: "peaking", freq_hz: 1000, q: 2, gain_db: 6 });
    const atCenter = bandMagnitudeDb(b, 1000, SR);
    expect(atCenter).toBeCloseTo(6, 1);
    expect(Math.abs(bandMagnitudeDb(b, 60, SR))).toBeLessThan(0.5);
    expect(Math.abs(bandMagnitudeDb(b, 16000, SR))).toBeLessThan(0.5);
  });

  it("low shelf lifts lows, not highs", () => {
    const b = band({ kind: "low_shelf", freq_hz: 300, gain_db: 6 });
    expect(bandMagnitudeDb(b, 40, SR)).toBeCloseTo(6, 0);
    expect(Math.abs(bandMagnitudeDb(b, 12000, SR))).toBeLessThan(0.5);
  });

  it("high shelf lifts highs, not lows", () => {
    const b = band({ kind: "high_shelf", freq_hz: 4000, gain_db: 6 });
    expect(bandMagnitudeDb(b, 18000, SR)).toBeCloseTo(6, 0);
    expect(Math.abs(bandMagnitudeDb(b, 60, SR))).toBeLessThan(0.5);
  });

  it("low pass passes lows and attenuates highs", () => {
    const b = band({ kind: "low_pass", freq_hz: 1000, q: 0.707 });
    expect(Math.abs(bandMagnitudeDb(b, 100, SR))).toBeLessThan(0.5);
    expect(bandMagnitudeDb(b, 12000, SR)).toBeLessThan(-12);
  });

  it("notch deeply attenuates at center, passes elsewhere", () => {
    const b = band({ kind: "notch", freq_hz: 1000, q: 4 });
    expect(bandMagnitudeDb(b, 1000, SR)).toBeLessThan(-20);
    expect(Math.abs(bandMagnitudeDb(b, 200, SR))).toBeLessThan(0.6);
  });

  it("disabled bands contribute nothing to the sum", () => {
    const bands: EqBand[] = [
      band({ kind: "peaking", freq_hz: 1000, gain_db: 12, enabled: false }),
    ];
    const pts = logFreqPoints(32);
    expect(sumResponseDb(bands, pts, SR).every((v) => v === 0)).toBe(true);
  });

  it("cascade magnitude adds in dB", () => {
    const a = band({ kind: "peaking", freq_hz: 1000, q: 3, gain_db: 4 });
    const b = band({ kind: "peaking", freq_hz: 1000, q: 3, gain_db: 5 });
    const summed = sumResponseDb([a, b], [1000], SR)[0];
    expect(summed).toBeCloseTo(
      bandMagnitudeDb(a, 1000, SR) + bandMagnitudeDb(b, 1000, SR),
      6,
    );
  });

  it("produces finite coefficients near Nyquist", () => {
    const c = bandCoeffs("high_shelf", 19000, 1, -12, SR);
    expect(c.every((v) => Number.isFinite(v))).toBe(true);
    expect(Number.isFinite(magnitudeDb(c, 19000, SR))).toBe(true);
  });

  it("logFreqPoints spans the requested range", () => {
    const pts = logFreqPoints(10, 20, 20000);
    expect(pts[0]).toBeCloseTo(20, 5);
    expect(pts[pts.length - 1]).toBeCloseTo(20000, 2);
  });
});
