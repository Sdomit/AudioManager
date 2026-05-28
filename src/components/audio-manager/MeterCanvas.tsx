import { useEffect, useRef } from "react";

interface MeterCanvasProps {
  /** Current level, 0..1.2 (>1 = clipping) */
  level: number;
  /** Width and height in CSS pixels */
  width?: number;
  height?: number;
  /** Show peak hold marker */
  peakHold?: boolean;
  /** Compact mode for input rows */
  variant?: "bus" | "input";
}

/**
 * Animated meter rendered on Canvas for performance.
 *
 * Renders a horizontal bar with the standard pro-audio gradient:
 *   green → yellow → orange → red
 *
 * Uses requestAnimationFrame to smooth between incoming levels.
 * Survives parent re-renders without re-mounting.
 */
export function MeterCanvas({
  level,
  width = 320,
  height = 12,
  peakHold = true,
  variant = "bus",
}: MeterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentRef = useRef(level);
  const peakRef = useRef(0);
  const peakAtRef = useRef(0);
  const targetRef = useRef(level);
  const dprRef = useRef(1);

  // Update target on prop change.
  useEffect(() => {
    targetRef.current = level;
  }, [level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    // Resolve gradient stops once via CSS variables on the element.
    const styles = getComputedStyle(canvas);
    const low  = styles.getPropertyValue("--am-meter-low").trim()  || "#22C55E";
    const mid  = styles.getPropertyValue("--am-meter-mid").trim()  || "#EAB308";
    const high = styles.getPropertyValue("--am-meter-high").trim() || "#F97316";
    const clip = styles.getPropertyValue("--am-meter-clip").trim() || "#EF4444";
    const trackBg = styles.getPropertyValue("--am-meter-track").trim() || "rgba(255,255,255,0.05)";

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    // Stops approximate dB regions: 0=-inf, 0.7=-6, 0.9=-3, 1.0=0/clip
    gradient.addColorStop(0.00, low);
    gradient.addColorStop(0.60, low);
    gradient.addColorStop(0.78, mid);
    gradient.addColorStop(0.90, high);
    gradient.addColorStop(1.00, clip);

    let raf = 0;
    const draw = () => {
      // Smooth current → target (attack faster than release)
      const t = targetRef.current;
      const c = currentRef.current;
      const diff = t - c;
      currentRef.current = c + diff * (diff > 0 ? 0.55 : 0.18);

      // Track peak
      if (currentRef.current >= peakRef.current) {
        peakRef.current = currentRef.current;
        peakAtRef.current = performance.now();
      } else if (performance.now() - peakAtRef.current > 1200) {
        peakRef.current = Math.max(currentRef.current, peakRef.current - 0.01);
      }

      ctx.clearRect(0, 0, width, height);

      // Track background
      ctx.fillStyle = trackBg;
      roundRect(ctx, 0, 0, width, height, height / 2);
      ctx.fill();

      // Level fill (clamped to width)
      const fill = Math.max(0, Math.min(1, currentRef.current));
      if (fill > 0.001) {
        ctx.save();
        roundRect(ctx, 0, 0, width, height, height / 2);
        ctx.clip();
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width * fill, height);
        ctx.restore();
      }

      // Peak hold marker
      if (peakHold && peakRef.current > 0.02) {
        const x = Math.min(width - 2, width * peakRef.current);
        ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
        ctx.fillRect(x - 1, 1, 2, height - 2);
      }

      // 0 dB tick at 1.0 (visual indicator just inside the right edge)
      ctx.fillStyle = "rgba(255, 255, 255, 0.16)";
      const tickX = width * 0.92;
      ctx.fillRect(tickX, 0, 1, height);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [width, height, peakHold]);

  return (
    <canvas
      ref={canvasRef}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={level}
      aria-label={variant === "bus" ? "Bus level meter" : "Input level meter"}
      style={{ display: "block" }}
    />
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x,     y + h, rr);
  ctx.arcTo(x,     y + h, x,     y,     rr);
  ctx.arcTo(x,     y,     x + w, y,     rr);
  ctx.closePath();
}
