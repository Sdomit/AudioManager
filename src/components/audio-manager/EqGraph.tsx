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

import { useCallback, useMemo, useRef } from "react";

import type { EqBand } from "../../types/engine";
import { bandUsesGain, bandUsesQ, DSP_RANGE } from "./dspDefaults";
import styles from "./EqGraph.module.css";
import { DEFAULT_EQ_SR, logFreqPoints, sumResponseDb } from "./eqResponse";

const VIEW_W = 600;
const VIEW_H = 220;
const F_MIN = 20;
const F_MAX = 20_000;
const GAIN_MAX = 24; // matches DSP_RANGE.eqGain
const NODE_R = 9;
const CURVE_POINTS = 200;

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
  sampleRate = DEFAULT_EQ_SR,
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

  const curve = useMemo(() => {
    const pts = logFreqPoints(CURVE_POINTS, F_MIN, F_MAX);
    const db = sumResponseDb(bands, pts, sampleRate);
    return pts
      .map((f, i) => `${freqToX(f).toFixed(1)},${gainToY(db[i]).toFixed(1)}`)
      .join(" ");
  }, [bands, sampleRate]);

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
        patch.gain_db = clamp(Math.round(yToGain(v.vy) * 2) / 2, gMin, gMax);
      }
      patchBand(i, patch);
    },
    [bands, eventToView, patchBand],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGCircleElement>) => {
    dragIdx.current = null;
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
      const next = clamp(
        Math.round(band.q * Math.exp(-e.deltaY * 0.001) * 10) / 10,
        qMin,
        qMax,
      );
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
    </div>
  );
}
