/**
 * Interactive EQ frequency-response graph.
 *
 * Draws the summed response curve (via `eqResponse`) and one draggable node per
 * enabled band. Drag a node to set freq (X) and, for shapes that use gain, gain
 * (Y); wheel over a node adjusts Q for shapes that use it. All edits flow up
 * through `onChange`; the parent throttles the resulting IPC write (one invoke
 * per animation frame) and the backend re-clamps, so this only needs to stay
 * inside sensible UI travel.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import type { EqBand } from "../../types/engine";
import { bandUsesGain, bandUsesQ, DSP_RANGE } from "./dspDefaults";
import styles from "./EqGraph.module.css";
import { DEFAULT_EQ_SR, logFreqPoints, sumResponseDb } from "./eqResponse";

/**
 * Engine sample rate for the EQ response curve, provided near the app root from
 * the active output device. EqGraph reads it when given no explicit `sampleRate`
 * prop, so the drawn curve matches the backend biquads at 44.1/96 kHz instead of
 * always assuming 48 kHz. Defaults to 48 kHz when no provider is mounted.
 */
export const EqSampleRateContext = createContext<number>(DEFAULT_EQ_SR);

const VIEW_W = 600;
const VIEW_H = 220;
const F_MIN = 20;
const F_MAX = 20_000;
const GAIN_MAX = 24; // matches DSP_RANGE.eqGain
const NODE_R = 9;
// Denser sampling so sharp (high-Q) peaks/notches render accurately rather than
// getting flattened between too-few points.
const CURVE_POINTS = 384;

function fmtFreq(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`;
}
function fmtGain(db: number): string {
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

const LOG_MIN = Math.log10(F_MIN);
const LOG_SPAN = Math.log10(F_MAX) - LOG_MIN;

const GRID_FREQS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FREQ_LABELS: Record<number, string> = {
  100: "100",
  1000: "1k",
  10000: "10k",
};
const GAIN_GRID = [-18, -12, -6, 0, 6, 12, 18];

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function freqToX(f: number): number {
  return ((Math.log10(clamp(f, F_MIN, F_MAX)) - LOG_MIN) / LOG_SPAN) * VIEW_W;
}
function xToFreq(x: number): number {
  return Math.pow(10, LOG_MIN + (clamp(x, 0, VIEW_W) / VIEW_W) * LOG_SPAN);
}
function gainToY(g: number): number {
  return (VIEW_H / 2) * (1 - clamp(g, -GAIN_MAX, GAIN_MAX) / GAIN_MAX);
}
function yToGain(y: number): number {
  return GAIN_MAX * (1 - (2 * clamp(y, 0, VIEW_H)) / VIEW_H);
}

export function EqGraph({
  bands,
  sampleRate,
  selected = null,
  onSelect,
  onChange,
}: {
  bands: EqBand[];
  sampleRate?: number;
  selected?: number | null;
  onSelect?: (index: number) => void;
  onChange: (bands: EqBand[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragIdx = useRef<number | null>(null);
  // Band whose values the live readout shows (during a drag, else the selection).
  const [active, setActive] = useState<number | null>(null);
  // Explicit prop wins; otherwise use the engine rate from context (default 48k)
  // so the curve tracks the real device rate rather than always 48 kHz.
  const ctxSampleRate = useContext(EqSampleRateContext);
  const effectiveSampleRate = sampleRate ?? ctxSampleRate;

  const curve = useMemo(() => {
    const pts = logFreqPoints(CURVE_POINTS, F_MIN, F_MAX);
    const db = sumResponseDb(bands, pts, effectiveSampleRate);
    return pts
      .map((f, i) => `${freqToX(f).toFixed(1)},${gainToY(db[i]).toFixed(1)}`)
      .join(" ");
  }, [bands, effectiveSampleRate]);

  const patchBand = useCallback(
    (i: number, patch: Partial<EqBand>) => {
      onChange(bands.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
    },
    [bands, onChange],
  );

  const eventToView = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      vx: ((clientX - rect.left) / rect.width) * VIEW_W,
      vy: ((clientY - rect.top) / rect.height) * VIEW_H,
    };
  }, []);

  const handlePointerDown = useCallback(
    (i: number) => (e: React.PointerEvent<SVGCircleElement>) => {
      e.preventDefault();
      dragIdx.current = i;
      setActive(i);
      onSelect?.(i);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [onSelect],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGCircleElement>) => {
      const i = dragIdx.current;
      if (i === null) return;
      const v = eventToView(e.clientX, e.clientY);
      if (!v) return;
      const band = bands[i];
      const [fMin, fMax] = DSP_RANGE.eqFreq;
      const patch: Partial<EqBand> = {
        freq_hz: clamp(Math.round(xToFreq(v.vx)), fMin, fMax),
      };
      if (bandUsesGain(band.kind)) {
        const [gMin, gMax] = DSP_RANGE.eqGain;
        // Shift = fine (0.1 dB); otherwise the 0.5 dB engine quantum.
        const step = e.shiftKey ? 0.1 : 0.5;
        patch.gain_db = clamp(Math.round(yToGain(v.vy) / step) * step, gMin, gMax);
      }
      patchBand(i, patch);
    },
    [bands, eventToView, patchBand],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    dragIdx.current = null;
    setActive(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handleWheel = useCallback(
    (i: number) => (e: React.WheelEvent<SVGCircleElement>) => {
      const band = bands[i];
      if (!bandUsesQ(band.kind)) return;
      e.preventDefault();
      const [qMin, qMax] = DSP_RANGE.eqQ;
      // Shift = fine (0.05); otherwise 0.1 steps. Exponential so Q feels even.
      const qStep = e.shiftKey ? 0.05 : 0.1;
      const raw = band.q * Math.exp(-e.deltaY * 0.001);
      const next = clamp(Math.round(raw / qStep) * qStep, qMin, qMax);
      patchBand(i, { q: next });
    },
    [bands, patchBand],
  );

  return (
    <div className={styles.wrap}>
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="EQ frequency response"
      >
        {/* Frequency grid */}
        {GRID_FREQS.map((f) => {
          const x = freqToX(f);
          return (
            <g key={`f${f}`}>
              <line
                x1={x}
                y1={0}
                x2={x}
                y2={VIEW_H}
                className={styles.grid}
              />
              {FREQ_LABELS[f] ? (
                <text x={x + 3} y={VIEW_H - 4} className={styles.axisLabel}>
                  {FREQ_LABELS[f]}
                </text>
              ) : null}
            </g>
          );
        })}
        {/* Gain grid */}
        {GAIN_GRID.map((g) => {
          const y = gainToY(g);
          return (
            <g key={`g${g}`}>
              <line
                x1={0}
                y1={y}
                x2={VIEW_W}
                y2={y}
                className={g === 0 ? styles.gridZero : styles.grid}
              />
              {(g === 0 || g === 12 || g === -12) && (
                <text x={4} y={y - 3} className={styles.axisLabel}>
                  {g > 0 ? `+${g}` : g}
                </text>
              )}
            </g>
          );
        })}
        {/* Response curve */}
        <polyline className={styles.curve} points={curve} />
        {/* Band nodes (enabled only) */}
        {bands.map((band, i) =>
          band.enabled ? (
            <circle
              key={i}
              className={styles.node}
              data-selected={selected === i ? "" : undefined}
              cx={freqToX(band.freq_hz)}
              cy={gainToY(bandUsesGain(band.kind) ? band.gain_db : 0)}
              r={NODE_R}
              onPointerDown={handlePointerDown(i)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onWheel={handleWheel(i)}
            >
              <title>{`Band ${i + 1}`}</title>
            </circle>
          ) : null,
        )}
      </svg>
      {(() => {
        const idx = active ?? selected;
        if (idx === null) return null;
        const b = bands[idx];
        if (!b || !b.enabled) return null;
        return (
          <div className={styles.readout} role="status" aria-live="polite">
            <span className={styles.readoutVal}>{fmtFreq(b.freq_hz)}</span>
            {bandUsesGain(b.kind) && (
              <span className={styles.readoutVal}>{fmtGain(b.gain_db)}</span>
            )}
            {bandUsesQ(b.kind) && (
              <span className={styles.readoutVal}>Q&nbsp;{b.q.toFixed(2)}</span>
            )}
          </div>
        );
      })()}
    </div>
  );
}
