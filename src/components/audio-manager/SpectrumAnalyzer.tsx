import { useEffect, useRef } from "react";
import { getSpectrumData } from "../../ipc/commands";
import type { BusId } from "./types";

const MIN_DB = -90;
const MAX_DB = 0;
const N_BINS = 1024;
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
// Nyquist for the 48 kHz engine; bin i covers i * SR_HALF / N_BINS Hz.
const SR_HALF = 24000;

// Temporal easing: rise fast to catch transients, fall slowly for a smooth,
// modern decay instead of a jittery raw readout.
const ATTACK = 0.55;
const DECAY = 0.09;

interface Props {
  busId: BusId;
  width: number;
  height?: number;
}

export function SpectrumAnalyzer({ busId, width, height = 56 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Per-column target (latest poll) + displayed (eased each frame) magnitudes.
  const targetRef = useRef<Float32Array>(new Float32Array(0));
  const dispRef = useRef<Float32Array>(new Float32Array(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = Math.max(1, Math.round(width));
    const H = Math.max(1, Math.round(height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    targetRef.current = new Float32Array(W);
    dispRef.current = new Float32Array(W);

    let cancelled = false;
    let raf = 0;

    // Precompute the bin range each pixel column aggregates (accurate: take the
    // peak across the column's frequency band instead of one nearest bin, which
    // dropped energy where many bins map to a pixel at high frequency).
    const binLo = new Int32Array(W);
    const binHi = new Int32Array(W);
    const freqAt = (t: number) => MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, t);
    const binOf = (f: number) =>
      Math.max(0, Math.min(N_BINS - 1, Math.round((f / SR_HALF) * N_BINS)));
    for (let x = 0; x < W; x++) {
      const lo = binOf(freqAt((x - 0.5) / (W - 1)));
      const hi = binOf(freqAt((x + 0.5) / (W - 1)));
      binLo[x] = Math.min(lo, hi);
      binHi[x] = Math.max(lo, hi);
    }

    const poll = async () => {
      try {
        const bins = await getSpectrumData(busId);
        if (cancelled) return;
        const target = targetRef.current;
        for (let x = 0; x < W; x++) {
          let peak = MIN_DB;
          for (let b = binLo[x]; b <= binHi[x]; b++) {
            const v = bins[b];
            if (v !== undefined && v > peak) peak = v;
          }
          target[x] = Math.max(0, Math.min(1, (peak - MIN_DB) / (MAX_DB - MIN_DB)));
        }
      } catch {
        // Bus not running — decay the display to silence smoothly.
        targetRef.current.fill(0);
      }
    };

    const color = () =>
      getComputedStyle(canvas).getPropertyValue("--bus-accent").trim() || "#f5b942";

    const draw = () => {
      if (cancelled) return;
      const target = targetRef.current;
      const disp = dispRef.current;
      // Ease each column toward its target (fast up, slow down).
      for (let x = 0; x < W; x++) {
        const d = target[x] - disp[x];
        disp[x] += d * (d > 0 ? ATTACK : DECAY);
      }

      ctx.clearRect(0, 0, W, H);
      const c = color();

      // Smooth silhouette via quadratic curve through column midpoints.
      const yOf = (x: number) => H - disp[x] * (H - 1) - 0.5;
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, yOf(0));
      for (let x = 1; x < W - 1; x++) {
        const xc = (x + x + 1) / 2;
        const yc = (yOf(x) + yOf(x + 1)) / 2;
        ctx.quadraticCurveTo(x, yOf(x), xc, yc);
      }
      ctx.lineTo(W - 1, yOf(W - 1));
      ctx.lineTo(W, H);
      ctx.closePath();

      // Filled area — accent fading to transparent toward the floor.
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, hexA(c, 0.55));
      grad.addColorStop(1, hexA(c, 0.04));
      ctx.fillStyle = grad;
      ctx.fill();

      // Crisp top line.
      ctx.beginPath();
      ctx.moveTo(0, yOf(0));
      for (let x = 1; x < W - 1; x++) {
        const xc = (x + x + 1) / 2;
        const yc = (yOf(x) + yOf(x + 1)) / 2;
        ctx.quadraticCurveTo(x, yOf(x), xc, yc);
      }
      ctx.lineTo(W - 1, yOf(W - 1));
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = "round";
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };

    const id = setInterval(poll, 80);
    poll();
    raf = requestAnimationFrame(draw);

    return () => {
      cancelled = true;
      clearInterval(id);
      cancelAnimationFrame(raf);
    };
  }, [busId, width, height]);

  return <canvas ref={canvasRef} style={{ display: "block" }} />;
}

/** Apply an alpha to a #rgb/#rrggbb color (falls back to the raw string). */
function hexA(color: string, a: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((ch) => ch + ch).join("");
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
