/**
 * Per-input / per-bus effect helpers (#feature4/#feature5).
 *
 * Pure logic extracted from the former NodeFxPopover so it can be shared by the
 * node canvas, the flow/matrix reorder list, and the detail panel without
 * dragging in a React component. Effects map 1:1 to the backend's fixed-order
 * per-input DSP; this module only reads/derives — it never mutates in place.
 */

import type { Bus, BusId, DspConfig } from "./types";

/** Per-input effect keys, in the engine's fixed processing order. */
export type InputFxKey = "denoise" | "hpf" | "gate" | "eq" | "comp" | "limiter";

/** Identifies which node's fx chain a UI surface is editing. */
export type NodeFxTarget =
  | { kind: "input"; id: string }
  | { kind: "bus"; id: BusId };

/** Canonical effect list (order = engine chain order) for menus + boxes. */
export const INPUT_FX_DEFS: { key: InputFxKey; label: string }[] = [
  { key: "denoise", label: "Denoise" },
  { key: "hpf", label: "High-pass" },
  { key: "gate", label: "Gate" },
  { key: "eq", label: "EQ" },
  { key: "comp", label: "Comp" },
  { key: "limiter", label: "Limiter" },
];

export function inputFxEnabled(dsp: DspConfig, key: InputFxKey): boolean {
  switch (key) {
    case "denoise":
      return dsp.denoise.enabled;
    case "hpf":
      return dsp.hpf.enabled;
    case "gate":
      return dsp.gate.enabled;
    case "eq":
      return dsp.eq.enabled;
    case "comp":
      return dsp.compressor.enabled;
    case "limiter":
      return dsp.limiter.enabled;
  }
}

/** Return a new DspConfig with one effect toggled on/off (immutable). */
export function setInputFxEnabled(
  dsp: DspConfig,
  key: InputFxKey,
  on: boolean,
): DspConfig {
  switch (key) {
    case "denoise":
      return { ...dsp, denoise: { ...dsp.denoise, enabled: on } };
    case "hpf":
      return { ...dsp, hpf: { ...dsp.hpf, enabled: on } };
    case "gate":
      return { ...dsp, gate: { ...dsp.gate, enabled: on } };
    case "eq":
      return { ...dsp, eq: { ...dsp.eq, enabled: on } };
    case "comp":
      return { ...dsp, compressor: { ...dsp.compressor, enabled: on } };
    case "limiter":
      return { ...dsp, limiter: { ...dsp.limiter, enabled: on } };
  }
}

/** Enabled effects in canonical order (menus/badges). */
export function enabledInputFx(dsp: DspConfig): { key: InputFxKey; label: string }[] {
  return INPUT_FX_DEFS.filter((d) => inputFxEnabled(dsp, d.key));
}

/** Enabled effects in the WIRED order (`dsp.order`) — drives the node chain. */
export function orderedInputFx(dsp: DspConfig): { key: InputFxKey; label: string }[] {
  const label = (k: InputFxKey) => INPUT_FX_DEFS.find((d) => d.key === k)?.label ?? k;
  return (dsp.order as InputFxKey[])
    .filter((k) => inputFxEnabled(dsp, k))
    .map((k) => ({ key: k, label: label(k) }));
}

/**
 * Move stage `from` to sit immediately before `before` in the chain order
 * (immutable). Used when the user wires one fx node's output into another's
 * input, or drags a stage in the flow/matrix reorder list. Returns the config
 * unchanged if the move is a no-op.
 */
export function reorderInputFx(
  dsp: DspConfig,
  from: InputFxKey,
  before: InputFxKey,
): DspConfig {
  if (from === before) return dsp;
  const order = (dsp.order as InputFxKey[]).filter((k) => k !== from);
  const i = order.indexOf(before);
  if (i < 0) return dsp;
  order.splice(i, 0, from);
  return { ...dsp, order: order as DspConfig["order"] };
}

/** Count enabled effects in an input chain — drives the node's FX pill badge. */
export function countInputFx(dsp: DspConfig): number {
  let n = 0;
  if (dsp.denoise.enabled) n++;
  if (dsp.hpf.enabled) n++;
  if (dsp.gate.enabled) n++;
  if (dsp.eq.enabled) n++;
  if (dsp.compressor.enabled) n++;
  if (dsp.limiter.enabled) n++;
  return n;
}

/** Count enabled effects in a bus chain (EQ + limiter). */
export function countBusFx(bus: Bus): number {
  let n = 0;
  if (bus.eq.enabled) n++;
  if (bus.limiter.enabled) n++;
  return n;
}
