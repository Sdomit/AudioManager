/**
 * Shared dB formatting for UI fader / volume / meter values.
 *
 * Fader/volume scale is the UI convention 0..1 where 0.75 ≈ 0 dB unity.
 * Meter levels are true linear amplitude (use 20*log10).
 */

export function gainToDb(g: number): string {
  if (g < 0.001) return "-∞ dB";
  const db = (g - 0.75) * 80;
  return `${db > 0 ? "+" : ""}${db.toFixed(0)} dB`;
}

export const volumeToDb = gainToDb;

export function levelToDb(level: number): string {
  if (level < 0.001) return "-∞ dB";
  const db = 20 * Math.log10(level);
  if (db < -60) return "-∞ dB";
  return `${db.toFixed(0)} dB`;
}
