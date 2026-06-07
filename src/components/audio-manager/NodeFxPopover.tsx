/**
 * Floating DSP editor for a node in the node-graph view.
 *
 * Node mode hides the detail panel, so effects were previously unreachable
 * there. This popover brings the same per-input / per-bus effect chain editing
 * onto the canvas: click a node's FX pill and its chain opens anchored to the
 * click. It reuses the exact controls from the detail panel — `InputDspControls`
 * for an input's full chain (denoise → HPF → gate → EQ → comp → limiter) and
 * `BusEqControls` + `BusLimiterControls` for a bus.
 *
 * Effects map 1:1 to the backend's per-input/per-bus DSP (fixed order), so this
 * is purely a different surface onto the same model — no new audio path.
 */

import { useEffect } from "react";

import { InputDspControls, BusEqControls, BusLimiterControls } from "./DspControls";
import type { AudioInput, Bus, BusId, DspConfig, EqConfig, LimiterConfig } from "./types";
import styles from "./NodeFxPopover.module.css";

export type NodeFxTarget =
  | { kind: "input"; id: string; x: number; y: number }
  | { kind: "bus"; id: BusId; x: number; y: number };

interface NodeFxPopoverProps {
  target: NodeFxTarget;
  inputs: AudioInput[];
  buses: Bus[];
  onInputDsp: (id: string, dsp: DspConfig) => void;
  onBusEq: (id: BusId, eq: EqConfig) => void;
  onBusLimiter: (id: BusId, limiter: LimiterConfig) => void;
  onClose: () => void;
}

/** Per-input effect keys, in the engine's fixed processing order. */
export type InputFxKey = "denoise" | "hpf" | "gate" | "eq" | "comp" | "limiter";

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

/** Enabled effects in chain order — drives the on-canvas effect boxes. */
export function enabledInputFx(dsp: DspConfig): { key: InputFxKey; label: string }[] {
  return INPUT_FX_DEFS.filter((d) => inputFxEnabled(dsp, d.key));
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

export function NodeFxPopover({
  target,
  inputs,
  buses,
  onInputDsp,
  onBusEq,
  onBusLimiter,
  onClose,
}: NodeFxPopoverProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Look the live object up by id each render so edits reflect immediately.
  const input =
    target.kind === "input" ? inputs.find((i) => i.id === target.id) ?? null : null;
  const bus =
    target.kind === "bus" ? buses.find((b) => b.id === target.id) ?? null : null;
  if (!input && !bus) return null;

  const title = input ? input.name : bus!.label;
  const eyebrow = input ? "Input FX" : "Bus FX";

  return (
    <>
      <div className={styles.backdrop} onMouseDown={onClose} onClick={onClose} aria-hidden />
      <div
        className={styles.popover}
        style={{ left: target.x, top: target.y }}
        role="dialog"
        aria-label={`Effects for ${title}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            <div className={styles.eyebrow}>{eyebrow}</div>
            <div className={styles.title}>{title}</div>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Close effects"
          >
            ×
          </button>
        </header>
        <div className={styles.body}>
          {input && (
            <InputDspControls
              dsp={input.dsp}
              onChange={(dsp) => onInputDsp(input.id, dsp)}
            />
          )}
          {bus && (
            <>
              <BusEqControls eq={bus.eq} onChange={(eq) => onBusEq(bus.id, eq)} />
              <BusLimiterControls
                limiter={bus.limiter}
                onChange={(lim) => onBusLimiter(bus.id, lim)}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
