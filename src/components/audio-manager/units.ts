/**
 * Shared dB formatting for UI fader / volume / meter values.
 *
 * Fader/volume scale is the UI convention 0..1. The engine gain is
 * `ui * BACKEND_VOLUME_MAX` (see adapters.ts), so UI 0.5 = 1.0 linear = 0 dB
 * unity and UI 1.0 = 2.0 linear ≈ +6 dB.
 * Meter levels are true linear amplitude (use 20*log10).
 */

export const UI_UNITY = 0.5;

export function faderDb(g: number): number {
  return 20 * Math.log10(g / UI_UNITY);
}

export function gainToDb(g: number): string {
  if (g < 0.001) return "-∞ dB";
  const db = faderDb(g);
  if (db < -60) return "-∞ dB";
  const r = Math.round(db);
  return `${r > 0 ? "+" : ""}${r === 0 ? 0 : r} dB`;
}

export const volumeToDb = gainToDb;

export function levelToDb(level: number): string {
  if (level < 0.001) return "-∞ dB";
  const db = 20 * Math.log10(level);
  if (db < -60) return "-∞ dB";
  return `${db.toFixed(0)} dB`;
}
