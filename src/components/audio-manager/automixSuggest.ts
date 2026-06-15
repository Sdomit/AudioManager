/**
 * Auto-suggest co-located phone groups for the live sound gate (Feature B, B3).
 *
 * "Proximity" can't be measured directly, so it's inferred from audio: phones in
 * the same room capturing the same voice have **correlated** level envelopes
 * (they rise and fall together). This module takes a short rolling history of
 * each phone input's meter level and proposes groups of inputs whose levels are
 * strongly correlated. Suggestions are non-binding — the UI shows them for the
 * user to confirm; nothing is applied automatically.
 *
 * Pure and frontend-only: it consumes the per-input `level` the app already
 * polls, so there is no realtime/backend cost.
 */

/** Pearson correlation of the most recent overlapping window of two series. */
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ax = a.slice(a.length - n);
  const bx = b.slice(b.length - n);
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += ax[i];
    sb += bx[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = ax[i] - ma;
    const y = bx[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  // Epsilon (not just `<= 0`): a "flat" series still carries float dust (e.g.
  // 0.3 is inexact), so a strict zero check would let a near-constant series
  // produce a spurious ratio.
  const EPS = 1e-9;
  if (da <= EPS || db <= EPS) return 0;
  return num / Math.sqrt(da * db);
}

/** Population variance — used to gate out idle (flat) inputs before correlating. */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) s += x;
  const m = s / xs.length;
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return v / xs.length;
}

export interface SuggestOptions {
  /** Min Pearson correlation for two inputs to be considered co-located. */
  minCorrelation: number;
  /** Min samples in a history before it's eligible. */
  minSamples: number;
  /** Min level variance — flat/idle inputs are ignored (no shared activity). */
  minVariance: number;
}

export const DEFAULT_SUGGEST_OPTIONS: SuggestOptions = {
  minCorrelation: 0.6,
  minSamples: 16,
  minVariance: 1e-4,
};

/**
 * Propose co-located phone groups from level histories.
 *
 * @param history    deviceId → rolling level samples (most recent last).
 * @param candidates phone input ids eligible for suggestion (already-grouped
 *                   ones should be excluded by the caller).
 * @returns groups (each ≥ 2 ids) of mutually-correlated inputs. A group is a
 *          connected component over the "correlated" relation, so a chain
 *          A~B~C clusters together even if A~C is slightly under threshold.
 */
export function suggestPhoneGroups(
  history: Record<string, number[]>,
  candidates: string[],
  opts: SuggestOptions = DEFAULT_SUGGEST_OPTIONS,
): string[][] {
  // Eligible: enough samples and actually active (non-flat).
  const ids = candidates.filter((id) => {
    const h = history[id];
    return h && h.length >= opts.minSamples && variance(h) >= opts.minVariance;
  });
  if (ids.length < 2) return [];

  // Union-find over correlated pairs.
  const parent = new Map<string, string>();
  ids.forEach((id) => parent.set(id, id));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if (correlation(history[ids[i]], history[ids[j]]) >= opts.minCorrelation) {
        union(ids[i], ids[j]);
      }
    }
  }

  const clusters = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const arr = clusters.get(root) ?? [];
    arr.push(id);
    clusters.set(root, arr);
  }
  return [...clusters.values()].filter((c) => c.length >= 2);
}
