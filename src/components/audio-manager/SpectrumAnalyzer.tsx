import { useEffect, useRef } from "react";
import { getSpectrumData } from "../../ipc/commands";
import type { BusId } from "./types";

const MIN_DB = -90;
const MAX_DB = 0;
const N_BINS = 1024;
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
// bin i = freq i * (48000/2) / N_BINS = i * 23.4375 Hz
const SR_HALF = 24000;

interface Props {
  busId: BusId;
  width: number;
  height?: number;
}

export function SpectrumAnalyzer({ busId, width, height = 56 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const bins = await getSpectrumData(busId);
        if (cancelled) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const color =
          getComputedStyle(canvas).getPropertyValue("--bus-accent").trim() ||
          "#4db6ac";
        const W = width;
        const H = height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = color;

        for (let x = 0; x < W; x++) {
          const t = x / (W - 1);
          const freq = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, t);
          const binIdx = Math.min(
            N_BINS - 1,
            Math.round((freq / SR_HALF) * N_BINS),
          );
          const db = bins[binIdx] ?? MIN_DB;
          const norm = Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB));
          ctx.fillRect(x, H - norm * H, 1, norm * H);
        }
      } catch {
        // bus not running — keep last frame
      }
    };

    const id = setInterval(poll, 100);
    poll();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [busId, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ display: "block" }}
    />
  );
}
